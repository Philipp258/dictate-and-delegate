'use strict';
// A note's journey end to end in the real app (headless): the speech model answers busy twice, the
// fallback writes it down, and the note goes to the fake bb's chief because Chief was clicked while
// recording. The note page says where it is, Details shows every try with the real error. A second
// recording meant for the chief fails to be written down: Home lists it under Needs you, and Retry
// writes it down and sends it (0.3.8 forgot the Chief choice on Retry).
// Run: scripts/e2e.sh journey

const assert = require('assert/strict');
const { startFake } = require('../support/fakes');
const { waitFor, sleep } = require('../../src/core/util');

module.exports = async function (dd) {
  const [or, bb] = await Promise.all([startFake('fake_openrouter.py'), startFake('fake_bb_mcp.py')]);
  process.env.DD_OPENROUTER_URL = or.url + '/api/v1';
  try {
    const { ctx } = dd;
    ctx.vault.set('openrouterKey', 'sk-or-fake');
    ctx.bb.useCustom(bb.url + '/mcp', '', 'http://bb.test');
    ctx.bb.setChief({ id: 'thr_fakechief', title: 'Chief of staff' });
    ctx.prefs.set('onboarded', true);
    const tells = async () => (await bb.get('/test/requests')).requests.filter((r) => /"tell"/.test(r.code || '')).map((r) => r.code);
    const d = dd.dictation();

    // 1. Busy twice, then the fallback; Chief clicked while recording.
    await or.post('/test/script', { transcribe: [{ error: 'busy' }, { error: 'busy' }, { text: 'Remind me to call the landlord about the heating.' }] });
    await d.start();
    await waitFor(() => d.snapshot().state === 'recording', 10000, 'recording');
    await sleep(1500);
    dd.panelAction('chief');
    await d.stop();
    await waitFor(() => d.snapshot().state === 'copied', 30000, 'written down by the fallback').catch((e) => {
      throw new Error(e.message + ' ' + JSON.stringify(d.snapshot()));
    });
    await waitFor(async () => (await tells()).some((c) => c.includes('call the landlord')), 15000, 'sent to the chief');
    const id = d.snapshot().session.noteId;
    const note = ctx.history.load(id);
    assert.equal(note.fallbackUsed, 'openai/gpt-transcribe');
    const speech = note.log.filter((x) => x.step === 'speech');
    assert.equal(speech.length, 3, JSON.stringify(note.log));
    assert.match(speech[0].error, /HTTP 429/);
    assert.ok(note.chiefThread && note.chiefRequest, 'sent, with its request ID');

    // 2. The note page says where it is; Details has every try and its network log lines.
    const win = dd.openMain('note:' + id);
    const text = () => win.webContents.executeJavaScript('document.body.innerText').catch(() => '');
    await waitFor(async () => /Sent to chief of staff/.test(await text()), 15000, 'the note page').catch(async (e) => {
      throw new Error(e.message + ': ' + (await text()).slice(0, 600));
    });
    assert.match(await text(), new RegExp('request ' + note.chiefRequest));
    const click = (label) =>
      win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
    assert.ok(await click('Details'), 'a Details button');
    await waitFor(async () => /Steps and tries/.test(await text()), 10000, 'the details page');
    const details = await text();
    assert.match(details, /writing down \| microsoft\/mai-transcribe-2 .*failed: The model is busy or rate-limited \(HTTP 429/);
    assert.match(details, /to the chief \| the chief · request/);
    assert.match(details, /note [0-9a-f]{8}/, 'its network log lines');
    assert.match(details, /body \{"error"/, 'the error answer is kept');

    // 3. Meant for the chief, not written down: Needs you on Home; Retry writes it down and sends it.
    await or.post('/test/script', { transcribe: [{ error: 'invalid' }] });
    await d.start();
    await waitFor(() => d.snapshot().state === 'recording', 10000, 'recording again');
    await sleep(1200);
    dd.panelAction('chief');
    await d.stop();
    await waitFor(() => d.snapshot().state === 'error' || d.hasSavedRecording(), 15000, 'the failure');
    dd.openMain('home');
    await waitFor(async () => /Needs you/i.test(await text()), 15000, 'Needs you on Home').catch(async (e) => {
      throw new Error(e.message + ': ' + (await text()).slice(0, 800));
    });
    assert.match(await text(), /For your chief of staff: not written down: OpenRouter couldn't run this request \(HTTP 400\): Fake invalid request The audio is kept/);
    await or.post('/test/script', { transcribe: [{ text: 'Second note for the chief.' }] });
    await d.retry();
    await waitFor(async () => (await tells()).some((c) => c.includes('Second note for the chief.')), 15000, 'the retried note sent to the chief');
  } finally {
    or.stop();
    bb.stop();
  }
};
