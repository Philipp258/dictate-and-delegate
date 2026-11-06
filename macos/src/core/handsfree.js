'use strict';
// Port of HandsFree.java.
//
// Hands-free mode: talking with the chief of staff without touching the computer. It listens
// (voice activity, no model), transcribes each stretch of speech once when you pause, and sends the
// message only when Jev says you're clearly done, asked when you say a send word ("over") or pause
// a few seconds; an end word ends the mode, and so does a long silence (sending nothing). The chief's spoken replies are read aloud; talking over
// one stops it. These are the settings and the pure parts: keyword matching and the voice activity
// segmenter.

// 16 kHz 16-bit mono PCM, as the Android app's AudioFiles.
const { RATE, BYTES_PER_SECOND, wav } = require('./audio-files');

/** Marks a message from hands-free mode for the chief (the dictate-and-delegate skill). */
const TAG = '[hands-free]';

/** What the chief hears when a call starts and ends: whether spoken messages are heard. */
const CALL_STARTED = '[hands-free call started]';
const CALL_ENDED = '[hands-free call ended]';

/** The call start as the talker gets it: marked, so its skill is used. */
const TALKER_CALL_STARTED = CALL_STARTED + ' [you are the talker]';

/** The chief's call start: it names the talker, if there is one, so the chief sends it its results. */
function callStarted(talker) {
  return !talker ? CALL_STARTED : CALL_STARTED + ' [talker: ' + talker + ']';
}

/** Prefs keys. */
const SEND_WORDS = 'hfSendWords';
const END_WORDS = 'hfEndWords';
const PAUSE_MS = 'hfEndOfTurnPauseMs';
const SILENCE_END_MS = 'hfSilenceEndMs';
const VOICE = 'hfVoice';

/**
 * One English word or phrase per action by default; each setting may hold several,
 * comma-separated. "over" is also ordinary speech ("until the period is over"), so a send word
 * only sends once Jev says you're done (HandsFreeSession.phrase).
 */
const DEFAULT_SEND = 'over';
const DEFAULT_END = 'end the call';
/**
 * A pause this long ends a part of your turn: then the whole turn so far is written down and
 * Jev asked whether you're done; only a clear yes sends it (a new key: the old setting's 1.8 s
 * sent while Philipp was still thinking). A call with this long of silence, nobody talking and
 * no reply playing, ends without sending anything.
 */
const DEFAULT_PAUSE_MS = 5000;
const DEFAULT_SILENCE_END_MS = 120_000;

const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const int = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function words(prefs, key, fallback) {
  return list(prefs.get(key, fallback));
}

function endSetting(prefs) {
  return prefs.get(END_WORDS, DEFAULT_END);
}

function pauseMs(prefs) {
  return clamp(500, 15_000, int(prefs.get(PAUSE_MS, DEFAULT_PAUSE_MS), DEFAULT_PAUSE_MS));
}

/** Prefs: quiet sounds for the key moments (on by default), and how long a voice model may take. */
const SOUNDS = 'hfSounds';
const VOICE_WAIT_MS = 'hfVoiceWaitMs';

/**
 * Prefs: live transcription (on by default; it needs the provider's key) and its model
 * (StreamingSpeech's choices), and the call audio kept open for the whole call (on by default).
 */
const LIVE = 'hfLive';
const LIVE_MODEL = 'hfLiveModel';
const OPEN_AUDIO = 'hfOpenAudio';

/** A voice model slower than this to send a reply's audio is given up for the system voice. */
const DEFAULT_VOICE_WAIT_MS = 3000;

function voiceWaitMs(prefs) {
  return clamp(500, 60_000, int(prefs.get(VOICE_WAIT_MS, DEFAULT_VOICE_WAIT_MS), DEFAULT_VOICE_WAIT_MS));
}

function silenceEndMs(prefs) {
  return clamp(30_000, 3_600_000, int(prefs.get(SILENCE_END_MS, DEFAULT_SILENCE_END_MS), DEFAULT_SILENCE_END_MS));
}

/** "over, send ,  senden" → [over, send, senden]: comma- or line-separated, blanks dropped. */
function list(setting) {
  const out = [];
  for (const w of String(setting == null ? '' : setting).split(/[,\n]/)) if (normalize(w) !== '') out.push(w.trim());
  return out;
}

// ------------------------------------------------------------------ keywords (unit-tested)

/** Lower case, accents and punctuation gone, single spaces: "Das war's!" → "das wars". */
function normalize(s) {
  let n = String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  n = n
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return n.trim();
}

/**
 * If the text ends with one of the words (a phrase of one or more words, as a whole word, case,
 * punctuation and accents ignored), the text without it; otherwise null. "Book the table. Over."
 * with [over] → "Book the table."
 */
function endsWith(text, wordList) {
  const t = text == null ? '' : String(text);
  const norm = normalize(t);
  for (const w of wordList) {
    const nw = normalize(w);
    if (nw === '') continue;
    if (norm === nw || norm.endsWith(' ' + nw)) return cut(t, nw.split(' ').length);
  }
  return null;
}

/**
 * How many times in a row the text ends with one of the words: "…those options. Over. Over." with
 * [over] → 2, "…is over." → 1, none → 0. (The text sent keeps all but the last: "the period is
 * over. Over." keeps its sentence.)
 */
function endings(text, wordList) {
  let n = 0;
  for (let t = endsWith(text, wordList); t != null; t = t === '' ? null : endsWith(t, wordList)) n++;
  return n;
}

/** The text without its last n words, and without the punctuation left before them. */
function cut(text, n) {
  let t = text.replace(/[^\p{L}\p{N}]+$/u, '');
  for (let i = 0; i < n; i++) {
    t = t.replace(/[\p{L}\p{N}'’`]+$/u, '');
    if (i < n - 1) t = t.replace(/[^\p{L}\p{N}]+$/u, '');
  }
  return t.replace(/[\s,;:–—-]+$/u, '').trim();
}

// ------------------------------------------------------------------ voice activity (unit-tested)

/** Prefs: how much louder than the background your voice has to be, and how long you speak to take the floor. */
const GATE = 'hfGate';
const TAKE_MS = 'hfTakeMs';

const DEFAULT_GATE = 3.0;
/**
 * Voice needed to take the turn, counted within the last WINDOW_MS, so natural speech with
 * its little gaps counts ("Hi, can you hear me").
 */
const DEFAULT_TAKE_MS = 400;

function gate(prefs) {
  return clamp(1.5, 20, num(prefs.get(GATE, DEFAULT_GATE), DEFAULT_GATE));
}

function takeMs(prefs) {
  return clamp(200, 5000, int(prefs.get(TAKE_MS, DEFAULT_TAKE_MS), DEFAULT_TAKE_MS));
}

/**
 * Layer 1: is this frame speech at all? A detector is a function (frame, level, background) →
 * boolean. Today by its level; a model (Silero) can take its place.
 */
/** The level-based detector: clearly above the background, and above a fixed minimum. */
const LEVEL = (frame, level, background) => level > Math.max(600, background * 2);

/** Collects bytes like a ByteArrayOutputStream. */
class Bytes {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }

  write(buf, length = buf.length) {
    const b = Buffer.from(buf.buffer, buf.byteOffset, length);
    this.chunks.push(Buffer.from(b)); // A copy: the microphone reuses its frame.
    this.size += length;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.size);
  }
}

/**
 * Splits a stream of 20 ms frames into stretches of your speech, in three layers: a frame counts
 * if the detector calls it speech (1) and it's at least gate times louder than the measured
 * background (2), so your voice close to the microphone counts and distant voices or music mostly
 * don't. A stretch only counts once it holds minSpeechMs of such frames within the last
 * WINDOW_MS, or a burst of BURST_FRAMES at least BURST times louder than the background and
 * above BURST_MIN (3); shorter ones are noise. It ends after pauseMs without speech, and keeps a
 * little audio before and after it. Silence in between never goes to the speech model.
 *
 * The listener: { segment(pcm), started?(level, background), noise?(speechMs, level, background),
 * tooQuiet?(ms, level, background) }, or a function taking segment's pcm.
 */
class Segmenter {
  /**
   * new Segmenter(pauseMs, listener) or new Segmenter(pauseMs, minSpeechMs, gate, detector,
   * listener), minSpeechMs a function returning milliseconds.
   */
  constructor(pauseMs, minSpeechMs, gateValue, detector, listener) {
    if (listener === undefined && gateValue === undefined) {
      listener = minSpeechMs;
      minSpeechMs = () => 200;
      gateValue = DEFAULT_GATE;
      detector = LEVEL;
    }
    if (typeof listener === 'function') listener = { segment: listener };
    this.pauseFrames = Math.max(1, Math.trunc(pauseMs / Segmenter.FRAME_MS));
    this.padFrames = Segmenter.PAD_MS / Segmenter.FRAME_MS;
    this.minSpeechMs = minSpeechMs;
    this._gate = gateValue;
    this.detector = detector;
    this.listener = listener;
    this.before = [];
    this.current = null;
    this.silentFrames = 0;
    this.speechFrames = 0;
    this.streak = 0;
    this.confirmed = false;
    this._background = 300;
    this.peak = 0;
    this._quietMs = 0;
    // A stretch of sound that's too quiet to count (for the reasons only; it changes nothing).
    this.nearFrames = 0;
    this.nearGap = 0;
    this.nearPeak = 0;
    /** Frame numbers of the recent loud frames (within the window), and frames seen in all. */
    this.voiced = [];
    this.frameNo = 0;
    this.quietFrames = 0;
    /** The audio of sounds that didn't count, since the last stretch that did: Send writes it down. */
    this.noiseAudio = null;
    this.noiseAt = 0;
    /** The short-burst rule applies (not over a reply: a clatter mustn't stop it). */
    this.bursts = true;
  }

  /** Milliseconds since the last confirmed speech (or since the start). */
  quietMs() {
    return this._quietMs;
  }

  /** Speech is going on (it reached minSpeechMs and hasn't ended yet). */
  speaking() {
    return this.current != null && this.confirmed;
  }

  /** Something loud started but isn't confirmed speech yet. */
  candidate() {
    return this.current != null;
  }

  background() {
    return this._background;
  }

  /**
   * Milliseconds since the last frame that counted as voice: within a stretch its silence so
   * far, else the quiet since the last one.
   */
  silentMs() {
    return this.current == null ? this._quietMs : this.silentFrames * Segmenter.FRAME_MS;
  }

  /** The audio of the stretch going on, from its start (with the little before it); empty if none. */
  stretchAudio() {
    return this.current == null ? Buffer.alloc(0) : this.current.toBuffer();
  }

  /** Milliseconds of voice within the window: how much it took to count. */
  voicedMs() {
    return this.voiced.length * Segmenter.FRAME_MS;
  }

  /** Root mean square of a frame of 16-bit little-endian samples. */
  static level(frame, length = frame.length) {
    let sum = 0;
    const n = Math.trunc(length / 2);
    for (let i = 0; i + 1 < length; i += 2) {
      const s = (((frame[i] & 0xff) | (frame[i + 1] << 8)) << 16) >> 16;
      sum += s * s;
    }
    return n === 0 ? 0 : Math.sqrt(sum / n);
  }

  /** Feeds one 20 ms frame (640 bytes at 16 kHz). */
  frame(frame) {
    const FRAME_MS = Segmenter.FRAME_MS;
    const level = Segmenter.level(frame, frame.length);
    const loud = this.detector(frame, level, this._background) && level >= this._background * this._gate;
    if (!loud) {
      // Fast at first, and fast down always: the noise at the start of a call (or any loud
      // spell) passes, and the background mustn't stay up with it. Slowly up.
      const a = this.quietFrames++ < Segmenter.LEARN_FRAMES ? 0.1 : level < this._background ? Segmenter.FALL : 0.005;
      this._background = this._background * (1 - a) + level * a;
    }
    this.frameNo++;
    if (loud) this.voiced.push(this.frameNo);
    const window = Math.trunc(Math.max(Segmenter.WINDOW_MS, Math.trunc((this.minSpeechMs() * 3) / 2)) / FRAME_MS);
    while (this.voiced.length && this.voiced[0] <= this.frameNo - window) this.voiced.shift();
    // Two loud frames in a row start a candidate, so a click doesn't.
    this.streak = loud ? this.streak + 1 : 0;
    this.nearly(loud, level);
    if (this.current == null) {
      this.before.push(Buffer.from(frame));
      while (this.before.length > this.padFrames) this.before.shift();
      this._quietMs += FRAME_MS;
      if (this.streak >= 2) {
        this.current = new Bytes();
        for (const b of this.before) this.current.write(b);
        this.before = [];
        this.speechFrames = this.streak;
        this.silentFrames = 0;
        this.confirmed = false;
        this.peak = level;
        this.confirm(level);
      }
      return;
    }
    this.current.write(frame);
    if (loud) {
      this.speechFrames++;
      this.silentFrames = 0;
      this.peak = Math.max(this.peak, level);
      this.confirm(level);
    } else {
      this.silentFrames++;
      if (this.confirmed) this._quietMs += FRAME_MS;
    }
    // Both end after the pause: a candidate's little gaps (between words) don't end it.
    if (this.silentFrames >= this.pauseFrames) this.finish();
  }

  /**
   * Notes sound that's clearly there (half again the background, above the detector's minimum)
   * but not loud enough to count: once it's gone for half a second after at least 0.3 s of it,
   * the listener hears it was too quiet. Thresholds stay as they are; this only reports.
   */
  nearly(loud, level) {
    const near = !loud && this.current == null && level > Math.max(600, this._background * 1.5);
    if (near) {
      this.nearFrames++;
      this.nearGap = 0;
      this.nearPeak = Math.max(this.nearPeak, level);
      return;
    }
    if (this.nearFrames === 0) return;
    if (loud || this.current != null) {
      // It became speech after all.
      this.nearFrames = 0;
      this.nearPeak = 0;
      return;
    }
    if (++this.nearGap < 500 / Segmenter.FRAME_MS) return;
    if (this.nearFrames * Segmenter.FRAME_MS >= 300 && this.listener.tooQuiet)
      this.listener.tooQuiet(this.nearFrames * Segmenter.FRAME_MS, this.nearPeak, this._background);
    this.nearFrames = 0;
    this.nearGap = 0;
    this.nearPeak = 0;
  }

  gate() {
    return this._gate;
  }

  /** Enough voice within the window, or a clearly loud burst. */
  confirm(level) {
    if (this.confirmed) return;
    const enough = this.voiced.length * Segmenter.FRAME_MS >= this.minSpeechMs();
    const burst =
      this.bursts && this.speechFrames >= Segmenter.BURST_FRAMES && this.peak >= Math.max(Segmenter.BURST_MIN, this._background * Segmenter.BURST);
    if (!enough && !burst) return;
    this.confirmed = true;
    this._quietMs = 0;
    if (this.listener.started) this.listener.started(this.peak, this._background);
  }

  /**
   * Ends the current stretch now (the mode ends); with force (Send pressed) a stretch that didn't
   * count yet is written down anyway, unless it's only a click.
   */
  flush(force = false) {
    if (this.current == null) return;
    if (force && this.speechFrames >= 2) this.confirmed = true;
    this.finish();
  }

  /**
   * The sounds that didn't count as speech in the last ten seconds (since the last stretch that
   * did), or null: Send pressed with nothing written down writes them down. Taken once.
   */
  takeNoise() {
    const n = this.noiseAudio;
    this.noiseAudio = null;
    if (n == null || this.frameNo - this.noiseAt > 10_000 / Segmenter.FRAME_MS) return null;
    return n.toBuffer();
  }

  /** Forgets everything in progress (a reply was read meanwhile). */
  reset() {
    this.current = null;
    this.before = [];
    this.silentFrames = 0;
    this.speechFrames = 0;
    this.streak = 0;
    this.confirmed = false;
    this._quietMs = 0;
    this.nearFrames = this.nearGap = 0;
    this.nearPeak = 0;
    this.voiced = [];
    this.noiseAudio = null;
  }

  finish() {
    const all = this.current.toBuffer();
    const frameBytes = (RATE * 2 * Segmenter.FRAME_MS) / 1000;
    // Keep only padFrames of the trailing silence.
    const keep = Math.max(0, all.length - Math.max(0, this.silentFrames - this.padFrames) * frameBytes);
    const real = this.confirmed;
    const ms = this.speechFrames * Segmenter.FRAME_MS;
    this.current = null;
    this.silentFrames = 0;
    this.speechFrames = 0;
    this.confirmed = false;
    this.voiced = [];
    if (real) {
      this.noiseAudio = null;
      this.listener.segment(Buffer.from(all.subarray(0, keep)));
    } else {
      if (this.noiseAudio == null || this.frameNo - this.noiseAt > 10_000 / Segmenter.FRAME_MS) this.noiseAudio = new Bytes();
      if (this.noiseAudio.size < 15 * BYTES_PER_SECOND) this.noiseAudio.write(all, keep);
      this.noiseAt = this.frameNo;
      if (this.listener.noise) this.listener.noise(ms, this.peak, this._background);
    }
  }
}

Segmenter.FRAME_MS = 20;
Segmenter.PAD_MS = 300;
Segmenter.WINDOW_MS = 1500;
Segmenter.BURST_FRAMES = 5;
Segmenter.BURST = 10;
/**
 * A burst also has to be at least this loud: with the background down at 50 (a quiet room),
 * 10× is only 500, and a clatter or a door took the turn with it. A short word close to the
 * microphone is far louder.
 */
Segmenter.BURST_MIN = 2500;
/** The background is learned fast over the first quiet frames (the default is a guess), then slowly. */
Segmenter.LEARN_FRAMES = 50;
/** How fast the background follows quieter frames down (half way in about 0.3 s). */
Segmenter.FALL = 0.05;

module.exports = {
  RATE,
  BYTES_PER_SECOND,
  wav,
  TAG,
  CALL_STARTED,
  CALL_ENDED,
  TALKER_CALL_STARTED,
  callStarted,
  SEND_WORDS,
  END_WORDS,
  PAUSE_MS,
  SILENCE_END_MS,
  VOICE,
  DEFAULT_SEND,
  DEFAULT_END,
  DEFAULT_PAUSE_MS,
  DEFAULT_SILENCE_END_MS,
  words,
  endSetting,
  pauseMs,
  SOUNDS,
  VOICE_WAIT_MS,
  LIVE,
  LIVE_MODEL,
  OPEN_AUDIO,
  DEFAULT_VOICE_WAIT_MS,
  voiceWaitMs,
  silenceEndMs,
  list,
  normalize,
  endsWith,
  endings,
  GATE,
  TAKE_MS,
  DEFAULT_GATE,
  DEFAULT_TAKE_MS,
  gate,
  takeMs,
  LEVEL,
  Segmenter,
};
