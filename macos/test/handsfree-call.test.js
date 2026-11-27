'use strict';
// The call controller (HandsFreeService's platform-free part) wired to fakes: no Java test of its
// own (the service's statics are in handsfree-live.test.js), so these check the wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HandsFree = require('../src/core/handsfree');
const { HandsFreeCall } = require('../src/core/handsfree-call');
const { PartlySent } = require('../src/core/handsfree-session');
const { MemoryPrefs } = require('../src/core/store');
const { frame, until } = require('./support/handsfree-fakes');

function fakes({ talker = '', texts = [], live = null } = {}) {
  const w = { sent: [], told: [], notes: [], spoken: [], cues: [], replies: null, closed: false, ended: false, changes: 0 };
  w.prefs = new MemoryPrefs({ [HandsFree.PAUSE_MS]: 1000, [HandsFree.LIVE]: live != null });
  w.bb = {
    chiefId: () => 'thr_chief',
    talkerId: () => talker,
    threadLink: (id) => 'https://bb/' + id,
    async sendHandsFree(chief, said, request, to) {
      if (w.missedBy) throw new PartlySent(request, w.missedBy === 'chief', 'thread not found');
      w.sent.push({ chief, said, request, talker: to });
      return { took: { [chief]: 5, ...(to ? { [to]: 4 } : {}) } };
    },
    async tellEach(map) {
      w.told.push([...map.entries()]);
      return {};
    },
  };
  w.voice = {
    callOpen: false,
    warmed: 0,
    openCall() {
      this.callOpen = true;
    },
    warm() {
      this.warmed++;
    },
    shutdown() {
      this.shut = true;
    },
  };
  w.speaker = {
    prepare: (request, text) => text,
    play(request, text, prepared, p) {
      w.spoken.push(text);
      w.playback = p;
      p.started(1000);
    },
    stop() {
      const p = w.playback;
      w.playback = null;
      if (p) p.ended(false);
    },
  };
  w.opts = {
    prefs: w.prefs,
    bb: w.bb,
    speechModel: 'test/model',
    hintWords: ['Jana'],
    transcribe: async (wav, { model, hints }) => {
      w.hints = hints;
      return { text: texts.shift(), cost: 0.0001 };
    },
    judge: null,
    createLive: live,
    speaker: w.speaker,
    voice: w.voice,
    voiceChoice: { tag: () => 'Kokoro', model: 'hexgrad/kokoro-82m' },
    playCue: (c) => {
      w.cues.push(c);
      return true;
    },
    microphone: null,
    replies: (o) => {
      w.replies = o;
      return { close: () => (w.closed = true) };
    },
    saveNote: async (e) => w.notes.push(e),
    onChange: () => w.changes++,
    onEnded: () => (w.ended = true),
  };
  return w;
}

/** Speech, then the pause that ends it, fed to the call. */
function talk(call) {
  for (let i = 0; i < 50; i++) call.frame(frame(50));
  for (let i = 0; i < 60; i++) call.frame(frame(6000));
  for (let i = 0; i < 60; i++) call.frame(frame(50));
}

test('aCallTellsTheChiefItStartedSendsATurnKeepsItsNoteReadsTheReplyAndTellsTheEnd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-call-'));
  const w = fakes({ texts: ['Book the hotel. Over.'] });
  w.opts.logFile = path.join(dir, 'handsfree.log');
  try {
    const call = new HandsFreeCall(w.opts);
    const session = call.start();
    await until(() => w.told.length === 1);
    assert.deepEqual(w.told[0], [['thr_chief', HandsFree.CALL_STARTED]]);
    talk(call);
    await until(() => w.sent.length === 1);
    assert.equal(w.sent[0].said, 'Book the hotel.');
    assert.equal(w.sent[0].chief, 'thr_chief');
    assert.ok(w.hints.includes('Jana') && w.hints.includes('over') && w.hints.includes('end the call'));
    await until(() => w.notes.length === 1);
    const note = w.notes[0].json;
    assert.equal(note.text, 'Book the hotel.');
    assert.equal(note.handsFree, true);
    assert.equal(note.call, call.callId);
    assert.equal(note.chiefRequest, w.sent[0].request);
    assert.equal(note.chiefLink, 'https://bb/thr_chief');
    assert.equal(note.knownCost, '0.0001');
    assert.ok(note.handsFreeLog.some((l) => l.includes('speech model test/model: ')), String(note.handsFreeLog));
    assert.deepEqual(
      note.steps.map((s) => s.kind),
      ['speech', 'bb'],
    );
    // The reply to it, from ntfy.
    assert.ok(w.replies.ours(w.sent[0].request));
    assert.ok(!w.replies.ours('other'));
    assert.equal(w.replies.untagged(), '', 'no talker: an untagged update has no request');
    w.replies.onReply(w.sent[0].request, 'Booked.', 0, false);
    await until(() => w.spoken.length === 1);
    let snap = call.snapshot();
    assert.equal(snap.live, 'PLAYING');
    assert.equal(snap.reply, 'Booked.');
    assert.equal(snap.canSend, false);
    assert.equal(snap.cost, 0.0001);
    w.playback.ended(true);
    snap = call.snapshot();
    assert.equal(snap.liveLabel, 'Mic paused after the reply');
    assert.ok(snap.reasons.length > 0);
    assert.ok(w.cues.includes('HEARD') && w.cues.includes('SENT') && w.cues.includes('REPLY'), String(w.cues));
    await call.finish();
    assert.ok(w.ended);
    assert.ok(w.closed, 'the replies listener closed');
    assert.deepEqual(w.told[1], [['thr_chief', HandsFree.CALL_ENDED]]);
    assert.equal(call.snapshot().live, 'ENDED');
    assert.equal(call.current(), null);
    const log = fs.readFileSync(w.opts.logFile, 'utf8');
    assert.ok(/── call started \d\d:\d\d ──/.test(log), log);
    assert.ok(log.includes('started · send [over] · end [end the call] · voice Kokoro · live transcription off · pause 1000 ms'), log);
    assert.ok(log.includes('call ended · $0.0001 on OpenRouter'), log);
    assert.ok(log.includes('audio: kept open for the call'), log);
    assert.equal(w.voice.warmed, 1);
    assert.ok(w.voice.shut, 'the voice shut down at the end');
    assert.ok(log.includes('told the chief: [hands-free call ended]'), log);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('theCallsEndToldDuringANetworkBlipIsTriedAgainWithinItsTime', async () => {
  // Philipp's call, 27 November 2026: "couldn't tell the chief [hands-free call ended]: … unknown address".
  const retry = HandsFreeCall.SIGNAL_RETRY_MS;
  HandsFreeCall.SIGNAL_RETRY_MS = 20;
  try {
    const w = fakes();
    const events = [];
    w.opts.log = (line) => events.push(line);
    let fails = 0;
    const tell = w.bb.tellEach;
    w.bb.tellEach = async (map) => {
      if ([...map.values()].includes(HandsFree.CALL_ENDED) && fails++ < 1) return { thr_chief: 'unknown address' };
      return tell(map);
    };
    const call = new HandsFreeCall(w.opts);
    call.start();
    await until(() => w.told.length === 1);
    await call.finish();
    assert.deepEqual(w.told[1], [['thr_chief', HandsFree.CALL_ENDED]]);
    const log = events.join('\n');
    assert.ok(log.includes("couldn't tell 1 of them (unknown address): trying again in 0.02 s"), log);
    assert.ok(log.includes('told the chief: [hands-free call ended]'), log);
    // No time left in the call end's budget: not tried again, and said.
    const w2 = fakes();
    const events2 = [];
    w2.opts.log = (line) => events2.push(line);
    w2.bb.tellEach = async () => ({ thr_chief: 'unknown address' });
    const tellMax = HandsFreeCall.TELL_MAX_MS;
    HandsFreeCall.TELL_MAX_MS = 1e9;
    try {
      const call2 = new HandsFreeCall(w2.opts);
      call2.start();
      await call2.finish();
    } finally {
      HandsFreeCall.TELL_MAX_MS = tellMax;
    }
    const log2 = events2.join('\n');
    assert.ok(log2.includes("couldn't tell 1 of them: no time left to try again"), log2);
    assert.ok(log2.includes("couldn't tell the chief [hands-free call ended]: unknown address"), log2);
  } finally {
    HandsFreeCall.SIGNAL_RETRY_MS = retry;
  }
});

test('withATalkerBothHearTheStartTheMessagesAndTheEnd', async () => {
  const w = fakes({ talker: 'thr_talker', texts: ['Order the parts. Over.'] });
  let skillTold = 0;
  w.opts.tellTalkerSkill = async () => skillTold++;
  const call = new HandsFreeCall(w.opts);
  const session = call.start();
  await until(() => w.told.length === 1);
  assert.equal(skillTold, 1);
  assert.deepEqual(w.told[0], [
    ['thr_talker', HandsFree.TALKER_CALL_STARTED],
    ['thr_chief', HandsFree.callStarted('thr_talker')],
  ]);
  talk(call);
  await until(() => w.sent.length === 1);
  assert.equal(w.sent[0].talker, 'thr_talker');
  assert.equal(w.replies.untagged(), w.sent[0].request, 'an untagged update answers the latest message');
  await until(() => w.notes.length === 1);
  await call.finish();
  assert.deepEqual(w.told[1], [
    ['thr_talker', HandsFree.CALL_ENDED],
    ['thr_chief', HandsFree.CALL_ENDED],
  ]);
});

test('liveTranscriptionWithoutItsKeyIsSaidAtTheStart', async () => {
  const w = fakes({ live: () => ({ missingKey: 'AssemblyAI' }) });
  const lines = [];
  w.opts.log = (l) => lines.push(l);
  const call = new HandsFreeCall(w.opts);
  call.start();
  assert.equal(call.snapshot().liveKeyMissing, 'AssemblyAI');
  assert.equal(call.snapshot().shortLabel, 'Live off · no AssemblyAI key');
  assert.ok(lines.some((l) => l.includes('live transcription on, but no AssemblyAI key: written down from audio')), lines.join('\n'));
  await call.finish();
});

test('liveTranscriptionGetsTheKeytermsAndItsTextGoesToTheSession', async () => {
  let terms = null;
  const live = {
    choice: { model: 'u3-rt-pro', provider: 'assemblyai' },
    changed: null,
    onFailure: null,
    events: null,
    opened: 0,
    speech() {
      this.opened++;
    },
    audio() {},
    text: () => '',
    take: async () => '',
    discard() {},
    working: () => true,
    failure: () => '',
    close() {
      this.closed = true;
    },
  };
  const w = fakes({ live: (keyterms) => ((terms = keyterms), live) });
  const lines = [];
  w.opts.log = (l) => lines.push(l);
  const call = new HandsFreeCall(w.opts);
  const session = call.start();
  assert.deepEqual(terms, ['over', 'end the call']);
  assert.equal(session.live, live);
  assert.equal(live.opened, 1, 'opened at the start');
  assert.equal(typeof live.changed, 'function');
  assert.ok(lines.some((l) => l.includes('live transcription u3-rt-pro (assemblyai)')), lines.join('\n'));
  await call.finish();
  await until(() => live.closed === true);
});

test('microphoneAudioInAnyChunksBecomesTwentyMillisecondFrames', async () => {
  const w = fakes();
  let onFrame = null;
  w.opts.microphone = {
    start(f) {
      onFrame = f;
    },
    stop() {
      w.micStopped = true;
    },
  };
  const call = new HandsFreeCall(w.opts);
  const session = call.start();
  const seen = [];
  const original = session.frame.bind(session);
  session.frame = (f) => {
    seen.push(f.length);
    original(f);
  };
  onFrame(Buffer.alloc(1000));
  onFrame(Buffer.alloc(1000));
  assert.deepEqual(seen, [640, 640, 640]);
  await call.finish();
  assert.ok(w.micStopped);
});

test('theSpeakerIsMadeForTheCallItsVoiceFailuresAndCostsGoToTheSessionNotesAndTheCallsCost', async () => {
  const w = fakes({ texts: ['Book the hotel. Over.'] });
  let hooks = null;
  w.opts.speaker = null;
  w.opts.createSpeaker = (h) => {
    hooks = h;
    return w.speaker;
  };
  const updates = [];
  w.opts.updateNote = async (request, fn) => {
    const e = new (require('../src/core/history-entry').HistoryEntry)({ id: 'n', knownCost: '0.0001' });
    fn(e);
    updates.push([request, e.json]);
  };
  const call = new HandsFreeCall(w.opts);
  const session = call.start();
  talk(call);
  await until(() => w.sent.length === 1);
  hooks.onVoiceFailed('Kokoro: HTTP 503: No provider available', true);
  assert.equal(session.voiceError(), 'Kokoro: HTTP 503: No provider available');
  await hooks.onCost({ request: w.sent[0].request, choice: { model: 'hexgrad/kokoro-82m' }, cost: 0.00003, costText: '0.00003', ms: 420 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], w.sent[0].request);
  assert.equal(updates[0][1].voiceCost, '0.00003');
  assert.equal(updates[0][1].knownCost, '0.00013');
  assert.equal(updates[0][1].voiceModel, 'hexgrad/kokoro-82m');
  assert.deepEqual(updates[0][1].steps, [{ kind: 'voice', model: 'hexgrad/kokoro-82m', ms: 420, cost: '0.00003' }]);
  assert.equal(call.snapshot().cost, 0.00013);
  hooks.event('voice line');
  await call.finish();
});
