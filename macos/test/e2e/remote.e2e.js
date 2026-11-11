'use strict';
// Remote dictation end to end in the real app (headless): another app asks over the fake ntfy
// (<topic>-remote) for a dictation; the app records the fake microphone, a stop writes it down at
// the fake OpenRouter and sends it, with the asking app's context, to the fake bb's chief; every
// state comes back on the remote topic. Then the failures: switched off, an old request, and no
// stop in time (the note waits under Needs you). Settings shows the switch and the connection;
// the app log and the network log have every request and state.
// Run: DD_WAV_SECONDS=20 scripts/e2e.sh remote

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startFake } = require('../support/fakes');
const { waitFor, sleep } = require('../../src/core/util');
const netLog = require('../../src/core/net-log');

module.exports = async function (dd) {
  const [or, bb, ntfy] = await Promise.all([startFake('fake_openrouter.py'), startFake('fake_bb_mcp.py'), startFake('fake_ntfy.py')]);
  process.env.DD_OPENROUTER_URL = or.url + '/api/v1';
  try {
    const { ctx } = dd;
    ctx.vault.set('openrouterKey', 'sk-or-fake');
    ctx.bb.useCustom(bb.url + '/mcp', '', 'http://bb.test');
    ctx.bb.setChief({ id: 'thr_fakechief', title: 'Chief of staff' });
    ctx.prefs.set('onboarded', true);
    const topic = ctx.bb.ntfyTopic();
    ctx.bb.setNtfyServer(ntfy.url); // a settings change: the remote subscription follows
    const remote = dd.remote();
    await waitFor(() => remote.status().connection === 'open', 10000, 'listening on the remote topic');
    const remoteTopic = topic + '-remote';

    const d = dd.dictation();
    const tells = async () => (await bb.get('/test/requests')).requests.filter((r) => /"tell"/.test(r.code || '')).map((r) => r.code);
    const published = async () => (await ntfy.get('/test/requests')).requests.filter((r) => r.method === 'publish');
    const states = async (session) =>
      (await published())
        .filter((r) => r.topic === remoteTopic && r.tags.includes('dictate-state') && r.tags.includes('session-' + session))
        .map((r) => ({ ...JSON.parse(r.message), priority: r.priority }));
    const waitState = (session, state, ms = 20000) =>
      waitFor(async () => (await states(session)).find((s) => s.state === state), ms, `${session}: ${state}`).catch(async (e) => {
        throw new Error(e.message + ' ' + JSON.stringify(await states(session)) + ' dictation ' + JSON.stringify(d.snapshot()).slice(0, 400));
      });
    const ask = (action, session, body = '', headers = {}) =>
      fetch(`${ntfy.url}/${remoteTopic}`, { method: 'POST', headers: { Title: 'Drum Along', Priority: 'high', Tags: `dd-remote,${action},session-${session}`, ...headers }, body });

    // 1. Start, record, stop: sent to the chief with the context; every state told.
    await or.post('/test/script', { transcribe: [{ text: 'Play the chorus again, a bit slower.', cost: 0.001 }] });
    await ask('dictate-start', 'kit-1', 'Drum Along: song "Africa", at bar 32, tempo 92.');
    await waitFor(() => d.snapshot().state === 'recording', 10000, 'recording');
    const listening = await waitState('kit-1', 'listening');
    assert.equal(listening.priority, 1, 'priority min');
    assert.match(listening.app, /^mac \d+\.\d+\.\d+/);
    assert.equal(d.snapshot().session.chief, 'queued', 'for the chief from the start');
    assert.match(d.snapshot().detail, /started by Drum Along/);
    await sleep(2000);
    const stopAt = Date.now();
    await ask('dictate-stop', 'kit-1', 'End the dictation and send it.');
    await waitState('kit-1', 'transcribing', 3000); // the bridge waits 10 s for it
    console.log(`E2E remote: transcribing told ${Date.now() - stopAt} ms after the stop was published`);
    const sent = await waitState('kit-1', 'sent');
    assert.equal(sent.text, 'Play the chorus again, a bit slower.');
    const message = (await tells()).find((c) => c.includes('Play the chorus again'));
    assert.ok(message, 'the chief got it');
    assert.ok(message.includes('<context from=\\"Drum Along\\">\\nDrum Along: song \\"Africa\\", at bar 32, tempo 92.\\n</context>'), message.slice(0, 600));
    assert.ok(message.includes('[request: ' + sent.request + ']'), 'the state carries the request ID');
    assert.deepEqual((await states('kit-1')).map((s) => s.state), ['listening', 'transcribing', 'sent']);
    assert.ok(!(await published()).some((r) => r.topic === topic), 'nothing on the main topic');
    const note = ctx.history.load(d.snapshot().session.noteId);
    assert.equal(note.remote.by, 'Drum Along');

    // 2. Switched off: it says so and nothing records.
    ctx.prefs.set('remoteDictation', false);
    await ask('dictate-start', 'kit-2');
    const off = await waitState('kit-2', 'failed');
    assert.match(off.error, /switched off/);
    assert.notEqual(d.snapshot().state, 'recording');
    ctx.prefs.set('remoteDictation', true);

    // 3. An old request (replayed after a reconnect) expires.
    await ask('dictate-start', 'kit-3', '', { 'X-Fake-Time': String(Math.floor(Date.now() / 1000) - 60) });
    const old = await waitState('kit-3', 'expired');
    assert.match(old.error, /s old/);
    assert.notEqual(d.snapshot().state, 'recording');

    // 4. No stop in time: it stops, the note is written down but not sent, and waits under Needs you.
    remote.stopWithinMs = 3000;
    await or.post('/test/script', { transcribe: [{ text: 'Count me in with four clicks.', cost: 0.001 }] });
    await ask('dictate-start', 'kit-4', 'Drum Along: song "Africa".');
    await waitState('kit-4', 'listening');
    const timedOut = await waitState('kit-4', 'failed', 15000);
    assert.match(timedOut.error, /No stop came within/);
    await waitFor(() => d.snapshot().state === 'copied', 20000, 'written down');
    const heldId = d.snapshot().session.noteId;
    await sleep(1500);
    assert.ok(!(await tells()).some((c) => c.includes('Count me in')), 'not sent by itself');
    assert.match(ctx.history.load(heldId).held, /no stop came from Drum Along/);
    const win = dd.openMain('home');
    const text = () => win.webContents.executeJavaScript('document.body.innerText').catch(() => '');
    await waitFor(async () => /Needs you/i.test(await text()) && /no stop came from Drum Along/.test(await text()), 15000, 'Needs you on Home').catch(async (e) => {
      throw new Error(e.message + ': ' + (await text()).slice(0, 900));
    });

    // 5. Settings shows the switch and how the connection stands.
    win.webContents.send('navigate', 'start');
    await waitFor(async () => /Let your assistant start a dictation/.test(await text()) && /Listening for requests/.test(await text()), 15000, 'the setting').catch(async (e) => {
      throw new Error(e.message + ': ' + (await text()).slice(0, 900));
    });

    // 6. The logs have it.
    const appLog = fs.readFileSync(path.join(process.env.DD_USER_DATA, 'app.log'), 'utf8');
    assert.match(appLog, /remote: dictate-start from Drum Along \(session kit-1\)/);
    assert.match(appLog, /remote: session kit-1: sent \(request /);
    assert.match(appLog, /remote: session kit-2: failed: Remote dictation is switched off/);
    const net = netLog.read();
    assert.match(net, /remote dictation request .*dictate-start.*session kit-1, from Drum Along/);
    assert.match(net, /ntfy remote state .*sent, session kit-1/);
    assert.ok(!net.includes(topic), 'the topic stays out of the network log');
  } finally {
    or.stop();
    bb.stop();
    ntfy.stop();
  }
};
