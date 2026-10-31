'use strict';
// DictationService's behaviour, ported from the device tests (MvpFlowTest, PanelTest, ControlsTest
// and the dictation parts of BbFlowTest) with fakes for everything outside: the microphone, the
// speech model, Jev, the text model, bb, ntfy, inserting and the notes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryPrefs, MemoryVault } = require('../src/core/store');
const { deferred, waitFor } = require('../src/core/util');
const D = require('../src/core/dictation');
const { panelModel } = require('../src/core/panel-model');

const SPEECH = 0.0012,
  JEV = 0.00003,
  TEXT = 0.004;
const CHIEF = 'thr_chief1';
const CHIEF_LINK = 'https://someone.getbb.app/threads/' + CHIEF;

/** Timers that only move when the test says so. */
class FakeTimers {
  constructor() {
    this.now = 0;
    this.items = new Map();
    this.next = 1;
  }
  setTimeout(f, ms) {
    const id = this.next++;
    this.items.set(id, { at: this.now + ms, f });
    return id;
  }
  clearTimeout(id) {
    this.items.delete(id);
  }
  advance(ms) {
    const until = this.now + ms;
    for (;;) {
      let first = null;
      for (const [id, t] of this.items) if (t.at <= until && (!first || t.at < first[1].at)) first = [id, t];
      if (!first) break;
      this.items.delete(first[0]);
      this.now = first[1].at;
      first[1].f();
    }
    this.now = until;
  }
  /** When the earliest pending timer fires, relative to now (null: none). */
  pending() {
    let min = null;
    for (const t of this.items.values()) if (min === null || t.at < min) min = t.at;
    return min === null ? null : min - this.now;
  }
}

/** A microphone that sends 20 ms frames when the test speaks. */
class FakeMic {
  constructor() {
    this.onFrame = null;
    this.onFail = null;
    this.running = false;
    this.starts = 0;
    this.refuse = null;
  }
  async start(onFrame, onFail) {
    if (this.refuse) throw this.refuse;
    this.onFrame = onFrame;
    this.onFail = onFail;
    this.running = true;
    this.starts++;
  }
  async stop() {
    this.running = false;
  }
  /** ms of audio at this amplitude, in 20 ms frames. */
  speak(ms, amplitude = 3000) {
    for (let t = 0; t < ms; t += 20) {
      const frame = Buffer.alloc(D.FRAME_BYTES);
      for (let i = 0; i < D.FRAME_BYTES; i += 2) frame.writeInt16LE(i % 4 ? amplitude : -amplitude, i);
      this.onFrame(frame);
    }
  }
}

function harness(opt = {}) {
  const prefs = new MemoryPrefs({ model: 'microsoft/mai-transcribe-2', autoRefine: true, autoChief: true, ...(opt.prefs || {}) });
  const vault = new MemoryVault();
  const notes = new Map();
  const timers = new FakeTimers();
  const mic = new FakeMic();
  const pending = opt.pending || new D.MemoryPendingAudio();
  let now = 1_700_000_000_000;
  const fx = {
    key: true,
    transcripts: ['um hi Jana see you at ten'],
    transcribeError: null,
    speechCost: SPEECH,
    jev: { refine: 0.1, template: 'none', chief: null, cost: JEV }, // an answer, an Error or a promise
    templates: [],
    replies: ['Hi Jana, see you at ten.'], // Refine's texts, or an Error / promise
    anthropic: false,
    chief: false, // bb ready with a chief
    chiefError: null,
    chiefGate: null,
    insert: 'inserted', // or 'pasted', 'copied', 'permission', null (refuses), 'throw'
    field: null, // a fake text field: { text } when Insert should land in one
    ntfy: null,
    calls: [],
  };
  const calls = { transcribe: [], decide: [], refine: [], chief: [], insert: [], replace: [], copy: [], call: [], links: [], notices: [], listen: [] };
  const clipboard = { text: 'something I still need' };
  const d = new D.Dictation({
    prefs,
    vault,
    pending,
    microphone: mic,
    clock: () => now,
    timers,
    uuid: (() => {
      let n = 0;
      return () => 'note-' + ++n;
    })(),
    requestId: () => 'req' + (calls.chief.length + 1).toString().padStart(3, '0'),
    hasKey: () => fx.key,
    transcribe: async (wav, words, model) => {
      calls.transcribe.push({ wav, words, model });
      if (fx.transcribeError) throw fx.transcribeError;
      const text = fx.transcripts.length > 1 ? fx.transcripts.shift() : fx.transcripts[0];
      return { text, cost: fx.speechCost };
    },
    decide: async (transcript, o) => {
      calls.decide.push({ transcript, ...o });
      const a = await fx.jev;
      if (a instanceof Error) throw a;
      return a;
    },
    templates: () => fx.templates,
    refine: async (text, o) => {
      calls.refine.push({ text, ...o });
      let r = fx.replies.length > 1 ? fx.replies.shift() : fx.replies[0];
      r = await r;
      if (r instanceof Error) throw r;
      if (fx.anthropic) return { text: r, cost: 0.003, model: 'claude-sonnet-5-5', anthropic: true, fallback: null, keyProblem: false };
      return { text: r, cost: TEXT, model: 'anthropic/claude-sonnet-5.5', anthropic: false, fallback: null, keyProblem: false };
    },
    refineModel: () => 'anthropic/claude-sonnet-5.5',
    chiefReady: () => fx.chief,
    chiefThread: () => (fx.chief ? { id: CHIEF, link: CHIEF_LINK } : null),
    sendToChief: async (text, o) => {
      calls.chief.push({ text, ...o });
      if (fx.chiefGate) await fx.chiefGate;
      if (fx.chiefError) throw fx.chiefError;
      return { files: 0, how: 'upload', refused: 0, failed: [] };
    },
    waitForChiefText: (request, since, onText) => {
      const l = { request, since, onText, stopped: false, stop: () => (l.stopped = true) };
      calls.listen.push(l);
      return l;
    },
    openLink: (url) => calls.links.push(url),
    insert: async (text) => {
      calls.insert.push(text);
      if (fx.insert === 'throw') throw new Error('gone');
      if (fx.insert === null) return null;
      if (fx.insert === 'copied' || fx.insert === 'permission') {
        clipboard.text = text;
        return { how: 'copied', reason: fx.insert === 'permission' ? 'permission' : undefined };
      }
      if (fx.field) fx.field.text += text;
      if (fx.insert === 'pasted') clipboard.text = text;
      return { how: fx.insert };
    },
    replaceInPlace: async (oldText, newText, earlier) => {
      calls.replace.push({ oldText, newText, earlier });
      if (!fx.field || !fx.field.text.includes(oldText)) return null;
      fx.field.text = fx.field.text.replace(oldText, newText);
      return { how: 'inserted' };
    },
    copy: (text) => {
      calls.copy.push(text);
      clipboard.text = text;
    },
    loadNote: async (id) => (notes.has(id) ? JSON.parse(JSON.stringify(notes.get(id))) : null),
    saveNote: async (e) => notes.set(e.id, JSON.parse(JSON.stringify(e))),
    attachments: {
      items: opt.attached || [],
      pendingCount() {
        return this.items.length;
      },
      claimPending(id) {
        const n = this.items.length;
        this.claimed = { id, n };
        this.items = [];
        return n;
      },
      clearPending() {
        this.items = [];
      },
    },
    startCall: (o) => calls.call.push(o),
    log: () => {},
  });
  d.on('notice', (t) => calls.notices.push(t));
  const h = {
    d,
    prefs,
    vault,
    notes,
    timers,
    mic,
    pending,
    fx,
    calls,
    clipboard,
    advance(ms) {
      now += ms;
      timers.advance(ms);
    },
    note() {
      return notes.get(d.session.noteId);
    },
    latest() {
      return [...notes.values()].pop();
    },
    panel() {
      return panelModel(d.snapshot());
    },
    /** Record for ms of speech, stop, wait for the transcript and whatever Jev starts. */
    async dictate(ms = 1200) {
      await d.start();
      assert.equal(d.state, D.RECORDING, d.detail);
      mic.speak(ms);
      await d.stop();
      assert.equal(d.state, D.COPIED, d.detail);
      await d.idle();
    },
  };
  return h;
}

const steps = (e) => (e.steps || []).map((s) => s.kind);
const close = (a, b) => Math.abs(a - b) < 1e-12;

// ---------------------------------------------------------------- MvpFlowTest

test('askedForATextRefineStartsByItselfCostsWhatOpenRouterReportedAndKeepsWhatYouSaid', async () => {
  const h = harness({ prefs: { profileWords: '["Jana"]' } });
  h.fx.jev = { refine: 0.95, template: 'none', cost: JEV };
  await h.dictate();
  const e = h.note();
  assert.equal(e.processed, 'Hi Jana, see you at ten.');
  assert.equal(e.original, 'um hi Jana see you at ten');
  assert.equal(e.raw, 'um hi Jana see you at ten');
  assert.equal(e.text, 'Hi Jana, see you at ten.');
  assert.equal(e.version, 'processed');
  assert.equal(h.vault.get('transcript'), 'Hi Jana, see you at ten.');
  // Exactly what was reported: no fee on top.
  assert.equal(e.knownCost, '0.00523'); // Decimal strings, as Android writes them.
  assert.equal(e.steps[0].cost, '0.0012');
  assert.equal(e.unpriced, 0);
  assert.equal(e.unconfirmed, 0);
  assert.equal(e.requests, 1);
  assert.ok(close(e.jevCost, JEV));
  assert.ok(close(e.textCost, TEXT));
  assert.equal(e.textModel, 'anthropic/claude-sonnet-5.5');
  assert.equal(e.status, 'complete');
  // The activity log: speech, Jev's answer, then Refine.
  assert.deepEqual(steps(e), ['speech', 'jev', 'refine']);
  assert.equal(e.steps[0].model, 'microsoft/mai-transcribe-2');
  assert.ok(close(e.steps[0].cost, SPEECH));
  assert.equal(e.steps[1].model, D.JEV_MODEL);
  assert.equal(e.steps[1].answer, 'refine 0.95');
  assert.ok(close(e.steps[1].cost, JEV));
  assert.equal(e.steps[2].provider, 'openrouter');
  assert.ok(!('detail' in e.steps[2]));
  // What went out: WAV audio with the words, Jev with the dictation (no chief, no templates).
  const speech = h.calls.transcribe[0];
  assert.equal(speech.wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(speech.wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(speech.model, 'microsoft/mai-transcribe-2');
  assert.deepEqual(speech.words, ['Jana']);
  assert.deepEqual(h.calls.decide[0], { transcript: 'um hi Jana see you at ten', templates: [], refine: true, chiefName: '' });
  assert.equal(h.calls.refine[0].text, 'um hi Jana see you at ten');
  assert.equal(h.calls.refine[0].template, '');
  // The panel offers Insert refined; nothing touched the clipboard.
  assert.equal(h.d.session.refine, D.DONE);
  assert.equal(h.d.session.message, 'Refined');
  assert.equal(h.clipboard.text, 'something I still need');
  assert.deepEqual(h.calls.insert, []);
});

test('aNamedTemplateGoesToRefine', async () => {
  const h = harness();
  h.fx.templates = ['Weekly update'];
  h.fx.transcripts = ['fill in my weekly update, shipped the panel'];
  h.fx.jev = { refine: 0.2, template: 'Weekly update', cost: JEV };
  h.fx.replies = ['Done: the panel\nNext: tests'];
  await h.dictate();
  assert.equal(h.note().template, 'Weekly update');
  assert.deepEqual(h.calls.decide[0].templates, ['Weekly update']);
  assert.equal(h.calls.refine[0].template, 'Weekly update');
  assert.equal(h.note().steps[1].answer, 'refine 0.20 · Weekly update');
});

test('aDictationWithoutRequestStaysTheTranscript', async () => {
  const h = harness();
  h.fx.transcripts = ['Call Jana tomorrow at ten.'];
  await h.dictate();
  assert.equal(h.vault.get('transcript'), 'Call Jana tomorrow at ten.');
  const e = h.note();
  assert.ok(close(e.knownCost, SPEECH + JEV));
  assert.ok(!('processed' in e));
  assert.equal(h.calls.refine.length, 0);
  assert.equal(h.d.session.refine, D.IDLE);
  assert.equal(h.d.session.message, '');
  assert.equal(h.d.detail, 'Your text is ready to insert');
});

test('withBothSwitchesOffJevIsntAskedAndNothingStarts', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  await h.dictate();
  assert.equal(h.vault.get('transcript'), 'um hi Jana see you at ten');
  assert.ok(close(h.note().knownCost, SPEECH));
  assert.equal(h.calls.decide.length, 0);
  assert.equal(h.calls.refine.length, 0);
  assert.ok(h.d.session.decided);
});

test('whenJevFailsOrIsSlowNothingStartsByItself', async () => {
  const h = harness();
  h.fx.transcripts = ['make this an email'];
  h.fx.jev = new Error('Jev is unavailable right now.');
  await h.dictate();
  let e = h.note();
  assert.deepEqual(steps(e), ['speech', 'jev']);
  assert.equal(e.steps[1].detail, 'Jev is unavailable right now.');
  assert.ok(!('processed' in e));
  assert.equal(h.calls.refine.length, 0);
  assert.ok(h.d.session.decided);
  // Slower than Jev's timeout counts as no answer, too (the adapter's call throws a timeout).
  h.d.close();
  const { TimeoutError } = require('../src/core/util');
  h.fx.jev = Promise.reject(new TimeoutError('Jev took longer than 3 s.'));
  h.fx.jev.catch(() => {});
  await h.dictate();
  e = h.note();
  assert.equal(e.steps[e.steps.length - 1].kind, 'jev');
  assert.ok(e.steps[e.steps.length - 1].detail);
  assert.ok(!('processed' in e));
  assert.equal(h.calls.refine.length, 0);
});

test('failedProcessingStillDeliversWhatYouSaid', async () => {
  const h = harness();
  h.fx.jev = { refine: 0.95, template: 'none', cost: JEV };
  h.fx.replies = [new Error('The text model is overloaded. Try again.'), 'Hi Jana, see you at ten.'];
  await h.dictate();
  let e = h.note();
  assert.equal(e.processingFailed, 'The text model is overloaded. Try again.');
  assert.equal(e.steps[2].detail, 'The text model is overloaded. Try again.');
  assert.equal(e.steps[2].model, 'anthropic/claude-sonnet-5.5');
  assert.equal(h.vault.get('transcript'), 'um hi Jana see you at ten');
  assert.equal(h.d.session.refine, D.FAILED);
  assert.equal(h.d.session.message, "Couldn't refine: The text model is overloaded. Try again.");
  assert.equal(h.panel().buttons.find((b) => b.id === 'refine').label, '✨ ↻');
  // ✨ ↻ tries again.
  h.d.tapRefine();
  assert.equal(h.d.session.refine, D.RUNNING);
  await h.d.idle();
  e = h.note();
  assert.equal(h.d.session.refine, D.DONE);
  assert.equal(e.processed, 'Hi Jana, see you at ten.');
  assert.ok(!('processingFailed' in e));
  assert.equal(h.d.session.refined, 'Hi Jana, see you at ten.');
});

test('anUnknownCostIsNeverShownAsFree', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  h.fx.speechCost = null;
  await h.dictate();
  const e = h.note();
  assert.equal(e.unpriced, 1);
  assert.equal(e.knownCost, '0');
  assert.ok(!('cost' in e.steps[0]));
});

test('usedUpCreditsKeepTheRecording', async () => {
  const h = harness();
  h.fx.transcribeError = new Error('Your OpenRouter credits are used up. Add credits, then retry.');
  await h.d.start();
  h.mic.speak(1200);
  await h.d.stop();
  assert.equal(h.d.state, D.ERROR);
  assert.match(h.d.detail, /credits are used up/);
  assert.ok(h.pending.exists());
  assert.ok(h.d.hasSavedRecording());
  const e = h.latest();
  assert.equal(e.status, 'needs attention');
  assert.equal(e.unconfirmed, 1); // A lost response stays an explicit unknown charge.
  assert.match(e.steps[0].detail, /credits are used up/);
  // A new recording waits until the saved one is retried or discarded.
  await h.d.start();
  assert.equal(h.d.state, D.ERROR);
  assert.equal(h.d.detail, 'A saved recording needs retry or discard first.');
  // Retry, with credits again: the same note completes.
  h.fx.transcribeError = null;
  await h.d.retry();
  assert.equal(h.d.state, D.COPIED);
  assert.equal(h.notes.size, 1);
  assert.equal(h.note().status, 'complete');
  assert.ok(!h.pending.exists());
});

test('withoutAKeyNothingIsRecorded', async () => {
  const h = harness();
  h.fx.key = false;
  await h.d.start();
  assert.equal(h.d.state, D.ERROR);
  assert.match(h.d.detail, /OpenRouter key/);
  assert.equal(h.mic.starts, 0);
  assert.ok(!h.d.busy());
  assert.ok(!h.pending.exists());
  assert.equal(h.panel().mode, 'message');
  h.advance(D.FEEDBACK_MS);
  assert.equal(h.panel().mode, 'hidden');
});

test('pastedTextGoesWithTheRequestAndStaysWithTheNote', async () => {
  const h = harness({ attached: [{ kind: 'text', name: 'pasted' }] });
  h.fx.transcripts = ['write a short application for this flat'];
  h.fx.jev = { refine: 0.97, template: 'none', cost: JEV };
  h.fx.replies = ['Application for Hauptstraße 5.'];
  await h.d.start();
  assert.equal(h.panel().buttons.find((b) => b.id === 'attach').label, '📎 1');
  h.mic.speak(1000);
  await h.d.stop();
  await h.d.idle();
  const e = h.note();
  assert.equal(e.attached, 1);
  assert.equal(h.vault.get('transcript'), 'Application for Hauptstraße 5.');
  assert.deepEqual(h.d.attachments.claimed, { id: e.id, n: 1 });
  // Refine gets the note's attachments (by its recording).
  assert.equal(h.calls.refine[0].recordingId, e.id);
});

// ---------------------------------------------------------------- PanelTest

test('insertPutsTheTranscriptAtTheCursorThenRefinedReplacesItInPlace', async () => {
  const h = harness();
  h.fx.transcripts = ['um so see you at ten I mean eleven'];
  h.fx.jev = { refine: 0.93, template: 'none', cost: JEV };
  h.fx.replies = ['See you at eleven.'];
  h.fx.field = { text: 'Hi Jana, ' };
  await h.d.start();
  let p = h.panel();
  assert.equal(p.mode, 'recording');
  assert.equal(p.buttons[0].name, 'Stop recording');
  assert.ok(p.buttons.some((b) => b.name === '✨ Refine'));
  h.mic.speak(1200);
  await h.d.stop();
  assert.equal(h.panel().buttons[0].name, 'Insert');
  await h.d.insert();
  assert.equal(h.fx.field.text, 'Hi Jana, um so see you at ten I mean eleven');
  await h.d.idle();
  assert.equal(h.d.session.message, 'Refined');
  // Refine started by itself (Jev 0.93) and its button became Insert refined.
  p = h.panel();
  assert.equal(p.buttons.find((b) => b.id === 'refine').name, 'Insert refined');
  await h.d.tapRefine();
  assert.equal(h.fx.field.text, 'Hi Jana, See you at eleven.');
  assert.equal(h.d.session.message, 'Replaced with the refined text');
  // Inserting, refining and replacing never touched the clipboard.
  assert.equal(h.clipboard.text, 'something I still need');
  assert.equal(h.note().processed, 'See you at eleven.');
  assert.equal(h.note().original, 'um so see you at ten I mean eleven');
});

test('insertMessageSaysInsertedOrThatAPasteLeftItOnTheClipboard', async () => {
  const h = harness({ prefs: { autoRefine: false } });
  await h.dictate();
  await h.d.insert();
  assert.equal(h.d.session.message, 'Inserted');
  h.fx.insert = 'pasted';
  await h.d.insert();
  assert.equal(h.d.session.message, "Inserted · this app only takes pastes, so it's on the clipboard too");
});

test('editedMeanwhileTheRefinedTextGoesAtTheCursorInstead', async () => {
  const h = harness();
  h.fx.transcripts = ['see you at ten'];
  h.fx.replies = ['See you at 10.'];
  h.fx.field = { text: '' };
  await h.dictate();
  await h.d.insert();
  assert.equal(h.fx.field.text, 'see you at ten');
  // Text around it doesn't matter: the transcript is still there, unchanged.
  h.fx.field.text = 'Ok, see you at ten, then';
  h.d.tapRefine();
  await h.d.idle();
  await h.d.tapRefine();
  assert.equal(h.fx.field.text, 'Ok, See you at 10., then');
  // Changed by hand: the refined text goes at the cursor instead.
  h.fx.field.text = 'see you at 10 then';
  await h.d.tapRefine();
  assert.equal(h.fx.field.text, 'see you at 10 thenSee you at 10.');
  assert.equal(h.d.session.message, 'Inserted');
});

test('refineChosenWhileRecordingRunsOnceTheTranscriptIsReady', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  h.fx.transcripts = ['hello there'];
  const gate = deferred();
  h.fx.replies = [gate.promise];
  await h.d.start();
  h.d.tapRefine();
  assert.equal(h.d.session.refine, D.QUEUED);
  assert.equal(h.panel().buttons.find((b) => b.id === 'refine').name, '✨ Refine ✓');
  assert.equal(h.calls.transcribe.length + h.calls.refine.length, 0);
  h.mic.speak(800);
  await h.d.stop();
  await waitFor(() => h.calls.refine.length === 1);
  assert.equal(h.d.session.refine, D.RUNNING);
  assert.equal(h.panel().buttons.find((b) => b.id === 'refine').name, '✨ Refining…');
  gate.resolve('Hello there!');
  await h.d.idle();
  assert.equal(h.panel().buttons.find((b) => b.id === 'refine').name, 'Insert refined');
  assert.equal(h.note().processed, 'Hello there!');
});

test('choicesWhileRecordingTapAgainUndoes', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  h.fx.chief = true;
  await h.d.start();
  h.d.tapRefine();
  h.d.tapChief();
  assert.equal(h.panel().buttons.find((b) => b.id === 'chief').label, '🧑‍💼 ✓');
  h.d.tapRefine();
  h.d.tapChief();
  assert.equal(h.d.session.refine, D.IDLE);
  assert.equal(h.d.session.chief, D.IDLE);
  h.mic.speak(600);
  await h.d.stop();
  await h.d.idle();
  assert.equal(h.calls.refine.length, 0);
  assert.equal(h.calls.chief.length, 0);
});

test('withoutTheServiceInsertCopiesInstead', async () => {
  const h = harness({ prefs: { autoRefine: false } });
  h.fx.transcripts = ['copy me please'];
  h.fx.insert = 'permission';
  await h.dictate();
  await h.d.insert();
  assert.match(h.d.session.message, /^Copied instead, paste with ⌘V\. Insert needs the Accessibility permission/);
  assert.equal(h.clipboard.text, 'copy me please');
  // The app refused: copied by the panel, which says so.
  h.fx.insert = null;
  h.clipboard.text = '';
  await h.d.insert();
  assert.equal(h.d.session.message, 'Copied instead, paste with ⌘V');
  assert.equal(h.clipboard.text, 'copy me please');
  assert.equal(h.panel().status, 'Copied instead, paste with ⌘V');
  // The app went away mid-way: copied, too.
  h.fx.insert = 'throw';
  h.clipboard.text = '';
  await h.d.insert();
  assert.equal(h.clipboard.text, 'copy me please');
});

test('cancelWhileRecordingThrowsItAwayAndCostsNothing', async () => {
  const h = harness({ attached: [{ kind: 'text' }] });
  await h.d.start();
  h.mic.speak(800);
  // ✕ on the outer edge: right of every other button.
  const p = h.panel();
  assert.equal(p.buttons[p.buttons.length - 1].name, 'Cancel: nothing is transcribed or sent');
  await h.d.close();
  assert.equal(h.d.state, D.READY);
  assert.equal(h.panel().mode, 'hidden');
  assert.equal(h.calls.transcribe.length + h.calls.decide.length + h.calls.refine.length, 0);
  assert.ok(!h.pending.exists());
  assert.equal(h.notes.size, 0);
  assert.equal(h.d.attachments.pendingCount(), 0);
  assert.deepEqual(h.calls.notices, ['Cancelled. Nothing was transcribed or sent.']);
  assert.equal(h.prefs.get('sessionId', ''), '');
});

test('closeHidesThePanelAndTheNoteStays', async () => {
  const h = harness();
  h.fx.transcripts = ['a note to keep'];
  await h.dictate();
  const p = h.panel();
  assert.equal(p.buttons[0].id, 'insert');
  assert.equal(p.buttons[p.buttons.length - 1].name, 'Close');
  await h.d.close();
  assert.equal(h.panel().mode, 'hidden');
  assert.equal(h.latest().text, 'a note to keep');
});

/** bb with its chief, and the chief's name. */
function withChief(h) {
  h.fx.chief = true;
  h.prefs.set('chiefName', 'Henry');
}

test('theChiefsTextBackAppearsInThePanelAndInserts', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ["Henry, write Tom that I'm running late"];
  h.fx.jev = { refine: 0.3, template: 'none', chief: 0.96, cost: JEV };
  h.fx.field = { text: '' };
  await h.dictate();
  assert.equal(h.panel().buttons.find((b) => b.id === 'chief').name, 'Open chat ↗');
  const request = h.note().chiefRequest;
  assert.ok(request);
  // The panel listens to the topic from the moment it was sent (5 s earlier, in seconds).
  assert.equal(h.calls.listen.length, 1);
  assert.equal(h.calls.listen[0].request, request);
  assert.equal(h.calls.listen[0].since, Math.floor(h.note().chiefSent / 1000) - 5);
  // Waiting for the chief's text: the panel stays five minutes.
  assert.equal(h.timers.pending(), D.PANEL_WAIT_MS);
  h.calls.listen[0].onText("Hi Tom, I'm running about ten minutes late.");
  assert.equal(h.d.session.message, 'Your chief of staff sent text to insert');
  assert.ok(h.calls.listen[0].stopped);
  const p = h.panel();
  assert.equal(p.extra.length, 1);
  assert.equal(p.extra[0].name, 'Insert from chief');
  await h.d.insertFromChief();
  assert.equal(h.fx.field.text, "Hi Tom, I'm running about ten minutes late.");
  await h.d.idle();
  assert.equal(h.note().chiefReply, "Hi Tom, I'm running about ten minutes late.");
  // Open chat ↗ opens the thread.
  h.d.tapChief();
  assert.deepEqual(h.calls.links, [CHIEF_LINK]);
});

test('refineThenChiefWrapsWholeButtonsInsteadOfSqueezingThem', async () => {
  // The panel's layout is the renderer's; here: the chief got what was said, not the refined text.
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['sag Tom, dass ich mich verspäte, und mach es höflich'];
  h.fx.jev = { refine: 0.1, template: 'none', chief: 0.2, cost: JEV };
  h.fx.replies = ['Hallo Tom, ich verspäte mich etwas. Entschuldige!'];
  await h.dictate();
  h.d.tapRefine();
  await h.d.idle();
  assert.equal(h.d.session.refine, D.DONE);
  h.d.tapChief();
  await h.d.idle();
  const p = h.panel();
  assert.deepEqual(
    p.buttons.map((b) => b.name),
    ['Insert', 'Insert refined', 'Open chat ↗', 'Close'],
  );
  assert.equal(h.calls.chief[0].text, 'sag Tom, dass ich mich verspäte, und mach es höflich');
  assert.equal(h.calls.chief[0].request, h.note().chiefRequest);
  // A Refine you tapped isn't dropped for the chief.
  assert.equal(h.d.session.refine, D.DONE);
});

test('aVolumeKeyStartAfterAnotherDictationShowsTheRecordingPanel', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  h.fx.transcripts = ['the first one', 'the second one'];
  await h.d.toggle();
  h.mic.speak(600);
  await h.d.toggle();
  assert.equal(h.d.state, D.COPIED);
  assert.equal(h.panel().buttons[0].name, 'Insert');
  await h.d.toggle();
  assert.equal(h.d.state, D.RECORDING);
  const p = h.panel();
  assert.equal(p.buttons[0].name, 'Stop recording');
  assert.ok(p.buttons.some((b) => b.name === '✨ Refine'));
  h.mic.speak(600);
  await h.d.toggle();
  assert.equal(h.d.state, D.COPIED);
  assert.equal(h.d.session.transcript, 'the second one');
  assert.equal(h.notes.size, 2);
});

test('theHotkeyDoesNothingWhileTranscribing', async () => {
  const h = harness();
  const gate = deferred();
  h.fx.jev = gate.promise;
  await h.d.start();
  h.mic.speak(400);
  let release;
  const held = new Promise((r) => (release = r));
  const transcribe = h.d.transcribeChunk;
  h.d.transcribeChunk = async (...a) => {
    await held;
    return transcribe(...a);
  };
  const stopping = h.d.toggle();
  await waitFor(() => h.d.state === D.UPLOADING);
  assert.equal(h.panel().mode, 'processing');
  assert.deepEqual(
    h.panel().buttons.map((b) => [b.id, b.label, b.enabled]),
    [
      ['insert', '…', false],
      ['refine', '✨', true],
    ],
  );
  await h.d.toggle();
  assert.equal(h.mic.starts, 1);
  release();
  await stopping;
  gate.resolve({ refine: 0 });
  await h.d.idle();
  assert.equal(h.d.state, D.COPIED);
});

// ---------------------------------------------------------------- ControlsTest

test('smallRecordingIconCanBeHiddenWithoutStoppingCapture', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  h.fx.transcripts = ['Quick Settings works.'];
  await h.d.toggle();
  assert.equal(h.panel().mode, 'recording');
  h.d.hide();
  assert.equal(h.panel().mode, 'hidden');
  assert.ok(h.d.busy());
  h.mic.speak(600);
  await h.d.toggle();
  assert.equal(h.d.state, D.COPIED);
  // Without the panel, a notice says what it would show.
  assert.deepEqual(h.calls.notices, ['Your text is ready to insert']);
  assert.equal(h.vault.get('transcript'), 'Quick Settings works.');
  assert.ok(!h.pending.exists());
});

// ---------------------------------------------------------------- BbFlowTest (the dictation parts)

test('sayingItsForTheChiefByNameSendsItThereInsteadOfRefining', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['Okay, so I want to talk to Henry about the hotel booking'];
  h.fx.jev = { refine: 0.92, template: 'none', chief: 0.97, cost: JEV };
  h.fx.replies = ['Should not be refined.'];
  await h.dictate();
  assert.equal(h.d.session.chief, D.DONE);
  assert.equal(h.calls.refine.length, 0);
  assert.equal(h.d.session.refine, D.IDLE);
  assert.equal(h.calls.decide[0].chiefName, 'Henry');
  assert.equal(h.calls.chief[0].text, 'Okay, so I want to talk to Henry about the hotel booking');
  assert.equal(h.calls.chief[0].chiefId, CHIEF);
  assert.equal(h.d.session.message, 'Sent to your chief of staff');
  assert.equal(h.panel().buttons.find((b) => b.id === 'chief').label, '🧑‍💼 ↗');
});

test('theNameOnlyMentionedInTheMessageStaysHere', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['hey Tom, Henry will send you the contract tomorrow'];
  h.fx.jev = { refine: 0.05, template: 'none', chief: 0.04, cost: JEV };
  await h.dictate();
  assert.equal(h.calls.decide[0].chiefName, 'Henry');
  assert.equal(h.d.session.chief, D.IDLE);
  assert.equal(h.d.session.hint, false);
  assert.equal(h.calls.chief.length, 0);
});

test('withoutTheNameTheChiefIsntAskedAbout', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['chief of staff, book a table for four'];
  h.fx.jev = { refine: 0.05, template: 'none', chief: 0.99, cost: JEV };
  await h.dictate();
  assert.equal(h.calls.decide[0].chiefName, '');
  assert.equal(h.d.session.chief, D.IDLE);
  assert.equal(h.d.session.hint, false);
  assert.equal(h.calls.chief.length, 0);
});

test('whenJevFailsWithTheNameChiefIsOnlySuggested', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['Henry, book a table for four'];
  h.fx.jev = new Error('provider');
  await h.dictate();
  assert.equal(h.d.session.chief, D.IDLE);
  assert.equal(h.d.session.hint, true);
  assert.equal(h.calls.chief.length, 0);
  const chief = h.panel().buttons.find((b) => b.id === 'chief');
  assert.equal(chief.name, 'Chief, suggested: this may be a task for your chief of staff');
  assert.equal(chief.ring, 'amber');
});

test('tappingChiefWhileJevsRefineRunsDropsTheRefine', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['um so the hotel booking for Lisbon, can you sort that out'];
  h.fx.jev = { refine: 0.9, template: 'none', cost: JEV };
  const gate = deferred();
  h.fx.replies = [gate.promise];
  await h.d.start();
  h.mic.speak(600);
  await h.d.stop();
  await waitFor(() => h.d.session.refine === D.RUNNING);
  h.d.tapChief();
  assert.equal(h.d.session.refine, D.IDLE);
  await waitFor(() => h.d.session.chief === D.DONE);
  gate.resolve('Refined, should be dropped.'); // The refine call ends and is ignored.
  await h.d.idle();
  assert.equal(h.d.session.refine, D.IDLE);
  const e = h.note();
  assert.equal(e.version, 'original');
  assert.equal(e.text, 'um so the hotel booking for Lisbon, can you sort that out');
  assert.equal(e.processed, 'Refined, should be dropped.'); // Stays a version.
  assert.ok(!h.calls.chief[0].text.includes('should be dropped'));
  assert.equal(h.panel().buttons.find((b) => b.id === 'chief').name, 'Open chat ↗');
});

test('addressedExplicitlyTheTaskGoesToTheChiefWithThePastedText', async () => {
  const h = harness({ attached: [{ kind: 'text', name: 'Flights' }] });
  withChief(h);
  h.fx.transcripts = ['Henry, find the cheapest of these flights'];
  h.fx.jev = { refine: 0.05, template: 'none', chief: 0.97, cost: JEV };
  await h.dictate();
  assert.equal(h.calls.refine.length, 0);
  assert.equal(h.calls.chief.length, 1);
  const e = h.note();
  assert.equal(h.calls.chief[0].recordingId, e.id); // Its attachments go along.
  assert.equal(h.calls.chief[0].request, e.chiefRequest);
  assert.equal(e.chiefThread, CHIEF);
  assert.equal(e.chiefLink, CHIEF_LINK);
  assert.equal(e.route, 'chief');
  assert.ok(!('chiefFailed' in e));
  assert.ok(close(e.knownCost, SPEECH + JEV));
  const bb = e.steps[e.steps.length - 1];
  assert.equal(bb.kind, 'bb');
  assert.equal(bb.model, 'chief of staff');
  assert.ok(!('cost' in bb));
  assert.ok(!('detail' in bb));
  assert.equal(e.steps[e.steps.length - 2].answer, 'refine 0.05 · chief 0.97');
  // Nothing was copied by itself.
  assert.equal(h.clipboard.text, 'something I still need');
});

test('unsureAboutTheNameItIsNotSentButChiefIsSuggested', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['Henry could look into why the nightly build failed'];
  h.fx.jev = { refine: 0.05, template: 'none', chief: 0.62, cost: JEV };
  await h.dictate();
  assert.equal(h.d.session.hint, true);
  assert.equal(h.d.session.chief, D.IDLE);
  assert.equal(h.calls.chief.length, 0);
  // One tap sends it.
  h.d.tapChief();
  await h.d.idle();
  assert.equal(h.calls.chief.length, 1);
  assert.equal(h.d.session.chief, D.DONE);
});

test('belowTheHintTheChiefButtonIsPlain', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['Henry could look into it'];
  h.fx.jev = { refine: 0.05, template: 'none', chief: 0.49, cost: JEV };
  await h.dictate();
  assert.equal(h.d.session.hint, false);
  // Sure, but sending by itself is off: only suggested.
  const h2 = harness({ prefs: { autoChief: false } });
  withChief(h2);
  h2.fx.transcripts = ['Henry, book it'];
  h2.fx.jev = { refine: 0.05, template: 'none', chief: 0.99, cost: JEV };
  await h2.dictate();
  assert.equal(h2.d.session.chief, D.IDLE);
  assert.equal(h2.d.session.hint, true);
});

test('chosenWhileRecordingTheChiefGetsItOnceTheTranscriptIsReady', async () => {
  const h = harness();
  withChief(h);
  h.fx.transcripts = ['the build is red again'];
  await h.d.start();
  h.d.tapChief();
  assert.equal(h.panel().buttons.find((b) => b.id === 'chief').name, '🧑‍💼 Chief ✓');
  assert.equal(h.calls.chief.length, 0);
  h.mic.speak(600);
  await h.d.stop();
  await h.d.idle();
  assert.equal(h.calls.chief[0].text, 'the build is red again');
});

test('whenBbFailsTheNoteKeepsWhatYouSaidAndSendsAgain', async () => {
  const h = harness();
  withChief(h);
  h.fx.chiefError = new Error("bb isn't reachable right now (HTTP 503).");
  h.fx.transcripts = ['Henry, book the table for Friday'];
  h.fx.jev = { refine: 0, template: 'none', chief: 0.95, cost: JEV };
  await h.dictate();
  let e = h.note();
  assert.match(e.chiefFailed, /isn't reachable right now \(HTTP 503\)/);
  assert.match(e.steps[e.steps.length - 1].detail, /HTTP 503/);
  assert.equal(h.d.session.chief, D.FAILED);
  // Kept and queued: the outbox sends it again by itself, with the same request ID.
  assert.equal(e.chiefQueued, true);
  assert.equal(e.chiefTries, 1);
  assert.equal(e.chiefRequest, h.calls.chief[0].request);
  assert.match(h.d.session.message, /^Not sent yet: .* It's kept and goes by itself once bb can be reached\.$/);
  assert.equal(h.panel().buttons.find((b) => b.id === 'chief').name, '🧑‍💼 Send again');
  assert.equal(h.clipboard.text, 'something I still need');
  // Send again.
  h.fx.chiefError = null;
  h.d.tapChief();
  await h.d.idle();
  e = h.note();
  assert.ok(!('chiefFailed' in e));
  assert.ok(!('chiefQueued' in e));
  assert.equal(e.chiefTries, 1); // It says it took a second try.
  assert.equal(e.chiefLink, CHIEF_LINK);
  assert.equal(h.calls.chief[1].text, 'Henry, book the table for Friday');
  // The same request, and bb checks first whether the first try arrived after all.
  assert.equal(h.calls.chief[1].request, h.calls.chief[0].request);
  assert.equal(h.calls.chief[1].again, true);
  assert.equal(h.calls.chief[0].again, false);
  assert.equal(h.d.session.chief, D.DONE);
  // An error that wasn't written for the user reads as bb unreachable.
  const h2 = harness();
  withChief(h2);
  h2.fx.chiefError = new TypeError('fetch failed');
  h2.fx.jev = { refine: 0, chief: 0, cost: JEV };
  await h2.dictate();
  h2.d.tapChief();
  await h2.d.idle();
  assert.equal(h2.note().chiefFailed, "bb couldn't be reached. Try again.");
});

test('withoutAChiefJevIsNotAskedAboutIt', async () => {
  const h = harness();
  h.prefs.set('chiefName', 'Henry');
  h.fx.transcripts = ['tell Henry, my chief of staff, to call the plumber'];
  h.fx.jev = { refine: 0, template: 'none', chief: 0.99, cost: JEV };
  await h.dictate();
  assert.equal(h.calls.decide[0].chiefName, '');
  assert.equal(h.calls.chief.length, 0);
  assert.ok(!h.panel().buttons.some((b) => b.id === 'chief'));
  // Tapping it anyway (no button, but the action) says how to set it up.
  h.d.tapChief();
  assert.equal(h.d.session.message, 'Set up your chief of staff in Dictate & Delegate → Settings → bb.');
});

// ---------------------------------------------------------------- the panel stays, then goes

test('thePanelHidesAfterAMinuteOrFiveWhileRefineRunsOrTheChiefsTextIsAwaited', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  await h.dictate();
  assert.equal(h.timers.pending(), D.PANEL_IDLE_MS);
  h.advance(D.PANEL_IDLE_MS - 1000);
  h.d.touch(); // A tap or drag: another minute.
  h.advance(D.PANEL_IDLE_MS - 1000);
  assert.equal(h.panel().mode, 'result');
  h.advance(1000);
  assert.equal(h.panel().mode, 'hidden');

  const r = harness({ prefs: { autoChief: false } });
  r.fx.jev = { refine: 0.9, cost: JEV };
  const gate = deferred();
  r.fx.replies = [gate.promise];
  await r.d.start();
  r.mic.speak(400);
  await r.d.stop();
  await waitFor(() => r.d.session.refine === D.RUNNING);
  assert.equal(r.timers.pending(), D.PANEL_WAIT_MS);
  r.advance(D.PANEL_IDLE_MS + 1000);
  assert.equal(r.panel().mode, 'result');
  gate.resolve('Done.');
  await r.d.idle();
  assert.equal(r.timers.pending(), D.PANEL_IDLE_MS); // Refined: back to a minute.
  // Hidden while the chief's text was awaited: the listener stops.
  const c = harness();
  withChief(c);
  c.fx.transcripts = ['Henry, draft it'];
  c.fx.jev = { refine: 0, chief: 0.99, cost: JEV };
  await c.dictate();
  assert.equal(c.timers.pending(), D.PANEL_WAIT_MS);
  c.advance(D.PANEL_WAIT_MS);
  assert.equal(c.panel().mode, 'hidden');
  assert.ok(c.calls.listen[0].stopped);
});

test('errorsAndNoSpeechShowBrieflyThenGo', async () => {
  const h = harness();
  h.fx.transcripts = ['   '];
  await h.d.start();
  h.mic.speak(400);
  await h.d.stop();
  assert.equal(h.d.state, D.EMPTY);
  assert.equal(h.d.detail, 'No speech recognized. Ready to record again.');
  assert.equal(h.latest().status, 'no speech');
  assert.ok(!h.pending.exists());
  const p = h.panel();
  assert.equal(p.mode, 'message');
  assert.equal(p.icon.name, 'No speech recognized');
  h.advance(D.FEEDBACK_MS);
  assert.equal(h.panel().mode, 'hidden');
  // Stopped before any audio came: nothing to transcribe.
  await h.d.start();
  await h.d.stop();
  assert.equal(h.d.state, D.EMPTY);
  assert.equal(h.d.detail, 'No audio captured. Ready to try again.');
});

// ---------------------------------------------------------------- Mac: Insert automatically

test('autoInsertInsertsTheTranscriptAsSoonAsItIsReady', async () => {
  const h = harness({ prefs: { autoInsert: true } });
  h.fx.field = { text: '' };
  await h.dictate();
  assert.equal(h.fx.field.text, 'um hi Jana see you at ten');
  assert.equal(h.d.session.message, 'Inserted');
  assert.equal(h.calls.insert.length, 1);
  // Off (the default, as on Android): nothing is inserted by itself.
  const off = harness();
  off.fx.field = { text: '' };
  await off.dictate();
  assert.equal(off.calls.insert.length, 0);
});

test('autoInsertWaitsForRefineAndInsertsTheRefinedText', async () => {
  // Started by Jev.
  const h = harness({ prefs: { autoInsert: true } });
  h.fx.jev = { refine: 0.95, cost: JEV };
  h.fx.field = { text: '' };
  await h.dictate();
  assert.deepEqual(h.calls.insert, ['Hi Jana, see you at ten.']);
  assert.equal(h.fx.field.text, 'Hi Jana, see you at ten.');
  // Chosen while recording.
  const t = harness({ prefs: { autoInsert: true, autoRefine: false, autoChief: false } });
  t.fx.field = { text: '' };
  await t.d.start();
  t.d.tapRefine();
  t.mic.speak(400);
  await t.d.stop();
  await t.d.idle();
  assert.deepEqual(t.calls.insert, ['Hi Jana, see you at ten.']);
  // Refine fails: the transcript instead.
  const f = harness({ prefs: { autoInsert: true } });
  f.fx.jev = { refine: 0.95, cost: JEV };
  f.fx.replies = [new Error('overloaded')];
  await f.dictate();
  assert.deepEqual(f.calls.insert, ['um hi Jana see you at ten']);
});

test('autoInsertLeavesWhatGoesToTheChiefOut', async () => {
  const h = harness({ prefs: { autoInsert: true } });
  withChief(h);
  h.fx.transcripts = ['Henry, book a table'];
  h.fx.jev = { refine: 0.9, chief: 0.97, cost: JEV };
  await h.dictate();
  assert.equal(h.d.session.chief, D.DONE);
  assert.equal(h.calls.insert.length, 0);
});

// ---------------------------------------------------------------- chunks, recovery, the call

test('aChunkIsCutAtTheQuietestFrameOfItsLastTwoSeconds', () => {
  const pending = new D.MemoryPendingAudio();
  pending.create();
  const seconds = 130;
  const pcm = Buffer.alloc(seconds * D.BYTES_PER_SECOND);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 2000 : -2000, i);
  // A quiet frame 1.5 s before the two-minute mark (frame-aligned within the final two seconds).
  const quiet = D.CHUNK_BYTES - 1.5 * D.BYTES_PER_SECOND;
  pcm.fill(0, quiet, quiet + D.FRAME_BYTES);
  pending.append(pcm);
  const first = D.readChunk(pending, 0);
  assert.equal(first.nextOffset, quiet + D.FRAME_BYTES / 2);
  assert.equal(first.wav.length, 44 + first.nextOffset);
  assert.equal(first.wav.readInt32LE(24), 16000);
  assert.equal(first.wav.readInt32LE(40), first.nextOffset);
  // The rest, no sample dropped.
  const second = D.readChunk(pending, first.nextOffset);
  assert.equal(second.nextOffset, pcm.length);
  assert.equal(first.wav.length - 44 + second.wav.length - 44, pcm.length);
  assert.throws(() => D.readChunk(pending, pcm.length), /no readable audio/);
  // A recording shorter than a chunk is one chunk.
  const short = new D.MemoryPendingAudio();
  short.append(Buffer.alloc(D.BYTES_PER_SECOND * 3));
  assert.equal(D.readChunk(short, 0).nextOffset, D.BYTES_PER_SECOND * 3);
});

test('aLongRecordingIsTranscribedInChunksAndResumesAfterAFailure', async () => {
  const h = harness({ prefs: { autoRefine: false, autoChief: false } });
  h.fx.transcripts = ['first part', 'second part', 'third part'];
  await h.d.start();
  h.mic.speak(250_000); // over two chunks
  let n = 0;
  const transcribe = h.d.transcribeChunk;
  h.d.transcribeChunk = async (...a) => {
    if (++n === 2) throw new Error('The connection to OpenRouter was lost.');
    return transcribe(...a);
  };
  await h.d.stop();
  assert.equal(h.d.state, D.ERROR);
  let e = h.latest();
  assert.equal(e.text, 'first part');
  assert.ok(e.offset > 0 && e.offset <= D.CHUNK_BYTES);
  assert.equal(e.requests, 1);
  assert.equal(e.unconfirmed, 1);
  // Retry goes on from the checkpoint; the speech step adds up.
  await h.d.retry();
  assert.equal(h.d.state, D.COPIED);
  e = h.latest();
  assert.equal(e.text, 'first part\nsecond part\nthird part');
  assert.equal(e.requests, 3);
  assert.equal(h.calls.transcribe.length, 3);
  assert.ok(close(e.knownCost, 3 * SPEECH));
  assert.ok(close(e.duration, 250));
  assert.deepEqual(steps(e), ['speech', 'speech']); // The failed chunk's step keeps its error.
  assert.match(e.steps[0].detail, /connection/);
});

test('anInterruptedRecordingIsFoundAtStartAndCanBeRetriedOrDiscarded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  try {
    const file = path.join(dir, 'pending.pcm');
    const first = harness({ pending: new D.FilePendingAudio(file), prefs: { autoRefine: false, autoChief: false } });
    await first.d.start();
    first.mic.speak(1000);
    await first.d.destroy(); // The app quit mid-recording.
    assert.equal(fs.statSync(file).size, D.BYTES_PER_SECOND);

    const again = harness({ pending: new D.FilePendingAudio(file), prefs: { ...first.prefs.all() } });
    again.fx.transcripts = ['saved words'];
    assert.equal(again.d.state, D.ERROR);
    assert.equal(again.d.detail, 'Saved recording found. Open Dictate & Delegate to retry or discard.');
    assert.ok(again.d.hasSavedRecording());
    await again.d.retry();
    assert.equal(again.d.state, D.COPIED);
    assert.equal(again.d.session.transcript, 'saved words');
    assert.equal(again.calls.transcribe[0].wav.length, 44 + D.BYTES_PER_SECOND);
    assert.ok(!fs.existsSync(file));

    const third = harness({ pending: new D.FilePendingAudio(file) });
    await third.d.start();
    third.mic.speak(500);
    await third.d.destroy();
    const discard = harness({ pending: new D.FilePendingAudio(file), prefs: { ...third.prefs.all() } });
    await discard.d.discard();
    assert.equal(discard.d.state, D.READY);
    assert.ok(!fs.existsSync(file));
    assert.equal(discard.prefs.get('sessionId', ''), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aMicrophoneFailureKeepsWhatWasRecorded', async () => {
  const h = harness();
  await h.d.start();
  h.mic.speak(400);
  h.mic.onFail(new Error('Microphone was interrupted. Saved audio can be retried.'));
  await waitFor(() => h.d.state === D.ERROR);
  assert.equal(h.d.detail, 'Microphone was interrupted. Saved audio can be retried.');
  assert.ok(h.pending.exists());
  assert.equal(h.calls.transcribe.length, 0);
  // No microphone access: nothing starts.
  const m = harness();
  m.mic.refuse = new Error('Allow microphone access for Dictate & Delegate in System Settings first.');
  await m.d.start();
  assert.equal(m.d.state, D.ERROR);
  assert.match(m.d.detail, /microphone access/);
  assert.ok(!m.pending.exists());
});

test('theCallButtonHandsTheRecordingSoFarToAHandsFreeCall', async () => {
  const h = harness({ attached: [{ kind: 'text' }] });
  withChief(h);
  await h.d.start();
  const p = h.panel();
  assert.deepEqual(
    p.buttons.map((b) => b.id),
    ['stop', 'refine', 'chief', 'call', 'attach', 'close'],
  );
  h.mic.speak(1000);
  await h.d.call();
  assert.equal(h.calls.call.length, 1);
  assert.equal(h.calls.call[0].pcm.length, D.BYTES_PER_SECOND);
  assert.equal(h.d.state, D.READY);
  assert.equal(h.panel().mode, 'hidden');
  // This dictation ends without a note or a transcription.
  assert.equal(h.notes.size, 0);
  assert.equal(h.calls.transcribe.length, 0);
  assert.ok(!h.pending.exists());
  assert.equal(h.d.attachments.pendingCount(), 0);
});

test('theTimerTicksWhileRecording', async () => {
  const h = harness();
  let changes = 0;
  await h.d.start();
  h.d.on('change', () => changes++);
  h.advance(12_400);
  assert.ok(changes >= 12);
  assert.equal(h.panel().timer.label, '● 00:12  ■');
  h.advance(60_000);
  assert.equal(h.panel().timer.elapsed, '01:12');
});

test('theChiefsNameMatchesAsAWordWithMishearingsAndPossessives', () => {
  for (const said of ['Henry, book it', "ask henry's team", 'Henrys plan', 'Henri, please', 'Henrie look', 'HENREY!'])
    assert.ok(D.mentions(said, 'Henry'), said);
  for (const said of ['Henryk is here', 'the henhouse', '']) assert.ok(!D.mentions(said, 'Henry'), said);
  assert.ok(D.mentions('ask the chief-of-staff', 'chief of staff'));
  assert.ok(D.mentions('Jürgen, hilf mir', 'Jürgen'));
  assert.ok(!D.mentions('xJürgen', 'Jürgen'));
  assert.ok(!D.mentions('Henry', ' '));
});

test('costsAddUpExactlyAsDecimalStrings', () => {
  assert.equal(D.sum('0.1', '0.2'), '0.3');
  assert.equal(D.sum('0.00060', 0.00003), '0.00063');
  assert.equal(D.sum('0', 1e-7), '0.0000001');
  assert.equal(D.sum(undefined, '2'), '2');
});

test('jevsDecisionFollowsItsThresholds', () => {
  const a = (refine, chief, template = '') => ({ refine, chief, template, cost: 0 });
  assert.deepEqual(D.jevDecision(null, true, true, true, true), { refine: false, template: '', chief: false, hint: true });
  assert.deepEqual(D.jevDecision(null, true, true, true, false), { refine: false, template: '', chief: false, hint: false });
  assert.equal(D.jevDecision(a(0.5, null), true, true, false, false).refine, true);
  assert.equal(D.jevDecision(a(0.49, null), true, true, false, false).refine, false);
  assert.equal(D.jevDecision(a(0.1, null, 'T'), true, true, false, false).refine, true);
  assert.equal(D.jevDecision(a(0.9, null), false, true, false, false).refine, false);
  const sent = D.jevDecision(a(0.9, 0.8), true, true, true, true);
  assert.deepEqual([sent.chief, sent.refine, sent.hint], [true, false, false]);
  assert.equal(D.jevDecision(a(0, 0.5), true, true, true, true).hint, true);
  assert.equal(D.jevDecision(a(0, 0.79), true, true, true, true).chief, false);
  assert.equal(D.jevDecision(a(0, null), true, true, true, true).hint, true);
});
