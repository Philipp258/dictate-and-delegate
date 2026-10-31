'use strict';
// Port of HandsFreeSession.java.
//
// One hands-free call, without the platform: microphone frames go in, messages to the chief and
// replies to read aloud come out. It's strictly turn-based, with an open floor: when nobody holds
// the turn, whoever starts first gets it.
//
//  - You take the floor by speaking (the segmenter's three layers decide what counts). You hold
//    it while you talk, while your words are written down, and while you have unsent text,
//    until the message goes (send word, Send now, long silence) or your turn comes to nothing.
//  - A chief message arriving on an open floor is read aloud; your speech over it stops it
//    (BARGE_MS), and the microphone is off a moment after it.
//  - A chief message arriving while you talk (or while what you said is written down) waits,
//    and is read at your next pause, also when you have unsent words: your turn goes on after
//    it. Sending never drops it. A reply you talk over stops and the rest of it is dropped;
//    your next message (or the call's end) tells the chief how far you heard it.
//  - Every decision it makes is a reason on screen (reasons()), in plain words, and in the log;
//    a few moments get a quiet sound (Cue).
//
// handsfree-call.js wires it to the microphone, bb, ntfy and the voice.
//
// Java → JS: the Java's threads become async work. The work queue (writing down, checks) and the
// outbox (delivering to bb) are SerialQueues, so their order holds; the voices and the speech
// pool are plain concurrent promises. Methods that blocked in Java and that callers wait on
// (sendLeftover, awaitDelivered) return promises; everything else returns at once, as in Java.
//
// Names that clash in JS (a Java field and a method of the same name): live() → liveState(),
// reply() (the text being read) → replyText(); the LiveText stays the `live` property.
//
// Injected interfaces (all may return promises where marked async):
//   transcriber: (wav: Buffer) → async string, or { transcribe(wav) }. Throws when it fails.
//   judge (property): (said) → async Verdict { choice, send, end, cost (Number|null) }, or
//     { judge(said) }; null: the send and end words decide. Throws when it can't tell.
//   sender: { newRequest?() → string, async send(said, request) } — send throws PartlySent when
//     only one of the chief and the talker got it, anything else when nobody did.
//   speaker: { async prepare(request, text) → prepared (never throws), play(request, text,
//     prepared, playback {started(durationMs), ended(played)}), playing?() → boolean,
//     heardChars?() → int, drop?(prepared), stop() }.
//   live (property): LiveText { audio(frame), speech(), text() → string, async take(waitMs),
//     discard(), working() → boolean, failure() → string, close() }.
//   changed: () → void, called after anything changes.

const HandsFree = require('./handsfree');
const { Segmenter } = HandsFree;
const { format, tr, sleep, withTimeout, TimeoutError, SerialQueue } = require('./util');
const crypto = require('crypto');

const State = Object.freeze({ LISTENING: 'LISTENING', READING: 'READING', ENDED: 'ENDED' });

/**
 * What the screen shows, and nothing else: you can talk, your message is on its way, the chief
 * has it, or a reply is read.
 */
const Phase = Object.freeze({ LISTENING: 'LISTENING', SENDING: 'SENDING', WORKING: 'WORKING', READING: 'READING' });

/** Who holds the turn. */
const Floor = Object.freeze({ OPEN: 'OPEN', YOU: 'YOU', CHIEF: 'CHIEF' });

/** What's happening right now, in more detail than Phase: the live line on screen. */
const Live = Object.freeze({
  LISTENING: 'LISTENING',
  HEARING: 'HEARING',
  WRITING: 'WRITING',
  WAITING_SEND: 'WAITING_SEND',
  SENDING: 'SENDING',
  SENT: 'SENT',
  WAITING_CHIEF: 'WAITING_CHIEF',
  REPLY_WAITING: 'REPLY_WAITING',
  REPLY_COMING: 'REPLY_COMING',
  PLAYING: 'PLAYING',
  MUTED: 'MUTED',
  ENDED: 'ENDED',
});

/** The moments that get a quiet sound. */
const Cue = Object.freeze({ HEARD: 'HEARD', SENT: 'SENT', REPLY: 'REPLY', FAILED: 'FAILED' });

/** How a message went: to bb (both), to the talker only (the chief missed it), or not at all. */
const Delivery = Object.freeze({ SENT: 'SENT', CHIEF_MISSED: 'CHIEF_MISSED', FAILED: 'FAILED' });

/**
 * A message that reached one of the chief and the talker but not the other: it counts as sent
 * (sending it again would repeat it to the one that got it), and the reason says who missed it.
 */
class PartlySent extends Error {
  constructor(request, chiefMissed, why) {
    super(why);
    this.name = 'PartlySent';
    this.request = request;
    this.chiefMissed = chiefMissed;
  }
}

/** PartlySent, also bb-bridge's own (the same shape). */
const isPartlySent = (ex) => ex instanceof PartlySent || (ex instanceof Error && ex.name === 'PartlySent' && typeof ex.chiefMissed === 'boolean');

/** A new request ID (ChiefText.requestId): six characters nobody misreads. */
function requestId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

/** BigDecimal.stripTrailingZeros().toPlainString() for a Number: 0.00002, never 2e-5. */
function plain(n) {
  if (!Number.isFinite(n)) return String(n);
  const [m0, e0] = n.toExponential(12).split('e');
  const neg = m0.startsWith('-');
  const digits = m0.replace('-', '').replace('.', '').replace(/0+$/, '') || '0';
  const point = Number(e0) + 1;
  let s;
  if (digits === '0') s = '0';
  else if (point <= 0) s = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) s = digits + '0'.repeat(point - digits.length);
  else s = digits.slice(0, point) + '.' + digits.slice(point);
  return (neg && s !== '0' ? '-' : '') + s;
}

/** An exception's message as Java's String.valueOf(ex.getMessage()) gives it. */
function message(ex) {
  if (ex instanceof Error) return String(ex.message);
  return String(ex);
}

/** A single-thread executor that can be shut down: run() after shutdown is refused (false). */
class Queue {
  constructor(onError) {
    this.queue = new SerialQueue();
    this.shut = false;
    this.onError = onError;
  }

  /** Runs task in order; false when shut down (it doesn't run). */
  execute(task) {
    if (this.shut) return false;
    this.queue.run(task).catch((ex) => this.onError(ex));
    return true;
  }

  shutdown() {
    this.shut = true;
  }

  /** Shut down and everything handed in has run. */
  terminated() {
    return this.shut && this.queue.pending === 0;
  }
}

const SILENCE = Buffer.alloc(640);

/** A chief message waiting to be read: being prepared until ready. */
class Held {
  constructor(request, text, arrived) {
    this.request = request;
    this.text = text;
    this.prepared = null;
    this.ready = false;
    /** Why it waited was shown (once per reason): told, and the last reason shown. */
    this.told = false;
    this.toldWhy = null;
    /** The seconds its voice has been fetched for, as last shown (0: not shown). */
    this.voiceShown = 0;
    /** Tries to play it that failed before (its voice fetched afresh each time). */
    this.failures = 0;
    /** When it arrived and when its voice was ready, for the timings in the log. */
    this.arrived = arrived;
    this.readyAt = 0;
    /** Not to be played (an outdated reply, or the call ended): its voice, when it comes, is let go. */
    this.dropped = false;
    /** The number of the message it answers (0: none). */
    this.answers = 0;
  }
}

/**
 * A note for your next message; claimedBy is the number of the message on its way with it (0:
 * none): removed once that one is delivered, free again if it couldn't be sent.
 */
class Note {
  constructor(text) {
    this.text = text;
    this.claimedBy = 0;
  }
}

/** A pass over a turn's parts in one, running in the background. */
class Whole {
  constructor(parts, started) {
    this.parts = parts;
    this.started = started;
    this.done = 0;
    this.text = null; // A promise of the text.
  }
}

/** The parts' audio in one, 0.3 s of silence between them. */
function joined(parts) {
  const gap = Buffer.alloc(((HandsFree.BYTES_PER_SECOND * 3) / 10) & ~1);
  const all = [];
  for (const p of parts) {
    if (all.length) all.push(gap);
    all.push(p);
  }
  return Buffer.concat(all);
}

/** The last few words, for the log. */
function tail(text) {
  const w = String(text).trim().split(/\s+/);
  return (w.length > 6 ? '…' : '') + w.slice(Math.max(0, w.length - 6)).join(' ');
}

const isLetterOrDigit = (c) => /[\p{L}\p{N}]/u.test(c);

class HandsFreeSession {
  /**
   * options: { pauseMs, silenceSendMs, takeMs = DEFAULT_TAKE_MS, gate = DEFAULT_GATE,
   * detector = LEVEL, sendWords, endWords, transcriber, sender, speaker, changed }.
   */
  constructor({
    pauseMs,
    silenceSendMs,
    takeMs = HandsFree.DEFAULT_TAKE_MS,
    gate = HandsFree.DEFAULT_GATE,
    detector = HandsFree.LEVEL,
    sendWords,
    endWords,
    transcriber,
    sender,
    speaker,
    changed = () => {},
  }) {
    this.silenceSendMs = silenceSendMs;
    this.pauseFrames = Math.max(1, Math.trunc(pauseMs / Segmenter.FRAME_MS));
    this.gate = gate;
    this.sendWords = sendWords;
    this.endWords = endWords;
    this.transcriber = typeof transcriber === 'function' ? transcriber : (wav) => transcriber.transcribe(wav);
    this.sender = sender;
    this.speaker = speaker;
    this.changedListener = changed;
    /** The time; tests set their own. */
    this.clock = () => Date.now();
    /**
     * Two queues, so nothing waits on what it doesn't need: work writes down what you say (in
     * order) and checks barge-ins; outbox delivers your messages to bb (in order), so writing down
     * your next words never waits for bb and a message never waits for transcription of words
     * that came after it. Voices (each reply's audio) and speech (the speech model, Jev) run at once.
     */
    const internal = (ex) => this.log('internal error: ' + (ex && ex.stack ? ex.stack : message(ex)));
    this.work = new Queue(internal);
    this.outbox = new Queue(internal);
    this.voicesOpen = true;
    this.speechOpen = true;
    /** Live transcription, if it's on (set before the call starts). */
    this.live = null;
    /** This turn is written down from its audio: its live text looked stalled. */
    this.batchTurn = false;
    /** A send phrase heard in the live text is being acted on (and when it was heard, for the log). */
    this.keyword = false;
    this.keywordAt = 0;
    /** The stretch of speech going on when a send phrase sent the turn: its audio was in that message. */
    this.dropStretch = false;
    /** When you started speaking in this turn, and whether its first live words were logged. */
    this.turnSpeechAt = 0;
    /** When the stretch of speech going on started (each one). */
    this.stretchAt = 0;
    /** When live transcription last gave you words: a reply waits HOLD_MAX_MS at most without them. */
    this.liveWordsAt = 0;
    /** Silence sends tried since you last spoke (each failure waits longer for the next). */
    this.silenceTries = 0;
    this.silenceNextAt = 0;
    this.firstWordsLogged = false;
    /**
     * Your turn: nothing is written down while you talk. Its audio is collected part by part (a
     * part ends at a longer pause, so in silence); at each such pause only the parts that are new
     * since the last check are written down, and the judge (Jev) is asked about the whole turn so
     * far: whether you're done. Null judge: the send and end words.
     */
    this.judge = null;
    /** The audio of this turn's parts, in order, and what changes it counts. */
    this.turnAudio = [];
    this.turnVersion = 0;
    /**
     * What each part said, once written down (by identity): a later check only writes down the
     * parts that are new. Parts written down together have their text on the last of them ("" on
     * the others).
     */
    this.written = new Map();
    /**
     * The whole turn written down in one pass, started at a check alongside the new part: what's
     * sent. A part written down on its own misses the words around it; the parts' text is only for
     * the screen and for Jev.
     */
    this.whole = null;
    /** Words of your turn said over a reply (written down then): they come before its audio. */
    this.turnPrefix = '';
    /** What a running check is doing: "writing" (the speech model) or "asking" (Jev); "" none. */
    this._checkStep = '';
    /** A check (writing down, then Jev) started (for the live line's seconds), 0 when none runs. */
    this.writingSince = 0;
    /** Messages handed to the outbox and not delivered yet. */
    this.outgoing = 0;
    /** Chief messages waiting to be read: at your next pause, or once the one playing ends. */
    this._held = [];
    /** Notes about replies you didn't hear (their reading failed, or you talked over them). */
    this._unheard = [];
    /**
     * A call with a talker: a reply to an older message than your latest isn't played (it no
     * longer fits what you said); your next message, or the call's end, says you didn't hear it.
     */
    this.dropsOutdated = false;
    /** Outdated replies dropped (their texts), not yet noted in a delivered message. */
    this.outdatedNotes = [];
    /**
     * Messages handed to the outbox so far (each one's number), the numbers on their way, the
     * latest delivered, and each sent request's number. Only a delivered message makes the
     * replies before it outdated.
     */
    this.handedOff = 0;
    this.latestSent = 0;
    this.onTheWay = new Set();
    this.requestNumber = new Map();
    /** The latest decisions with their reasons, oldest first. */
    this._reasons = [];
    /** The English of the last reason shown. */
    this.lastReason = '';
    /** What the call's end tells the chief: replies still waiting, or cut off by the end (see endNote()). */
    this._endNote = '';
    this.requests = [];
    /** Request → [replies so far, sent at]: for "Chief is working". */
    this.working = new Map();
    /** Checks of your turn (writing down, Jev) queued or running. */
    this.transcribing = 0;
    this._state = State.LISTENING;
    this._pending = '';
    this._status = '';
    this._error = '';
    this._reply = '';
    this.sendAfterFlush = false;
    this.takenByYou = false;
    /**
     * Send was pressed and your message hasn't gone yet (what you said may still be written down):
     * the screen says Sending… at once, and pressing again does nothing.
     */
    this.sendPressed = false;
    /** When your last message went: a press right after it belongs to it, not to what follows. */
    this.sentAt = Number.MIN_SAFE_INTEGER / 2;
    this.mutedUntil = 0;
    this.deliveredAt = Number.MIN_SAFE_INTEGER / 2;
    /** Until when a sound of ours may be in the microphone's frames. */
    this.cueUntil = 0;
    /** A sound was heard while the microphone was paused after a reply (said once per reply). */
    this.tailHeard = false;
    this.sinceCheck = 0;
    this.events = () => {};
    /** Plays a sound, true if it did; handsfree-call's are quiet and short, and may be off. */
    this.cues = () => false;
    this.reading = 0;
    this._sent = 0;
    this.current = null;
    this.playing = false;
    this.readingDeadline = 0;
    this.readingSince = 0;
    /** The call's end built its note (endNote); a message still in bb failing after this sends its words itself. */
    this.endNoted = false;
    this.settled = false;
    this.leftoverRunning = false;
    /** Last words for both threads' end line (sending failed), and for the chief's only (the talker got them). */
    this.unsentEnd = '';
    this.chiefOnlyEnd = '';
    this._voiceError = '';
    this.voiceErrorAt = 0;
    this.liveOff = '';
    this.liveOffAt = 0;
    /** When the first tick came; whether live transcription's state was logged (LIVE_CHECK_MS in). */
    this.firstTick = 0;
    this.liveChecked = false;
    /** The phrase skip logged last, so the live text's repeats don't fill the log. */
    this.lastSkip = '';
    /** Whose turn it was when last logged: "yours (why)", "ours (a reply plays)" or "silence". */
    this.turnLogged = 'silence';
    /**
     * A send phrase Jev said wasn't the end, as the turn's text (normalized): the live text keeps
     * ending with it until you say more, and that doesn't ask again. "" none.
     */
    this.heldPhrase = '';
    this.liveFailedSaid = false;

    const session = this;
    this.segmenter = new Segmenter(
      pauseMs,
      // Taking the floor needs takeMs of speech; once it's yours, short stretches count too.
      // Over a reply, BARGE_MS of your speech stops it.
      () => (session._state === State.READING ? HandsFreeSession.BARGE_MS : session.floorIsYours() ? HandsFreeSession.SHORT_MS : takeMs),
      gate,
      detector,
      {
        segment(pcm) {
          if (session.dropStretch) {
            // Its words were taken from live transcription (sent, or in the turn's words).
            session.dropStretch = false;
            session.log(
              format('the rest of the stretch with the phrase (%.1f s) was taken from live transcription already', pcm.length / HandsFree.BYTES_PER_SECOND),
            );
            // What you said after the phrase in the same breath ("Over. Build it.") is in the
            // live text only: it's your turn's, and this is a pause like any other.
            if (session.streaming()) session.check('rest');
            return;
          }
          session.addPart(pcm);
          // A longer pause: is the turn done? With Send pressed: it goes, no question.
          session.check(session.sendAfterFlush ? 'button' : 'pause');
        },
        started(level, background) {
          const taking = !session.takenByYou;
          session.takenByYou = true;
          session.stretchAt = session.clock();
          session.silenceTries = 0;
          session.silenceNextAt = 0;
          if (taking) {
            session.log(format('floor: you (level %.0f, background %.0f)', level, background));
            session.cue(Cue.HEARD);
            session.turnSpeechAt = session.clock();
            session.firstWordsLogged = false;
          }
          session.changed();
        },
        noise(speechMs, level, background) {
          session.dropStretch = false; // That stretch didn't count: the next one is yours again.
          session.log(format('noise ignored (%d ms, level %.0f, background %.0f)', speechMs, level, background));
          // Clicks are left out of the reasons; anything you might have meant is in. Not over a
          // reply: what's left of its echo would fill the list.
          if (speechMs >= 100 && session._state !== State.READING)
            session.reason(
              'Didn\'t count as speech: too short (%1$d ms, %2$d ms needed)',
              speechMs,
              session.floorIsYours() ? HandsFreeSession.SHORT_MS : takeMs,
            );
          // Send now during a sound too short to count: what was said before still goes.
          if (session.sendAfterFlush) session.check('button');
        },
        tooQuiet(ms, level, background) {
          session.log(format('too quiet to count (%d ms, level %.0f, background %.0f, gate ×%.1f)', ms, level, background, gate));
          if (session._state !== State.READING)
            session.reason('Didn\'t count as speech: too quiet (level %1$.0f < %2$.1f× background %3$.0f)', level, gate, background);
        },
      },
    );
  }

  changed() {
    try {
      this.changedListener();
    } catch (ex) {
      /* The screen is a help. */
    }
  }

  state() {
    return this._state;
  }

  /** What you said since the last message. */
  pending() {
    return this._pending;
  }

  /** The reply being read aloud, "" when none is. */
  replyText() {
    return this._reply;
  }

  /** The last thing that happened. */
  status() {
    return this._status;
  }

  /** The last error (a part not written down, a message not sent), "" when the last try worked. */
  error() {
    return this._error;
  }

  sent() {
    return this._sent;
  }

  speaking() {
    return this.segmenter.speaking();
  }

  /** A reply's audio is coming out. */
  audioPlaying() {
    return this._state === State.READING && this.playing;
  }

  /** Chief messages waiting to be read. */
  held() {
    return this._held.length;
  }

  /** What's happening right now, for the live line on screen and the call bar (Java's live()). */
  liveState() {
    if (this._state === State.ENDED) return Live.ENDED;
    const now = this.clock();
    if (this._state === State.READING) return !this.playing ? Live.REPLY_COMING : Live.PLAYING;
    const voiceReady = this._held.length === 0 || this._held[0].ready;
    if (now < this.mutedUntil) return Live.MUTED;
    if (this.segmenter.speaking()) return Live.HEARING;
    if (this.transcribing > 0) return Live.WRITING;
    if (this.sendPressed || this.outgoing > 0) return Live.SENDING;
    if (this.held() > 0) return voiceReady ? Live.REPLY_WAITING : Live.REPLY_COMING;
    if (this.hasTurn()) return Live.WAITING_SEND;
    if (now - this.deliveredAt < HandsFreeSession.SENT_SHOWN_MS) return Live.SENT;
    for (const w of this.working.values()) if (w[0] < 2 && now - w[1] < HandsFreeSession.WORKING_MS) return Live.WAITING_CHIEF;
    return Live.LISTENING;
  }

  /** The latest decisions with their reasons ({at, text, times}), newest first. */
  reasons() {
    return this._reasons.slice().reverse();
  }

  /**
   * A decision, with its reason in plain words: on screen (translated), and in the log (in
   * English). The same one again in a row counts up instead of filling the list.
   */
  reason(english, ...args) {
    this.log('→ ' + (args.length === 0 ? english : format(english, ...args)));
    this.show(english, false, args);
  }

  /**
   * A reason that counts up while it lasts ("… (3 s)"): it takes the place of the last one when
   * that's the same reason, and is logged only the first time.
   */
  ongoing(english, ...args) {
    const first = english !== this.lastReason;
    if (first) this.log('→ ' + format(english, ...args));
    this.show(english, true, args);
  }

  show(english, inPlace, args) {
    const text = tr(english, ...args);
    const now = this.clock();
    const last = this._reasons.length ? this._reasons[this._reasons.length - 1] : null;
    if (last != null && inPlace && english === this.lastReason) {
      this._reasons.pop();
      this._reasons.push({ at: now, text, times: 1 });
    } else if (last != null && last.text === text) {
      this._reasons.pop();
      this._reasons.push({ at: now, text, times: last.times + 1 });
    } else this._reasons.push({ at: now, text, times: 1 });
    this.lastReason = english;
    while (this._reasons.length > HandsFreeSession.REASONS) this._reasons.shift();
    this.changed();
  }

  /**
   * A quiet sound; for CUE_MS the microphone's frames can't start your speech or a barge-in. Not
   * for HEARD: it plays while you're talking, and your speech goes on through it.
   */
  cue(c) {
    try {
      if (this.cues(c) && c !== Cue.HEARD) this.cueUntil = this.clock() + HandsFreeSession.CUE_MS;
    } catch (ignored) {
      /* A sound is a help, not a must. */
    }
  }

  /** May a sound of ours be in the frame coming in now? */
  inCue() {
    return this.clock() < this.cueUntil;
  }

  /**
   * What the call's end tells the chief, after the end signal: the replies that never played
   * (still waiting), or the one cut off by the end. "" when every reply was heard.
   */
  endNote() {
    let note = this._endNote;
    const notNoted = [];
    this.endNoted = true; // A reply after this can't be noted any more.
    // Notes no message took (a reply you talked over or that was outdated), once the messages
    // on their way are settled (a failed one frees its notes).
    for (const n of this._unheard) if (n.claimedBy === 0) note += '\n\n' + n.text;
    for (const n of this.outdatedNotes) if (n.claimedBy === 0) notNoted.push(n.text);
    if (notNoted.length) note += '\n\n' + HandsFreeSession.missed(notNoted);
    note += this.unsentEnd;
    return note;
  }

  /**
   * After the call's end, once the messages on their way are settled: words a message that
   * failed left behind are sent now (with the notes it carried), so they aren't stranded. Tried
   * LEFTOVER_TRIES times, not past until (the clock's time). Resolves true when nothing is left.
   */
  async sendLeftover(until) {
    if (this._state !== State.ENDED) return true;
    this.settled = true;
    for (;;) {
      if (this.leftoverRunning) return false; // Another one is at it.
      this.leftoverRunning = true;
      let sent;
      try {
        sent = await this.leftoverOnce(until);
      } finally {
        this.leftoverRunning = false;
      }
      if (!sent) return false;
      // Words a message that failed meanwhile left (it saw this running): they go too.
      if (this.turnPrefix.trim() === '') return true;
    }
  }

  /**
   * Words left at the end, tried LEFTOVER_TRIES times. Given up, they go in the end line; if only
   * the talker got them, in the chief's end line. False when given up.
   */
  async leftoverOnce(until) {
    for (let tries = 0; ; tries++) {
      const text = this.turnPrefix.trim();
      this.turnPrefix = '';
      if (text === '') return true;
      this.log('words a message couldn\'t take before the end: sending them now' + (tries > 0 ? ' (try ' + (tries + 1) + ')' : ''));
      this.outgoing++;
      const h = this.handOff(true);
      const d = await this.deliver(text + h.notes, text, 'end of the call', h, this.clock());
      if (d === Delivery.CHIEF_MISSED) {
        // It counts as sent (the talker has them): the chief gets them with its end line.
        this.chiefOnlyEnd += '\n\n' + HandsFreeSession.notSent(text);
        this.log('the chief missed your last words: they go with its end of the call');
        return true;
      }
      if (d === Delivery.SENT) return true;
      // Not sent: deliver put them back in your turn, for the next try.
      if (tries + 1 >= HandsFreeSession.LEFTOVER_TRIES || this.clock() + HandsFreeSession.leftoverRetryMs > until) {
        const left = this.turnPrefix.trim();
        this.turnPrefix = '';
        if (left !== '') this.unsentEnd += '\n\n' + HandsFreeSession.notSent(left);
        this.log('words left at the call\'s end couldn\'t be sent: they go with the end of the call');
        return false;
      }
      await sleep(HandsFreeSession.leftoverRetryMs);
    }
  }

  /** Words that never reached a thread, for the end line. */
  static notSent(words) {
    return '[my last words, not sent before the end: "' + words.trim() + '"]';
  }

  /** The chief's end line: endNote() and the last words only the talker got. */
  endNoteForChief() {
    return this.endNote() + this.chiefOnlyEnd;
  }

  /** Chief messages that couldn't be read, not yet noted in a message. */
  unheard() {
    return this._unheard.length;
  }

  /** Is your turn going on: speaking, being written down, unsent text, or going out? */
  floorIsYours() {
    return this.takenByYou || this.segmenter.speaking() || this.transcribing > 0 || this.hasTurn() || this.outgoing > 0;
  }

  floor() {
    if (this._state === State.READING) return Floor.CHIEF;
    return this.floorIsYours() ? Floor.YOU : Floor.OPEN;
  }

  phase() {
    if (this._state === State.READING) return Phase.READING;
    if (this.outgoing > 0 || this.sendPressed) return Phase.SENDING;
    if (this.floorIsYours()) return Phase.LISTENING;
    const now = this.clock();
    for (const w of this.working.values()) if (w[0] < 2 && now - w[1] < HandsFreeSession.WORKING_MS) return Phase.WORKING;
    return Phase.LISTENING;
  }

  /** Each thing that happens, for the hands-free log (what went wrong in a turn). */
  onEvent(listener) {
    this.events = listener;
  }

  log(event) {
    try {
      this.events(event);
    } catch (ignored) {
      /* The log is a help. */
    }
  }

  /** The request sent last in this call; "" before the first. */
  lastRequest() {
    return this.requests.length === 0 ? '' : this.requests[this.requests.length - 1];
  }

  /** Is this one of the requests sent in this call? */
  ours(request) {
    return this.requests.includes(request);
  }

  /**
   * One 20 ms frame from the microphone. While a reply plays it's checked for you talking over
   * it (barge-in); for TAIL_MS after a reply ended frames are dropped, so its last word doesn't
   * start your turn.
   */
  frame(frame) {
    const cue = this.inCue();
    const l = this.live;
    if (l != null && l.working() && this._state !== State.ENDED) {
      // Live transcription hears everything you say (not only what the segmenter keeps); a reply
      // and its tail are silence to it (its echo isn't you): if you talk over it, what you said
      // over it goes first.
      const quiet = this._state === State.READING || this.clock() < this.mutedUntil;
      l.audio(quiet ? SILENCE : frame);
      if (this.segmenter.speaking()) l.speech();
    }
    if (this._state === State.READING) {
      this.bargeFrame(frame, cue);
      return;
    }
    if (this._state !== State.LISTENING) return;
    const now = this.clock();
    if (now < this.mutedUntil) {
      if (!this.tailHeard && Segmenter.level(frame, frame.length) > Math.max(600, this.segmenter.background() * this.gate)) {
        this.tailHeard = true;
        this.reason('A sound right after the reply was ignored (mic paused)');
      }
      return;
    }
    // A sound of ours just played: it can't start a stretch of speech (one going on goes on).
    if (cue && !this.segmenter.candidate()) return;
    this.segmenter.frame(frame);
    // A waiting reply plays once your turn is over: checked a few times a second.
    if (++this.sinceCheck >= 10) {
      this.sinceCheck = 0;
      this.noteTurn();
      if (this.held() > 0) this.readNext();
    }
  }

  /**
   * Barge-in: the microphone's frames while a reply plays go to the segmenter (the reply's echo
   * cancelled by the system); once it hears BARGE_MS of your speech the reply stops.
   */
  bargeFrame(frame, cue) {
    if (this._state !== State.READING) return; // Also before its audio starts: you may talk first.
    const token = this.reading;
    if (cue && !this.segmenter.candidate()) return; // A sound of ours, not you.
    this.segmenter.frame(frame);
    if (this.segmenter.speaking()) this.bargeIn(token);
  }

  /**
   * You talk over the reply: it stops at once and the rest of it is dropped (you've said something
   * new; it no longer fits). Your next message tells the chief how far you heard; your speech goes
   * on as your turn.
   */
  bargeIn(token) {
    const at = this.heardChars();
    if (token !== this.reading || this._state !== State.READING || this.current == null) return;
    const text = this.current.text;
    const speech = this.segmenter.voicedMs();
    const since = this.clock();
    const note = HandsFreeSession.heardUpTo(text, at);
    // What you said over it, from the start of that stretch (it took a moment to count as you).
    const said = this.segmenter.stretchAudio();
    if (!this.endReading(token, note, false)) return;
    this.speaker.stop();
    const l = this.live;
    if (l != null && l.working()) for (let i = 0; i + 640 <= said.length; i += 640) l.audio(said.subarray(i, i + 640));
    this.log(
      format(
        'barge-in: speech %d ms → stopped (in %d ms, at character %d of %d); the rest is dropped, your next message says %s',
        speech,
        this.clock() - since,
        at,
        text.length,
        note,
      ),
    );
    this.reason('Reply stopped: you talked over it; the chief will hear how far you got');
  }

  heardChars() {
    return typeof this.speaker.heardChars === 'function' ? this.speaker.heardChars() : 0;
  }

  speakerPlaying() {
    return typeof this.speaker.playing === 'function' ? this.speaker.playing() : false;
  }

  speakerDrop(prepared) {
    if (typeof this.speaker.drop === 'function') this.speaker.drop(prepared);
  }

  /** The note for a reply you interrupted: its last words you heard (or that you heard none). */
  static heardUpTo(reply, heardChars) {
    let part = reply.substring(0, Math.max(0, Math.min(heardChars, reply.length))).trim();
    // A word cut in the middle wasn't heard.
    if (heardChars < reply.length && heardChars > 0 && isLetterOrDigit(reply.charAt(heardChars)) && isLetterOrDigit(reply.charAt(heardChars - 1)))
      part = part.replace(/\S+$/, '').trim();
    const w = part === '' ? [] : part.split(/\s+/);
    if (w.length < 2) return HandsFreeSession.missed(reply);
    const last = w.slice(Math.max(0, w.length - 8)).join(' ');
    return '[heard up to: "' + (w.length > 8 ? '…' : '') + last + '"]';
  }

  /**
   * The voice model failed to deliver a reply's audio (why: its HTTP status and what it said, or
   * how long it didn't answer): on screen, on the call bar a while, and in the log. With the
   * system voice the reply is read in it; without, playing it fails and it's tried once more.
   */
  voiceFailed(why, android) {
    this._voiceError = why;
    this.voiceErrorAt = this.clock();
    if (android) this.reason('Voice failed (%1$s): the Mac\'s voice reads the reply', why);
    else this.reason('Voice failed (%1$s): no other voice works on this Mac', why);
  }

  /** Why the voice model failed, while it's shown; "" otherwise. */
  voiceError() {
    return this.clock() - this.voiceErrorAt < HandsFreeSession.VOICE_ERROR_MS ? this._voiceError : '';
  }

  /**
   * liveKeyMissing(provider): live transcription is on, but its provider (AssemblyAI,
   * ElevenLabs) has no key: your words are written down from their audio at each pause, and a
   * send word doesn't send at once. Said at the call's start: in the reasons, on the screen for
   * the whole call, on the call bar a while. liveKeyMissing(): that provider, "" when it isn't.
   */
  liveKeyMissing(provider) {
    if (provider === undefined) return this.liveOff;
    this.liveOff = provider;
    this.liveOffAt = this.clock();
    this.reason('Live transcription is off: no %1$s key (Settings → Hands-free)', provider);
    return undefined;
  }

  /** Is the call bar still to say so? */
  liveOffRecent() {
    return this.liveOff !== '' && this.clock() - this.liveOffAt < HandsFreeSession.LIVE_OFF_MS;
  }

  /** Once a second: a long silence sends anyway, a held reply may start, a hung voice is let go. */
  tick() {
    if (this._state === State.ENDED) return;
    const now = this.clock();
    this.liveCheck(now);
    const token = this.reading;
    let late = this._state === State.READING && now > this.readingDeadline;
    // Longer than it said, but audio still coming out: let it finish.
    if (late && this.playing && now - this.readingSince < HandsFreeSession.READING_CAP_MS && this.speakerPlaying()) {
      this.readingDeadline = now + HandsFreeSession.OVERRUN_MS;
      late = false;
    }
    if (late) {
      const started = this.playing;
      this.log(started ? 'the reply played too long: listening again' : 'the reply\'s audio didn\'t start: listening again');
      this.speaker.stop();
      this.finishReading(token, false, started ? tr('it played far too long') : tr('its audio didn\'t start'));
      return;
    }
    if (
      this._state === State.LISTENING &&
      this.hasTurn() &&
      !this.segmenter.candidate() &&
      this.transcribing === 0 &&
      this.outgoing === 0 &&
      this.segmenter.quietMs() >= this.silenceSendMs &&
      now >= this.silenceNextAt
    ) {
      // Tried again later if it fails (bb unreachable, nothing written down): not every second.
      const tries = this.silenceTries++;
      this.silenceNextAt = now + Math.min(HandsFreeSession.SILENCE_RETRY_MAX_MS, HandsFreeSession.SILENCE_RETRY_MS * 2 ** Math.min(tries, 3));
      if (tries > 0) this.log('silence send: trying again (' + (tries + 1) + ')');
      this.check('silence');
    }
    // Words live transcription heard while nobody had the floor (noise, a TV, someone else) don't
    // start your next turn.
    const l = this.live;
    if (
      l != null &&
      l.working() &&
      this._state === State.LISTENING &&
      this.floor() === Floor.OPEN &&
      !this.segmenter.candidate() &&
      this.segmenter.quietMs() >= HandsFreeSession.STRAY_MS &&
      l.text() !== ''
    ) {
      this.log('live text heard words while nobody had the floor: dropped ("' + tail(l.text()) + '")');
      l.discard();
    }
    this.readNext();
  }

  /** Runs r on the work queue; rejected instead once the call ended. */
  execute(r, rejected) {
    if (!this.work.execute(r) && rejected) rejected(); // Ended.
  }

  /** Is live transcription on and working, for this turn? */
  streaming() {
    const l = this.live;
    return l != null && l.working() && !this.batchTurn;
  }

  /**
   * The live text changed (from the transcription): shown as your words, and a send or end
   * phrase at its end acts at once (checked on the work queue: the model's final text decides).
   */
  liveText(text) {
    const ending =
      text === '' ? null : HandsFree.endsWith(text, this.endWords) != null ? 'end' : HandsFree.endsWith(text, this.sendWords) != null ? 'send' : null;
    if (this._state !== State.LISTENING || !this.streaming() || text === '' || !this.floorIsYours()) {
      if (ending != null)
        this.phraseSkipped(
          ending,
          text,
          this._state === State.READING
            ? 'a reply is playing'
            : this._state !== State.LISTENING
              ? 'the call ended'
              : !this.streaming()
                ? this.batchTurn
                  ? 'this turn is written down from its audio'
                  : 'live transcription isn\'t working'
                : 'nobody had the floor (no speech heard)',
        );
      return;
    }
    const now = this.live;
    if (now != null && text !== now.text()) {
      // Overtaken (its turn was just taken).
      if (ending != null) this.phraseSkipped(ending, text, 'the live text moved on (its turn was just taken)');
      return;
    }
    const prefix = this.turnPrefix;
    this._pending = (prefix + ' ' + text).trim();
    this.liveWordsAt = this.clock();
    if (!this.firstWordsLogged && this.turnSpeechAt > 0) {
      this.firstWordsLogged = true;
      this.log(format('live text: first words %d ms after you started speaking', this.clock() - this.turnSpeechAt));
    }
    this.changed();
    const phrase = ending;
    if (phrase == null) return;
    if (phrase === 'send' && this.heldPhrase === HandsFree.normalize(this._pending)) {
      this.phraseSkipped(phrase, text, 'Jev said you weren\'t done with these words');
      return;
    }
    if (this.keyword) {
      this.phraseSkipped(phrase, text, 'a phrase is being checked already');
      return;
    }
    this.keyword = true;
    this.keywordAt = this.clock();
    this.log('live text ends with the ' + phrase + ' phrase: "' + tail(text) + '"');
    this.check(phrase === 'end' ? 'end phrase' : 'send phrase');
  }

  /** Once, LIVE_CHECK_MS into the call: is live transcription running, so a log says why "over" didn't act. */
  liveCheck(now) {
    if (this.liveChecked) return;
    if (this.firstTick === 0) this.firstTick = now;
    if (now - this.firstTick < HandsFreeSession.LIVE_CHECK_MS) return;
    this.liveChecked = true;
    const l = this.live;
    this.log(
      'live transcription ' +
        HandsFreeSession.LIVE_CHECK_MS / 1000 +
        ' s into the call: ' +
        (l == null ? 'not used (off, or no key)' : !l.working() ? 'failed (' + l.failure() + '): send words act at your pauses only' : 'working'),
    );
  }

  /** Logs why a send or end phrase at the end of the live text didn't act: every one says why. */
  phraseSkipped(phrase, text, why) {
    const line = 'live text ends with the ' + phrase + ' phrase, not acted on: ' + why + ' ("' + tail(text) + '")';
    if (line === this.lastSkip) return;
    this.lastSkip = line;
    this.log(line);
  }

  /**
   * What was said before hands-free started (the dictation it was switched to from): written down
   * as the start of your first turn, which it holds the floor for.
   */
  seed(pcm) {
    if (pcm.length === 0) return;
    this.log(format('started from a dictation (%.1f s)', pcm.length / HandsFree.BYTES_PER_SECOND));
    this.takenByYou = true;
    this.addPart(pcm);
    this.check('seed'); // Shown; you go on talking, so not judged yet.
  }

  /**
   * Send now (the call bar's, the panel's or the global hotkey). It shows at once (Sending…),
   * since your message may wait for what you said last to be written down; a second press
   * meanwhile, or right after it went, does nothing (it would send the next words you start on
   * their own). Every press is logged, also the ones that do nothing.
   */
  sendNow() {
    if (this._state === State.ENDED) return;
    if (this.sendPressed) {
      this.log('send pressed again: already sending');
      this.reason('Send ignored: already sending');
      return;
    }
    const since = this.clock() - this.sentAt;
    if (since < HandsFreeSession.REPRESS_MS) {
      this.log('send pressed right after your message went: taken as the same press');
      this.reason('Send ignored: just sent (%1$.1f s ago)', since / 1000.0);
      return;
    }
    // Sounds that didn't count as speech just before: Send means they were meant, so they're
    // written down and sent.
    const noise =
      this._state === State.LISTENING && !this.hasTurn() && this.transcribing === 0 && !this.segmenter.candidate() ? this.segmenter.takeNoise() : null;
    if (noise != null) {
      this.sendPressed = true;
      this.takenByYou = true;
      this.log(format('send pressed: writing down the last %.1f s of sounds that didn\'t count as speech', noise.length / HandsFree.BYTES_PER_SECOND));
      this.reason('Send: writing down what didn\'t count as speech, then it goes');
      this.addPart(noise);
      this.check('button');
      return;
    }
    if (!this.hasTurn() && this.transcribing === 0 && !this.talking()) {
      if (this._state === State.READING) {
        this.log('send pressed while a reply is read: nothing of yours to send (talk over the reply to interrupt it)');
        this.reason('Send ignored: a reply is playing and you have nothing unsent');
      } else {
        this.log('send pressed: nothing said yet');
        this.reason('Send ignored: nothing heard yet');
      }
      return;
    }
    this.sendPressed = true;
    this.changed();
    if (this.talking()) {
      this.log('send pressed: ending what you\'re saying');
      this.reason('Send: ending what you\'re saying, then it goes');
      this.sendAfterFlush = true;
      this.segmenter.flush(true); // Written down even if it didn't count as speech yet.
    } else {
      // Your unsent words go also while a reply plays: sending doesn't stop it. Written down
      // first (after a check that's running), never judged: Send always sends.
      this.log('send pressed: writing down your turn, then it goes' + (this._state === State.READING ? ' (a reply plays on)' : ''));
      this.reason('Send: writing down your turn, then it goes');
      this.check('button');
    }
  }

  /** Ends the call. What you said but didn't send yet is sent before the end. */
  end() {
    if (this._state === State.ENDED) return;
    // What you're saying right now is part of your last words.
    if (this._state === State.LISTENING) this.segmenter.flush(true);
    const at = this._state === State.READING ? this.heardChars() : 0;
    let note = '';
    if (this._state === State.ENDED) return; // Ended once only (End and an end phrase at once).
    // The chief hears once, with the call's end, which replies never reached you.
    if (this._state === State.READING && this.current != null) note += '\n\n' + HandsFreeSession.heardUpTo(this.current.text, at);
    for (const h of this._held) {
      note += '\n\n' + HandsFreeSession.missed(h.text);
      h.dropped = true; // A voice still being fetched is let go when it comes.
    }
    const dropped = this._held.slice();
    const waiting = this._held.length;
    // Notes no message takes are added by endNote(), once the messages on their way settled.
    this._held = [];
    this._state = State.ENDED;
    for (const h of dropped) this.speakerDrop(h.prepared); // Not played: not fetched on.
    this._endNote = note;
    if (waiting > 0) this.log('ended with ' + waiting + ' reply(ies) still waiting: the chief is told');
    this.sendUnsent();
    this.log('ended');
    this.speaker.stop();
    this._status = 'ended';
    this.work.shutdown();
    const l = this.live;
    if (l != null) {
      // After your last words are taken from it.
      if (!this.outbox.execute(() => l.close())) l.close();
    }
    this.outbox.shutdown(); // Messages on their way still go.
    this.voicesOpen = false;
    this.speechOpen = false;
    this.changed();
  }

  /**
   * A spoken message from the chief: its audio is fetched right away, while the floor stays open;
   * once ready it's read on an open floor, else held. published is when ntfy got it (unix ms, 0 if
   * unknown), for the log's timings; untagged: the talker's update without a request ID. Its
   * request is then the latest one handed over (lastRequest), also while that message is on its
   * way: it answers that one.
   */
  reply(request, text, published = 0, untagged = false) {
    if (this._state === State.ENDED) {
      this.replyAfterEnd(request, text);
      return;
    }
    const h = new Held(request, text, this.clock());
    const w = this.working.get(request);
    if (w != null) w[0]++;
    const since = w == null ? -1 : this.clock() - w[1];
    const n = this.requestNumber.get(request);
    h.answers = n == null ? 0 : n;
    const old = this.outdated(h);
    if (old) this.outdatedNotes.push(new Note(text));
    else this._held.push(h);
    if (old) {
      this.log(
        'chief message ' +
          request +
          ' dropped (' +
          text.length +
          ' characters): it answers an older message than your latest; your next message says you didn\'t hear it',
      );
      this.reason('An older reply wasn\'t played: you\'ve said more since. Your next message says so');
      this.changed();
      return;
    }
    // ntfy's time is in whole seconds (and the server's clock): about how long delivery took.
    const ntfy = published <= 0 ? -1 : Math.max(0, Date.now() - published);
    this.log(
      'chief message ' +
        request +
        (untagged ? ' (untagged)' : '') +
        ' (' +
        text.length +
        ' characters' +
        (since < 0 ? '' : ', ' + since + ' ms after your message went') +
        (ntfy < 0 ? '' : ', ntfy delivered it ~' + Math.trunc(ntfy / 1000) + ' s after it was posted') +
        ')',
    );
    this.prepare(h);
    this.readNext(); // Says why it waits, if it does.
    this.changed();
  }

  /**
   * Does this reply answer an older message than your latest delivered one? Only in a call with a
   * talker. A reply before your first message is outdated once one is delivered. One that comes
   * while your message is on its way waits (it's your turn) until it's delivered: then it's
   * outdated if it answers an older one.
   */
  outdated(h) {
    return this.dropsOutdated && h.answers < this.latestSent;
  }

  /**
   * A reply after the call's end isn't played: noted with the end, while its note is still to be
   * built; else only logged.
   */
  replyAfterEnd(request, text) {
    const noted = !this.endNoted;
    if (noted) this._unheard.push(new Note(HandsFreeSession.missed(text)));
    this.log(
      'chief message ' +
        request +
        ' after the call\'s end (' +
        text.length +
        ' characters): ' +
        (noted ? 'noted with the end' : 'not played, and the end was already sent'),
    );
  }

  /** Fetches a reply's audio (in the background, each at once); once ready it plays when it may. */
  prepare(h) {
    if (!this.voicesOpen) return; // The call ended.
    (async () => {
      const start = this.clock();
      try {
        h.prepared = await this.speaker.prepare(h.request, h.text);
        if (h.dropped) {
          this.speakerDrop(h.prepared); // Dropped while its voice was fetched.
          return;
        }
        if (!this.voicesOpen) return; // The call ended meanwhile (Java interrupts the fetch).
        this.log('voice ready for ' + h.request + ' in ' + (this.clock() - start) + ' ms');
      } catch (ex) {
        this.log('voice not ready for ' + h.request + ': ' + message(ex));
      }
      h.readyAt = this.clock();
      h.ready = true;
      this.readNext();
    })().catch((ex) => this.log('internal error: ' + message(ex)));
  }

  /**
   * The next waiting reply plays once its audio is ready and nobody has the turn (silence): never
   * during your turn (yourTurn), however long it lasts. Why it waits is shown once per reason, and
   * when it plays after waiting; while its voice is fetched the seconds count up on screen.
   */
  readNext() {
    this.noteTurn();
    let waits;
    let plays = null;
    const now = this.clock();
    let fetching = 0;
    if (this._state !== State.LISTENING || this._held.length === 0) return;
    const first = this._held[0];
    waits = this.holds(first, now);
    if (waits === 'voice') {
      // Shown from a second on (a voice is usually ready by then), and counted up each second.
      fetching = Math.trunc((now - first.arrived) / 1000);
      if (fetching < 1 || fetching === first.voiceShown) return;
      first.voiceShown = fetching;
    } else if (waits != null) {
      if (waits === first.toldWhy) return;
      first.told = true;
      first.toldWhy = waits;
    } else if (first.told) {
      plays = this.yourTurn(now) != null ? 'capped' : 'silence';
    }
    if (waits != null) {
      switch (waits) {
        case 'voice':
          this.ongoing('Reply waits: its voice is being fetched (%1$d s)', fetching);
          return;
        case 'speaking':
          this.reason('Reply waits: you\'re talking');
          break;
        case 'writing down':
          this.reason('Reply waits: checking whether you\'re done');
          break;
        case 'sending':
          this.reason('Reply waits: your message is being sent');
          break;
        default:
          this.reason('Reply waits: your turn (unsent words)');
      }
      this.readNext(); // It may play right away after all (it was told, so this doesn't repeat).
      return;
    }
    if (plays === 'capped') this.reason('Reply plays: it waited %1$d s without new words from you', HandsFreeSession.HOLD_MAX_MS / 1000);
    else if (plays != null) this.reason('Reply plays: your turn is over');
    // A sound that hasn't counted as speech yet ends as noise (if it was you, talking on over the
    // reply interrupts it). Speech going on (a reply past its cap) ends as a part of your turn,
    // so the reset below doesn't lose it.
    this.segmenter.flush(this.segmenter.speaking());
    if (this._state !== State.LISTENING || this._held.length === 0 || this.holds(this._held[0], this.clock()) != null) return;
    const next = this._held.shift();
    this._state = State.READING;
    this._reply = next.text;
    this.current = next;
    this.playing = false;
    // The microphone stays on: what it hears over the reply goes to the segmenter, afresh.
    this.segmenter.reset();
    this.dropStretch = false; // Whatever stretch was going on is gone.
    this.segmenter.bursts = false;
    const token = ++this.reading;
    this.readingSince = this.clock();
    this.readingDeadline = this.readingSince + HandsFreeSession.START_MS;
    this._status = 'reading';
    this.log('floor: chief, reading ' + next.request);
    this.noteTurn();
    this.cue(Cue.REPLY);
    this.changed();
    const session = this;
    try {
      this.speaker.play(next.request, next.text, next.prepared, {
        started(durationMs) {
          if (token !== session.reading || session._state !== State.READING) return;
          session.playing = true;
          session.readingDeadline = session.clock() + durationMs + HandsFreeSession.OVERRUN_MS;
          const at = session.clock();
          session.log(format('audio started (%.1f s) after %d ms', durationMs / 1000.0, at - session.readingSince));
          // Where the time went between the reply arriving and you hearing it.
          session.log(
            format(
              'timing %s: voice %d ms, then waiting %d ms, then starting %d ms (%.1f s from arrival)',
              next.request,
              next.readyAt - next.arrived,
              session.readingSince - next.readyAt,
              at - session.readingSince,
              (at - next.arrived) / 1000.0,
            ),
          );
        },
        ended(played) {
          session.finishReading(token, played, tr('the voice stopped'));
        },
      });
    } catch (ex) {
      this.log('the voice failed: ' + message(ex));
      this.finishReading(token, false, tr('the voice failed (%1$s)', message(ex)));
    }
  }

  /**
   * Why the first waiting reply can't play now: it's your turn (yourTurn's why) or "voice" (its
   * audio isn't ready); null when it can.
   */
  holds(first, now) {
    const yours = this.yourTurn(now);
    if (yours != null && !this.heldTooLong(first, now)) return yours;
    return first.ready ? null : 'voice';
  }

  /**
   * Has it waited HOLD_MAX_MS, once ready, without new words from live transcription, and isn't
   * a stretch of your speech going on that started less than LONG_STRETCH_MS ago?
   */
  heldTooLong(h, now) {
    const waited = now - Math.max(h.readyAt, this.liveWordsAt);
    if (!h.ready || waited < HandsFreeSession.HOLD_MAX_MS) return false;
    if (this.segmenter.speaking()) return now - this.stretchAt >= HandsFreeSession.LONG_STRETCH_MS;
    // A sound just starting may be your next sentence; past twice the cap it's noise that never
    // becomes speech (road bumps, an indicator clicking).
    return !this.segmenter.candidate() || waited >= 2 * HandsFreeSession.HOLD_MAX_MS;
  }

  /**
   * Is it your turn, and why: "unsent words", "speaking", "writing down" (a check of your turn)
   * or "sending" (Send pressed, or a message on its way); null when it isn't. Unsent words come
   * from live transcription while it works for this turn: words in the live text since your last
   * message (or kept from before), so loudness alone doesn't give you the turn; speech without
   * words yet holds it WORDLESS_MS at most. Without it (off, no key, failed) they come from your
   * unsent audio parts (and their words written down), and speech holds the turn while it goes on.
   * A sound that hasn't counted as speech (a cough, noise) never does.
   */
  yourTurn(now) {
    if (this.streaming()) {
      const words = this._pending !== '' || this.turnPrefix !== '';
      if (!words && this.segmenter.speaking() && now - this.stretchAt < HandsFreeSession.WORDLESS_MS) return 'speaking';
      if (this.transcribing > 0) return 'writing down';
      if (words) return 'unsent words';
    } else {
      if (this.segmenter.speaking()) return 'speaking';
      if (this.transcribing > 0) return 'writing down';
      if (this.hasTurn() || this._pending !== '') return 'unsent words';
    }
    if (this.outgoing > 0 || this.sendPressed) return 'sending';
    return null;
  }

  /**
   * Logs each change of turn, so the log shows why a reply waited: "turn: yours (unsent words)",
   * "turn: ours (a reply plays)", "turn: silence (sent)".
   */
  noteTurn() {
    if (this._state === State.ENDED) return;
    const why = this._state === State.READING ? null : this.yourTurn(this.clock());
    const now = this._state === State.READING ? 'ours (a reply plays)' : why != null ? 'yours (' + why + ')' : 'silence';
    if (this.turnLogged === now) return;
    const was = this.turnLogged;
    this.turnLogged = now;
    if (now !== 'silence') this.log('turn: ' + now);
    else {
      let because;
      switch (was) {
        case 'ours (a reply plays)':
          because = 'the reply ended';
          break;
        case 'yours (sending)':
          because = 'sent';
          break;
        case 'yours (writing down)':
          because = 'nothing to send';
          break;
        case 'yours (speaking)':
          because = 'no words';
          break;
        default:
          because = 'your words were let go';
      }
      this.log('turn: silence (' + because + ')');
    }
  }

  /**
   * Reading number token ended (finished or given up): the floor is open again. A reply that didn't
   * play is noted in your next message as not heard.
   */
  finishReading(token, played, why) {
    if (token !== this.reading || this._state !== State.READING) return;
    const started = this.playing;
    const heard = played && this.playing;
    const failed = heard ? null : this.current;
    let note = null;
    let again = null;
    if (heard) this.log('reply played to the end');
    else if (failed != null && started) {
      // Part of it was heard: not played again from its start; your next message says how far.
      const at = this.heardChars();
      note = HandsFreeSession.heardUpTo(failed.text, at);
      this.log('reply stopped part-way (' + why + ', at character ' + at + ' of ' + failed.text.length + '): not played again; your next message says ' + note);
      this.cue(Cue.FAILED);
      this.reason('Reply stopped part-way (%1$s): your next message tells the chief how far you heard', why);
    } else if (failed != null && failed.failures < HandsFreeSession.RETRIES) {
      // Never given up at once: its voice is fetched again (the voice model, else the system's).
      again = new Held(failed.request, failed.text, this.clock());
      again.failures = failed.failures + 1;
      again.told = true;
      this.log('reply not played (' + why + '): trying again (' + again.failures + ' of ' + HandsFreeSession.RETRIES + ')');
      this.reason('Reply couldn\'t be played (%1$s): trying again', why);
    } else {
      note = failed == null ? null : HandsFreeSession.missed(failed.text);
      this.log('reply not heard: noted in your next message');
      this.cue(Cue.FAILED);
      this.reason('Reply couldn\'t be played: %1$s. Your next message tells the chief', why);
    }
    if (!this.endReading(token, note, true)) return;
    if (again != null) {
      this._held.unshift(again);
      this.prepare(again);
    }
    this.readNext();
  }

  /**
   * Ends reading number token: note (if any) goes with your next message; tail mutes the
   * microphone a moment and forgets what it heard during the reply. Not when you talked over it:
   * then your speech goes on, as your turn. False if it had ended.
   */
  endReading(token, note, tailMute) {
    if (token !== this.reading || this._state !== State.READING) return false;
    if (note != null) this._unheard.push(new Note(note));
    // You started talking over its last words: they're kept, the microphone stays on.
    if (tailMute && this.segmenter.candidate()) tailMute = false;
    this.current = null;
    this.mutedUntil = tailMute ? this.clock() + HandsFreeSession.TAIL_MS : 0;
    this.tailHeard = false;
    if (tailMute) {
      this.segmenter.reset();
      this.dropStretch = false;
    }
    this.segmenter.bursts = true;
    this._reply = '';
    this._state = State.LISTENING;
    this._status = 'listening';
    this.log('floor: ' + (tailMute ? 'open' : 'you'));
    this.noteTurn();
    if (tailMute) this.reason('Mic paused %1$.1f s after the reply (echo)', HandsFreeSession.TAIL_MS / 1000.0);
    this.changed();
    return true;
  }

  /**
   * The call ended with words of yours not sent yet: they go now (written down first, if they
   * weren't), on the outbox, so before the chief hears the call ended.
   */
  sendUnsent() {
    if (this.turnAudio.length === 0 && this.turnPrefix === '') return;
    const audio = this.turnAudio.slice();
    const prefix = this.turnPrefix;
    this.turnAudio = [];
    this.turnPrefix = '';
    this.turnVersion++;
    this.log('ended with words not sent yet (' + audio.length + ' part(s)): they\'re sent before the call\'s end');
    this.outgoing++;
    const queued = this.clock();
    const last = async () => {
      let text = null;
      if (this.streaming())
        try {
          text = (prefix + ' ' + (await this.live.take(HandsFreeSession.TAKE_MS))).trim();
        } catch (ex) {
          this.liveFailed(message(ex));
        }
      let missing = false;
      if (text == null) {
        const all = this.startWhole(audio);
        let parts;
        try {
          const w = await this.writeTurn(audio, 'end');
          parts = (prefix + ' ' + w.text).trim();
          if (w.parts > 0) this.log(format('your last words: %d new part(s), %.1f s, written down in %d ms', w.parts, w.seconds, w.ms));
        } catch (ex) {
          // What was written down before still goes (and all of it, if the whole pass works).
          missing = true;
          parts = (prefix + ' ' + this.partsText(audio)).trim();
          this.log('some of your last words couldn\'t be written down (' + message(ex) + '): what was goes');
        }
        text = await this.toSend(parts, all, prefix);
      }
      if (text === '') {
        this.log(missing ? 'your last words couldn\'t be written down: not sent' : 'your last words had no words in them: nothing sent');
        this.outgoing--;
        return;
      }
      const h = this.handOff(true);
      await this.deliver(text + h.notes, text, 'end of the call', h, queued);
    };
    if (!this.outbox.execute(last)) last().catch((ex) => this.log('internal error: ' + message(ex)));
  }

  /** Is there a turn of yours not sent yet (audio or words)? */
  hasTurn() {
    return this.turnAudio.length !== 0 || this.turnPrefix !== '';
  }

  /** A part of your turn: its audio, written down at the next check. */
  addPart(pcm) {
    this.turnAudio.push(pcm);
    this.turnVersion++;
    this.takenByYou = true;
  }

  /**
   * Checks your turn, on the work queue: why is "pause" (a longer pause: written down, then Jev
   * asked whether you're done), "button" or "silence" (written down and sent, no question), "seed"
   * (written down to show it), "rest", or "send phrase"/"end phrase".
   */
  check(why) {
    this.transcribing++;
    this.execute(
      () => this.checkNow(why),
      () => this.transcribing--,
    );
  }

  /** What a running check is doing: "writing", "asking" or "". */
  checkStep() {
    return this.transcribing === 0 ? '' : this._checkStep;
  }

  /**
   * Writes down audio with the speech model, at most writeTimeoutMs a try, twice: a request that
   * hangs is given up (and logged) rather than waited for.
   */
  async writeDown(pcm, why) {
    const file = HandsFree.wav(pcm);
    if (!this.speechOpen) return String(await this.transcriber(file)).trim(); // The call ended: your last words, here.
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const f = Promise.resolve().then(() => this.transcriber(file));
      f.catch(() => {}); // A try given up may still fail later.
      try {
        return String(await withTimeout(f, HandsFreeSession.writeTimeoutMs)).trim();
      } catch (ex) {
        if (!(ex instanceof TimeoutError)) throw ex;
        const secs = HandsFreeSession.writeTimeoutMs / 1000.0;
        this.log(format('writing down (%s) took over %.0f s: %s', why, secs, attempt === 1 ? 'trying once more' : 'given up'));
        if (attempt === 1) this.reason('Writing down took over %1$.0f s: trying once more', secs);
        last = new Error(tr('the speech model took over %1$.0f s', secs));
      }
    }
    throw last;
  }

  /**
   * Starts writing down these parts in one pass, in the background (or finds the pass already
   * started for them); null for a single part: its own pass is the whole.
   */
  startWhole(audio) {
    if (audio.length < 2) return null;
    let w = this.whole;
    if (w != null && w.parts.length === audio.length) {
      let same = true;
      for (let i = 0; i < audio.length && same; i++) same = w.parts[i] === audio[i];
      if (same) return w;
    }
    w = new Whole(audio.slice(), this.clock());
    this.whole = w;
    const pass = w;
    pass.text = (async () => {
      try {
        return await this.writeDown(joined(pass.parts), 'whole turn');
      } finally {
        pass.done = this.clock();
      }
    })();
    pass.text.catch(() => {}); // Seen where it's waited for.
    return pass;
  }

  /**
   * The text that goes: the whole turn's pass (prefix before it), waited for; without one (a
   * single part), or if it failed, the parts' text. The log says what it took and how many words
   * it changed.
   */
  async toSend(partsText, w, prefix) {
    if (w == null) return partsText;
    const start = this.clock();
    try {
      const all = (prefix + ' ' + (await w.text)).trim();
      this.log(
        format(
          'whole turn (%d parts) written down in %d ms (waited %d ms for it); it changed %d of %d words of the parts\' text',
          w.parts.length,
          w.done - w.started,
          this.clock() - start,
          HandsFreeSession.wordsChanged(partsText, all),
          HandsFree.normalize(partsText).split(' ').length,
        ),
      );
      return all === '' ? partsText : all;
    } catch (ex) {
      this.log('the whole turn couldn\'t be written down (' + message(ex) + '): the parts\' text goes');
      return partsText;
    }
  }

  /** How many words differ between two texts (words added, dropped or changed), case and punctuation ignored. */
  static wordsChanged(a, b) {
    const na = HandsFree.normalize(a);
    const nb = HandsFree.normalize(b);
    const x = na === '' ? [] : na.split(' ');
    const y = nb === '' ? [] : nb.split(' ');
    const d = new Array(y.length + 1);
    for (let j = 0; j <= y.length; j++) d[j] = j;
    for (let i = 1; i <= x.length; i++) {
      let diagonal = d[0];
      d[0] = i;
      for (let j = 1; j <= y.length; j++) {
        const was = d[j];
        d[j] = Math.min(Math.min(d[j] + 1, d[j - 1] + 1), diagonal + (x[i - 1] === y[j - 1] ? 0 : 1));
        diagonal = was;
      }
    }
    return d[y.length];
  }

  /**
   * The text of a turn's parts: those written down before as they were, the new ones written down
   * now, together in one pass (usually there's one: the part that just ended). Each part ends in
   * a pause, so no word is cut between two. Resolves { text, parts, seconds, ms }: the parts that
   * were new, their seconds, and how long.
   */
  async writeTurn(audio, why) {
    const fresh = audio.filter((p) => !this.written.has(p));
    let ms = 0;
    let bytes = 0;
    if (fresh.length) {
      const start = this.clock();
      const t = await this.writeDown(joined(fresh), why);
      ms = this.clock() - start;
      for (const p of fresh) bytes += p.length;
      for (const p of fresh) this.written.set(p, '');
      this.written.set(fresh[fresh.length - 1], t);
    }
    return { text: this.partsText(audio), parts: fresh.length, seconds: bytes / HandsFree.BYTES_PER_SECOND, ms };
  }

  /** What these parts said, those written down so far, joined. */
  partsText(audio) {
    let text = '';
    for (const p of audio) {
      const t = this.written.get(p) || '';
      if (t !== '') text += (text === '' ? '' : ' ') + t;
    }
    return text;
  }

  /** Keeps only the written-down texts of parts still in the turn (Java's written.keySet().retainAll). */
  retainWritten() {
    for (const p of [...this.written.keys()]) if (!this.turnAudio.includes(p)) this.written.delete(p);
  }

  async checkNow(why) {
    const original = why;
    const button = why === 'button' || (why === 'rest' && this.sendAfterFlush);
    try {
      if (this._state === State.ENDED) return;
      if (why.endsWith(' phrase')) {
        await this.phrase(why === 'end phrase');
        return;
      }
      if (why === 'rest') {
        await this.takeRest();
        why = this.sendAfterFlush ? 'button' : 'pause'; // Send pressed during the stretch: it goes.
      }
      let audio = this.turnAudio.slice();
      let prefix = this.turnPrefix;
      let version = this.turnVersion;
      if (audio.length === 0 && prefix === '') {
        if (button) {
          this.sendAfterFlush = false;
          this.sendPressed = false;
          if (this.clock() - this.sentAt < 10_000) {
            this.log('send: your message had already gone');
            this.reason('Send: your message had already gone');
          } else this.reason('Nothing to send: no words were written down');
          this.changed();
        }
        return;
      }
      const start = this.clock();
      this.writingSince = start;
      this.changed();
      let text = prefix;
      let bytes = 0;
      for (const p of audio) bytes += p.length;
      const seconds = bytes / HandsFree.BYTES_PER_SECOND;
      let w = { text: '', parts: 0, seconds: 0, ms: 0 };
      const l = this.live;
      let streamed = this.streaming() && why !== 'seed';
      if (streamed && why === 'pause' && seconds >= HandsFreeSession.STALL_SECONDS) {
        const nt = HandsFree.normalize(l.text());
        const words = nt === '' ? 0 : nt.split(' ').length;
        if (words < seconds * HandsFreeSession.STALL_WORDS_PER_SECOND) {
          this.batchTurn = true;
          streamed = false;
          this.log(format('live text looks stuck (%d words for %.1f s of speech): this turn is written down from its audio', words, seconds));
          this.reason('Live transcription looks stuck (%1$d words for %2$.0f s): your words are written down instead', words, seconds);
        }
      }
      let liveText = null;
      let offLive = false;
      let liveWas = 0; // How much live text there was before writing down (offLive).
      if (streamed) {
        try {
          this._checkStep = 'writing';
          liveText = why === 'pause' ? l.text() : await l.take(HandsFreeSession.TAKE_MS);
          text = (prefix + ' ' + liveText).trim();
        } catch (ex) {
          this.liveFailed(message(ex));
          streamed = false;
        }
        if (streamed && liveText === '' && audio.length) {
          // Audio but no live words (yet): written down from the audio rather than dropped.
          this.log(format('no live text for %.1f s of your speech: written down from its audio', seconds));
          streamed = false;
          offLive = why === 'pause';
          liveWas = l.text().length;
          text = prefix;
        }
      }
      // What would be sent is written down whole meanwhile (not for the screen alone). Not for
      // parts live transcription missed at a pause: their words become the turn's (below).
      const all = why === 'seed' || streamed || offLive ? null : this.startWhole(audio);
      if (audio.length && !streamed) {
        try {
          this._checkStep = 'writing';
          w = await this.writeTurn(audio, why);
          text = (prefix + ' ' + w.text).trim();
        } catch (ex) {
          const m = message(ex);
          this._status = 'transcription failed: ' + m;
          this._error = 'Couldn\'t write down what you said: ' + m;
          this.log(format('check (%s): %.1f s, transcription failed after %d ms: %s', why, seconds, this.clock() - start, m));
          this.cue(Cue.FAILED);
          this.reason('Couldn\'t write down %1$.1f s of what you said: %2$s', seconds, m);
          // Kept: the next pause or Send tries again with it.
          this.sendAfterFlush = false;
          this.sendPressed = false;
          this.changed();
          return;
        }
      }
      const took = this.clock() - start;
      if (this._state === State.ENDED) return; // The call's end sends it (end()).
      this._error = '';
      this._pending = text;
      this.changed();
      this.log(
        format(
          'check (%s): %d part(s), %.1f s; %s: "%s"',
          why,
          audio.length,
          seconds,
          streamed
            ? why === 'pause'
              ? 'live text'
              : 'final live text in ' + took + ' ms'
            : w.parts === 0
              ? 'written down already'
              : format('%d new (%.1f s) written down in %d ms', w.parts, w.seconds, w.ms),
          text,
        ),
      );
      if (took >= HandsFreeSession.SLOW_WRITING_MS) this.reason('Writing down took %1$.1f s (the speech model was slow)', took / 1000.0);
      if (why === 'seed') {
        if (this.streaming()) {
          // Live transcription didn't hear it: its text starts the turn.
          this.turnAudio = this.turnAudio.filter((p) => !audio.includes(p));
          this.retainWritten();
          this.turnPrefix = text;
          this.turnVersion++;
        }
        return;
      }
      if (text === '' && all != null) text = await this.toSend(text, all, prefix); // The parts had no words; the whole pass may.
      if (text === '') {
        if (this.stale(version) && !button) return;
        this.reason('The speech model heard no words: your turn ends');
        this.giveUpTurn('nothing was said');
        return;
      }
      if (why !== 'pause') {
        if (!streamed) this.forgetLive();
        this.send(streamed ? text : await this.toSend(text, all, prefix), why, audio.length, prefix);
        return;
      }
      if (offLive && this.streaming()) {
        // Live transcription missed these parts (it connected late, or its words for them never
        // came): it only has what you say next, so their words start the turn, as words, before
        // it. Otherwise a send word after this pause would send the live text alone and drop them
        // (Philipp's call, 27 October 2026: "So it seems to be stuck right" and then "Over."
        // sent nothing).
        const wentOn = this.stale(version);
        this.turnAudio = this.turnAudio.filter((p) => !audio.includes(p)); // By identity.
        this.retainWritten();
        this.turnPrefix = (this.turnPrefix + ' ' + w.text).trim();
        this.turnVersion++;
        prefix = this.turnPrefix;
        version = this.turnVersion;
        // Its words that came late while they were written down would be there twice: dropped
        // (with what's still in flight of them). Not when nothing came: a drop then guesses the
        // next stretch, and would swallow what you say next. Not when you went on: what it has
        // now may be your new words.
        if (!wentOn && l.text().length > liveWas) this.forgetLive();
        this.log('these words start your turn: live transcription didn\'t hear them' + (wentOn ? ' (you went on: what it hears next follows them)' : ''));
        if (wentOn) {
          // The check queued for what you said since decides, about all of it.
          this.log('you went on talking: checked again at your next pause');
          return;
        }
        audio = [];
        streamed = true;
      }
      if (this.stale(version)) {
        this.log('you went on talking: checked again at your next pause');
        return;
      }
      const viaLive = streamed;
      const before = prefix;
      await this.decide(text, audio.length, before, version, async (t) => {
        if (viaLive) return this.finalLive(t, before);
        this.forgetLive();
        return this.toSend(t, all, before);
      });
    } finally {
      if (original.endsWith(' phrase')) this.keyword = false;
      this.writingSince = 0;
      this._checkStep = '';
      this.transcribing--;
      this.changed();
      this.readNext();
    }
  }

  /**
   * The live text ended with a send (or end) phrase. Jev is asked at once whether you're done (or
   * saying goodbye), while the short quiet after the phrase is waited for, so it adds little to
   * the wait; then the model is asked for its final text, and if that still ends with the phrase
   * the turn goes (or the call ends) without waiting for a pause. A phrase mid-sentence ("until
   * the period is over", "game over and …") sends nothing.
   */
  async phrase(end) {
    const l = this.live;
    if (!this.streaming() || this._state !== State.LISTENING) {
      this.log(
        'the ' +
          (end ? 'end' : 'send') +
          ' phrase isn\'t checked: ' +
          (this._state === State.READING
            ? 'a reply started playing'
            : this._state !== State.LISTENING
              ? 'the call ended'
              : this.batchTurn
                ? 'this turn is written down from its audio'
                : 'live transcription stopped working') +
          '; your next pause decides',
      );
      return;
    }
    // Asked at once: its answer comes while the quiet after the phrase is waited for.
    const asked = this.ask((this.turnPrefix + ' ' + l.text()).trim());
    try {
      await this.phraseChecked(end, l, asked);
    } finally {
      asked.cancel(); // You went on, or the call ended: its answer is no longer wanted.
    }
  }

  async phraseChecked(end, l, asked) {
    const words = end ? this.endWords : this.sendWords;
    const need = end ? HandsFreeSession.END_QUIET_MS : HandsFreeSession.SEND_QUIET_MS;
    const waited = performance.now();
    const until = waited + HandsFreeSession.PHRASE_WAIT_MS;
    while (this.segmenter.silentMs() < need) {
      if (this._state !== State.LISTENING) return;
      if (HandsFree.endsWith(l.text(), words) == null) {
        this.log('you went on after the phrase: not an ending, the turn goes on');
        return;
      }
      if (performance.now() > until) {
        this.log('no pause after the phrase: it\'s left to your next pause');
        return;
      }
      await sleep(10);
    }
    if (HandsFree.endsWith(l.text(), words) == null) {
      this.log('you went on after the phrase: not an ending, the turn goes on');
      return;
    }
    const quiet = Math.trunc(performance.now() - waited);
    this._checkStep = 'asking';
    this.changed();
    const v = await asked.verdict();
    if (v != null) this.logVerdict(end ? 'on the end phrase' : 'on the send phrase', asked.ms(), v);
    if (this._state !== State.LISTENING) return;
    if (end) {
      // Hanging up by mistake is the worst: only when Jev confirms it's a goodbye. Without that
      // (no Jev, it failed, or not a goodbye) the turn goes on as it is, and your pause decides.
      const why =
        v == null
          ? 'Jev couldn\'t confirm the goodbye (' + asked.failed + ')'
          : v.end >= HandsFreeSession.END_AT
            ? null
            : format('Jev: not a goodbye (end the call %.2f)', v.end);
      if (why != null) {
        this.log(why + ': not ended, the turn goes on');
        return;
      }
    } else if (v != null && v.send < HandsFreeSession.PHRASE_SEND_AT) {
      // "Over" as a word of the sentence, not the send word: the turn goes on, and the same
      // text doesn't ask again (the live text repeats it until you say more).
      this.heldPhrase = HandsFree.normalize(asked.said);
      this.log(format('send phrase: Jev says you\'re not done (done %.2f): not sent, the turn goes on', v.send));
      this.notDone(v);
      this.changed();
      return;
    } else if (v == null) this.log('Jev couldn\'t tell whether you\'re done (' + asked.failed + '): the send word decides');
    const start = this.clock();
    this.writingSince = start;
    this._checkStep = 'writing';
    this.changed();
    let text;
    try {
      text = await l.take(HandsFreeSession.TAKE_MS);
    } catch (ex) {
      this.liveFailed(message(ex));
      return;
    }
    const took = this.clock() - start;
    const cut = HandsFree.endsWith(text, end ? this.endWords : this.sendWords);
    const audio = this.turnAudio.slice();
    const prefix = this.turnPrefix;
    const notEnding = cut == null ? format('the final text in %d ms doesn\'t end with the phrase ("%s")', took, tail(text)) : null;
    if (notEnding != null) {
      // Not an ending after all: the turn goes on. What was taken stays in it, as words: its
      // audio no longer needs writing down.
      this.turnAudio.splice(0, Math.min(audio.length, this.turnAudio.length));
      this.retainWritten();
      this.turnPrefix = (this.turnPrefix + ' ' + text).trim();
      this.turnVersion++;
      this.dropStretch = this.segmenter.candidate(); // The stretch going on holds them too.
      this.log(notEnding + ': not ' + (end ? 'ended' : 'sent') + ', the turn goes on');
      return;
    }
    // Its audio went with this message: the stretch going on now is part of it.
    this.dropStretch = this.segmenter.candidate();
    const rest = (prefix + ' ' + cut).trim();
    this._pending = rest;
    this.log(
      format(
        '%s phrase: quiet %d ms after it, final text in %d ms (%d ms after the phrase was heard): "%s"',
        end ? 'end' : 'send',
        quiet,
        took,
        this.clock() - this.keywordAt,
        text,
      ),
    );
    if (end) {
      this.log('end of the call');
      this.reason('Ending the call: you said goodbye');
      if (rest !== '') this.send(rest, 'end phrase', audio.length, prefix);
      this.end();
      return;
    }
    if (rest === '') {
      // The live text was just taken: nothing of it to drop (dropping would lose what you say next).
      if (this.clock() - this.sentAt < 10_000) {
        this.log('the send word came after your message went: nothing more to send');
        this.reason('Send word heard: your message had already gone');
        this.endTurn(false);
      } else {
        this.reason('Only the send word was heard: nothing to send');
        this.giveUpTurn('only the send word', false);
      }
      return;
    }
    this.reason('Sent: you said %1$s', '"' + this.sendWords[0] + '"');
    this.send(rest, 'send phrase', audio.length, prefix);
  }

  /** A question to Jev on its way (in the background): its answer, or why there is none. */
  ask(said) {
    const session = this;
    const asked = {
      said,
      answer: null,
      started: this.clock(),
      answered: 0,
      failed: 'no judge',
      cancelled: false,
      /** Waits for the answer (at most phraseJudgeMs); null when there's none (see failed). */
      async verdict() {
        if (this.answer == null) return null;
        if (this.cancelled) {
          this.failed = 'cancelled';
          return null;
        }
        try {
          return await withTimeout(this.answer, HandsFreeSession.phraseJudgeMs);
        } catch (ex) {
          if (ex instanceof TimeoutError) this.failed = 'no answer in ' + HandsFreeSession.phraseJudgeMs + ' ms';
          else this.failed = message(ex);
        }
        return null;
      },
      ms() {
        return (this.answered === 0 ? session.clock() : this.answered) - this.started;
      },
      /** Its answer is no longer wanted (Java cancels the future; here it's only let go). */
      cancel() {
        this.cancelled = true;
      },
    };
    const j = this.judgeFn();
    if (j != null) {
      if (!this.speechOpen) asked.failed = 'the call ended';
      else {
        asked.answer = (async () => {
          try {
            return await j(said);
          } finally {
            asked.answered = session.clock();
          }
        })();
        asked.answer.catch(() => {}); // Seen by verdict(), if it's still wanted.
      }
    }
    return asked;
  }

  /** The judge as a function, or null. */
  judgeFn() {
    const j = this.judge;
    if (j == null) return null;
    return typeof j === 'function' ? j : (said) => j.judge(said);
  }

  /** Logs Jev's answer: what it chose, how sure it is, what it cost. */
  logVerdict(on, ms, v) {
    this.log(
      format(
        'Jev%s in %d ms%s: %s (done %.2f, end the call %.2f)',
        on === '' ? '' : ' ' + on,
        ms,
        v.cost == null ? '' : ', $' + plain(Number(v.cost)),
        v.choice,
        v.send,
        v.end,
      ),
    );
  }

  /** Says why your turn wasn't sent, from Jev's answer. */
  notDone(v) {
    const pct = Math.round(100 * v.send);
    switch (v.choice) {
      case 'unfinished':
        this.reason('Not sent: you seem mid-sentence (%1$d%% done)', pct);
        break;
      case 'more':
        this.reason('Not sent: you seem to have more to say (%1$d%% done)', pct);
        break;
      default:
        this.reason('Not sent: not clearly done yet (%1$d%%)', pct);
    }
  }

  /**
   * The stretch with a send phrase went on after it and has ended: what live transcription heard
   * of it since then is your turn's (its audio went with the message, so the live text is all
   * there is of it). Taken into the turn as words; a pause check follows.
   */
  async takeRest() {
    const l = this.live;
    if (!this.streaming() || this._state !== State.LISTENING || l.text() === '') return;
    let text;
    try {
      text = await l.take(HandsFreeSession.TAKE_MS);
    } catch (ex) {
      this.liveFailed(message(ex));
      return;
    }
    if (text === '') return;
    this.turnPrefix = (this.turnPrefix + ' ' + text).trim();
    this.turnVersion++;
    this.takenByYou = true;
    this.log('words after the phrase, in the same stretch: they\'re your turn\'s ("' + tail(text) + '")');
  }

  /** The live text's final version for sending (prefix before it), or what was checked if that fails. */
  async finalLive(checked, prefix) {
    const l = this.live;
    const start = this.clock();
    try {
      const t = (prefix + ' ' + (await l.take(HandsFreeSession.TAKE_MS))).trim();
      this.log(format('final live text in %d ms', this.clock() - start));
      return t === '' ? checked : t;
    } catch (ex) {
      this.liveFailed(message(ex));
      return checked;
    }
  }

  /** A turn sent from its audio: what live transcription has of it is dropped. */
  forgetLive() {
    const l = this.live;
    if (l != null && l.working()) l.discard();
  }

  /** Live transcription stopped working: said once, and from now on your words are written down. */
  liveFailed(why) {
    if (this.liveFailedSaid) return;
    this.liveFailedSaid = true;
    this.log('live transcription failed (' + why + '): your words are written down from their audio from now on');
    // On the work queue (it's heard from the connection): before the next check of your turn.
    const say = () => {
      this.cue(Cue.FAILED);
      this.reason('Live transcription failed (%1$s): your words are written down instead', why);
    };
    this.execute(say, say);
  }

  /** Did the turn change (a new part) or are you talking again, since the check began? */
  stale(version) {
    if (this.turnVersion !== version) return true;
    return this.talking();
  }

  /**
   * A sound you may be making is going on. Not while a reply plays: what the segmenter has then
   * hasn't stopped it, so it isn't you (yet).
   */
  talking() {
    return this._state !== State.READING && this.segmenter.candidate();
  }

  /**
   * At a longer pause: asks the judge whether your turn is done, and acts: sends it, ends the
   * call, or listens on. Without a judge, or when it fails, the send and end words decide.
   */
  async decide(text, parts, prefix, version, finalText) {
    let v = null;
    const start = this.clock();
    let failed = null;
    this._checkStep = 'asking';
    this.changed();
    const j = this.judgeFn();
    if (j != null) {
      try {
        v = await j(text);
      } catch (ex) {
        failed = message(ex);
      }
    }
    const ms = this.clock() - start;
    if (v != null) this.logVerdict('', ms, v);
    else if (failed != null) this.log('Jev failed after ' + ms + ' ms (' + failed + '): the send and end words decide');
    if (this._state === State.ENDED) return; // The call's end sent it.
    if (this.stale(version)) {
      this.log('you went on talking: checked again at your next pause');
      return;
    }
    const ended = HandsFree.endsWith(text, this.endWords);
    const over = HandsFree.endsWith(text, this.sendWords);
    const end = v != null ? v.end >= HandsFreeSession.END_AT : ended != null;
    // Jev held this send word back a moment ago: Jev failing now doesn't make it the send word.
    const done = v != null ? v.send >= HandsFreeSession.SEND_AT : over != null && HandsFree.normalize(text) !== this.heldPhrase;
    if (failed != null)
      this.reason(
        'Couldn\'t ask whether you\'re done (%1$s): say %2$s or press Send',
        failed,
        this.sendWords.length === 0 ? 'Send' : '"' + this.sendWords[0] + '"',
      );
    if (end) {
      this.log('end of the call');
      this.reason('Ending the call: you said goodbye');
      const sent = await finalText(text);
      const cut = HandsFree.endsWith(sent, this.endWords);
      const rest = cut != null ? cut : ended != null && sent === text ? ended : sent;
      if (rest !== '') this.send(rest, 'end phrase', parts, prefix);
      this.end();
      return;
    }
    const pct = v == null ? 0 : Math.round(100 * v.send);
    if (done) {
      // What goes is the whole pass's text: it decides what's left once the send word is off.
      const sent = await finalText(text);
      const cut = HandsFree.endsWith(sent, this.sendWords);
      const rest = sent === text ? (over != null ? over : text) : cut != null ? cut : sent;
      if (this.stale(version)) {
        // You went on while it was written down whole: checked at your next pause.
        if (this.streaming()) {
          // Taken from live transcription: it starts the rest of the turn.
          this.turnAudio.splice(0, Math.min(parts, this.turnAudio.length));
          this.retainWritten();
          this.turnPrefix = sent;
          this.turnVersion++;
        }
        this.log('you went on talking: checked again at your next pause');
        return;
      }
      // The live text was taken (or dropped) for the final text already: nothing more to drop.
      if (rest === '' && this.clock() - this.sentAt < 10_000) {
        // "Over" just after Send.
        this.log('the send word came after your message went: nothing more to send');
        this.reason('Send word heard: your message had already gone');
        this.endTurn(false);
        return;
      }
      if (rest === '') {
        // Only "over".
        this.reason('Only the send word was heard: nothing to send');
        this.giveUpTurn('only the send word', false);
        return;
      }
      if (v == null) this.reason('Sent: you said %1$s', '"' + this.sendWords[0] + '"');
      else
        switch (v.choice) {
          case 'question':
            this.reason('Sent: you asked your question (%1$d%%)', pct);
            break;
          case 'request':
            this.reason('Sent: you finished what you were saying (%1$d%%)', pct);
            break;
          default:
            this.reason('Sent: you said you\'re done (%1$d%%)', pct);
        }
      this.send(rest, 'jev', parts, prefix);
      return;
    }
    if (v == null) {
      if (failed == null) this.reason('Not sent: no %1$s yet', this.sendWords.length === 0 ? 'send word' : '"' + this.sendWords[0] + '"');
    } else this.notDone(v);
    this.changed();
  }

  /** How long the current check (writing down, Jev) has been running, 0 when none is. */
  writingMs() {
    const since = this.writingSince;
    return since === 0 || this.transcribing === 0 ? 0 : Math.max(0, this.clock() - since);
  }

  /**
   * Your turn is over without a message, quietly (nothing was lost); forget drops what live
   * transcription has of the turn. Not when its text was just taken: a drop then would catch what
   * you say next ("Over. Build it.").
   */
  endTurn(forget = true) {
    this._pending = '';
    this.takenByYou = false;
    this.batchTurn = false;
    this.heldPhrase = '';
    if (forget) this.forgetLive();
    this.sendAfterFlush = false;
    this.sendPressed = false;
    this.turnAudio = [];
    this.written.clear();
    this.whole = null;
    this.turnPrefix = '';
    this.turnVersion++;
    this.changed();
  }

  /** Your turn came to nothing: the floor opens, and a waiting chief message is read. */
  giveUpTurn(why, forget = true) {
    this.log('your turn ended without a message (' + why + ')');
    this.endTurn(forget);
  }

  /**
   * Your message goes, with a note for each reply that couldn't be played. Replies waiting
   * meanwhile stay waiting: they play at your next pause.
   */
  send(text, why, parts, prefix) {
    this.sendAfterFlush = false;
    this.sendPressed = false;
    this.batchTurn = false;
    if (this._state === State.ENDED) {
      // Ended while this was written down: the call's end sent these words.
      this.log('the call ended meanwhile: its end sends your words, not this check');
      return;
    }
    if (text.trim() === '') {
      this.reason('Nothing to send: no words were written down');
      this.giveUpTurn('empty');
      return;
    }
    // The turn is over: the parts written down go; what you said since starts your next turn.
    // Taken with the handover: the call's end can't send them a second time.
    let more = false;
    const h = this.handOff(false, () => {
      this.turnAudio.splice(0, Math.min(parts, this.turnAudio.length));
      this.retainWritten();
      if (this.turnPrefix === prefix) this.turnPrefix = '';
      this.turnVersion++;
      more = this.turnAudio.length !== 0 || this.turnPrefix !== '';
    });
    if (h == null) {
      this.log('the call ended meanwhile: its end sends your words, not this check');
      return;
    }
    this._pending = '';
    this.takenByYou = more;
    this.heldPhrase = '';
    this.outgoing++;
    this.sentAt = this.clock();
    this.changed();
    const queued = this.clock();
    const delivery = () => this.deliver(text.trim() + h.notes, text, why, h, queued);
    // The call ended with this message (an end phrase): it still goes.
    if (!this.outbox.execute(delivery)) delivery().catch((ex) => this.log('internal error: ' + message(ex)));
  }

  /**
   * Hands a message over: numbers it, registers its request ID (a reply to it is ours from now on,
   * also before bb is done), and claims the notes no message on its way carries yet. Null once the
   * call ended, unless last (your last words, after the end). consume takes the message's words
   * from your turn, at once with the handover. Returns { number, request, notes }.
   */
  handOff(last, consume = () => {}) {
    if (this._state === State.ENDED && !last) return null;
    consume();
    const number = ++this.handedOff;
    this.onTheWay.add(number);
    const request = typeof this.sender.newRequest === 'function' ? this.sender.newRequest() : requestId();
    this.requests.push(request);
    this.requestNumber.set(request, number);
    let notes = '';
    for (const n of this._unheard)
      if (n.claimedBy === 0) {
        n.claimedBy = number;
        notes += '\n\n' + n.text;
      }
    const missedNow = [];
    for (const n of this.outdatedNotes)
      if (n.claimedBy === 0) {
        n.claimedBy = number;
        missedNow.push(n.text);
      }
    if (missedNow.length) notes += '\n\n' + HandsFreeSession.missed(missedNow);
    // Without a talker, the chief's replies still waiting play once this message went: it hears
    // so, and doesn't answer the same again (Philipp's call, 31 October 2026: "Hi, can you hear
    // me?" asked again before the first answer played, answered again, and "Yes, I can hear you"
    // heard twice).
    if (!this.dropsOutdated && !last) {
      const waiting = this._held.filter((w) => w.answers < number).map((w) => w.text);
      if (waiting.length) notes += '\n\n' + HandsFreeSession.notPlayedYet(waiting);
    }
    return { number, request, notes };
  }

  /** The notes message number carries are free again: for the next message or the call's end. */
  unclaim(number) {
    for (const n of this._unheard) if (n.claimedBy === number) n.claimedBy = 0;
    for (const n of this.outdatedNotes) if (n.claimedBy === number) n.claimedBy = 0;
  }

  /**
   * Delivers a message to the chief (on the outbox): in order, without holding up what you say
   * next. The log says how long it waited for earlier messages and how long bb took.
   */
  async deliver(said, text, why, h, queued) {
    const start = this.clock();
    const number = h.number;
    const request = h.request;
    try {
      let partly = null;
      try {
        await this.sender.send(said, request);
      } catch (ex) {
        if (!isPartlySent(ex)) throw ex;
        partly = ex;
      }
      const done = this.clock();
      const old = [];
      const chiefMissed = partly != null && partly.chiefMissed;
      this.working.set(request, [0, done]);
      // Its notes reached the chief: done. The chief missed it: they go again.
      if (chiefMissed) this.unclaim(number);
      else {
        this._unheard = this._unheard.filter((n) => n.claimedBy !== number);
        this.outdatedNotes = this.outdatedNotes.filter((n) => n.claimedBy !== number);
      }
      this.onTheWay.delete(number);
      this.latestSent = Math.max(this.latestSent, number);
      this.silenceTries = 0;
      this.silenceNextAt = 0;
      // With a talker, the replies waiting that answer an older message no longer fit: not
      // played; your next message, or the call's end, says so.
      if (this.dropsOutdated)
        this._held = this._held.filter((w) => {
          if (!this.outdated(w)) return true;
          w.dropped = true;
          old.push(w);
          this.outdatedNotes.push(new Note(w.text));
          return false;
        });
      for (const w of old) {
        this.speakerDrop(w.prepared); // Its voice no longer fetched on (let go when it comes).
        this.log(
          'chief message ' +
            w.request +
            ' dropped (' +
            w.text.length +
            ' characters): it was waiting when your newer message ' +
            request +
            ' went; your next message says you didn\'t hear it',
        );
      }
      if (old.length === 1) this.reason('An older reply wasn\'t played: you\'ve said more since');
      else if (old.length > 1) this.reason('%1$d older replies weren\'t played: you\'ve said more since', old.length);
      this._sent++;
      this.sentAt = done;
      this.deliveredAt = done;
      this._status = 'sent (' + why + ')';
      this._error = '';
      this.log(
        format(
          'sent %s (%s, %d characters; bb took %d ms, waited %d ms%s)',
          request,
          why,
          said.length,
          done - start,
          start - queued,
          why === 'send phrase' || why === 'end phrase' ? '; ' + (done - this.keywordAt) + ' ms after the phrase was heard' : '',
        ),
      );
      this.cue(partly != null && partly.chiefMissed ? Cue.FAILED : Cue.SENT);
      if (partly != null) {
        if (partly.chiefMissed) this.reason('Sent to the talker only. The chief didn\'t get it: %1$s', partly.message);
        else this.reason('Sent ✓ to the chief. The talker didn\'t get it: %1$s', partly.message);
      } else
        switch (why) {
          case 'jev':
          case 'send phrase':
            this.reason('Sent ✓');
            break;
          case 'silence':
            this.reason('Sent ✓ after %1$d s of silence', Math.trunc(this.silenceSendMs / 1000));
            break;
          case 'end phrase':
          case 'end of the call':
            this.reason('Sent ✓ before the call ended');
            break;
          default:
            this.reason('Sent ✓ by the Send button');
        }
      return chiefMissed ? Delivery.CHIEF_MISSED : Delivery.SENT;
    } catch (ex) {
      const m = message(ex);
      // Its notes go with the next message (or the call's end). Its request stays ours: nobody
      // got it, so no reply to it comes.
      this.onTheWay.delete(number);
      this.unclaim(number);
      // Kept, before whatever you said since, so the next check or Send tries again.
      this.turnPrefix = (text + ' ' + this.turnPrefix).trim();
      this.turnVersion++;
      this._pending = this._pending === '' ? text : text + ' ' + this._pending;
      this.takenByYou = true;
      this._status = 'not sent: ' + m;
      this._error = 'Not sent: ' + m;
      this.log(format('not sent (%s) after %d ms: %s', why, this.clock() - start, m));
      this.cue(Cue.FAILED);
      this.reason('Not sent: %1$s. Your words are kept; send again', m);
      // After the call's end settled (a message still in bb then failed): its words go now.
      if (this._state === State.ENDED && this.settled && !this.leftoverRunning) {
        this.log('a message failed after the call\'s end: its words are sent now');
        setImmediate(() => this.sendLeftover(this.clock() + 20_000).catch((e) => this.log('internal error: ' + message(e))));
      }
      return Delivery.FAILED;
    } finally {
      this.outgoing--;
      this.changed();
      this.readNext();
    }
  }

  /**
   * Waits (at most ms) until every message of the call is delivered: before telling the chief it
   * ended. Resolves false if they weren't (or the call hasn't ended).
   */
  async awaitDelivered(ms) {
    const until = Date.now() + ms;
    for (;;) {
      if (this.outbox.terminated()) return true;
      if (Date.now() >= until) return false;
      await sleep(Math.min(5, Math.max(0, until - Date.now())));
    }
  }

  /**
   * The note about replies you didn't hear: one as "[didn't hear your reply: …]" with its first
   * words; several (an array) as how many, the first one's first words and how many more.
   */
  static missed(replies) {
    if (Array.isArray(replies)) {
      if (replies.length === 1) return HandsFreeSession.missed(replies[0]);
      const words = replies[0].trim().split(/\s+/);
      const first = words.slice(0, Math.min(8, words.length)).join(' ');
      return '[didn\'t hear ' + replies.length + ' replies: "' + first + (words.length > 8 ? '…' : '') + '" and ' + (replies.length - 1) + ' more]';
    }
    const words = replies.trim().split(/\s+/);
    const first = words.slice(0, Math.min(12, words.length)).join(' ');
    return '[didn\'t hear your reply: "' + first + (words.length > 12 ? '…' : '') + '"]';
  }

  /**
   * The note in your message about the chief's replies still waiting (they play once it went):
   * one by its first words; several as how many, the first one's first words and how many more.
   */
  static notPlayedYet(replies) {
    const n = replies.length === 1 ? 12 : 8;
    const words = replies[0].trim().split(/\s+/);
    const quoted = '"' + words.slice(0, Math.min(n, words.length)).join(' ') + (words.length > n ? '…' : '') + '"';
    return replies.length === 1
      ? '[your reply hasn\'t played yet, it plays after this message: ' + quoted + ']'
      : '[' + replies.length + ' replies haven\'t played yet, they play after this message: ' + quoted + ' and ' + (replies.length - 1) + ' more]';
  }
}

Object.assign(HandsFreeSession, {
  State,
  Phase,
  Floor,
  Live,
  Cue,
  Delivery,
  PartlySent,
  /**
   * With live transcription, speech without words in the live text holds your turn this long at
   * most (the live text's delay for the first words): noise or a cough doesn't hold a reply.
   */
  WORDLESS_MS: 3000,
  /**
   * A reply whose voice is ready waits through your turn at most this long without new words from
   * live transcription: a TV (without live transcription), a slow check or bb refusing your
   * message can't hold it forever.
   */
  HOLD_MAX_MS: 60_000,
  /**
   * Past HOLD_MAX_MS a reply still never starts over a stretch of your speech younger than this:
   * a sentence; a stretch this long without pause is a TV or the like.
   */
  LONG_STRETCH_MS: 20_000,
  /** A silence send that failed is tried again after this, doubling each time, at most SILENCE_RETRY_MAX_MS. */
  SILENCE_RETRY_MS: 15_000,
  SILENCE_RETRY_MAX_MS: 60_000,
  /** How long the screen says Sent ✓ after a message went. */
  SENT_SHOWN_MS: 3000,
  /** While a sound plays (and a moment after) the microphone can't start your speech with it. */
  CUE_MS: 300,
  /** How many reasons the screen keeps. */
  REASONS: 8,
  /** A message counts as being worked on until the chief's second reply, or this long. */
  WORKING_MS: 10 * 60_000,
  /** After a reply is read the microphone stays off this long, so its last word isn't caught. */
  TAIL_MS: 800,
  /**
   * A reply's audio has to start this soon after the floor is taken, and end this long after its
   * own length, or the reading is given up and listening resumes.
   */
  START_MS: 6000,
  OVERRUN_MS: 3000,
  /**
   * Past its length a reply keeps playing as long as the voice says audio is coming out; only one
   * that stalls, or plays this long in all, is given up.
   */
  READING_CAP_MS: 10 * 60_000,
  /** This much of your speech over a reply (without the short-burst rule) stops it. */
  BARGE_MS: 300,
  /** Once you hold the floor, a stretch this short still counts ("Over." on its own). */
  SHORT_MS: 200,
  /** The longest a turn's final text from live transcription is waited for (it took 0.1 to 0.4 s). */
  TAKE_MS: 1500,
  /**
   * A send or end phrase is an ending, not a hesitation ("should we end the call … tomorrow"), once
   * you've been quiet this long after it with the live text still ending in it; hanging up waits
   * longer (and asks Jev), it's the worse mistake. Without that quiet within PHRASE_WAIT_MS the
   * phrase is left to your next pause.
   */
  SEND_QUIET_MS: 300,
  END_QUIET_MS: 700,
  PHRASE_WAIT_MS: 3000,
  /**
   * A turn of this many seconds of speech with fewer words a second than this in the live text
   * looks stalled (ElevenLabs once stuck on "Mm." for 30 s): it's written down from its audio.
   */
  STALL_SECONDS: 4,
  STALL_WORDS_PER_SECOND: 0.3,
  /** The floor open this long with no speech: words the live text has (noise, a TV) are dropped. */
  STRAY_MS: 3000,
  /** At these probabilities a turn is sent, or the call ended, without a word from you. */
  SEND_AT: 0.7,
  END_AT: 0.8,
  /** Writing down took this long: shown as slow. */
  SLOW_WRITING_MS: 4000,
  /** Writing down a turn is given up after this long and tried once more (tests change it). */
  writeTimeoutMs: 6000,
  /** Tries of sendLeftover, leftoverRetryMs apart. */
  LEFTOVER_TRIES: 3,
  leftoverRetryMs: 2000,
  /** A press this soon after a message went is taken as a repeated press for that message. */
  REPRESS_MS: 1500,
  /** How long the call bar and screen say the voice model failed. */
  VOICE_ERROR_MS: 20_000,
  /** How long the call bar says live transcription is off for a missing key. */
  LIVE_OFF_MS: 60_000,
  LIVE_CHECK_MS: 10_000,
  /** A reply that couldn't be played is tried once more before your message notes it. */
  RETRIES: 1,
  /**
   * Jev's answer on a send or end phrase, asked in the background: below this it holds a send
   * phrase back (it's more likely a word of your sentence than the send word).
   */
  PHRASE_SEND_AT: 0.5,
  /** The longest Jev's answer on a phrase is waited for (Jev gives up after 3 s itself). */
  phraseJudgeMs: 3500,
});

module.exports = { HandsFreeSession, State, Phase, Floor, Live, Cue, Delivery, PartlySent, requestId, plain };
