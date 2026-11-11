'use strict';
// Remote dictation (Mac only for now): something outside (a button, a gesture in another app,
// through a bridge) asks for a dictation that goes to the chief, over ntfy. It's the user's own
// topic with "-remote" added, so the phone, which shows every message on the topic, never sees
// these. Requests are messages tagged "dd-remote", one of dictate-start / dictate-stop /
// dictate-cancel, and "session-<id>"; the title says who asks, a start's message is context that
// goes to the chief after what was said. The Mac answers on the same topic with the session's
// state (tags dd-remote, dictate-state, session-<id>; priority min; a JSON body), so the app that
// asked can show it:
//
//   listening → transcribing → sent (the transcript and request ID) | failed (why)
//   cancelled, or expired (a request older than MAX_AGE_MS, e.g. replayed after a reconnect)
//
// A start does what the shortcut does, with the chief chosen at once (saved on the note). A stop
// writes it down and sends it as a Chief dictation does. Without a stop within STOP_WITHIN_MS it
// stops and keeps the note for the user (Needs you). Whatever ends it on the Mac (the shortcut,
// Stop, ✕, 📞) is told as well. Every request and state goes to the app log and the network log;
// a state that can't be published is retried, then shown as a notification.

const { tr, SerialQueue } = require('./util');
const chiefText = require('./chief-text');
const netLog = require('./net-log');
const flow = require('./note-flow');

/** Pref: let another app start a dictation through the assistant (on by default). */
const PREF = 'remoteDictation';

const TAG = 'dd-remote';
const STATE_TAG = 'dictate-state';
const START = 'dictate-start',
  STOP = 'dictate-stop',
  CANCEL = 'dictate-cancel';
const ACTIONS = [START, STOP, CANCEL];
const SESSION = /^session-([A-Za-z0-9_-]{4,40})$/i;

const States = Object.freeze({
  LISTENING: 'listening',
  TRANSCRIBING: 'transcribing',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

/** A request older than this (by ntfy's time) does nothing: it was meant for back then. */
const MAX_AGE_MS = 20_000;
/** Recording ends by itself this long after a remote start without a stop. */
const STOP_WITHIN_MS = 120_000;
/** The context a start may carry, at most (more is cut, and said so). */
const CONTEXT_MAX = 4000;
/** A state's text at most, so its body stays under ntfy's 4,096 bytes (else it becomes an attachment). */
const TEXT_MAX = 2500;
/** The waits before publishing a state again when ntfy didn't take it. */
const PUBLISH_WAITS = [1500, 4000];
/** A note that failed to go and is tried again by itself: its "sent" is still told this long. */
const WATCH_MS = 20 * 60_000;
/** Finished sessions remembered, to answer a late stop or cancel with how they ended. */
const KEEP_FINISHED = 20;

/** The topic for remote dictation: the assistant's own plus "-remote". */
function topicFor(topic) {
  return topic ? topic + '-remote' : '';
}

/**
 * A topic message as a request: null when it isn't one (no dd-remote tag, or a state). Otherwise
 * { id, time (unix s), title, session ("" when missing), action ("" unless exactly one), actions }.
 */
function parse(m) {
  if (!m || typeof m !== 'object') return null;
  if ((m.event === undefined || m.event === null ? 'message' : m.event) !== 'message') return null;
  const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t).trim()) : [];
  const lower = tags.map((t) => t.toLowerCase());
  if (!lower.includes(TAG) || lower.includes(STATE_TAG)) return null;
  let session = '';
  for (const t of tags) {
    const x = SESSION.exec(t);
    if (x) {
      session = x[1];
      break;
    }
  }
  const actions = ACTIONS.filter((a) => lower.includes(a));
  return {
    id: String(m.id || ''),
    time: Number(m.time) || 0,
    title: String(m.title || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    session,
    action: actions.length === 1 ? actions[0] : '',
    actions,
  };
}

/** Publishes one state to the topic; throws when ntfy didn't take it. */
async function publishState(fetchImpl, server, topic, body) {
  const url = server + '/' + topic;
  const data = JSON.stringify(body);
  return netLog.request('ntfy remote state', 'POST', url, async (net) => {
    net.sent(Buffer.byteLength(data, 'utf8')).note(body.state + ', session ' + body.session);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Title: 'Dictate & Delegate', Tags: [TAG, STATE_TAG, 'session-' + body.session].join(','), Priority: 'min' },
      body: data,
      signal: AbortSignal.timeout(15_000),
    });
    net.status(res.status);
    const answer = await res.text().catch(() => '');
    if (res.status >= 300) {
      net.body(answer);
      throw new Error('ntfy answered HTTP ' + res.status + (answer.trim() ? ': ' + answer.trim().slice(0, 200) : ''));
    }
    return true;
  }, { secrets: [topic] });
}

class RemoteDictation {
  /**
   * o: dictation (the Dictation), prefs, loadNote(id) → note|null, endpoint() → { server, topic }
   * of the assistant's ntfy or null, checks { inCall(), chiefReady(), hasKey(), microphone() →
   * 'granted'|'denied'|'not-determined'|… }, problem({ title, text }) (a notification), log(line),
   * version, and for tests fetch, publish(body), clock, timers, stopWithinMs, publishWaits.
   */
  constructor(o) {
    this.dictation = o.dictation;
    this.prefs = o.prefs;
    this.loadNote = o.loadNote || (async () => null);
    this.endpoint = o.endpoint || (() => null);
    this.checks = { inCall: () => false, chiefReady: () => true, hasKey: () => true, microphone: () => 'granted', ...(o.checks || {}) };
    this.problem = o.problem || (() => {});
    this.log = o.log || (() => {});
    this.version = o.version || '?';
    this.fetch = o.fetch || ((...a) => globalThis.fetch(...a));
    this.publishOne = o.publish || ((body) => {
      const e = this.endpoint();
      if (!e || !e.topic) throw new Error(tr('no ntfy topic on this Mac'));
      return publishState(this.fetch, e.server, topicFor(e.topic), body);
    });
    this.clock = o.clock || (() => Date.now());
    this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    this.stopWithinMs = o.stopWithinMs || STOP_WITHIN_MS;
    this.publishWaits = o.publishWaits || PUBLISH_WAITS;
    this.subscribe = o.subscribe || chiefText.subscribe;

    /** The session this Mac is recording or writing down for; null when none. */
    this.active = null;
    /** Finished sessions by id (their last state), newest last. */
    this.finished = new Map();
    /** Notes whose sending failed and is tried again by itself: note id → session. */
    this.watching = new Map();
    this.requests = new SerialQueue();
    this.work = new Set();
    this.publishing = new SerialQueue();
    this.sub = null;
    this.key = '';
    this.connection = 'off';
    this.lastLine = '';

    this.dictation.on('change', (snap) => this.changed(snap));
    this.dictation.on('notes', (id) => this.noteChanged(id));
    this.dictation.on('cancelled', () => this.endedOnMac(States.CANCELLED, null));
    this.dictation.on('handedToCall', () => this.endedOnMac(States.FAILED, tr('It became a hands-free call on the Mac (📞); nothing was sent from this dictation.')));
  }

  enabled() {
    return this.prefs.get(PREF, true) !== false;
  }

  // ---------------------------------------------------------------- the subscription

  /** (Re)connects to <topic>-remote when the topic or server changed. */
  refresh() {
    let e = null;
    try {
      e = this.endpoint();
    } catch {
      e = null;
    }
    const topic = e && e.topic ? topicFor(e.topic) : '';
    const key = topic ? e.server + '|' + topic : '';
    if (key === this.key) return;
    this.stop();
    this.key = key;
    if (!key) return;
    this.say(`remote: listening on ${e.server} for remote dictation requests` + (this.enabled() ? '' : ' (switched off: requests are answered "switched off")'));
    const server = e.server;
    this.sub = this.subscribe({
      server,
      topic,
      what: 'ntfy remote',
      fetch: this.fetch,
      onMessage: (m) => this.message(m, server),
      onState: (state, err) => {
        this.connection = state;
        if (state === 'retrying') this.log(`remote: connection lost (${err ? err.message || err : 'closed'}); retrying`);
      },
    });
  }

  stop() {
    if (this.sub) this.sub.stop();
    this.sub = null;
    this.key = '';
    this.connection = 'off';
  }

  /** For Settings: how the connection stands and the last thing that happened. */
  status() {
    return { connection: this.connection, last: this.lastLine, active: !!this.active, enabled: this.enabled() };
  }

  say(line) {
    this.lastLine = line.replace(/^remote: /, '');
    this.log(line);
  }

  // ---------------------------------------------------------------- requests

  /** One message from the topic (each once). Requests are handled one after another, in order. */
  async message(m, server) {
    const r = parse(m);
    if (!r) return; // Not a request: our own states, or something else on the topic.
    const age = r.time ? this.clock() - r.time * 1000 : 0;
    const from = r.title || tr('another app');
    netLog.event('remote dictation request', '', r.action || 'unreadable', '', 'session ' + (r.session || '?') + ', from ' + from + ', ' + Math.round(age / 1000) + ' s old, id ' + (r.id || '?'));
    if (!r.session) {
      this.say(`remote: a request from ${from} without a session tag (tags ${(m.tags || []).join(',')}); it can't be answered`);
      this.problem({ title: tr('Remote dictation request not understood'), text: tr('A request from %1$s had no session-<id> tag, so it was ignored and could not be answered.', from) });
      return;
    }
    if (!r.action) {
      this.say(`remote: a request from ${from} (session ${r.session}) with ${r.actions.length ? 'several actions' : 'no action'}`);
      return this.answer(r.session, States.FAILED, { error: tr('The request needs exactly one of dictate-start, dictate-stop or dictate-cancel in its tags.') });
    }
    if (age > MAX_AGE_MS) {
      this.say(`remote: ${r.action} from ${from} (session ${r.session}) was ${Math.round(age / 1000)} s old: expired, nothing done`);
      return this.answer(r.session, States.EXPIRED, { error: tr('The request was %1$d s old when it reached the Mac (more than %2$d s), so nothing was done.', Math.round(age / 1000), MAX_AGE_MS / 1000) });
    }
    let context = '';
    if (r.action === START) {
      try {
        context = await chiefText.text(m, server, { fetch: this.fetch });
      } catch (ex) {
        return this.answer(r.session, States.FAILED, { error: tr("The request's context couldn't be read: %1$s", (ex && ex.message) || String(ex)) });
      }
      if (context.length > CONTEXT_MAX) {
        this.log(`remote: the context from ${from} was ${context.length} characters; only the first ${CONTEXT_MAX} go along`);
        context = context.slice(0, CONTEXT_MAX) + '\n[… shortened by Dictate & Delegate]';
      }
    }
    this.say(`remote: ${r.action} from ${from} (session ${r.session})`);
    // Not awaited: the subscription reads on meanwhile; requests still run one after another.
    this.requests.run(() => {
      if (r.action === START) return this.start(r.session, from, context);
      if (r.action === STOP) return this.stopRequested(r.session);
      return this.cancelRequested(r.session);
    }).catch((ex) => {
      this.log('remote: ' + ((ex && ex.stack) || ex));
      return this.answer(r.session, States.FAILED, { error: tr('Something went wrong on the Mac: %1$s', (ex && ex.message) || String(ex)) });
    });
  }

  /** Why a dictation can't start now, in words; "" when it can. */
  whyNot() {
    if (!this.enabled()) return tr('Remote dictation is switched off on the Mac (Dictate & Delegate → Settings → Start and insert).');
    if (this.active) return tr('Another remote dictation (from %1$s) is still under way on the Mac.', this.active.by);
    const d = this.dictation;
    if (d.snapshot().state === 'recording' || d.busy())
      return d.snapshot().state === 'recording' ? tr('A dictation is already recording on the Mac.') : tr('The Mac is still writing down the last dictation.');
    if (d.hasSavedRecording()) return tr('A saved recording waits on the Mac: retry or discard it there first.');
    if (this.checks.inCall()) return tr('A hands-free call is on.');
    if (!this.checks.chiefReady()) return tr('The Mac is not signed in to bb, or has no chief of staff set up (Settings → bb).');
    if (!this.checks.hasKey()) return tr('The Mac has no OpenRouter key saved (Settings).');
    const mic = this.checks.microphone();
    if (mic === 'not-determined') return tr("Dictate & Delegate hasn't been allowed the microphone yet: start one dictation with your shortcut and allow it.");
    if (mic !== 'granted') return tr('Dictate & Delegate may not use the microphone (System Settings → Privacy & Security → Microphone).');
    return '';
  }

  async start(id, by, context) {
    if (this.active && this.active.id === id) return this.tellAgain(this.active); // A second start of the same session.
    const why = this.whyNot();
    if (why) {
      this.say(`remote: can't start (session ${id}): ${why}`);
      return this.answer(id, States.FAILED, { error: why });
    }
    const s = { id, by, context, phase: 'starting', noteId: '', last: null, timer: null, done: false };
    this.active = s;
    await this.dictation.start({ remote: { session: id, by, context, at: this.clock() } });
    const snap = this.dictation.snapshot();
    if (snap.state !== 'recording') return this.finish(s, States.FAILED, { error: tr("Recording didn't start: %1$s", snap.detail) });
    s.phase = 'listening';
    s.timer = this.timers.setTimeout(() => this.timedOut(s), this.stopWithinMs);
    this.tell(s, States.LISTENING);
  }

  async stopRequested(id) {
    const s = this.active;
    if (!s || s.id !== id) return this.notActive(id, 'stop');
    if (s.phase !== 'listening') return this.tellAgain(s);
    // Told at once (the app that asked waits for it); writing it down follows the microphone's stop.
    s.phase = 'transcribing';
    this.clearTimer(s);
    this.tell(s, States.TRANSCRIBING);
    // Not awaited: writing it down can take a while, and the next request mustn't wait for it.
    this.track(this.dictation.stop().catch((ex) => this.log('remote: stop: ' + ((ex && ex.stack) || ex))));
  }

  async cancelRequested(id) {
    const s = this.active;
    if (!s || s.id !== id) return this.notActive(id, 'cancel');
    if (s.phase !== 'listening') {
      this.say(`remote: cancel for session ${id} came too late (it's ${s.last ? s.last.state : s.phase})`);
      return this.tellAgain(s);
    }
    s.phase = 'cancelling';
    this.clearTimer(s);
    this.track(this.dictation.cancel().catch((ex) => this.log('remote: cancel: ' + ((ex && ex.stack) || ex))));
  }

  /** A stop or cancel for a session that isn't under way: how it ended, if it's known. */
  notActive(id, what) {
    const f = this.finished.get(id);
    if (f) return this.tellAgain(f);
    this.say(`remote: ${what} for session ${id}, which isn't under way on this Mac`);
    return this.answer(id, States.FAILED, { error: tr('No dictation with this session is under way on the Mac.') });
  }

  timedOut(s) {
    s.timer = null;
    if (s.done || s.phase !== 'listening' || this.dictation.snapshot().state !== 'recording') return;
    const why = tr('no stop came from %1$s within %2$d minutes', s.by, Math.round(this.stopWithinMs / 60_000));
    this.say(`remote: session ${s.id}: ${why}; stopped, kept on the Mac, not sent`);
    this.finish(s, States.FAILED, {
      error: tr('No stop came within %1$d minutes, so the Mac stopped recording. The note is kept there, not sent: it waits under Needs you.', Math.round(this.stopWithinMs / 60_000)),
    });
    this.track(this.dictation.stopToKeep(why).catch((ex) => this.log('remote: stop after the time-out: ' + ((ex && ex.stack) || ex))));
  }

  // ---------------------------------------------------------------- what the dictation does

  changed(snap) {
    const s = this.active;
    if (!s || s.done || !['listening', 'stopping', 'cancelling', 'transcribing'].includes(s.phase)) return;
    switch (snap.state) {
      case 'uploading':
        if (s.phase !== 'transcribing') {
          this.clearTimer(s);
          s.phase = 'transcribing';
          this.tell(s, States.TRANSCRIBING);
        }
        return;
      case 'copied':
        if (!snap.session.noteId) return;
        s.noteId = snap.session.noteId;
        s.phase = 'delivering';
        this.check(s);
        return;
      case 'error':
      case 'empty':
        this.finish(s, States.FAILED, { error: snap.detail });
        return;
      case 'ready':
        // ✕ and 📞 say so first ('cancelled', 'handedToCall'); anything else that ends it:
        this.finish(s, States.FAILED, { error: tr('The dictation ended on the Mac without a note.') });
        return;
    }
  }

  /** ✕ or 📞 on the Mac (or a remote cancel) ended the recording. */
  endedOnMac(state, error) {
    const s = this.active;
    if (!s || s.done || !['listening', 'stopping', 'cancelling'].includes(s.phase)) return;
    if (s.phase !== 'cancelling') this.say(`remote: session ${s.id} ended on the Mac (${state === States.CANCELLED ? '✕' : '📞'})`);
    this.finish(s, state, error ? { error } : {});
  }

  noteChanged(id) {
    const s = this.active && this.active.noteId === id ? this.active : this.watching.get(id);
    if (s) this.check(s);
  }

  /** The note was written down: where its delivery stands, told once it's decided. */
  async check(s) {
    let n = null;
    try {
      n = await this.loadNote(s.noteId);
    } catch {
      n = null;
    }
    const watched = this.watching.get(s.noteId) === s;
    if (s.done && !watched) return;
    if (!n) {
      this.watching.delete(s.noteId);
      if (!s.done) this.finish(s, States.FAILED, { error: tr('The note was deleted on the Mac.') });
      return;
    }
    const now = this.clock();
    if (flow.sent(n)) {
      this.watching.delete(s.noteId);
      const said = typeof n.original === 'string' ? n.original : n.text || '';
      return this.finish(s, States.SENT, { text: said, request: n.chiefRequest || '' }, watched);
    }
    const d = flow.delivery(n, now);
    if (watched) {
      // Still being tried by itself? Otherwise it waits for the user now: nothing more to tell.
      if (d !== flow.Delivery.WAITING && d !== flow.Delivery.SENDING && d !== flow.Delivery.DUE) this.watching.delete(s.noteId);
      else if (now > s.watchUntil) this.watching.delete(s.noteId);
      return;
    }
    if (n.chiefFailed && d !== flow.Delivery.SENDING) {
      const again = d === flow.Delivery.WAITING || d === flow.Delivery.DUE;
      if (again) {
        s.watchUntil = now + WATCH_MS;
        this.watching.set(s.noteId, s);
      }
      return this.finish(s, States.FAILED, {
        error:
          tr('Not sent to your chief of staff: %1$s', String(n.chiefFailed)) +
          (again ? ' ' + tr("It's tried again by itself for a few minutes; a later \"sent\" says it got there.") : ''),
        request: n.chiefRequest || '',
      });
    }
    if (d === flow.Delivery.NONE) return this.finish(s, States.FAILED, { error: tr('Written down, but not sent: sending it to the chief was taken back on the Mac. The note is kept there.') });
    if (d === flow.Delivery.NEEDS_OK) return this.finish(s, States.FAILED, { error: tr("Written down, but it doesn't go by itself (%1$s): it waits on the Mac under Needs you.", flow.waitReason(n, now)) });
    // DUE or SENDING: the next change of the note says how it went.
  }

  // ---------------------------------------------------------------- telling the app that asked

  finish(s, state, extra = {}, again = false) {
    if (s.done && !again) return;
    s.done = true;
    s.phase = 'done';
    this.clearTimer(s);
    if (this.active === s) this.active = null;
    this.finished.delete(s.id);
    this.finished.set(s.id, s);
    while (this.finished.size > KEEP_FINISHED) this.finished.delete(this.finished.keys().next().value);
    return this.tell(s, state, extra);
  }

  clearTimer(s) {
    if (s.timer !== null && s.timer !== undefined) this.timers.clearTimeout(s.timer);
    s.timer = null;
  }

  /** A state for a session this Mac doesn't run (refused, expired, unknown). */
  answer(id, state, extra) {
    return this.tell({ id, last: null }, state, extra);
  }

  /** The session's last state once more (a repeated or late request). */
  tellAgain(s) {
    if (!s.last) return this.tell(s, States.FAILED, { error: tr('No state yet; try again in a moment.') });
    const { state, text, request, error } = s.last;
    return this.tell(s, state, { text, request, error });
  }

  tell(s, state, extra = {}) {
    const body = { session: s.id, state };
    if (extra.text !== undefined) {
      const t = String(extra.text);
      body.text = t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) + '…' : t;
      if (t.length > TEXT_MAX) body.textShortened = true;
    }
    if (extra.request) body.request = extra.request;
    if (extra.error) body.error = String(extra.error);
    body.app = 'mac ' + this.version;
    body.at = this.clock();
    s.last = body;
    this.say(`remote: session ${s.id}: ${state}` + (body.request ? ` (request ${body.request})` : '') + (body.error ? ': ' + body.error : ''));
    // In order, on their own queue: a slow ntfy doesn't hold up the next request.
    this.publishing.run(() => this.publish(body)).catch((ex) => this.log('remote: ' + ((ex && ex.stack) || ex)));
  }

  /** Publishes a state, again after a pause when ntfy didn't take it; in the end a notification says so. */
  async publish(body) {
    let last = null;
    for (let i = 0; i <= this.publishWaits.length; i++) {
      if (i > 0) await new Promise((r) => this.timers.setTimeout(r, this.publishWaits[i - 1]));
      try {
        await this.publishOne(body);
        if (i > 0) this.log(`remote: state ${body.state} of session ${body.session} published on try ${i + 1}`);
        return true;
      } catch (ex) {
        last = ex;
        this.log(`remote: state ${body.state} of session ${body.session} not published (try ${i + 1}): ${(ex && ex.message) || ex}`);
      }
    }
    const why = (last && last.message) || String(last);
    this.say(`remote: couldn't tell the app that asked (session ${body.session}) "${body.state}": ${why}`);
    this.problem({
      title: tr("Couldn't tell the app that started the dictation"),
      text: tr('The state "%1$s" didn\'t reach ntfy (%2$s). Details in Settings → Network log.', body.state, why),
    });
    return false;
  }

  /** Keeps a stop or cancel under way, for idle(). */
  track(p) {
    this.work.add(p);
    p.finally(() => this.work.delete(p));
    return p;
  }

  /** Resolves once every request, stop and state so far is handled and published (tests). */
  async idle() {
    for (;;) {
      await this.requests.idle();
      const pending = [...this.work];
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    await this.publishing.idle();
  }
}

module.exports = {
  PREF,
  TAG,
  STATE_TAG,
  START,
  STOP,
  CANCEL,
  States,
  MAX_AGE_MS,
  STOP_WITHIN_MS,
  CONTEXT_MAX,
  TEXT_MAX,
  WATCH_MS,
  topicFor,
  parse,
  publishState,
  RemoteDictation,
};
