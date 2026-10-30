'use strict';
// A hands-free call end to end in the real app (headless): the fake microphone talks for 2.4 s
// and pauses; the turn is written down at the fake OpenRouter, Jev says it's a question, it goes
// to the fake bb's chief, the chief's spoken reply comes over the fake ntfy, the voice is fetched
// and played by the audio window, and hanging up tells the chief the call ended.
// Run: DD_WAV_PATTERN=call DD_WAV_SECONDS=7 scripts/e2e.sh handsfree

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startFake } = require('../support/fakes');
const { waitFor, sleep, withTimeout } = require('../../src/core/util');

const step = (what) => {
  if (process.env.DD_TRACE) fs.appendFileSync(process.env.DD_TRACE, `e2e: ${what} ${Date.now()}\n`);
};

module.exports = async function (dd) {
  const [or, bb, ntfy] = await Promise.all([startFake('fake_openrouter.py'), startFake('fake_bb_mcp.py'), startFake('fake_ntfy.py')]);
  process.env.DD_OPENROUTER_URL = or.url + '/api/v1';
  const shots = process.env.DD_SHOTS || '/tmp/dd-e2e';
  fs.mkdirSync(shots, { recursive: true });
  try {
    const { ctx } = dd;
    ctx.vault.set('openrouterKey', 'sk-or-fake');
    ctx.bb.useCustom(bb.url + '/mcp', '', 'http://bb.test');
    ctx.bb.setNtfyServer(ntfy.url);
    ctx.bb.setChief({ id: 'thr_fakechief', title: 'Chief of staff' });
    ctx.prefs.set('hfLive', false); // No AssemblyAI here: turns are written down from their audio.
    await or.post('/test/script', {
      transcribe: [{ text: 'What time is the viewing tomorrow?', cost: 0.001 }],
      decide: [{ turn: 'question' }, { turn: 'question' }, { turn: 'question' }],
    });

    step('start call');
    dd.startCall();
    const call = dd.call();
    await waitFor(() => call.active(), 5000, 'call active');
    const tells = async () => (await bb.get('/test/requests')).requests.filter((r) => /"tell"/.test(r.code || '')).map((r) => r.code);
    await waitFor(async () => false, 1).catch(() => {});
    await waitFor(() => tellsCache.some((c) => c.includes('hands-free call started')), 15000, 'call start told').catch(async (e) => {
      throw new Error(e.message + ' ' + JSON.stringify(await tells()).slice(0, 500));
    });
    step('call started told');
    await waitFor(() => tellsCache.some((c) => c.includes('What time is the viewing tomorrow?')), 25000, 'the turn sent to the chief').catch((e) => {
      throw new Error(e.message + ' log: ' + JSON.stringify(call.snapshot().reasons).slice(0, 800));
    });
    step('turn sent');
    const message = tellsCache.find((c) => c.includes('What time is the viewing tomorrow?'));
    assert.match(message, /\[hands-free\]/);
    const request = /\[request: (\w+)\]/.exec(message)[1];
    await capture(dd, path.join(shots, 'callbar.png'));

    // The chief answers by voice, over ntfy, tagged with the request.
    const topic = ctx.bb.ntfyTopic();
    await fetch(`${ntfy.url}/${topic}`, { method: 'POST', headers: { Tags: `talkrouter-speak,req-${request}` }, body: 'At ten, at the agency.' });
    step('reply published');
    await waitFor(async () => (await or.get('/test/requests')).requests.some((r) => r.kind === 'speech'), 15000, 'the voice was fetched');
    await waitFor(() => ['PLAYING', 'REPLY_COMING'].includes(call.snapshot().live) || /Playing|Reply/.test(call.snapshot().liveLabel), 15000, 'the reply plays').catch((e) => {
      throw new Error(e.message + ' ' + JSON.stringify(call.snapshot()).slice(0, 900));
    });
    step('reply playing');
    await waitFor(() => !['PLAYING', 'REPLY_COMING'].includes(call.snapshot().live), 20000, 'the reply ended');
    const log = fs.readFileSync(ctx.files.handsFreeLog, 'utf8');
    assert.match(log, /reply|read/i, 'the call log has the reply');

    step('end call');
    await withTimeout(call.end(), 50000, 'the end');
    await waitFor(() => tellsCache.some((c) => c.includes('hands-free call ended')), 15000, 'call end told');
    const notes = ctx.history.all().filter((n) => n.json.handsFree);
    assert.ok(notes.length >= 1, 'the message was kept as a note');
    // The call can run on into another turn (the waits above really wait): any note may be newer.
    assert.ok(notes.some((n) => n.json.chiefRequest === request), 'the note of the message sent, among ' + notes.map((n) => n.json.chiefRequest).join(', '));
    fs.writeFileSync(path.join(shots, 'handsfree.log'), log);
  } finally {
    clearInterval(poller);
    or.stop();
    bb.stop();
    ntfy.stop();
  }

  // (set up below, used above)
};

let tellsCache = [];
let poller = null;
const original = module.exports;
module.exports = async function (dd) {
  // Keep a fresh copy of what bb was told, so the waits above stay synchronous.
  const startFakeOrig = startFake;
  void startFakeOrig;
  return original(new Proxy(dd, {
    get(target, prop) {
      if (prop === 'startCall') {
        return (...args) => {
          const bbUrl = target.ctx.bb.url().replace(/\/mcp$/, '');
          poller = setInterval(async () => {
            try {
              const r = await (await fetch(bbUrl + '/test/requests')).json();
              tellsCache = r.requests.filter((q) => /"tell"/.test(q.code || '')).map((q) => q.code);
            } catch {}
          }, 200);
          return target.startCall(...args);
        };
      }
      return target[prop];
    },
  }));
};

async function capture(dd, file) {
  try {
    const { BrowserWindow } = require('electron');
    const bar = BrowserWindow.getAllWindows().find((w) => /callbar/.test(w.webContents.getURL()));
    if (!bar) return;
    const img = await withTimeout(bar.webContents.capturePage(), 3000);
    fs.writeFileSync(file, img.toPNG());
  } catch (e) {
    console.log('screenshot failed', e.message);
  }
}
