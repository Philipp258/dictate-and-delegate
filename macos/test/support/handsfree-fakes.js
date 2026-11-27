'use strict';
// The fakes of HandsFreeTest.java: a session on a fake clock whose speech model returns queued
// texts, a fake bb, a fake voice, and a fake live transcription.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const HandsFree = require('../../src/core/handsfree');
const { HandsFreeSession, PartlySent } = require('../../src/core/handsfree-session');
const { sleep, deferred } = require('../../src/core/util');

/** A CountDownLatch of one: await l.promise, l.countDown(). */
function latch() {
  const d = deferred();
  return { promise: d.promise, countDown: () => d.resolve() };
}

/** An AtomicLong-like clock value. */
class Clock {
  constructor(v) {
    this.v = v;
  }

  get() {
    return this.v;
  }

  addAndGet(d) {
    this.v += d;
    return this.v;
  }
}

/** A 20 ms frame of a 220 Hz tone at this amplitude. */
function frame(amplitude) {
  const f = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) {
    const s = Math.trunc(amplitude * Math.sin((i * 2 * Math.PI * 220) / 16000.0));
    f[2 * i] = s & 0xff;
    f[2 * i + 1] = (s >> 8) & 0xff;
  }
  return f;
}

function feed(s, amplitude, ms) {
  for (let i = 0; i < Math.trunc(ms / 20); i++) s.frame(frame(amplitude));
}

/** A household sound: n frames at the given amplitude. */
function clatter(session, amplitude, frames) {
  for (let i = 0; i < frames; i++) session.frame(frame(amplitude));
}

/** Content keys (Java's ByteBuffer equality). */
const keyOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/** A WAV's parts: the session joins them with 0.3 s of exact silence. Their keys. */
function parts(wav) {
  const out = [];
  let start = 44;
  let zeros = 0;
  const gap = (HandsFree.BYTES_PER_SECOND * 3) / 10 / 2;
  for (let i = 44; i + 1 < wav.length; i += 2) {
    zeros = wav[i] === 0 && wav[i + 1] === 0 ? zeros + 1 : 0;
    if (zeros === gap) {
      out.push(keyOf(wav.subarray(start, i + 2 - 2 * gap)));
      start = i + 2;
      zeros = 0;
    }
  }
  out.push(keyOf(wav.subarray(start, wav.length)));
  return out;
}

/** Polls (at most 2 s) until c holds, then asserts it. */
async function until(c, what) {
  for (let i = 0; i < 100 && !c(); i++) await sleep(20);
  assert.ok(c(), what);
}

/** A session whose speech model returns queued texts, one per stretch. */
class Fake {
  constructor(...texts) {
    const f = this;
    this.transcripts = [...texts];
    this.sent = [];
    this.spoken = [];
    this.log = [];
    /** The prepared voices let go of (not played). */
    this.dropped = [];
    /** Ends the reply being read, played to the end. */
    this.done = null;
    this.fail = null;
    /** The voice: its audio starts at once (as long as this is true), or never. */
    this.audioStarts = true;
    this.audioPlaying = false;
    this.stopped = false;
    this.heardChars = 0;
    /** While set, the speech model waits for it (a slow transcription). */
    this.slow = null;
    /** While set, delivering to bb waits for it (a slow bb). */
    this.slowBb = null;
    /** How often the speech model was asked for a part, and for a whole turn of several. */
    this.transcriptions = 0;
    this.wholes = 0;
    /** What each part's audio was written down as: a whole turn is its parts' texts. */
    this.heard = new Map();
    /** Each stretch of speech a little louder than the last, so no two parts are the same audio. */
    this.stretches = 0;
    /** What a whole turn's pass makes of its parts' texts (it hears the words at their edges better). */
    this.wholeAs = (t) => t;
    /** The whole turn's pass fails. */
    this.wholeFails = false;
    /** While set, the whole turn's pass waits for it (a slow one). */
    this.slowWhole = null;
    /** While set, bb can't be reached: nothing is delivered. */
    this.bbDown = false;
    /** While set, deliveries reach only one of the chief and the talker: "chief" or "talker" misses them. */
    this.missedBy = null;
    /** What preparing a reply does (fetching its audio); by default nothing. */
    this.prepare = (text) => text;
    this.now = new Clock(1_000_000);
    let ids = 0;
    this.session = new HandsFreeSession({
      pauseMs: 1000,
      silenceEndMs: 120_000,
      takeMs: HandsFree.DEFAULT_TAKE_MS,
      gate: HandsFree.DEFAULT_GATE,
      detector: HandsFree.LEVEL,
      sendWords: HandsFree.list(HandsFree.DEFAULT_SEND),
      endWords: HandsFree.list(HandsFree.DEFAULT_END),
      transcriber: async (wav) => {
        const l = f.slow;
        if (l) await l.promise;
        const ps = parts(wav);
        if (ps.length > 1) {
          // The whole turn in one pass: what its parts were written down as (once they are).
          let all = '';
          let known = f.heard.has(ps[0]); // Else none was written down yet.
          for (let i = 0; known && i < 100 && !ps.every((p) => f.heard.has(p)); i++) await sleep(20);
          known = known && ps.every((p) => f.heard.has(p));
          for (const p of ps) {
            const t = f.heard.get(p) || '';
            if (t !== '') all += (all === '' ? '' : ' ') + t;
          }
          if (known) {
            f.wholes++;
            const w = f.slowWhole;
            if (w) await w.promise;
            if (f.wholeFails) throw new Error('Fake provider error');
            return f.wholeAs(all);
          }
        }
        // Parts never written down on their own (after a failure): written down together,
        // once (the same audio again gets the same text).
        const key = keyOf(wav);
        const again = f.heard.get(key);
        if (again != null) return again;
        f.transcriptions++;
        if (f.transcripts.length === 0) throw new Error('Index 0 out of bounds for length 0');
        const t = f.transcripts.shift();
        for (const p of ps) f.heard.set(p, '');
        f.heard.set(ps[ps.length - 1], t);
        f.heard.set(key, t);
        return t;
      },
      sender: {
        newRequest() {
          return 'r' + ++ids;
        },
        async send(said, request) {
          const l = f.slowBb;
          if (l) await l.promise;
          if (f.bbDown) throw new Error('bb isn\'t reachable');
          f.sent.push(said);
          const missed = f.missedBy;
          if (missed != null) throw new PartlySent(request, missed === 'chief', 'thread not found');
        },
      },
      speaker: {
        playback: null,
        prepare(request, text) {
          return f.prepare(text);
        },
        play(request, text, prepared, p) {
          this.playback = p;
          f.done = () => p.ended(true);
          f.fail = () => p.ended(false);
          f.spoken.push(text);
          if (f.audioStarts) p.started(2000);
        },
        playing() {
          return f.audioPlaying;
        },
        heardChars() {
          return f.heardChars;
        },
        drop(prepared) {
          if (prepared != null) f.dropped.push(prepared);
        },
        stop() {
          f.stopped = true;
          const p = this.playback;
          this.playback = null;
          f.done = null;
          if (p) p.ended(false);
        },
      },
      changed: () => {},
    });
    this.session.onEvent((l) => f.log.push(l));
    this.session.clock = () => f.now.get();
  }

  /** Quiet room for a while, so the background is measured. */
  quiet(ms) {
    for (let i = 0; i < Math.trunc(ms / 20); i++) this.session.frame(frame(50));
  }

  /** 1.2 s of speech close to the microphone: enough to take the turn. */
  speak() {
    const level = 6000 + 10 * this.stretches++;
    for (let i = 0; i < 60; i++) this.session.frame(frame(level));
  }

  /** Speech, then the pause that ends the stretch. */
  async talk() {
    this.speak();
    this.quiet(1200);
    await sleep(150);
  }

  logText() {
    return this.log.join('\n');
  }
}

/** Live transcription that says what the test tells it to, and counts what it heard. */
class FakeLive {
  constructor(f) {
    this.session = f.session;
    this.session.live = this;
    this.current = '';
    /** What the model's final text of it will be (null: the live text as it is). */
    this.finalText = null;
    this.failed = false;
    this.taken = [];
    this.frames = 0;
    this.loud = 0;
    this.discards = 0;
  }

  /** The model's live text is now this. */
  say(t) {
    this.current = t;
    this.session.liveText(t);
  }

  fail(why) {
    this.failed = true;
    this.session.liveFailed(why);
  }

  audio(frame) {
    this.frames++;
    if (HandsFree.Segmenter.level(frame, frame.length) > 250) this.loud++;
  }

  speech() {}

  text() {
    return this.current;
  }

  async take(waitMs) {
    if (this.failed) throw new Error('connection lost');
    const t = this.finalText != null ? this.finalText : this.current;
    this.finalText = null;
    this.current = '';
    this.taken.push(t);
    return t;
  }

  discard() {
    this.current = '';
    this.discards++;
  }

  working() {
    return !this.failed;
  }

  failure() {
    return this.failed ? 'connection lost' : '';
  }

  close() {}
}

/** The reasons on screen, newest first, as one text. */
function reasons(f) {
  return f.session
    .reasons()
    .map((r) => r.text + '\n')
    .join('');
}

function count(text, what) {
  return text.split(what).length - 1;
}

/** Talks, then waits for the message to go out. */
async function sendTurn(f, n) {
  await f.talk();
  await until(() => f.sent.length === n);
}

/** A reply played to the end, and the microphone open again after it. */
async function hear(f, spoken) {
  await until(() => f.spoken.length === spoken);
  f.done();
  f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
}

function verdict(choice, send, end) {
  return { choice, send, end, cost: 0.00002 };
}

/** Jev as it should answer: done once "over" is a sentence of its own at the end, else more to come. */
function overIsDone(said) {
  return /^(?:[\s\S]*[.!?,]\s*)?over[.!?]?$/i.test(said) ? verdict('over', 0.95, 0) : verdict('more', 0.1, 0);
}

const LONG_REPLY = 'The flight leaves at nine in the morning from gate twelve. The train to Lisbon costs about forty euros if you book today.';

/** A reply playing, what's left of its echo after echo cancellation in the mic. */
async function playingReply(...transcripts) {
  const f = new Fake(...transcripts);
  f.quiet(1000);
  f.session.reply('r1', LONG_REPLY);
  await until(() => f.spoken.length === 1);
  for (let i = 0; i < 100; i++) f.session.frame(frame(i % 7 === 0 ? 700 : 300)); // Its leftover echo.
  assert.ok(!f.stopped, 'its own echo doesn\'t stop it');
  f.heardChars = LONG_REPLY.indexOf('from gate');
  return f;
}

/** Feeds your speech over the reply until it stops (at most limit frames): how many it took. */
function framesToStop(f, amplitude, limit) {
  for (let i = 1; i <= limit; i++) {
    f.session.frame(frame(amplitude));
    if (f.stopped) return i;
  }
  return -1;
}

/**
 * Feeds your speech over the reply (a frame each 5 ms: what's heard is written down meanwhile)
 * until it stops, at most limit frames: how many it took, -1 if it didn't.
 */
async function talkOverUntilStopped(f, amplitude, limit) {
  for (let i = 1; i <= limit; i++) {
    f.session.frame(frame(amplitude));
    await sleep(5);
    if (f.stopped) return i;
  }
  return -1;
}

/** A module another port provides (path as from test/), or null while it isn't there yet. */
function optional(p) {
  const full = require('path').resolve(__dirname, '..', p);
  try {
    return require(full);
  } catch (ex) {
    if (ex && ex.code === 'MODULE_NOT_FOUND' && String(ex.message).includes(full)) return null;
    throw ex;
  }
}

module.exports = {
  latch,
  Clock,
  frame,
  feed,
  clatter,
  parts,
  until,
  Fake,
  FakeLive,
  reasons,
  count,
  sendTurn,
  hear,
  verdict,
  overIsDone,
  LONG_REPLY,
  playingReply,
  framesToStop,
  talkOverUntilStopped,
  optional,
};
