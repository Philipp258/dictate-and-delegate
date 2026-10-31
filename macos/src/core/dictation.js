'use strict';
// One dictation at a time: recording, chunked transcription and the floating panel's choices, a
// port of DictationService.java without Android. The transcript always comes first; then the panel
// offers Insert, Refine and Chief. Jev decides what starts by itself: Refine when the dictation
// asks for a text or names a template, the chief only when it was explicitly addressed. Refine and
// Chief can be chosen while recording; they run once the transcript is ready.
//
// Everything outside (microphone, speech model, Jev, the text model, bb, ntfy, inserting, notes)
// comes in as injected functions; see the constructor. The panel draws panelModel(snapshot()).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tr, format, SerialQueue, withTimeout } = require('./util');
const outboxLib = require('./outbox');

// States, as DictationService's (also the "state" a tray or the app may show).
const READY = 'ready',
  RECORDING = 'recording',
  STOPPING = 'stopping',
  UPLOADING = 'uploading',
  COPIED = 'copied',
  ERROR = 'error',
  EMPTY = 'empty';

/** Where Refine and Chief are for this dictation. */
const IDLE = 'idle',
  QUEUED = 'queued',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed';

/** The panel hides after this long without a tap; longer while something is under way. */
const PANEL_IDLE_MS = 60_000,
  PANEL_WAIT_MS = 5 * 60_000;
/** Error and "no speech" show this long, then the panel goes. */
const FEEDBACK_MS = 3500;

// AudioFiles: 16 kHz mono PCM16LE, chunked only after stop, ~2 minutes a chunk.
const RATE = 16000,
  BYTES_PER_SECOND = RATE * 2,
  CHUNK_BYTES = BYTES_PER_SECOND * 120,
  FRAME_BYTES = 640; // 20 ms

// Jev (Jev.java): the thresholds the decision uses.
const JEV_MODEL = '~typesafe/jev-latest',
  JEV_TIMEOUT_MS = 3000,
  REFINE_AT = 0.5,
  CHIEF_AT = 0.8,
  HINT_AT = 0.5;

/** What the activity log calls the chief-of-staff step's target. */
const CHIEF_STEP = 'bb',
  CHIEF_TARGET = 'chief of staff';

// Profile.java: the speech models offered, and the default.
const DEFAULT_MODEL = 'microsoft/mai-transcribe-2';
const OFFERED = new Set([
  'openai/gpt-transcribe',
  'openai/gpt-4o-transcribe',
  'openai/gpt-4o-mini-transcribe',
  'openai/whisper-1',
  'assemblyai/universal-3-5-pro',
  'microsoft/mai-transcribe-2',
  'microsoft/mai-transcribe-1.5',
]);

// Mac: the Android texts say "Tap the bubble"; there's no bubble here, so the idle line names the
// shortcut instead.
const READY_DETAIL = tr('Press your shortcut to record');

/** Dictate & Delegate's own errors: their message is shown as it is (Java's plain IOException). */
class DictationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DictationError';
  }
}

/** A message fit for the panel, as DictationService.friendly. */
function friendly(ex) {
  if (!ex) return tr('Could not complete this action. Check microphone permission, available storage and your saved key, then retry.');
  if (typeof ex === 'string') return ex;
  if (ex instanceof DictationError || typeof ex.friendly === 'string') return ex.friendly || ex.message;
  const code = String(ex.code || (ex.cause && ex.cause.code) || '');
  if (/^(ENOSPC|ENOENT|EACCES|EPERM|EISDIR|EROFS|EIO|EMFILE)$/.test(code) || /ENOSPC/.test(String(ex.message)))
    return tr("Dictate & Delegate couldn't read or write its files. Check available storage, then retry.");
  // Raw network failures carry English from the stack, if anything.
  if (
    ex.name === 'AbortError' ||
    (ex.name === 'TypeError' && /fetch|network|socket/i.test(String(ex.message))) ||
    /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR)/.test(code)
  )
    return tr('The connection to OpenRouter was lost. Check your internet connection, then retry.');
  if (plainMessage(ex)) return ex.message;
  return tr('Could not complete this action. Check microphone permission, available storage and your saved key, then retry.');
}

/** An error whose message was written for the user (a plain Error, an HttpError, a timeout). */
function plainMessage(ex) {
  return (
    !!ex &&
    !!ex.message &&
    (ex instanceof DictationError ||
      ex.constructor === Error ||
      ex.name === 'HttpError' ||
      ex.name === 'TimeoutError')
  );
}

// ------------------------------------------------------------------ audio (AudioFiles)

/** 16 kHz 16-bit mono PCM as a WAV file. */
function wav(pcm) {
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0, 'ascii');
  out.writeInt32LE(36 + pcm.length, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeInt32LE(16, 16);
  out.writeInt16LE(1, 20);
  out.writeInt16LE(1, 22);
  out.writeInt32LE(RATE, 24);
  out.writeInt32LE(BYTES_PER_SECOND, 28);
  out.writeInt16LE(2, 32);
  out.writeInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeInt32LE(pcm.length, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(out, 44);
  return out;
}

/**
 * The next chunk from offset: up to two minutes, cut at the quietest 20 ms frame of its final
 * 2 seconds, without dropping any samples. No silence ever ends a recording; chunking happens only
 * after stop.
 */
function readChunk(pending, offset) {
  const length = pending.length();
  const end = length - (length % 2);
  if (offset < 0 || offset % 2 !== 0 || offset >= end)
    throw new DictationError(tr('Recording contains no readable audio.'));
  let boundary = Math.min(end, offset + CHUNK_BYTES);
  if (boundary < end) {
    const from = boundary - BYTES_PER_SECOND * 2;
    const window = pending.read(from, boundary);
    let best = Infinity,
      bestAt = boundary;
    for (let at = 0; at + FRAME_BYTES <= window.length; at += FRAME_BYTES) {
      let energy = 0;
      for (let i = 0; i < FRAME_BYTES; i += 2) energy += Math.abs(window.readInt16LE(at + i));
      if (energy < best) {
        best = energy;
        bestAt = from + at + FRAME_BYTES / 2;
      }
    }
    boundary = bestAt;
  }
  return { wav: wav(pending.read(offset, boundary)), nextOffset: boundary };
}

function appendText(previous, next) {
  if (!next || next.trim() === '') return previous;
  return previous === '' ? next.trim() : previous + '\n' + next.trim();
}

/** "mm:ss" for the timer. */
function elapsed(millis) {
  const seconds = Math.max(0, Math.floor(millis / 1000));
  return format('%02d:%02d', Math.floor(seconds / 60), seconds % 60);
}

/** The recording in memory (tests). */
class MemoryPendingAudio {
  constructor() {
    this.data = null;
    this.parts = [];
  }
  exists() {
    return this.data !== null || this.parts.length > 0;
  }
  create() {
    this.data = Buffer.alloc(0);
    this.parts = [];
  }
  append(buf) {
    if (this.data === null) this.data = Buffer.alloc(0);
    this.parts.push(Buffer.from(buf));
  }
  flat() {
    if (this.parts.length) {
      this.data = Buffer.concat([this.data || Buffer.alloc(0), ...this.parts]);
      this.parts = [];
    }
    return this.data || Buffer.alloc(0);
  }
  length() {
    return this.flat().length;
  }
  read(start, end) {
    return this.flat().subarray(start, end);
  }
  flush() {}
  remove() {
    this.data = null;
    this.parts = [];
  }
}

/** The recording in a file (pending.pcm), so an interrupted one survives a crash or quit. */
class FilePendingAudio {
  constructor(file) {
    this.file = file;
    this.fd = null;
  }
  exists() {
    return fs.existsSync(this.file);
  }
  create() {
    this.close();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'w', 0o600);
  }
  append(buf) {
    if (this.fd === null) this.fd = fs.openSync(this.file, 'a', 0o600);
    fs.writeSync(this.fd, buf);
  }
  length() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }
  read(start, end) {
    const out = Buffer.alloc(Math.max(0, end - start));
    const fd = fs.openSync(this.file, 'r');
    try {
      let done = 0;
      while (done < out.length) {
        const n = fs.readSync(fd, out, done, out.length - done, start + done);
        if (n <= 0) break;
        done += n;
      }
      return out.subarray(0, done);
    } finally {
      fs.closeSync(fd);
    }
  }
  flush() {
    if (this.fd !== null) fs.fsyncSync(this.fd);
    this.close();
  }
  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* Already closed. */
      }
      this.fd = null;
    }
  }
  remove() {
    this.close();
    fs.rmSync(this.file, { force: true });
  }
}

// ------------------------------------------------------------------ notes (HistoryEntry on plain objects)

// Costs are kept in the note as decimal strings, exactly as the Android app writes them
// ("knownCost": "0.00060"), so a sum never turns into 0.30000000000000004.

/** A cost (Number or decimal string) as a plain decimal string; null stays null. */
function plain(v) {
  if (v === null || v === undefined || v === '') return null;
  let t = typeof v === 'number' ? String(v) : String(v).trim();
  if (/e/i.test(t)) t = Number(t).toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
}

/** a + b as BigDecimal.add does: exact, at the larger of the two scales. */
function sum(a, b) {
  const x = plain(a) || '0',
    y = plain(b) || '0';
  const scale = Math.max((x.split('.')[1] || '').length, (y.split('.')[1] || '').length);
  const big = (t) => {
    const negative = t.startsWith('-');
    const [i, f = ''] = (negative ? t.slice(1) : t).split('.');
    const n = BigInt(i + f.padEnd(scale, '0'));
    return negative ? -n : n;
  };
  const total = big(x) + big(y);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
  const out = scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits;
  return (total < 0n ? '-' : '') + out;
}

function createEntry(id, model, seconds, now) {
  return {
    id,
    created: now,
    model,
    duration: seconds,
    text: '',
    offset: 0,
    knownCost: '0',
    unpriced: 0,
    unconfirmed: 0,
    requests: 0,
    status: 'pending',
  };
}

const recordingIdOf = (e) => e.recordingId || e.id;
const saidOf = (e) => (typeof e.original === 'string' ? e.original : e.text || '');

/** Adds what a call cost; null: it reported nothing (the note's cost is then incomplete). */
function charge(e, cost) {
  if (plain(cost) === null) e.unpriced = (e.unpriced || 0) + 1;
  else e.knownCost = sum(e.knownCost, cost);
}

/** Adds to a cost kept apart ("textCost", "jevCost"); null adds nothing. */
function addCost(e, key, cost) {
  if (plain(cost) !== null) e[key] = sum(e[key], cost);
}

/** One step of the activity log; the speech chunks of one recording add up to one step. */
function addStep(e, kind, model, ms, cost, detail) {
  if (!Array.isArray(e.steps)) e.steps = [];
  const last = e.steps[e.steps.length - 1];
  if (kind === 'speech' && last && last.kind === 'speech' && last.model === model && !('detail' in last)) {
    last.ms = (last.ms || 0) + ms;
    if (plain(cost) === null || !('cost' in last)) delete last.cost;
    else last.cost = sum(last.cost, cost);
    if (detail !== null && detail !== undefined) last.detail = detail;
    return last;
  }
  const s = { kind, model, ms };
  if (plain(cost) !== null) s.cost = plain(cost);
  if (detail !== null && detail !== undefined) s.detail = detail;
  e.steps.push(s);
  return s;
}

// ------------------------------------------------------------------ Jev's part (Jev.java)

/**
 * Whether the chief's name comes up: case-insensitive, as a whole word, also with a possessive
 * ("Henry's", "Henrys") and as speech models mishear it ("Henri", "Henrie").
 */
function mentions(dictation, name) {
  if (!dictation || !name || !name.trim()) return false;
  return namePattern(name).test(dictation);
}

function namePattern(name) {
  const n = name.trim().toLowerCase();
  const forms = new Set([n]);
  if (n.endsWith('y')) {
    const stem = n.slice(0, -1);
    forms.add(stem + 'i');
    forms.add(stem + 'ie');
    forms.add(stem + 'ey');
  } else if (n.endsWith('ie')) forms.add(n.slice(0, -2) + 'y');
  else if (n.endsWith('i')) forms.add(n.slice(0, -1) + 'y');
  const quote = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  // Spaces and hyphens in a name match either: "chief of staff", "chief-of-staff".
  const alt = [...forms].map((f) => f.split(/[\s-]+/).map(quote).join('[\\s-]+')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?:'s|’s|s)?(?![\\p{L}\\p{N}])`, 'iu');
}

/** Jev's answers, read as Jev.parse does: anything missing counts as not asked. */
function readAnswers(a) {
  const p = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  return {
    refine: p(a && a.refine),
    template: (a && typeof a.template === 'string' && a.template !== 'none' && a.template) || '',
    chief: p(a && a.chief),
    cost: a ? plain(a.cost) : null,
  };
}

/**
 * What happens by itself (Jev.decide): to the chief only when bb is ready, its name came up and
 * Jev is CHIEF_AT sure; between HINT_AT and CHIEF_AT, or when Jev failed, 🧑‍💼 is only
 * highlighted. What goes to the chief isn't refined by itself.
 */
function jevDecision(a, autoRefine, autoChief, chiefReady, named) {
  const ask = chiefReady && named;
  if (!a) return { refine: false, template: '', chief: false, hint: ask };
  const c = a.chief;
  const chief = ask && autoChief && c !== null && c >= CHIEF_AT;
  const hint = ask && !chief && (c === null || c >= HINT_AT);
  const template = a.template !== '';
  const refine = !chief && autoRefine && (template || (a.refine !== null && a.refine >= REFINE_AT));
  return { refine, template: a.template, chief, hint };
}

/** For Activity: "refine 0.82 · chief 0.03 · Apartment application". */
function jevDetail(a) {
  const parts = [];
  if (a.refine !== null) parts.push(format('refine %.2f', a.refine));
  if (a.chief !== null) parts.push(format('chief %.2f', a.chief));
  if (a.template) parts.push(a.template);
  return parts.join(' · ');
}

/** Six random lowercase letters and digits (ChiefText.requestId). */
function requestId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

// ------------------------------------------------------------------ the controller

function newSession() {
  return {
    noteId: '',
    transcript: '',
    refined: '',
    reply: '',
    refine: IDLE,
    chief: IDLE,
    template: '',
    chiefLink: '',
    request: '',
    message: '',
    /** Jev answered or isn't asked; until then queued choices wait (a template may come). */
    decided: false,
    hint: false,
    redo: false,
    chiefReady: false,
    /** What the last Insert put where (the insert function's result, with its text). */
    inserted: null,
    insertedKind: '',
    /** Refine was started by Jev, not tapped: it yields to the chief. */
    autoRefine: false,
    /** Counts Refine runs; a run whose number is no longer current is ignored when it ends. */
    refineRun: 0,
    /** Mac: Insert automatically waits for this dictation's text (true) or is done/off (false). */
    autoInsert: false,
  };
}

const noop = () => {};
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

class Dictation extends EventEmitter {
  /**
   * Injected (all optional unless marked; async ones may also return plain values):
   *
   * prefs                      settings, get(key, fallback)/set/remove (required). Read: autoRefine,
   *                            autoChief, chiefName, model, profileWords, autoInsert (Mac), bubbleOpacity;
   *                            written: sessionId, recordingId, sessionModel, sessionCreated.
   * microphone                 { start(onFrame(buf), onFail(err)): Promise, stop(): Promise } (required).
   *                            Frames: 16 kHz mono PCM16LE, 20 ms each (Buffer or typed array). start
   *                            throws a friendly Error when there's no permission or no microphone.
   * pending                    where the recording goes: MemoryPendingAudio / FilePendingAudio(file).
   * hasKey()                   whether the OpenRouter key is saved (nothing is recorded without it).
   * transcribe(wav, words, model) → { text, cost }      one chunk, cost in USD or null (required).
   * decide(transcript, { templates, refine, chiefName }) → { refine, template, chief, cost }
   *                            Jev's answers (Jev.ask); throws when it fails or is slower than 3 s.
   * templates()                → the saved template names.
   * refine(text, { template, recordingId }) → { text, cost, model, anthropic, fallback, keyProblem }
   *                            the text model (TextModel.process with the template's prompt, the
   *                            note's attachments, the Refine prompt and the profile context).
   * refineModel()              → the text model's ID, for a failed Refine's step.
   * chiefReady()               → bb connected and a chief set (BbBridge.ready).
   * chiefThread()              → { id, link } of the chief (link: its bb web link), or null.
   * sendToChief(text, { request, recordingId, chiefId }) → { files, how, refused, failed: [] }
   *                            BbBridge.sendRequest with the note's pasted texts and files.
   * waitForChiefText(request, sinceSeconds, onText(text)) → { stop() } | stop function
   *                            the ntfy listener for the chief's text for this request.
   * openLink(url)              opens Open chat ↗ in the browser; throws when it can't.
   * insert(text)               → { how: 'inserted' | 'pasted' | 'copied', clipboard?, reason? }
   *                            at the cursor of the focused field. 'pasted': the app only took a paste
   *                            (clipboard: false if the clipboard was restored afterwards). 'copied':
   *                            it couldn't insert and copied instead (reason: 'permission' without the
   *                            Accessibility permission). null or a throw: the controller copies.
   * replaceInPlace(oldText, newText, earlier) → result like insert's, or null when the inserted text
   *                            isn't in the field unchanged any more (earlier: insert's result).
   * copy(text)                 puts text on the clipboard.
   * loadNote(id) → note|null, saveNote(note)   the notes (HistoryStore), plain objects with the
   *                            Android HistoryEntry keys; costs are Numbers.
   * attachments                { pendingCount(), claimPending(recordingId) → count, clearPending() }
   * openAttach()               the 📎: add context while recording goes on.
   * archiveAudio(recordingId, pending)   keeps the audio for a week (AudioArchive.retain).
   * startCall({ pcm })         📞: hands-free call seeded with the audio so far (Buffer, or null).
   * vault                      { set(name, value) }: "transcript" keeps the last text, as on Android.
   * clock() → ms, timers { setTimeout, clearTimeout }, log(line), uuid() → string, requestId() → string.
   *
   * Events: 'change' (snapshot) on every change; 'notice' (text) where Android shows a toast, e.g.
   * while the panel is hidden; 'notes' (note id) after a note was saved.
   */
  constructor(o = {}) {
    super();
    if (!o.prefs) throw new Error('prefs required');
    this.prefs = o.prefs;
    this.microphone = o.microphone;
    this.pending = o.pending || new MemoryPendingAudio();
    this.hasKey = o.hasKey || (() => true);
    this.transcribeChunk = o.transcribe;
    this.jev = o.decide || null;
    this.templateNames = o.templates || (() => []);
    this.refineText = o.refine;
    this.refineModel = o.refineModel || (() => '');
    this.chiefReady = o.chiefReady || (() => false);
    this.chiefThread = o.chiefThread || (() => null);
    this.sendToChief = o.sendToChief;
    this.waitForChiefText = o.waitForChiefText || null;
    this.openLink = o.openLink || null;
    this.insertAt = o.insert || null;
    this.replaceInPlace = o.replaceInPlace || null;
    this.copyText = o.copy || noop;
    this.loadNote = o.loadNote || (() => null);
    this.saveNote = o.saveNote || noop;
    this.attachments = o.attachments || { pendingCount: () => 0, claimPending: () => 0, clearPending: noop };
    this.openAttach = o.openAttach || noop;
    this.archiveAudio = o.archiveAudio || noop;
    this.startCall = o.startCall || noop;
    this.vault = o.vault || null;
    this.clock = o.clock || (() => Date.now());
    this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    this.log = o.log || noop;
    this.uuid = o.uuid || (() => crypto.randomUUID());
    this.newRequestId = o.requestId || requestId;
    /** The Outbox (failures for the report, sending what's queued); a stand-in without one. */
    this.outbox = o.outbox || { failure: noop, resolved: noop, worked: noop, failuresWaiting: () => 0, waiting: async () => false };
    /** Notes being sent right now: a second send of one (Retry while the outbox tries) waits its turn. */
    this.sendingNotes = new Map();

    this.state = READY;
    this.detail = READY_DETAIL;
    this.session = newSession();
    /** The panel was closed or timed out (Android: no bubble); a new dictation shows it again. */
    this.hidden = false;
    this.started = 0;
    this.starting = false;
    this.capturing = false;
    this.recordFailure = null;
    this.listener = null;
    this.feedbackTimer = null;
    this.tickTimer = null;
    this.destroyed = false;
    this.notesQueue = new SerialQueue();
    this.inserter = new SerialQueue();
    this.work = new Set();

    if (this.pending.exists()) {
      // An interrupted recording: retry() or discard() (the app's recovery offers both).
      this.state = ERROR;
      this.detail = tr('Saved recording found. Open Dictate & Delegate to retry or discard.');
      this.feedbackTimer = this.timers.setTimeout(() => this.finishFeedback(), FEEDBACK_MS);
    }
  }

  // ---------------------------------------------------------------- what the panel sees

  /** Recording, saving or transcribing: no new dictation now. */
  busy() {
    return this.starting || this.state === RECORDING || this.state === STOPPING || this.state === UPLOADING;
  }

  /** A saved recording waits for retry or discard. */
  hasSavedRecording() {
    return !this.busy() && this.pending.exists();
  }

  snapshot() {
    const s = this.session;
    const recording = this.state === RECORDING;
    let attached = 0;
    if (recording)
      try {
        attached = Number(this.attachments.pendingCount()) || 0;
      } catch {
        attached = 0;
      }
    return {
      state: this.state,
      detail: this.detail,
      visible: !this.hidden && this.state !== READY,
      busy: this.busy(),
      elapsedMs: recording ? Math.max(0, this.clock() - this.started) : 0,
      attached,
      opacity: Number(this.prefs.get('bubbleOpacity', 65)),
      chiefAvailable: s.chiefReady || s.chief !== IDLE,
      waitingForChief: s.chief === DONE && !s.reply && this.listener !== null,
      session: {
        noteId: s.noteId,
        transcript: s.transcript,
        refined: s.refined,
        reply: s.reply,
        refine: s.refine,
        chief: s.chief,
        template: s.template,
        chiefLink: s.chiefLink,
        request: s.request,
        message: s.message,
        decided: s.decided,
        hint: s.hint,
        chiefReady: s.chiefReady,
        autoRefine: s.autoRefine,
        insertedKind: s.insertedKind,
      },
    };
  }

  changed() {
    if (!this.destroyed) this.emit('change', this.snapshot());
  }

  /** Resolves once the background work (Jev, Refine, the chief, inserting) has settled (tests). */
  async idle() {
    for (;;) {
      const pending = [...this.work];
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    await this.inserter.idle();
    await this.notesQueue.idle();
  }

  run(task) {
    const p = Promise.resolve()
      .then(task)
      .catch((ex) => this.log('dictation: ' + (ex && ex.stack ? ex.stack : ex)));
    this.work.add(p);
    p.finally(() => this.work.delete(p));
    return p;
  }

  // ---------------------------------------------------------------- the panel's actions

  /** The hotkey, as Android's volume key: stops a recording, else starts one unless busy. */
  toggle() {
    if (this.state === RECORDING) return this.stop();
    if (this.busy()) return Promise.resolve();
    return this.start();
  }

  /** ✕: cancels while recording, else closes the panel (the note stays). */
  close() {
    if (this.state === RECORDING) return this.cancel();
    this.session.autoInsert = false;
    this.hide();
    return Promise.resolve();
  }

  /**
   * The panel goes (Android's finishIdle): Refine and the chief still run and save to the note;
   * while recording, recording goes on.
   */
  hide() {
    this.clearFeedback();
    this.hidden = true;
    if (!this.busy()) this.stopListening();
    this.changed();
  }

  /** The panel was touched or dragged: it stays a while longer. */
  touch() {
    this.clearFeedback();
    if (this.state !== COPIED || this.hidden) return;
    const s = this.session;
    const waiting =
      s.refine === RUNNING || s.chief === RUNNING || (s.chief === DONE && !s.reply && this.listener !== null);
    this.feedbackTimer = this.timers.setTimeout(() => this.finishFeedback(), waiting ? PANEL_WAIT_MS : PANEL_IDLE_MS);
  }

  attach() {
    if (this.state === RECORDING) this.openAttach();
  }

  /** 📥 Insert: the transcript at the cursor. */
  insert() {
    if (this.state !== COPIED) return Promise.resolve();
    this.session.autoInsert = false;
    return this.insertText('transcript', this.session.transcript);
  }

  insertFromChief() {
    if (!this.session.reply) return Promise.resolve();
    return this.insertText('chief', this.session.reply);
  }

  /** Copy (no button on the panel, as on Android: for the app's own use). */
  copy(kind = 'transcript') {
    const s = this.session;
    const text = kind === 'refined' ? s.refined : kind === 'chief' ? s.reply : s.transcript;
    if (text) this.copyText(text);
  }

  /** Refine: chosen ahead while recording, started once the transcript is ready, then inserted. */
  tapRefine() {
    const s = this.session;
    let result = Promise.resolve();
    switch (s.refine) {
      case QUEUED:
        s.refine = IDLE;
        break;
      case RUNNING:
        break;
      case DONE:
        s.autoInsert = false;
        result = this.insertText('refined', s.refined);
        break;
      default:
        s.refine = QUEUED;
        s.autoRefine = false;
        this.startQueued();
    }
    this.changed();
    this.touch();
    return result;
  }

  /** Chief: chosen ahead while recording, sent once the transcript is ready; then opens the chat. */
  tapChief() {
    const s = this.session;
    switch (s.chief) {
      case QUEUED:
        s.chief = IDLE;
        break;
      case RUNNING:
        break;
      case DONE:
        if (!s.chiefLink) this.say(tr('Set the bb web address for links in Settings → bb.'));
        else
          try {
            if (!this.openLink) throw new Error('no browser');
            this.openLink(s.chiefLink);
          } catch {
            this.say(tr('No browser available'));
          }
        break;
      default:
        if (!this.chiefReady()) {
          this.say(tr('Set up your chief of staff in Dictate & Delegate → Settings → bb.'));
          return;
        }
        s.chief = QUEUED;
        this.dropAutoRefine(s);
        this.startQueued();
    }
    this.changed();
    this.touch();
  }

  say(message) {
    this.session.message = message;
    this.changed();
    this.touch();
  }

  /** The chief gets it as said: a Refine that Jev started (not one you tapped) is dropped. */
  dropAutoRefine(s) {
    if (!s.autoRefine) return;
    if (s.refine === QUEUED || s.refine === RUNNING) {
      s.refine = IDLE;
      s.refineRun++;
    }
    s.autoRefine = false;
  }

  /** Runs what's queued, once the transcript is there and Jev has answered (or isn't asked). */
  startQueued() {
    const s = this.session;
    if (this.state !== COPIED || !s.decided || !s.noteId) return;
    if (s.refine === QUEUED) {
      s.refine = RUNNING;
      const template = s.template;
      const run = ++s.refineRun;
      this.run(async () => this.refined(s, run, await this.refineNote(s.noteId, template)));
    }
    if (s.chief === QUEUED) {
      s.chief = RUNNING;
      this.run(async () => this.sent(s, await this.sendNote(s.noteId)));
    }
    this.autoInsert(s);
    this.changed();
    this.touch();
  }

  // ---------------------------------------------------------------- recording

  async start() {
    if (this.busy() || this.destroyed) return;
    if (this.pending.exists()) {
      this.hidden = false;
      this.transition(ERROR, tr('A saved recording needs retry or discard first.'));
      return;
    }
    this.starting = true;
    try {
      if (!this.hasKey()) throw new DictationError(tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
      this.newSession();
      this.prefs.remove('recordingId');
      this.prefs.set('sessionModel', this.fixedModel());
      this.prefs.set('sessionId', this.uuid());
      this.prefs.set('sessionCreated', this.clock());
      this.recordFailure = null;
      this.pending.create();
      this.capturing = true;
      await this.microphone.start(
        (frame) => this.frame(frame),
        (err) => this.recorderFailed(err),
      );
    } catch (ex) {
      this.capturing = false;
      this.starting = false;
      try {
        if (this.pending.exists() && this.pending.length() === 0) this.pending.remove();
      } catch {
        /* Nothing was recorded. */
      }
      this.hidden = false;
      this.transition(ERROR, friendly(ex));
      return;
    }
    this.starting = false;
    // User controls the lifetime. No timeout or voice-activity/silence detector ends recording.
    this.started = this.clock();
    this.hidden = false;
    this.transition(RECORDING, tr('Recording until you tap Stop. Switch apps freely.'));
    this.tick();
    if (this.recordFailure) this.stopRecording(false);
  }

  frame(frame) {
    if (!this.capturing) return;
    try {
      this.pending.append(Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    } catch (ex) {
      this.recorderFailed(ex);
    }
  }

  recorderFailed(err) {
    if (this.recordFailure) return;
    this.recordFailure = err || new DictationError(tr('Microphone was interrupted. Saved audio can be retried.'));
    if (this.state === RECORDING) this.stopRecording(false);
  }

  tick() {
    this.timers.clearTimeout(this.tickTimer);
    this.tickTimer = this.timers.setTimeout(() => {
      if (this.state !== RECORDING || this.destroyed) return;
      this.changed();
      this.tick();
    }, 1000);
  }

  stopTicker() {
    this.timers.clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  /** Stops the microphone; returns its failure, if any. */
  async stopMicrophone() {
    let failure = null;
    try {
      await this.microphone.stop();
    } catch (ex) {
      failure = ex;
    }
    this.capturing = false;
    try {
      if (this.pending.flush) this.pending.flush();
    } catch (ex) {
      failure = failure || ex;
    }
    return this.recordFailure || failure;
  }

  /** ■ (or the hotkey): stop and transcribe. */
  stop() {
    return this.stopRecording(true);
  }

  async stopRecording(transcribe) {
    if (this.state !== RECORDING) return;
    this.transition(STOPPING, tr('Saving recording…'));
    this.stopTicker();
    const failure = await this.stopMicrophone();
    if (this.destroyed) return;
    if (failure || !transcribe)
      this.transition(ERROR, failure ? friendly(failure) : tr('Recording interrupted. Saved audio can be retried.'));
    else await this.upload();
  }

  /** ✕ while recording: the audio is thrown away, nothing is transcribed or sent, so it costs nothing. */
  async cancel() {
    if (this.state !== RECORDING) return;
    this.transition(STOPPING, tr('Cancelling…'));
    this.stopTicker();
    await this.stopMicrophone();
    if (this.destroyed) return;
    try {
      this.attachments.clearPending();
    } catch {
      /* What was attached just stays for the next one. */
    }
    try {
      await this.clearPending();
    } catch (ex) {
      this.transition(ERROR, friendly(ex));
      return;
    }
    this.emit('notice', tr('Cancelled. Nothing was transcribed or sent.'));
    this.transition(READY, READY_DETAIL);
  }

  /**
   * 📞 while recording: the recording so far becomes the start of a hands-free call. The audio
   * goes to hands-free mode, this dictation ends without a note, and listening goes on there.
   */
  async call() {
    if (this.state !== RECORDING) return;
    this.transition(STOPPING, tr('Starting the call…'));
    this.stopTicker();
    await this.stopMicrophone();
    if (this.destroyed) return;
    let pcm = null;
    try {
      pcm = Buffer.from(this.pending.read(0, this.pending.length()));
    } catch {
      pcm = null;
    }
    try {
      this.attachments.clearPending();
    } catch {
      /* The seed is what matters now. */
    }
    try {
      await this.clearPending();
    } catch {
      /* The seed copy is what matters now. */
    }
    try {
      await this.startCall({ pcm: pcm && pcm.length ? pcm : null });
    } catch (ex) {
      this.log('call: ' + friendly(ex));
      this.emit('notice', friendly(ex));
    }
    this.transition(READY, READY_DETAIL);
  }

  /** Transcribes the saved recording again (the app's recovery). */
  async retry() {
    if (this.busy()) return;
    this.newSession();
    this.hidden = false;
    await this.upload();
  }

  /** Throws the saved recording away (the app's recovery). */
  async discard() {
    if (this.busy()) return;
    try {
      await this.clearPending();
      this.transition(READY, READY_DETAIL);
    } catch (ex) {
      this.transition(ERROR, friendly(ex));
    }
  }

  // ---------------------------------------------------------------- transcription

  async upload() {
    const pending = this.pending;
    if (!pending.exists() || pending.length() < 2) {
      try {
        await this.clearPending();
        this.transition(EMPTY, tr('No audio captured. Ready to try again.'));
      } catch (ex) {
        this.transition(ERROR, friendly(ex));
      }
      return;
    }
    this.transition(UPLOADING, tr('Transcribing… You can keep using other apps.'));
    const existing = this.prefs.get('sessionId', '');
    const sessionId = existing || this.uuid();
    this.prefs.set('sessionId', sessionId);
    this.prefs.set('recordingId', this.prefs.get('recordingId', sessionId));
    const uploadStarted = this.clock();
    try {
      const model = this.prefs.get('sessionModel', '') || this.fixedModel();
      let entry = await this.loadNote(sessionId);
      if (!entry) {
        entry = createEntry(sessionId, model, pending.length() / BYTES_PER_SECOND, this.clock());
        entry.recordingId = this.prefs.get('recordingId', sessionId);
        entry.created = this.prefs.get('sessionCreated', this.clock());
        await this.saveNote(entry);
      }
      // No language: the speech models detect it, also when you switch mid-note.
      const words = this.hintWords();
      for (;;) {
        const length = pending.length();
        if ((entry.offset || 0) >= length - (length % 2)) break;
        if (this.destroyed) return;
        const chunk = readChunk(pending, entry.offset || 0);
        entry.unconfirmed = (entry.unconfirmed || 0) + 1;
        await this.saveNote(entry); // A lost response leaves an explicit unknown charge.
        const asked = this.clock();
        let result;
        try {
          result = await this.transcribeChunk(chunk.wav, words, model);
        } catch (failed) {
          addStep(entry, 'speech', model, this.clock() - asked, null, friendly(failed));
          await this.saveNote(entry);
          throw failed;
        }
        const cost = result ? plain(result.cost) : null;
        entry.text = appendText(entry.text || '', (result && result.text) || '');
        entry.offset = chunk.nextOffset;
        entry.requests = (entry.requests || 0) + 1;
        entry.unconfirmed = Math.max(0, (entry.unconfirmed || 0) - 1);
        charge(entry, cost);
        addStep(entry, 'speech', model, this.clock() - asked, cost, null);
        await this.saveNote(entry); // Text, cost and resume offset commit together.
        if (this.destroyed) return;
      }
      const empty = !(entry.text || '').trim();
      if (!empty && !('raw' in entry)) {
        // "raw" stays what the speech model wrote; "original" and "processed" are the two versions.
        entry.raw = entry.text;
        entry.original = entry.text;
        // What was attached while recording belongs to this note (not to a redo of another).
        if (recordingIdOf(entry) === entry.id) {
          let attached = 0;
          try {
            attached = Number(await this.attachments.claimPending(recordingIdOf(entry))) || 0;
          } catch {
            attached = 0;
          }
          if (attached > 0) entry.attached = attached;
        }
      }
      entry.status = empty ? 'no speech' : 'complete';
      entry.processingMs = (entry.processingMs || 0) + this.clock() - uploadStarted;
      await this.notesQueue.run(() => this.saveNote(entry));
      this.emit('notes', entry.id);
      this.outbox.resolved('recording:' + sessionId);
      const redo = recordingIdOf(entry) !== entry.id;
      try {
        await this.archiveAudio(recordingIdOf(entry), pending);
      } catch (ex) {
        this.log('archive: ' + friendly(ex));
      }
      if (this.destroyed) return;
      if (empty) {
        try {
          await this.clearPending();
          this.transition(EMPTY, tr('No speech recognized. Ready to record again.'));
        } catch (ex) {
          this.transition(ERROR, friendly(ex));
        }
        return;
      }
      this.keepTranscript(entry.text);
      try {
        // The transcript comes first, on the panel to insert; never on the clipboard by itself.
        await this.clearPending();
        const s = this.session;
        s.noteId = sessionId;
        s.transcript = entry.text;
        s.redo = redo;
        s.autoInsert = this.prefs.get('autoInsert', false) === true;
        this.transition(COPIED, tr('Your text is ready to insert'));
        this.decide();
      } catch {
        this.transition(ERROR, tr('Transcript saved in history. Open Dictate & Delegate to copy it.'));
      }
    } catch (ex) {
      try {
        const entry = await this.loadNote(sessionId);
        if (entry && entry.status !== 'complete' && entry.status !== 'no speech') {
          entry.status = 'needs attention';
          await this.saveNote(entry);
        }
      } catch {
        /* Keep the original error and recoverable audio. */
      }
      this.emit('notes', sessionId);
      // For the next failure report: the recording is kept for Retry.
      this.outbox.failure('recording:' + sessionId, 'recording', 'Recording (writing it down)', friendly(ex));
      if (!this.destroyed) this.transition(ERROR, friendly(ex));
    }
  }

  keepTranscript(text) {
    try {
      if (this.vault) this.vault.set('transcript', text);
    } catch {
      /* Only the last-transcript shortcut. */
    }
  }

  async clearPending() {
    try {
      this.pending.remove();
    } catch {
      throw new DictationError(tr('Could not delete saved audio. Try again after restarting Dictate & Delegate.'));
    }
    const id = this.prefs.get('sessionId', '');
    try {
      const entry = id ? await this.loadNote(id) : null;
      if (entry && entry.status !== 'complete' && entry.status !== 'no speech') {
        entry.status = 'audio discarded';
        await this.saveNote(entry);
      }
    } catch {
      throw new DictationError(tr('Could not update history.'));
    }
    for (const key of ['sessionModel', 'sessionId', 'sessionCreated', 'recordingId']) this.prefs.remove(key);
    if (id) this.emit('notes', id);
  }

  // ---------------------------------------------------------------- Jev

  /** Jev, right after the transcript: what starts by itself, the template, the chief hint. */
  decide() {
    const s = this.session;
    const autoRefine = this.prefs.get('autoRefine', true) !== false;
    const autoChief = this.prefs.get('autoChief', true) !== false;
    const chiefReady = !!this.chiefReady();
    let templates = [];
    try {
      templates = this.templateNames() || [];
    } catch {
      templates = [];
    }
    const said = s.transcript;
    const name = this.chiefName();
    // The chief is only asked about when its name comes up.
    const named = chiefReady && mentions(said, name);
    if (s.redo || !this.jev || (!autoRefine && !named && templates.length === 0)) {
      s.decided = true;
      this.startQueued();
      return;
    }
    const id = s.noteId;
    this.run(async () => {
      let answers = null,
        why = null;
      const asked = this.clock();
      try {
        // Jev's own call times out after 3 s; this only makes sure a hung one can't hold the panel.
        const raw = await withTimeout(
          Promise.resolve().then(() => this.jev(said, { templates, refine: autoRefine, chiefName: named ? name : '' })),
          JEV_TIMEOUT_MS + 1000,
          tr('Jev took too long to answer.'),
        );
        answers = readAnswers(raw);
        if (answers.template && !templates.includes(answers.template)) answers.template = '';
      } catch (ex) {
        why = friendly(ex);
      }
      const ms = this.clock() - asked;
      try {
        await this.update(id, (e) => {
          const step = addStep(e, 'jev', JEV_MODEL, ms, answers ? answers.cost : null, why);
          if (answers) {
            step.answer = jevDetail(answers);
            charge(e, answers.cost);
            addCost(e, 'jevCost', answers.cost);
          }
        });
      } catch {
        /* The note keeps the transcript; Activity just lacks this step. */
      }
      const d = jevDecision(answers, autoRefine, autoChief, chiefReady, named);
      if (this.session !== s) return;
      s.decided = true;
      s.template = d.template;
      s.hint = d.hint;
      if (d.chief && s.chief === IDLE) s.chief = QUEUED;
      // What goes to the chief goes as said: Jev's Refine only when it doesn't.
      if (d.refine && s.refine === IDLE && s.chief === IDLE) {
        s.refine = QUEUED;
        s.autoRefine = true;
      }
      this.startQueued();
      this.changed();
    });
  }

  // ---------------------------------------------------------------- Refine

  /**
   * Refine: what was said, with the template named and the attachments, through the text model.
   * The note gets the refined version (what was said stays); on failure it records why. Returns
   * null, or why it failed.
   */
  async refineNote(id, template) {
    const entry = await this.loadNote(id);
    if (!entry) return tr('This note was deleted.');
    const said = saidOf(entry);
    const asked = this.clock();
    let r = null,
      failed = null;
    try {
      r = await this.refineText(said, { template: template || '', recordingId: recordingIdOf(entry) });
      if (!r || typeof r.text !== 'string') throw new DictationError(tr('The text model sent no text.'));
    } catch (ex) {
      r = null;
      failed = friendly(ex);
    }
    const ms = this.clock() - asked;
    try {
      await this.update(id, (e) => {
        if (!r) {
          e.processingFailed = failed;
          addStep(e, 'refine', this.refineModel(), ms, null, failed);
          return;
        }
        const cost = plain(r.cost);
        if (r.anthropic) {
          // Anthropic credits: kept apart, never in the note's or the month's cost.
          addCost(e, 'anthropicCost', cost);
          Object.assign(addStep(e, 'refine', r.model, ms, cost, null), { provider: 'anthropic', approx: true });
        } else {
          charge(e, cost);
          addCost(e, 'textCost', cost);
          const step = Object.assign(addStep(e, 'refine', r.model, ms, cost, null), { provider: 'openrouter' });
          if (r.fallback) step.fallback = r.fallback;
        }
        if (r.keyProblem) e.anthropicWarning = r.fallback;
        else delete e.anthropicWarning;
        e.processed = r.text;
        e.text = r.text;
        e.version = 'processed';
        e.textModel = r.model;
        delete e.processingFailed;
        if (template) e.template = template;
        else delete e.template;
      });
    } catch (ex) {
      return friendly(ex);
    }
    return failed;
  }

  /** Refine finished (failure: why, else null). */
  async refined(s, run, failed) {
    if (run !== s.refineRun && failed === null) {
      // Dropped for the chief: the note shows what was said; the refined text stays a version.
      try {
        await this.update(s.noteId, (e) => {
          e.version = 'original';
          e.text = saidOf(e);
        });
      } catch {
        /* The note just opens on the refined version. */
      }
    }
    let text = '';
    if (failed === null) {
      const e = await this.loadNote(s.noteId);
      text = e ? e.text || '' : '';
    }
    if (run !== s.refineRun) return; // Dropped: the dictation went to the chief meanwhile.
    const current = this.session === s;
    const shown = current && !this.hidden;
    if (failed !== null) {
      s.refine = FAILED;
      s.message = tr("Couldn't refine: %1$s", failed);
    } else {
      s.refine = DONE;
      s.refined = text;
      this.keepTranscript(text);
      // Never on the clipboard by itself: Insert refined, or Copy on the note.
      s.message = shown ? tr('Refined') : '';
      if (current && !shown) this.emit('notice', tr('Refined. The text is in Dictate & Delegate.'));
    }
    if (current) {
      this.autoInsert(s);
      this.changed();
      this.touch();
    }
  }

  // ---------------------------------------------------------------- the chief

  /**
   * Hands what was said, with pasted text as context and a request ID, to the chief-of-staff
   * thread in bb. On failure the note records why and stays queued in the Outbox, which sends it
   * again by itself (with the same request ID, so it never arrives twice). Returns null, or why it
   * failed.
   */
  async sendNote(id) {
    while (this.sendingNotes.has(id)) await this.sendingNotes.get(id).catch(noop);
    const p = this.sendNoteOnce(id);
    this.sendingNotes.set(id, p);
    try {
      return await p;
    } finally {
      this.sendingNotes.delete(id);
    }
  }

  async sendNoteOnce(id) {
    const entry = await this.loadNote(id);
    if (!entry) return tr('This note was deleted.');
    // Sent meanwhile (by the outbox, or a Retry before this one): nothing to do.
    if (has(entry, 'chiefThread') && !has(entry, 'chiefFailed')) return null;
    const said = saidOf(entry);
    let chief = null;
    try {
      chief = this.chiefThread();
    } catch {
      chief = null;
    }
    // The same request ID on every try: the chief's reply finds the note, and a try that may have
    // arrived isn't sent twice.
    const again = has(entry, 'chiefFailed') && !!entry.chiefRequest;
    const request = again ? entry.chiefRequest : this.newRequestId();
    const asked = this.clock();
    let why = null,
      files = null;
    try {
      if (!chief || !chief.id) throw new DictationError(tr('No chief of staff is set up. Set one up in Settings → bb.'));
      files = await this.sendToChief(said, { request, recordingId: recordingIdOf(entry), chiefId: chief.id, again });
    } catch (ex) {
      why = plainMessage(ex) ? ex.message : tr("bb couldn't be reached. Try again.");
    }
    const ms = this.clock() - asked;
    try {
      await this.update(id, (e) => {
        const step = addStep(e, CHIEF_STEP, CHIEF_TARGET, ms, null, why);
        // Activity: how many files went along, and how ("upload", or "base64" as a fallback).
        if (files && files.files > 0) Object.assign(step, { files: files.files, filesHow: files.how });
        if (files && files.refused > 0) step.uploadRefused = files.refused;
        if (files && Array.isArray(files.failed) && files.failed.length) step.filesFailed = files.failed.join('; ');
        e.route = 'chief';
        e.chiefRequest = request;
        if (why !== null) {
          outboxLib.failed(e, why, (e.chiefTries || 0) + 1, this.clock());
          return;
        }
        outboxLib.sent(e);
        e.chiefThread = chief.id;
        e.chiefLink = chief.link || '';
        e.chiefSent = this.clock();
      });
    } catch (ex) {
      return why === null ? friendly(ex) : why;
    }
    const key = 'chief:' + request;
    if (why !== null) this.outbox.failure(key, 'chief', 'Note to you, request ' + request, why);
    else if (again) {
      this.outbox.resolved(key);
      this.outbox.worked();
    } else if (this.outbox.failuresWaiting() > 0) this.outbox.worked(); // A failure is kept for each queued note.
    return why;
  }

  /** The chief got it (failure: why, else null): the button opens the chat; its text may follow. */
  async sent(s, failed) {
    const e = await this.loadNote(s.noteId);
    const current = this.session === s;
    if (failed !== null || !e) {
      s.chief = FAILED;
      s.message =
        e && e.chiefQueued === true
          ? tr("Not sent yet: %1$s It's kept and goes by itself once bb can be reached.", failed === null ? '' : failed)
          : tr('Not sent to your chief of staff: %1$s', failed === null ? '' : failed);
    } else {
      s.chief = DONE;
      s.chiefLink = e.chiefLink || '';
      s.request = e.chiefRequest || '';
      s.message = tr('Sent to your chief of staff');
      if (current && this.hidden) this.emit('notice', tr('Sent to chief of staff'));
      if (current && !this.hidden) this.listen(s, e.chiefSent || this.clock());
    }
    if (current) {
      this.autoInsert(s);
      this.changed();
      this.touch();
    }
  }

  /** While the panel is open: the chief's text for this request, from the ntfy topic. */
  listen(s, sentAt) {
    this.stopListening();
    if (!this.waitForChiefText || !s.request) return;
    let handle = null,
      found = false;
    const onText = (text) => {
      if (found || !text) return;
      found = true;
      this.keepReply(s, text);
      if (this.session !== s) return;
      s.reply = text;
      s.message = tr('Your chief of staff sent text to insert');
      if (this.listener === handle) this.listener = null;
      stopHandle(handle);
      this.changed();
      this.touch();
    };
    try {
      handle = this.waitForChiefText(s.request, Math.max(0, Math.floor(sentAt / 1000) - 5), onText) || null;
    } catch {
      return;
    }
    if (!found) this.listener = handle || { stop: noop };
    else stopHandle(handle);
  }

  stopListening() {
    const l = this.listener;
    this.listener = null;
    stopHandle(l);
  }

  /** Keeps the chief's text with the note that asked for it. */
  keepReply(s, text) {
    if (!s.noteId) return;
    this.update(s.noteId, (e) => {
      e.chiefReply = text;
      e.chiefReplyAt = this.clock();
    }).catch(() => {
      /* The text was still shown. */
    });
  }

  // ---------------------------------------------------------------- inserting

  /**
   * Insert: at the cursor of the field in the app you're in. The refined text replaces the
   * transcript it follows if the field still holds that unchanged. When the app refuses, or
   * without the Accessibility permission, the text is copied instead.
   */
  insertText(kind, text) {
    if (!text) return Promise.resolve();
    const s = this.session;
    const earlier = s.insertedKind === 'transcript' ? s.inserted : null;
    this.touch();
    return this.inserter.run(async () => {
      let r = null,
        replaced = false;
      try {
        if (this.replaceInPlace && kind === 'refined' && earlier) {
          r = (await this.replaceInPlace(earlier.text, text, earlier)) || null;
          if (r && r.how === 'copied') r = null;
          replaced = r !== null;
        }
        if (r === null && this.insertAt) r = (await this.insertAt(text)) || null;
      } catch {
        r = null; // The app went away mid-way: copy instead.
      }
      if (!r || r.how === 'copied') {
        // Insert couldn't: the clipboard instead, and the panel says so.
        if (!r) {
          try {
            await this.copyText(text);
          } catch {
            /* Nothing more to fall back to. */
          }
        }
        // Mac: ⌘V instead of Android's long press, and the Mac's Accessibility setting.
        s.message =
          !this.insertAt || (r && r.reason === 'permission')
            ? tr('Copied instead, paste with ⌘V. Insert needs the Accessibility permission (System Settings → Privacy & Security → Accessibility).')
            : tr('Copied instead, paste with ⌘V');
      } else {
        s.inserted = { ...r, text };
        s.insertedKind = kind;
        const clipboard = r.how === 'pasted' && r.clipboard !== false;
        s.message =
          (replaced ? tr('Replaced with the refined text') : tr('Inserted')) +
          (clipboard ? ' · ' + tr("this app only takes pastes, so it's on the clipboard too") : '');
      }
      if (this.session === s) {
        this.changed();
        this.touch();
      }
    });
  }

  /**
   * Mac: "Insert automatically when the transcript is ready" (autoInsert). Once Jev has answered:
   * the refined text when Refine was chosen or started by Jev (the transcript if it fails), else the
   * transcript; nothing when it only goes to the chief.
   */
  autoInsert(s) {
    if (!s.autoInsert || this.session !== s || !s.decided || this.state !== COPIED) return;
    if (s.refine === QUEUED || s.refine === RUNNING) return;
    if (s.refine === DONE) {
      s.autoInsert = false;
      this.insertText('refined', s.refined);
      return;
    }
    if (s.refine === IDLE && s.chief !== IDLE) {
      s.autoInsert = false; // For the chief, not for this field.
      return;
    }
    s.autoInsert = false;
    this.insertText('transcript', s.transcript);
  }

  // ---------------------------------------------------------------- notes

  /** Loads a note, changes it and saves it, one change at a time. */
  update(id, change) {
    return this.notesQueue.run(async () => {
      const e = id ? await this.loadNote(id) : null;
      if (!e) throw new DictationError(tr('This note was deleted.'));
      await change(e);
      await this.saveNote(e);
      this.emit('notes', id);
    });
  }

  // ---------------------------------------------------------------- state

  newSession() {
    this.stopListening();
    this.session = newSession();
    try {
      this.session.chiefReady = !!this.chiefReady();
    } catch {
      this.session.chiefReady = false;
    }
  }

  transition(next, message) {
    this.clearFeedback();
    this.state = next;
    this.detail = message;
    this.changed();
    // Without the panel, a notice says what the panel would show.
    if (this.hidden && (next === COPIED || next === ERROR || next === EMPTY)) this.emit('notice', message);
    if (next === COPIED) this.touch();
    else if (next === ERROR || next === EMPTY)
      this.feedbackTimer = this.timers.setTimeout(() => this.finishFeedback(), FEEDBACK_MS);
  }

  finishFeedback() {
    this.feedbackTimer = null;
    if (this.state === ERROR || this.state === COPIED || this.state === EMPTY) {
      if (this.state === COPIED) this.session.autoInsert = false;
      this.hide();
    }
  }

  clearFeedback() {
    if (this.feedbackTimer !== null) this.timers.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
  }

  // Profile.java, the parts a dictation reads.

  fixedModel() {
    const id = this.prefs.get('model', DEFAULT_MODEL);
    return OFFERED.has(id) ? id : DEFAULT_MODEL;
  }

  hintWords() {
    const v = this.prefs.get('profileWords', '[]');
    if (Array.isArray(v)) return v.map(String);
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return []; // Treat a damaged list as empty.
    }
  }

  chiefName() {
    return String(this.prefs.get('chiefName', '') || '').trim();
  }

  /** Stops everything (the app quits); a recording in progress stays as a saved recording. */
  async destroy() {
    this.destroyed = true;
    this.clearFeedback();
    this.stopTicker();
    this.stopListening();
    if (this.capturing) {
      try {
        await this.microphone.stop();
      } catch {
        /* Quitting anyway. */
      }
      this.capturing = false;
      try {
        if (this.pending.flush) this.pending.flush();
      } catch {
        /* The recording so far is what was written. */
      }
    }
  }
}

function stopHandle(h) {
  if (!h) return;
  try {
    if (typeof h === 'function') h();
    else if (typeof h.stop === 'function') h.stop();
  } catch {
    /* Already stopped. */
  }
}

module.exports = {
  Dictation,
  DictationError,
  MemoryPendingAudio,
  FilePendingAudio,
  friendly,
  readChunk,
  wav,
  appendText,
  elapsed,
  mentions,
  namePattern,
  jevDecision,
  jevDetail,
  readAnswers,
  sum,
  requestId,
  READY,
  RECORDING,
  STOPPING,
  UPLOADING,
  COPIED,
  ERROR,
  EMPTY,
  IDLE,
  QUEUED,
  RUNNING,
  DONE,
  FAILED,
  PANEL_IDLE_MS,
  PANEL_WAIT_MS,
  FEEDBACK_MS,
  RATE,
  BYTES_PER_SECOND,
  CHUNK_BYTES,
  FRAME_BYTES,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  REFINE_AT,
  CHIEF_AT,
  HINT_AT,
  CHIEF_STEP,
  CHIEF_TARGET,
  DEFAULT_MODEL,
  READY_DETAIL,
};
