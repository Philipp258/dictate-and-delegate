'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BbBridge = require('../src/core/bb-bridge');
const ChiefSkills = require('../src/core/chief-skills');

/** HandsFree is ported elsewhere (hands-free.js); its checks run once it's there. */
function handsFree() {
  try {
    return require('../src/core/handsfree');
  } catch {
    return null;
  }
}

test('threadIdsComeFromLinksOrIds', () => {
  assert.equal(BbBridge.threadId('thr_abc123'), 'thr_abc123');
  assert.equal(BbBridge.threadId('https://someone.getbb.app/threads/thr_abc123'), 'thr_abc123');
  assert.equal(BbBridge.threadId('https://someone.getbb.app/threads/thr_abc123?x=1'), 'thr_abc123');
  assert.equal(BbBridge.threadId('https://someone.getbb.app/'), '');
  assert.equal(BbBridge.threadId(null), '');
});

test('threadLinksPointAtTheWebApp', () => {
  assert.equal(BbBridge.threadLink('https://someone.getbb.app', 'thr_x'), 'https://someone.getbb.app/threads/thr_x');
  assert.equal(BbBridge.threadLink('', 'thr_x'), '');
  assert.equal(BbBridge.linkBaseFor('https://someone.getbb.app/mcp'), 'https://someone.getbb.app');
  assert.equal(BbBridge.linkBaseFor('http://127.0.0.1:38886/api/v1/plugins/bb--mcp/http/mcp'), '');
});

test('theMessageGoesAsDataNotCode', () => {
  const said = 'Say "hi" `now` $(rm -rf ~) and\nback\\slash';
  const code = BbBridge.tellSnippet('thr_x', said);
  assert.ok(code.includes('"thread","tell","thr_x","--mode","queue","--message-file","-"'));
  // The message is one JSON string literal handed over as stdin.
  assert.ok(code.includes('{stdin: ' + JSON.stringify(said) + '}'));
  assert.ok(!code.includes('\nback'));
});

test('pastedTextFollowsTheDictation', () => {
  const m = BbBridge.message(' research flights to Lisbon ', [['pasted text', 'Dates: 3 to 7 May']], BbBridge.base64Note(['map.jpg (2 parts)']), 'k3x9qa');
  assert.ok(m.endsWith('map.jpg (2 parts).)\n\n[request: k3x9qa]'));
  assert.ok(m.startsWith('research flights to Lisbon\n\n<pasted name="pasted text">\nDates: 3 to 7 May\n</pasted>'));
  assert.ok(m.includes('cat <name>.part*.b64 | base64 -d > <name>'));
  assert.equal(BbBridge.message('just this', [], '', ''), 'just this');
});

test('pastedTextIsShortenedToStayWithinBbsLimit', () => {
  const big = 'x'.repeat(70_000);
  const m = BbBridge.message('look', [['a', big], ['b', 'more']], '', 'r1');
  assert.ok(m.length < BbBridge.CODE_LIMIT - 5_000);
  assert.ok(m.includes('[… shortened by Dictate & Delegate]'));
  assert.ok(!m.includes('<pasted name="b">'));
});

test('attachedFilesGetASafeNameWithTheirRealExtension', () => {
  assert.equal(BbBridge.fileName({ kind: 'image', name: 'IMG_20261016.HEIC', mimeType: 'image/jpeg' }), 'IMG_20261016.jpg');
  assert.equal(BbBridge.fileName({ kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg' }), 'photo.jpg');
  assert.equal(BbBridge.fileName({ kind: 'pdf', name: 'offer (1).pdf', mimeType: 'application/pdf' }), 'offer__1_.pdf');
});

test('attachmentsGoWithTheTell', () => {
  const code = BbBridge.tellSnippet('thr_c', 'look', [
    ['--image', 'img-1-a.jpg'],
    ['--file', 'offer-2-b.pdf'],
  ]);
  assert.ok(
    code.includes('["thread","tell","thr_c","--mode","queue","--message-file","-","--image","img-1-a.jpg","--file","offer-2-b.pdf"]'),
    code,
  );
  assert.equal(BbBridge.tellSnippet('thr_c', 'look', []), BbBridge.tellSnippet('thr_c', 'look'));
});

test('aNewChiefGetsOneLine', () => {
  const code = BbBridge.spawnSnippet(ChiefSkills.START);
  assert.ok(code.includes('"--project","proj_personal","--title","Chief of staff"'));
  assert.ok(code.includes('Use the chief-of-staff and dictate-and-delegate skills.'));
});

test('ntfyTopicsAndLinks', () => {
  const t = BbBridge.newTopic();
  assert.match(t, /^talkrouter-[A-Za-z0-9_-]{24}$/);
  assert.notEqual(t, BbBridge.newTopic());
  assert.equal(BbBridge.ntfyLink('https://ntfy.sh', 'talkrouter-a'), 'ntfy://ntfy.sh/talkrouter-a');
  assert.equal(BbBridge.ntfyLink('http://example.org:8080/', 't'), 'ntfy://example.org:8080/t?secure=false');
});

test('theCallStartNamesTheTalkerOnlyWhenThereIsOne', { skip: !handsFree() && 'hands-free.js not ported yet' }, () => {
  const HandsFree = handsFree();
  assert.equal(HandsFree.callStarted(''), '[hands-free call started]');
  assert.equal(HandsFree.callStarted('thr_talk1'), '[hands-free call started] [talker: thr_talk1]');
});

test('aHandsFreeMessageIsTaggedBeforeItsRequest', () => {
  assert.equal(BbBridge.handsFreeMessage(' Book it ', 'ab12'), 'Book it\n\n[hands-free]\n\n[request: ab12]');
});

// Mac: the talker's message goes first (HandsFreeService.bothTo).
test('theTalkerIsToldFirst', () => {
  assert.deepEqual([...BbBridge.bothTo('thr_c', 'thr_t', 'a', 'b').entries()], [
    ['thr_t', 'b'],
    ['thr_c', 'a'],
  ]);
  assert.deepEqual([...BbBridge.bothTo('thr_c', '', 'a', 'b').keys()], ['thr_c']);
});

test('aMessageIsToldApartByItsRequestOrReportId', () => {
  assert.equal(BbBridge.mark('do this\n\n[request: k3x9qa]'), '[request: k3x9qa]');
  assert.equal(BbBridge.mark('[app failure report] …\n\nReport ID: r-ab12'), 'Report ID: r-ab12');
  assert.equal(BbBridge.mark('[call started]'), '');
  assert.equal(BbBridge.mark(null), '');
});

test('aNewTryChecksTheThreadBeforeTellingIt', () => {
  const message = 'look\n\n[request: k3x9qa]';
  const code = BbBridge.tellOnceSnippet('thr_c', message, [], '[request: k3x9qa]');
  const check = code.indexOf('["thread","history","thr_c","--limit","50"]');
  const queue = code.indexOf('["thread","queue","list","thr_c"]');
  const tell = code.indexOf('["thread","tell","thr_c"');
  assert.ok(check > 0 && queue > check && tell > queue, code);
  assert.ok(code.includes('if (seen) return {threadId: "thr_c", delivery: "already there"};'));
  assert.ok(code.endsWith(BbBridge.tellSnippet('thr_c', message, [])));
  // The network log still calls it a tell.
  assert.equal(BbBridge.what(code, 'run', 'thr_c', ''), 'tell chief');
});

test('onlyPassingFailuresAreTriedAgain', () => {
  const { McpError } = require('../src/core/mcp');
  const unreachable = new McpError('Could not reach bb');
  unreachable.unreachable = true;
  assert.ok(unreachable.passing());
  for (const status of [429, 502, 503, 504]) assert.ok(new McpError('x', status).passing());
  for (const status of [0, 400, 401, 403, 404, 500]) assert.ok(!new McpError('x', status).passing());
});
