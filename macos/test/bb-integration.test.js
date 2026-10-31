'use strict';
// The bb side against scripts/fakes/fake_bb_mcp.py: connecting, the chief, sending with
// attachments, the skills, adopting the phone's skills, and bb Connect's sign-in (a small OAuth
// fake in front of the fake bb). No real bb or ntfy.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { MemoryPrefs, MemoryVault } = require('../src/core/store');
const BbBridge = require('../src/core/bb-bridge');
const ChiefSkills = require('../src/core/chief-skills');
const BbOAuth = require('../src/core/bb-oauth');
const { startFake, freePort } = require('./support/fakes');

let bb;

test.before(async () => {
  bb = await startFake('fake_bb_mcp.py');
});

test.after(() => bb && bb.stop());

test.beforeEach(async () => {
  await bb.post('/test/reset');
});

/** A bridge in custom-address mode on the fake, with fast skill polling. */
function bridge({ prefs = new MemoryPrefs(), vault = new MemoryVault(), token = '', skillOptions = {} } = {}) {
  const b = new BbBridge.BbBridge({ prefs, vault });
  b.useCustom(bb.url + '/mcp', token, '');
  b.skills = new ChiefSkills.ChiefSkills({ bridge: b, prefs, pollMs: 10, installWaitMs: 2000, talkerGraceMs: 100, ...skillOptions });
  return b;
}

async function requests() {
  return (await bb.get('/test/requests')).requests;
}

async function calls() {
  return (await requests()).filter((r) => r.method === 'tools/call');
}

const tells = async () => (await calls()).filter((r) => r.code.includes('"thread","tell"'));

/** The stdin string a snippet hands over. */
function stdinOf(code) {
  return JSON.parse(/\{stdin: ("(?:[^"\\]|\\.)*")\}/.exec(code)[1]);
}

// ------------------------------------------------------------------ connecting

test('connectTestFindsTheRunTool', async () => {
  const b = bridge();
  await b.test();
  const methods = (await requests()).map((r) => r.method);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('aCustomTokenGoesAsBearerAndAWrongOneIsExplained', async () => {
  await bb.post('/test/config', { token: 'secret' });
  await assert.rejects(bridge({ token: 'wrong' }).test(), /bb refused the token \(HTTP 401\)/);
  await bridge({ token: 'secret' }).test();
  assert.ok((await requests()).some((r) => r.auth === 'Bearer secret'));
});

test('failuresComeBackReadable', async () => {
  const b = bridge();
  await bb.post('/test/fail', { kind: 'tell', error: 'http503' });
  await assert.rejects(b.send('thr_x', 'hi'), /bb isn't reachable right now \(HTTP 503\)/);
  await bb.post('/test/fail', { kind: 'tell', error: 'tool' });
  await assert.rejects(b.send('thr_x', 'hi'), /bb couldn't do it: Error: bb thread tell failed/);
  await bb.post('/test/fail', { kind: 'tell', error: 'rpc' });
  await assert.rejects(b.send('thr_x', 'hi'), /bb: Fake bb error/);
  const nothing = new BbBridge.BbBridge({ prefs: new MemoryPrefs(), vault: new MemoryVault() });
  const closed = await freePort();
  nothing.useCustom('http://127.0.0.1:' + closed + '/mcp');
  await assert.rejects(nothing.test(), new RegExp('Could not reach bb at http://127\\.0\\.0\\.1:' + closed + '/mcp: nothing answers at this address'));
  await assert.rejects(new BbBridge.BbBridge({ prefs: new MemoryPrefs(), vault: new MemoryVault() }).test(), /bb isn't connected/);
});

test('aSnippetOverBbsLimitIsntSent', async () => {
  await assert.rejects(bridge().send('thr_x', 'x'.repeat(BbBridge.CODE_LIMIT)), /This is too long for bb/);
  assert.equal((await calls()).length, 0);
});

// ------------------------------------------------------------------ the chief

test('createChiefInstallsTheSkillsThenSpawnsTheChief', async () => {
  const prefs = new MemoryPrefs({ bbUserName: 'Alex' });
  const b = bridge({ prefs });
  const t = await b.createChief();
  assert.deepEqual(t, { id: 'thr_fakechief', title: 'Chief of staff', status: 'starting' });
  assert.equal(prefs.get(BbBridge.CHIEF_ID), 'thr_fakechief');
  assert.equal(prefs.get(BbBridge.CHIEF_NAME), 'Chief of staff');
  assert.equal(prefs.get(ChiefSkills.CHIEF_TOLD), true);
  const skills = await bb.get('/test/skills');
  assert.deepEqual(Object.keys(skills.files).sort(), ['chief-of-staff', 'dictate-and-delegate']);
  assert.ok(skills.files['dictate-and-delegate'].includes('/' + b.ntfyTopic() + " <<'TEXT'"));
  assert.ok(skills.files['chief-of-staff'].includes("You're Alex's chief of staff."));
  const codes = (await calls()).map((c) => c.code);
  const install = codes.findIndex((c) => c.includes('Dictate & Delegate: install skills'));
  const archive = codes.findIndex((c) => c.includes('"thread","archive","thr_fakeinstall"'));
  const chief = codes.findIndex((c) => c.includes('"--title","Chief of staff"'));
  assert.ok(install >= 0 && install < archive && archive < chief, JSON.stringify(codes.map((c) => c.slice(0, 60))));
  assert.equal(stdinOf(codes[chief]), ChiefSkills.START);
});

test('anExistingChiefIsCheckedAndGetsTheOneLine', async () => {
  const prefs = new MemoryPrefs();
  const b = bridge({ prefs });
  const t = await b.useExistingChief('https://someone.getbb.app/threads/thr_mine1');
  assert.equal(t.id, 'thr_mine1');
  const tell = (await tells())[0];
  assert.ok(tell.code.includes('"thread","tell","thr_mine1","--mode","queue"'));
  assert.equal(stdinOf(tell.code), ChiefSkills.START);
  assert.equal(prefs.get(BbBridge.CHIEF_ID), 'thr_mine1');
  await assert.rejects(b.useExistingChief('not a thread'), /isn't a bb thread link or id/);
});

// ------------------------------------------------------------------ sending

const jpeg = crypto.randomBytes(5000);
const pdf = crypto.randomBytes(120_000);

test('attachmentsAreUploadedAndGoWithTheTell', async () => {
  const b = bridge();
  const sent = await b.sendRequest('thr_c', 'look at these', [['pasted text', 'Dates: 3 to 7 May']], [
    { kind: 'image', name: 'IMG_1.HEIC', mimeType: 'image/jpeg', data: jpeg },
    { kind: 'pdf', name: 'offer (1).pdf', mimeType: 'application/pdf', data: pdf },
  ], 'k3x9qa');
  assert.deepEqual(sent, { files: 2, how: 'upload', refused: 0, failed: [] });
  const uploads = (await bb.get('/test/uploads')).uploads;
  assert.deepEqual(uploads.map((u) => [u.name, u.mimeType, u.via, u.size]), [
    ['IMG_1.jpg', 'image/jpeg', 'rest', jpeg.length],
    ['offer__1_.pdf', 'application/pdf', 'rest', pdf.length],
  ]);
  assert.equal(uploads[0].sha256, crypto.createHash('sha256').update(jpeg).digest('hex'));
  const tell = (await tells())[0];
  assert.ok(tell.code.includes('"--image","IMG_1.jpg-fake-0","--file","offer__1_.pdf-fake-1"'), tell.code.slice(0, 300));
  assert.equal(stdinOf(tell.code), 'look at these\n\n<pasted name="pasted text">\nDates: 3 to 7 May\n</pasted>\n\n[request: k3x9qa]');
});

test('aRefusedUploadFallsBackToBase64Parts', async () => {
  await bb.post('/test/config', { uploadStatus: 401 });
  const big = Buffer.alloc(BbBridge.BASE64_MAX + 1, 7);
  const b = bridge();
  const sent = await b.sendRequest('thr_c', 'see attached', [], [
    { kind: 'image', name: 'a.jpg', mimeType: 'image/jpeg', data: jpeg },
    { kind: 'pdf', name: 'offer.pdf', mimeType: 'application/pdf', data: pdf },
    { kind: 'pdf', name: 'huge.pdf', mimeType: 'application/pdf', data: big },
  ], 'r1');
  assert.equal(sent.files, 2);
  assert.equal(sent.how, 'base64');
  assert.equal(sent.refused, 401);
  assert.deepEqual(sent.failed, ["huge.pdf: it's too big to pass on this way"]);
  const uploads = (await bb.get('/test/uploads')).uploads;
  assert.ok(uploads.every((u) => u.via === 'mcp' && u.codeLength <= BbBridge.CODE_LIMIT));
  assert.deepEqual(uploads.map((u) => u.name), ['a.jpg.part01of01.b64', 'offer.pdf.part01of02.b64', 'offer.pdf.part02of02.b64']);
  const joined = uploads.slice(1).map((u) => u.text).join('');
  assert.ok(Buffer.from(joined, 'base64').equals(pdf));
  assert.ok(Buffer.from(uploads[0].text, 'base64').equals(jpeg));
  const tell = (await tells())[0];
  assert.ok(tell.code.includes('"--file","a.jpg.part01of01.b64-fake-0","--file","offer.pdf.part01of02.b64-fake-1"'));
  const msg = stdinOf(tell.code);
  assert.ok(msg.startsWith('see attached\n\n(Dictate & Delegate couldn\'t upload my attachments directly'));
  assert.ok(msg.includes(': a.jpg (1 part), offer.pdf (2 parts).)'));
  assert.ok(msg.includes("(I also attached huge.pdf: it's too big to pass on this way. Dictate & Delegate couldn't pass that on.)"));
  assert.ok(msg.endsWith('[request: r1]'));
});

test('handsFreeGoesToTheChiefAndTheTalkerAtOnce', async () => {
  const b = bridge();
  await bb.post('/test/config', { tellDelayMs: 1000 });
  const start = Date.now();
  const { took } = await b.sendHandsFree('thr_chief', 'Book it', 'ab12', 'thr_talk');
  assert.ok(Date.now() - start < 1900, 'both at once, not one after the other (that takes 2 s)');
  assert.deepEqual(Object.keys(took).sort(), ['thr_chief', 'thr_talk']);
  const sent = await tells();
  assert.equal(sent.length, 2);
  for (const t of sent) assert.equal(stdinOf(t.code), 'Book it\n\n[hands-free]\n\n[request: ab12]');
});

test('aMessageOnlyOneOfThemGotCountsAsPartlySent', async () => {
  const b = bridge();
  await bb.post('/test/fail', { kind: 'tell', error: 'tool', thread: 'thr_talk' });
  await assert.rejects(b.sendHandsFree('thr_chief', 'hi', 'r1', 'thr_talk'), (ex) => {
    assert.ok(ex instanceof BbBridge.PartlySent);
    assert.equal(ex.chiefMissed, false);
    assert.equal(ex.request, 'r1');
    return true;
  });
  await bb.post('/test/fail', { kind: 'tell', error: 'http503', thread: 'thr_chief' });
  await assert.rejects(b.sendHandsFree('thr_chief', 'hi', 'r2', 'thr_talk'), (ex) => ex instanceof BbBridge.PartlySent && ex.chiefMissed);
  await bb.post('/test/fail', { kind: 'tell', error: 'tool', thread: 'thr_chief' });
  await bb.post('/test/fail', { kind: 'tell', error: 'tool', thread: 'thr_talk' });
  await assert.rejects(b.sendHandsFree('thr_chief', 'hi', 'r3', 'thr_talk'), (ex) => !(ex instanceof BbBridge.PartlySent) && /neither the chief nor the talker got it/.test(ex.message));
  // Without a talker it's just the chief.
  await b.sendHandsFree('thr_chief', 'hi', 'r4');
});

// ------------------------------------------------------------------ skills

test('syncInstallsOnceAndThenOnlyWhenSomethingChanged', async () => {
  const prefs = new MemoryPrefs();
  const b = bridge({ prefs });
  const states = [];
  b.skills.onChange = (s) => states.push(s);
  await b.skills.sync();
  assert.equal(b.skills.state, ChiefSkills.State.INSTALLED, b.skills.problem);
  assert.deepEqual(states, ['CHECKING', 'INSTALLING', 'INSTALLED']);
  assert.equal(prefs.get(ChiefSkills.INSTALLED), ChiefSkills.summary(b.skills.filled()));
  assert.equal(prefs.get(ChiefSkills.CHECKED_VERSION), ChiefSkills.APP_VERSION);
  assert.ok((await calls()).some((c) => c.code.includes('"thread","archive","thr_fakeinstall"')));
  await bb.post('/test/reset', {});
  await bb.post('/test/skills', { installed: (await bb.get('/test/skills')).installed });
  // Nothing changed: bb isn't even asked.
  await b.skills.sync();
  assert.equal((await requests()).length, 0);
  // A new name: checked and installed again.
  prefs.set(ChiefSkills.USER_NAME, 'Sam');
  await b.skills.sync();
  assert.ok((await calls()).some((c) => c.code.includes('Dictate & Delegate: install skills')));
  assert.ok((await bb.get('/test/skills')).files['chief-of-staff'].includes("You're Sam's chief of staff."));
});

test('aForcedSyncOnlyChecksWhenBbIsCurrent', async () => {
  const b = bridge();
  await b.skills.sync();
  await bb.post('/test/reset', {});
  const files = b.skills.filled();
  await bb.post('/test/skills', { installed: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, ChiefSkills.marker(v)])) });
  await b.skills.sync(true);
  const c = await calls();
  assert.equal(c.length, 1);
  assert.equal(c[0].tool, 'read');
  assert.equal(b.skills.state, 'INSTALLED');
});

test('aStalledInstallFailsInTimeAndTheThreadIsArchived', async () => {
  await bb.post('/test/skills', { stall: true });
  const b = bridge({ skillOptions: { installWaitMs: 150 } });
  await b.skills.sync();
  assert.equal(b.skills.state, 'FAILED');
  assert.match(b.skills.problem, /didn't install the chief's skills in time/);
  assert.ok((await calls()).some((c) => c.code.includes('"thread","archive","thr_fakeinstall"')));
});

test('theTalkerSkillMissingIsSaidApartAndTheTalkerToldOnce', async () => {
  const prefs = new MemoryPrefs({ talkerId: 'thr_talk', talkerOn2: true, chiefId: 'thr_old' });
  const b = bridge({ prefs });
  await bb.post('/test/skills', { skip: ['dictate-and-delegate-talker'] });
  await b.skills.sync();
  assert.equal(b.skills.state, 'INSTALLED');
  assert.match(b.skills.talkerProblem(), /didn't install the talker's skill/);
  // The older chief got the one line; the talker wasn't told (its skill isn't there).
  let t = await tells();
  assert.deepEqual(t.map((x) => stdinOf(x.code)), [ChiefSkills.START]);
  assert.ok(t[0].code.includes('"thr_old"'));
  assert.equal(prefs.get(ChiefSkills.CHIEF_TOLD), true);
  // Next time bb takes it, and the talker hears about it once.
  await bb.post('/test/skills', { skip: [] });
  await b.skills.sync();
  assert.equal(b.skills.talkerProblem(), '');
  t = await tells();
  assert.deepEqual(t.map((x) => stdinOf(x.code)), [ChiefSkills.START, ChiefSkills.TALKER_START]);
  assert.ok(t[1].code.includes('"thr_talk"'));
  await b.skills.sync();
  await b.skills.tellTalker();
  assert.equal((await tells()).length, 2);
});

// ------------------------------------------------------------------ the phone's skills (Mac)

/** Skills as the phone filled them. */
function phoneFiles({ name = 'Philipp', server = 'https://ntfy.example.org', topic = 'talkrouter-PhoneTopic_123456789012', link = 'https://someone.getbb.app' } = {}) {
  const out = {};
  for (const n of [ChiefSkills.CHIEF, ChiefSkills.ROUTER]) out[n] = ChiefSkills.fill(n, ChiefSkills.template(n), name, server, topic, link);
  return out;
}

test('aNewMacTakesThePhonesTopicAndDoesntReinstall', async () => {
  await bb.post('/test/skills', { files: phoneFiles() });
  const prefs = new MemoryPrefs();
  const vault = new MemoryVault();
  const b = bridge({ prefs, vault });
  await b.skills.sync();
  assert.equal(b.skills.state, 'INSTALLED', b.skills.problem);
  assert.equal(vault.get(BbBridge.NTFY_TOPIC), 'talkrouter-PhoneTopic_123456789012');
  assert.equal(b.ntfyServer(), 'https://ntfy.example.org');
  assert.equal(prefs.get(ChiefSkills.USER_NAME), 'Philipp');
  assert.equal(b.linkBase(), 'https://someone.getbb.app');
  // The Mac fills them exactly as the phone did: no install thread.
  assert.ok(!(await calls()).some((c) => c.code.includes('install skills')));
  assert.equal(prefs.get(ChiefSkills.INSTALLED), ChiefSkills.summary(phoneFiles()));
});

test('adoptingKeepsWhatTheMacSetUnlessAsked', async () => {
  await bb.post('/test/skills', { files: phoneFiles({ name: '' }) });
  const prefs = new MemoryPrefs({ ntfyServer: 'https://ntfy.mine.example', bbUserName: 'Phil' });
  const vault = new MemoryVault({ ntfyTopic: 'talkrouter-macsown' });
  const b = bridge({ prefs, vault });
  let r = await b.skills.adoptFromBb();
  assert.equal(r.found, true);
  assert.deepEqual(r.values, { topic: 'talkrouter-PhoneTopic_123456789012', server: 'https://ntfy.example.org', name: '', linkBase: 'https://someone.getbb.app' });
  assert.deepEqual(r.adopted, ['linkBase']); // The custom address had no link base yet.
  assert.equal(r.exact, false);
  assert.equal(vault.get(BbBridge.NTFY_TOPIC), 'talkrouter-macsown');
  // The user asks: all of it.
  r = await b.skills.adoptFromBb({ force: true });
  assert.deepEqual(r.adopted, ['topic', 'server', 'name']);
  assert.equal(r.exact, true);
  assert.equal(vault.get(BbBridge.NTFY_TOPIC), 'talkrouter-PhoneTopic_123456789012');
  assert.equal(prefs.get(ChiefSkills.USER_NAME), undefined);
  // In bb Connect mode the link base follows the handle: a different one is only reported.
  const c = new BbBridge.BbBridge({ prefs: new MemoryPrefs(), vault: new MemoryVault() });
  c.useCustom(bb.url + '/mcp');
  c.prefs.set(BbBridge.LINK_BASE, 'https://other.example');
  r = await c.skills.adoptFromBb();
  assert.equal(r.linkBaseDiffers, true);
  assert.ok(!r.adopted.includes('linkBase'));
});

test('withNothingInstalledTheMacMakesItsOwnTopic', async () => {
  const vault = new MemoryVault();
  const b = bridge({ vault });
  assert.deepEqual((await b.skills.adoptFromBb()).found, false);
  await b.createChief();
  assert.match(vault.get(BbBridge.NTFY_TOPIC), /^talkrouter-[A-Za-z0-9_-]{24}$/);
});

// ------------------------------------------------------------------ bb Connect

/**
 * bb Connect in small: the OAuth endpoints, and everything else passed on to the fake bb. Access
 * tokens: "acc-1" from the code, "acc-2", … from refreshes; the fake bb takes only the current one.
 */
async function connectFake() {
  const state = { codes: new Map(), issued: 0, refreshes: [], revoked: [], current: '' };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: origin + '/mcp', authorization_servers: [origin] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', revocation_endpoint: origin + '/oauth/revoke' });
    }
    if (url.pathname === '/oauth/token' || url.pathname === '/oauth/revoke') {
      const f = Object.fromEntries(new URLSearchParams(body.toString()));
      if (url.pathname === '/oauth/revoke') {
        state.revoked.push(f);
        return json(200, {});
      }
      if (f.grant_type === 'authorization_code') {
        const want = state.codes.get(f.code);
        if (!want || BbOAuth.challenge(f.code_verifier) !== want.challenge || f.client_id !== BbOAuth.CLIENT_ID || f.redirect_uri !== BbOAuth.REDIRECT) {
          return json(400, { error: 'invalid_grant' });
        }
      } else if (f.grant_type === 'refresh_token') {
        state.refreshes.push(f);
        if (f.refresh_token !== 'ref-' + state.issued) return json(400, { error: 'invalid_grant', error_description: 'revoked' });
      } else return json(400, { error: 'unsupported_grant_type' });
      state.issued++;
      state.current = 'acc-' + state.issued;
      await bb.post('/test/config', { token: state.current });
      return json(200, { access_token: state.current, refresh_token: 'ref-' + state.issued, expires_in: 3600, token_type: 'Bearer' });
    }
    // bb itself.
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const r = await fetch(bb.url + req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
    const out = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'transfer-encoding' && k !== 'connection' && k !== 'keep-alive') h[k] = v;
    });
    res.writeHead(r.status, h);
    res.end(out);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, state };
}

test('bbConnectSignsInRefreshesOnA401AndSignsOut', async () => {
  const fake = await connectFake();
  try {
    const vault = new MemoryVault();
    const prefs = new MemoryPrefs();
    const oauth = new BbOAuth.BbOAuth({ vault, originFor: () => fake.origin });
    const b = new BbBridge.BbBridge({ prefs, vault, oauth });
    b.useConnect('someone');
    assert.equal(b.url(), fake.origin + '/mcp');
    assert.equal(b.connected(), false);
    const authorize = new URL(await oauth.begin('someone'));
    assert.equal(authorize.origin + authorize.pathname, fake.origin + '/oauth/authorize');
    const q = Object.fromEntries(authorize.searchParams);
    assert.equal(q.resource, fake.origin + '/mcp');
    assert.ok(JSON.parse(vault.get(BbOAuth.PENDING)).verifier);
    fake.state.codes.set('code-1', { challenge: q.code_challenge });
    await assert.rejects(oauth.complete({ code: 'code-1', state: 'forged' }), /doesn't match the one started here/);
    assert.equal(await oauth.complete({ code: 'code-1', state: q.state, iss: fake.origin }), 'someone');
    assert.equal(vault.get(BbOAuth.PENDING), null);
    assert.equal(oauth.signedIn(), true);
    assert.equal(oauth.signedInHandle(), 'someone');
    assert.equal(b.connected(), true);
    await b.test();
    // bb stops taking the token (as after its expiry): refreshed once, and the call goes through.
    await bb.post('/test/config', { token: 'something-else' });
    await b.test();
    assert.equal(fake.state.refreshes.length, 1);
    assert.equal(fake.state.refreshes[0].client_id, BbOAuth.CLIENT_ID);
    assert.equal(fake.state.refreshes[0].resource, fake.origin + '/mcp');
    assert.equal(await oauth.accessToken(), 'acc-2');
    // Uploads go to bb Connect's origin with the same token.
    const sent = await b.sendRequest('thr_c', 'look', [], [{ kind: 'image', name: 'a.jpg', mimeType: 'image/jpeg', data: jpeg }], 'r1');
    assert.equal(sent.how, 'upload');
    await b.disconnect();
    assert.equal(oauth.signedIn(), false);
    assert.deepEqual(fake.state.revoked.map((r) => r.token_type_hint), ['refresh_token', 'access_token']);
    await assert.rejects(b.test(), /bb isn't connected/);
    await assert.rejects(oauth.accessToken(), /You're signed out of bb/);
    await assert.rejects(oauth.complete({ code: 'x', state: 'y' }), /wasn't started here/);
  } finally {
    fake.server.close();
  }
});

test('aRevokedRefreshTokenSignsOut', async () => {
  const fake = await connectFake();
  try {
    const vault = new MemoryVault();
    let now = 1_000_000;
    const oauth = new BbOAuth.BbOAuth({ vault, originFor: () => fake.origin, clock: () => now });
    const q = Object.fromEntries(new URL(await oauth.begin('someone')).searchParams);
    fake.state.codes.set('c', { challenge: q.code_challenge });
    await oauth.complete({ code: 'c', state: q.state });
    assert.equal(await oauth.accessToken(), 'acc-1');
    now += 3600_000; // Expired: refreshed first.
    assert.equal(await oauth.accessToken(), 'acc-2');
    fake.state.issued = 99; // bb no longer knows ref-2.
    await assert.rejects(oauth.accessToken(true), /signed out of bb/);
    assert.equal(oauth.signedIn(), false);
    await assert.rejects(oauth.complete({ error: 'access_denied' }), /wasn't started here/);
    await oauth.begin('someone');
    await assert.rejects(oauth.complete({ error: 'access_denied' }), /bb didn't allow the sign-in/);
  } finally {
    fake.server.close();
  }
});
