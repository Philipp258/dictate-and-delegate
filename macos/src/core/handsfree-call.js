'use strict';
// Port of the platform-free part of HandsFreeService.java: one hands-free call. It builds the
// HandsFreeSession and wires it to the pieces the Mac app injects: the microphone, bb, the ntfy
// replies, Jev, live transcription, the voice, the sounds, the call log, the notes and the costs.
// The call bar shows snapshot() (onChange says when it changed); the global hotkey calls sendNow().
//
// Left out (Android only), for main/ to give Mac equivalents where they matter:
//  - the foreground service and its notification (with Send now and End actions): the call bar
//    window shows snapshot() instead; liveLabel/shortLabel/canSend are its texts and buttons;
//  - the media session (headset and car button sends): the global hotkey calls sendNow();
//  - the wake lock (4 h): powerSaveBlocker('prevent-app-suspension') while a call is on;
//  - CallAudio (communication mode, so echo cancellation takes the replies out of the mic) and
//    AcousticEchoCanceler: the microphone should be captured with echoCancellation on (the
//    renderer's getUserMedia), the microphone source's job; its log line goes through event();
//  - HandsFreePanel (the floating call window, its position from the dictation panel's):
//    the call bar window;
//  - nothing else: the voice's logs and cost lookups are voice.js createSpeaker's, wired here.
//
// Injected (all in the constructor's options):
//   prefs: settings ({ get(key, fallback) }), the Android keys (HandsFree.*).
//   bb: { chiefId() → string, talkerId() → string ("" for none), threadLink?(id) → string,
//     async sendHandsFree(chiefId, said, request, talker) — to the chief, and with a talker to
//     both (throws PartlySent when only one got it, anything else when nobody did; may resolve
//     { took: { threadId: ms } }), async tellEach(Map threadId → text) → { threadId: why } (the
//     ones that failed) } — BbBridge has all of these.
//   transcribe: async (wav, { model, hints }) → { text, cost (Number|null) } — the speech model
//     (OpenRouter.transcribe) for turns written down from their audio.
//   speechModel: the model id for transcribe (Profile.fixedModel()); hintWords: Profile.hintWords().
//   judge: async (said, { sendWords, endWords }) → { choice, send, end, cost } (Jev.turn), or null
//     (no Jev: the send and end words decide). Its cost is counted here (don't also count it
//     through Jev.makeJudge's onCost).
//   createLive: (keyterms, { onText(text), onFailure(why), log(line) }) → a LiveText (e.g. a
//     StreamingSpeech; its changed/onFailure/events properties are set too if it has them; its
//     choice {model, provider} names it in the log), or { missingKey: 'AssemblyAI' } when the
//     provider's key is missing, or null. Only asked when live transcription is on (hfLive).
//   createSpeaker: ({ event(line), onVoiceFailed(why, systemVoice), onCost({ request, choice,
//     cost, costText, ms }) }) → HandsFreeSession's Speaker — voice.js createSpeaker with the
//     Voice and prefs bound; or speaker: a ready Speaker (prepare, play, playing, heardChars,
//     drop, stop), then voiceFailed() and chargeVoice() are the caller's to call.
//   voice: the Voice (voice.js), optional: openCall() and callOpen (the call audio kept open,
//     with hfOpenAudio), warm(), shutdown() at the end.
//   voiceChoice: the voice chosen (Voice.choice(prefs hfVoice)): its tag() for the log, and
//     whether it has a model (then the voice is warmed up).
//   playCue: (name: 'HEARD' | 'SENT' | 'REPLY' | 'FAILED') → boolean (it played). Off with hfSounds.
//   microphone: { start(onFrame(pcm)) , stop() } — 16 kHz mono PCM16LE (any chunk size; cut into
//     20 ms = 640-byte frames here); null: frames come through frame() (tests).
//   replies: ({ sinceSeconds, ours(request), untagged() → request, onReply(request, text,
//     published, untagged) }) → { close() } (ChiefText.Replies, started); throws without a topic.
//   logFile: the hands-free log's path (HandsFreeLog), or null; log: (line) → void as well.
//   saveNote: async (HistoryEntry) → void — each message kept as a note (HistoryStore.save, and
//     bump historyRevision).
//   updateNote: async (request, (HistoryEntry) → void) → void — a voice cost added to the note of
//     the message it answers (DictationService.updateByRequest); optional.
//   tellTalkerSkill: async () → void — ChiefSkills.safelyTellTalker, at a call start with a talker.
//   onChange: () → void — snapshot() changed. onEnded: () → void — the call is over and the end
//     told (or given up after END_BUDGET_MS).
//   clock: () → ms (the session's time; tests set their own).
//
// API: new HandsFreeCall(opts); start({ seed }) → the session (seed: PCM of a dictation switched
// to the call); sendNow(); finish() → Promise (End; resolves once the chief was told); snapshot();
// current() → the session or null; frame(pcm640) / audio(pcm) to feed it without a microphone;
// voiceFailed(why, systemVoice) and chargeVoice({ request, choice, cost, costText, ms }) for a
// speaker that isn't made through createSpeaker. Statics for the call bar: liveLabel(session),
// shortLabel, canSend, liveOffShown, liveOffText, voiceFailure, brief; bothTo(chief, talker, …).

const crypto = require('crypto');
const HandsFree = require('./handsfree');
const HandsFreeLog = require('./handsfree-log');
const netLog = require('./net-log');
const { HandsFreeSession, Live, Phase } = require('./handsfree-session');
const { HistoryEntry } = require('./history-entry');
const decimal = require('./decimal');
const { format, tr, withTimeout } = require('./util');

/** DictationService.CHIEF_STEP and CHIEF_TARGET: the note's bb step. */
const CHIEF_STEP = 'bb';
const CHIEF_TARGET = 'chief of staff';

/**
 * The call's end: messages on their way get SETTLE_MS, words a failed one left are tried until
 * LEFTOVER_MS from the end, and the end waits END_BUDGET_MS at most, so the end line itself (a bb
 * call of a second or two) fits too.
 */
const SETTLE_MS = 20_000;
const LEFTOVER_MS = 30_000;
const END_BUDGET_MS = 45_000;

const FRAME_BYTES = (HandsFree.RATE * 2 * HandsFree.Segmenter.FRAME_MS) / 1000;

const isPartlySent = (ex) => ex instanceof Error && ex.name === 'PartlySent' && typeof ex.chiefMissed === 'boolean';
const plainCost = (d) => decimal.plain(decimal.strip(d));
const two = (n) => String(n).padStart(2, '0');
const hhmm = (d) => two(d.getHours()) + ':' + two(d.getMinutes());
const hhmmss = (d) => hhmm(d) + ':' + two(d.getSeconds());
/** Java's List.toString: "[over, send]". */
const listText = (l) => '[' + l.join(', ') + ']';

/**
 * The talker's and the chief's messages, the talker's first: tellEach starts the first one first,
 * which a real bb took first more often.
 */
function bothTo(chief, talker, toChief, toTalker) {
  const to = new Map();
  if (talker) to.set(talker, toTalker);
  to.set(chief, toChief);
  return to;
}

/**
 * Send now is offered while you can talk and nothing is on its way, and while a reply plays if
 * you have unsent words.
 */
function canSend(s) {
  const p = s.phase();
  return p === Phase.LISTENING || p === Phase.WORKING || (p === Phase.READING && s.pending() !== '');
}

/** What's happening right now, in full: the call bar's live line, its tooltip, VoiceOver. */
function liveLabel(s) {
  const live = s.liveState();
  const failed = voiceFailure(s);
  if (failed != null) return tr('Voice failed: %1$s', failed);
  switch (live) {
    case Live.HEARING:
      return tr('Hearing you');
    case Live.WRITING:
      return s.checkStep() === 'asking' ? tr('Checking whether you\'re done…') : tr('Writing down… %1$d s', Math.max(1, Math.trunc((s.writingMs() + 999) / 1000)));
    case Live.WAITING_SEND:
      return tr('Listening · not sent yet');
    case Live.SENDING:
      return tr('Sending…');
    case Live.SENT:
      return tr('Sent ✓');
    case Live.WAITING_CHIEF:
      return tr('Waiting for the chief · you can talk');
    case Live.REPLY_WAITING:
      return tr('Reply waiting · plays when your turn is over');
    case Live.REPLY_COMING:
      return tr('Reply coming…');
    case Live.PLAYING:
      return tr('Playing the reply');
    case Live.MUTED:
      return tr('Mic paused after the reply');
    case Live.ENDED:
      return tr('Ended');
    default:
      return tr('Listening');
  }
}

/** The same, short, for the call bar. */
function shortLabel(s) {
  const failed = voiceFailure(s);
  if (failed != null) return tr('Voice failed · %1$s', brief(failed));
  if (liveOffShown(s)) return tr('Live off · no %1$s key', s.liveKeyMissing());
  switch (s.liveState()) {
    case Live.HEARING:
      return tr('Hearing you');
    case Live.WRITING:
      return s.checkStep() === 'asking' ? tr('Checking…') : tr('Writing… %1$d s', Math.max(1, Math.trunc((s.writingMs() + 999) / 1000)));
    case Live.WAITING_SEND:
      return tr('Not sent yet');
    case Live.SENDING:
      return tr('Sending…');
    case Live.SENT:
      return tr('Sent ✓');
    case Live.WAITING_CHIEF:
      return tr('Working…');
    case Live.REPLY_WAITING:
      return tr('Reply waiting');
    case Live.REPLY_COMING:
      return tr('Reply coming');
    case Live.PLAYING:
      return tr('Reading');
    case Live.MUTED:
      return tr('Mic paused');
    case Live.ENDED:
      return tr('Ended');
    default:
      return tr('Listening');
  }
}

const QUIET_MOMENTS = new Set([Live.LISTENING, Live.WAITING_CHIEF, Live.REPLY_WAITING, Live.REPLY_COMING, Live.SENT]);

/**
 * The call bar says live transcription is off for a missing key: in the call's first minute,
 * while nothing more important is going on (as a voice failure, which goes first).
 */
function liveOffShown(s) {
  if (!s.liveOffRecent()) return false;
  return QUIET_MOMENTS.has(s.liveState());
}

/** In full, for VoiceOver and the call bar's tooltip. */
function liveOffText(s) {
  return tr('Live transcription is off: no %1$s key (Settings → Hands-free)', s.liveKeyMissing());
}

/**
 * Why the voice model just failed (shown a while, while nothing more important is going on:
 * you talking, a reply playing), or null.
 */
function voiceFailure(s) {
  const failed = s.voiceError();
  if (failed === '') return null;
  return QUIET_MOMENTS.has(s.liveState()) ? failed : null;
}

/** "Kokoro: HTTP 503: Service unavailable" → "Kokoro: HTTP 503": short enough for the call bar. */
function brief(failed) {
  const i = failed.indexOf(': ');
  if (i < 0) return failed;
  const j = failed.indexOf(': ', i + 2);
  return j < 0 ? failed : failed.substring(0, j);
}

class HandsFreeCall {
  constructor(opts) {
    this.opts = opts;
    this.prefs = opts.prefs;
    this.bb = opts.bb;
    this.clock = opts.clock || (() => Date.now());
    this.session = null;
    /** The last call's session, once it ended (for the call bar). */
    this.lastSession = null;
    /** This call's talker thread, fixed when the call starts; "" for none. */
    this.talker = '';
    this.chief = '';
    /** What this message cost so far (transcription, Jev), and the call in all (also the voice). */
    this.cost = decimal.of(0);
    this.callCost = decimal.of(0);
    this.unpriced = false;
    this.seconds = 0;
    /** This call's ID: its messages' notes carry it, so the notes list shows the call as one entry. */
    this.callId = '';
    this.sinceLastNote = [];
    this.callEnded = false;
    this.repliesHandle = null;
    this.ticker = null;
    this.chunk = Buffer.alloc(0);
    /** The end told to the chief (a promise), once the call ended. */
    this.ended = null;
  }

  /** The session of the call going on, or null. */
  current() {
    return this.session;
  }

  /**
   * Starts the call: the session, live transcription, the call start for the chief (and the
   * talker), the replies, the microphone, the ticker. seed: PCM of a dictation switched to the
   * call, the start of your first turn.
   */
  start({ seed = null } = {}) {
    if (this.session != null) return this.session;
    const { prefs, bb, opts } = this;
    this.callEnded = false;
    this.talker = bb.talkerId() || '';
    this.chief = bb.chiefId() || '';
    // Its notes carry it; a voice cost looked up late counts for its own call only.
    this.callId = crypto.randomUUID();
    const callId = this.callId;
    const voice = opts.voice || null;
    // The call's audio stays open (silent) for the whole call: a reply starts without a new track
    // and its warm-up. Opened first, so even the first reply finds it.
    const openAudio = !!prefs.get(HandsFree.OPEN_AUDIO, true) && voice != null && typeof voice.openCall === 'function';
    if (openAudio) voice.openCall();
    const speaker = opts.createSpeaker
      ? opts.createSpeaker({
          event: (e) => this.event(e),
          onVoiceFailed: (why, system) => this.voiceFailed(why, system),
          onCost: (info) => this.chargeVoice({ ...info, callId }),
        })
      : opts.speaker;
    this.speaker = speaker;
    const model = opts.speechModel || '';
    // The send and end words are hints for the speech model, so a short "over" isn't dropped.
    const sendWords = HandsFree.words(prefs, HandsFree.SEND_WORDS, HandsFree.DEFAULT_SEND);
    const endWords = HandsFree.list(HandsFree.endSetting(prefs));
    const hints = [...(opts.hintWords || [])];
    for (const w of sendWords) if (!hints.includes(w)) hints.push(w);
    for (const w of endWords) if (!hints.includes(w)) hints.push(w);
    const call = this;
    const session = new HandsFreeSession({
      pauseMs: HandsFree.pauseMs(prefs),
      silenceSendMs: HandsFree.silenceSendMs(prefs),
      takeMs: HandsFree.takeMs(prefs),
      gate: HandsFree.gate(prefs),
      detector: HandsFree.LEVEL,
      sendWords,
      endWords,
      transcriber: async (wav) => {
        const r = await opts.transcribe(wav, { model, hints });
        const secs = (wav.length - 44) / HandsFree.BYTES_PER_SECOND;
        call.seconds += secs;
        if (r.cost == null) call.unpriced = true;
        else {
          call.cost = decimal.add(call.cost, decimal.of(r.cost));
          call.callCost = decimal.add(call.callCost, decimal.of(r.cost));
        }
        call.event(format('speech model %s: %.1f s, %s', model, secs, r.cost == null ? 'cost unknown' : '$' + plainCost(decimal.of(r.cost))));
        return r.text;
      },
      sender: {
        send: (said, request) =>
          call.sendMessage(said, request, model).catch((ex) => {
            // Your words are kept by the call and go with the next message; this is for the report.
            if (typeof opts.sendFailed === 'function' && (!isPartlySent(ex) || ex.chiefMissed))
              opts.sendFailed(request, ex && ex.message ? ex.message : String(ex), isPartlySent(ex));
            throw ex;
          }),
      },
      speaker,
      changed: () => call.changed(),
    });
    this.session = session;
    session.clock = this.clock;
    session.onEvent((e) => call.event(e));
    // At each longer pause Jev says whether the turn is done (sent) or you want to end the call.
    if (opts.judge)
      session.judge = async (said) => {
        const v = await opts.judge(said, { sendWords, endWords });
        if (v && v.cost != null) {
          call.cost = decimal.add(call.cost, decimal.of(v.cost));
          call.callCost = decimal.add(call.callCost, decimal.of(v.cost));
        }
        return v;
      };
    session.cues = (c) => !!prefs.get(HandsFree.SOUNDS, true) && !!opts.playCue && !!opts.playCue(c);
    // With a talker, a reply to an older message than your latest isn't played: it no longer fits.
    session.dropsOutdated = this.talker !== '';
    const live = this.startLive(sendWords, endWords);
    const choice = opts.voiceChoice || null;
    if (voice != null && 'systemStatus' in voice) voice.systemStatus = (why) => call.event("the Mac's voice: " + why);
    if (voice != null && choice && choice.model && typeof voice.warm === 'function') voice.warm();
    this.callCost = decimal.of(0);
    if (opts.logFile) HandsFreeLog.append(opts.logFile, HandsFreeLog.callStarted(hhmm(new Date())));
    netLog.callStarted();
    this.event(
      format(
        'started · send %s · end %s · voice %s · live transcription %s · pause %d ms · take %d ms in %d ms · gate ×%.1f',
        listText(session.sendWords),
        listText(session.endWords),
        choice == null ? '' : typeof choice.tag === 'function' ? choice.tag() : String(choice.tag || ''),
        live,
        HandsFree.pauseMs(prefs),
        HandsFree.takeMs(prefs),
        Math.max(HandsFree.Segmenter.WINDOW_MS, Math.trunc((HandsFree.takeMs(prefs) * 3) / 2)),
        HandsFree.gate(prefs),
      ),
    );
    if (this.talker) this.event('talker ' + this.talker + ': every message goes to it and to the chief');
    this.signal(HandsFree.CALL_STARTED);
    if (seed != null && seed.length) {
      try {
        session.seed(Buffer.from(seed));
      } catch (ex) {
        this.event('couldn\'t take over the dictation: ' + (ex && ex.message));
      }
    }
    if (opts.replies) {
      try {
        this.repliesHandle = opts.replies({
          sinceSeconds: Math.trunc(Date.now() / 1000) - 5,
          ours: (request) => call.session != null && call.session.ours(request),
          // With a talker, its spoken updates from the chief carry no request: the latest one's.
          untagged: () => (call.talker === '' || call.session == null ? '' : call.session.lastRequest()),
          onReply: (request, text, published = 0, untagged = false) => {
            const s = call.session;
            if (s != null) s.reply(request, text, published, untagged);
          },
        });
      } catch {
        /* No topic: replies can't be read aloud; messages still go. */
      }
    }
    if (openAudio) this.event(voice.callOpen ? 'audio: kept open for the call' : 'audio: couldn\'t be kept open: each reply opens its own');
    if (opts.microphone) {
      try {
        const started = opts.microphone.start((pcm) => call.audio(pcm));
        if (started && typeof started.catch === 'function')
          started.catch((ex) => {
            call.event('microphone failed: ' + (ex && ex.message));
            call.finish();
          });
      } catch (ex) {
        this.event('microphone failed: ' + (ex && ex.message));
        this.finish();
        return session;
      }
    }
    this.ticker = setInterval(() => {
      const s = call.session;
      if (s == null) return;
      s.tick();
      call.notify();
    }, 1000);
    if (this.ticker.unref) this.ticker.unref();
    this.changed();
    return session;
  }

  /**
   * Live transcription for this call, if it's on and its provider's key is there: connected now,
   * so your first words don't wait for it. Its text goes to the session as it comes. Returns what
   * the call's start line says about it.
   */
  startLive(sendWords, endWords) {
    const { prefs, opts, session } = this;
    if (!prefs.get(HandsFree.LIVE, true) || !opts.createLive) return 'off';
    // The send and end words as key terms, so a short "over" is heard as that.
    const terms = [...sendWords];
    for (const w of endWords) if (!terms.includes(w)) terms.push(w);
    const call = this;
    const onText = (text) => {
      const h = call.session;
      if (h != null) h.liveText(text);
    };
    const onFailure = (why) => {
      const h = call.session;
      if (h != null) h.liveFailed(why);
    };
    const log = (e) => call.event(e);
    let s;
    try {
      s = opts.createLive(terms, { onText, onFailure, log });
    } catch (ex) {
      this.event('live transcription couldn\'t start: ' + (ex && ex.message));
      return 'off';
    }
    if (s == null) return 'off';
    if (s.missingKey) {
      session.liveKeyMissing(s.missingKey);
      return 'on, but no ' + s.missingKey + ' key: written down from audio';
    }
    if ('changed' in s) s.changed = onText;
    if ('onFailure' in s) s.onFailure = onFailure;
    if ('events' in s) s.events = log;
    session.live = s;
    s.speech(); // Open now.
    const c = s.choice;
    return c && c.model ? c.model + ' (' + c.provider + ')' : 'on';
  }

  /** Microphone audio: cut into 20 ms frames for the session. */
  audio(pcm) {
    let buf = this.chunk.length ? Buffer.concat([this.chunk, Buffer.from(pcm)]) : Buffer.from(pcm);
    let at = 0;
    for (; at + FRAME_BYTES <= buf.length; at += FRAME_BYTES) this.frame(buf.subarray(at, at + FRAME_BYTES));
    this.chunk = Buffer.from(buf.subarray(at));
  }

  /** One 20 ms frame (640 bytes), as from the microphone. */
  frame(frame) {
    const s = this.session;
    if (s != null) s.frame(frame);
  }

  /** Send now: the call bar's button or the global hotkey (also while a reply plays, which plays on). */
  sendNow() {
    const s = this.session;
    if (s != null) s.sendNow();
  }

  /** The voice model failed (the speaker says so): on screen and in the log. */
  voiceFailed(why, android) {
    const s = this.session;
    if (s != null) s.voiceFailed(why, android);
  }

  /**
   * A message of the call: to the chief, and with a talker to both at once, the same text and
   * request ID. Throws when nobody got it (your words are kept); PartlySent when one did. Each
   * message that reached someone is kept as a note.
   */
  async sendMessage(said, request, model) {
    // The chief as set now (Android reads it at each send), the talker fixed for the call.
    this.chief = this.bb.chiefId() || this.chief;
    const events = (line) => this.event(line);
    if (!this.talker) {
      await this.bb.sendHandsFree(this.chief, said, request, '', events);
      await this.keepNote(said, request, model);
      return;
    }
    let r;
    try {
      r = await this.bb.sendHandsFree(this.chief, said, request, this.talker, events);
    } catch (ex) {
      if (isPartlySent(ex)) await this.keepNote(said, request, model);
      throw ex;
    }
    await this.keepNote(said, request, model);
    const took = (r && r.took) || {};
    this.event(format('sent %s to the talker too (bb took %d ms for the talker, %d ms for the chief)', request, took[this.talker] || 0, took[this.chief] || 0));
  }

  /** Each message is kept as a note, with its transcription cost, like a dictation sent to the chief. */
  async keepNote(said, request, model) {
    const e = HistoryEntry.create(crypto.randomUUID(), model, this.seconds);
    Object.assign(e.json, {
      text: said,
      raw: said,
      original: said,
      status: 'complete',
      requests: 1,
      handsFree: true,
      call: this.callId,
      route: 'chief',
      chiefThread: this.chief,
      chiefLink: typeof this.bb.threadLink === 'function' ? this.bb.threadLink(this.chief) : '',
      chiefSent: Date.now(),
      chiefRequest: request,
    });
    // What happened in this turn, for a failed one: Activity shows the note, the log its events.
    e.json.handsFreeLog = this.sinceLastNote.splice(0);
    const cost = this.unpriced ? null : decimal.plain(this.cost);
    e.charge(cost);
    e.step('speech', model, 0, cost, null);
    this.cost = decimal.of(0);
    this.unpriced = false;
    this.seconds = 0;
    e.step(CHIEF_STEP, CHIEF_TARGET, 0, null, null);
    if (this.opts.saveNote) await this.opts.saveNote(e);
  }

  /**
   * What reading a reply cost (the speaker looked it up and logged it: OpenRouter's generation,
   * else the list price; voice.js createSpeaker's onCost): added to the call's cost and to the
   * note of the message it answers. callId: the call it was for (a late lookup from an earlier
   * call doesn't count for this one's total).
   */
  async chargeVoice({ request, choice = null, cost, costText = null, ms = 0, callId = this.callId }) {
    if (cost == null) return;
    const price = decimal.of(costText != null ? costText : cost);
    if (callId === this.callId) this.callCost = decimal.add(this.callCost, price);
    const model = choice && choice.model ? choice.model : '';
    if (this.opts.updateNote) {
      const charged = decimal.plain(price);
      try {
        await this.opts.updateNote(request, (e) => {
          e.charge(charged);
          e.addCost('voiceCost', charged);
          e.json.voiceModel = model;
          e.step('voice', model, ms, charged, null);
        });
      } catch (ex) {
        this.event('voice cost not kept: ' + (ex && ex.message));
      }
    }
    this.notify();
  }

  /**
   * Tells the chief a call started or ended, so it knows whether spoken messages are heard; and the
   * talker, with one. In the background; returns its promise, or null without a chief. after: the
   * session whose messages still on their way go first (in order).
   */
  signal(line, after = null) {
    const chief = this.chief;
    const talker = this.talker;
    if (!chief) return null;
    const call = this;
    return (async () => {
      let said = line;
      let chiefSaid = null;
      if (after != null) {
        // Within END_BUDGET_MS: the messages on their way, the words a failed one left (tried a
        // few times), then the end itself.
        const start = Date.now();
        if (!(await after.awaitDelivered(SETTLE_MS))) call.event('a message was still on its way when the call ended');
        await after.sendLeftover(after.clock() + LEFTOVER_MS - (Date.now() - start));
        said = line + after.endNote();
        chiefSaid = line + after.endNoteForChief(); // With last words only the talker got.
      }
      // The call start names the talker for the chief; the talker learns it's the talker (told to
      // use its skill first, if it wasn't told yet).
      const starting = said === HandsFree.CALL_STARTED;
      const chiefLine = starting ? HandsFree.callStarted(talker) : chiefSaid != null ? chiefSaid : said;
      const talkerLine = starting ? HandsFree.TALKER_CALL_STARTED : said;
      if (starting && talker && call.opts.tellTalkerSkill) {
        try {
          await call.opts.tellTalkerSkill();
        } catch {
          /* Safely: the talker still gets the call start. */
        }
      }
      const to = bothTo(chief, talker, chiefLine, talkerLine);
      let failed;
      try {
        failed = (await call.bb.tellEach(to)) || {};
      } catch (ex) {
        failed = {};
        for (const id of to.keys()) failed[id] = (ex && ex.message) || String(ex);
      }
      for (const [id, text] of to) {
        const who = id === chief ? 'the chief' : 'the talker (' + id + ')';
        if (Object.prototype.hasOwnProperty.call(failed, id)) call.event('couldn\'t tell ' + who + ' ' + text + ': ' + failed[id]);
        else call.event('told ' + who + ': ' + text);
      }
    })().catch((ex) => call.event('couldn\'t tell the chief: ' + (ex && ex.message)));
  }

  /** Each thing that happens: the hands-free log and the note of the next message. */
  event(e) {
    const line = hhmmss(new Date()) + ' ' + e;
    this.sinceLastNote.push(line);
    if (this.opts.logFile) HandsFreeLog.append(this.opts.logFile, line);
    if (this.opts.log) {
      try {
        this.opts.log(line);
      } catch {
        /* The log is a help. */
      }
    }
  }

  changed() {
    const s = this.session;
    if (s != null && s.state() === HandsFreeSession.State.ENDED) {
      this.finish();
      return;
    }
    if (this.callEnded) return; // What still goes on after the end (its messages) mustn't show the call again.
    this.notify();
  }

  notify() {
    if (this.opts.onChange) {
      try {
        this.opts.onChange();
      } catch {
        /* The screen is a help. */
      }
    }
  }

  /**
   * The call bar's state: { active, state, phase, floor, live, liveLabel, shortLabel, pending,
   * reply, reasons [{at, text, times}], cost (Number, the call's so far), canSend, canEnd,
   * voiceError, liveOff (the full text while the call bar shows it, else ""), liveKeyMissing,
   * held, sent, talker }.
   */
  snapshot() {
    const s = this.session || this.lastSession;
    if (s == null)
      return {
        active: false,
        state: 'ENDED',
        live: Live.ENDED,
        liveLabel: tr('Ended'),
        shortLabel: tr('Ended'),
        pending: '',
        reply: '',
        reasons: [],
        cost: decimal.toNumber(this.callCost),
        canSend: false,
        canEnd: false,
      };
    return {
      active: !this.callEnded,
      state: s.state(),
      phase: s.phase(),
      floor: s.floor(),
      live: s.liveState(),
      liveLabel: liveLabel(s),
      shortLabel: shortLabel(s),
      pending: s.pending(),
      reply: s.replyText(),
      reasons: s.reasons(),
      cost: decimal.toNumber(this.callCost),
      canSend: !this.callEnded && canSend(s),
      canEnd: !this.callEnded,
      voiceError: s.voiceError(),
      liveOff: liveOffShown(s) ? liveOffText(s) : '',
      liveKeyMissing: s.liveKeyMissing(),
      held: s.held(),
      sent: s.sent(),
      talker: this.talker,
    };
  }

  /**
   * Ends the call (End, or the session ended itself): once per call. Resolves once the chief was
   * told the call ended (after your last words), or after END_BUDGET_MS.
   */
  finish() {
    // Once per call: a second End (or an end the session reported meanwhile) mustn't cut the
    // end's messages short.
    if (this.callEnded) return this.ended || Promise.resolve();
    this.callEnded = true;
    const s = this.session;
    this.session = null;
    this.lastSession = s; // The call bar shows it ended.
    if (s != null) s.end();
    if (this.opts.microphone) {
      try {
        this.opts.microphone.stop();
      } catch {
        /* Never started. */
      }
    }
    this.event('call ended · $' + plainCost(this.callCost) + ' on OpenRouter');
    // With the end, once: the replies that never reached you. After the messages on their way:
    // words a failed one left go first, then the notes left.
    const told = s == null ? null : this.signal(HandsFree.CALL_ENDED, s);
    if (this.repliesHandle) {
      try {
        if (typeof this.repliesHandle.close === 'function') this.repliesHandle.close();
        else if (typeof this.repliesHandle.finish === 'function') this.repliesHandle.finish();
      } catch {
        /* Gone already. */
      }
      this.repliesHandle = null;
    }
    const voice = this.opts.voice;
    if (voice && typeof voice.shutdown === 'function') {
      try {
        voice.shutdown();
      } catch {
        /* Stopping anyway. */
      }
    }
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.notify();
    // Done once the chief knows the call ended (at most END_BUDGET_MS, messages still on their way first).
    this.ended = (told ? withTimeout(told, END_BUDGET_MS).catch(() => {}) : Promise.resolve()).then(() => {
      if (this.session == null && this.opts.onEnded) this.opts.onEnded(); // Unless a new call started meanwhile.
    });
    return this.ended;
  }
}

module.exports = {
  HandsFreeCall,
  bothTo,
  canSend,
  liveLabel,
  shortLabel,
  liveOffShown,
  liveOffText,
  voiceFailure,
  brief,
  SETTLE_MS,
  LEFTOVER_MS,
  END_BUDGET_MS,
};
