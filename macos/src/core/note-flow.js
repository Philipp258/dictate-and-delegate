'use strict';
// Port of NoteFlow.java.
//
// A note's journey, kept on the note itself so nothing lives only in memory: what it is for (its
// intent: just a dictation, or a request to the chief), and two steps that each keep their own
// state, tries and last error: writing it down (transcription), then delivering it to the chief.
// Everything that moves a note on (the panel, the note page, Retry, the outbox's tries, the app
// starting again) reads and writes this state, never a copy in memory.
//
// Rules:
// - The intent is saved the moment it's chosen (the panel's Chief, also while recording), so ✕, a
//   retry, quitting or a restart can't lose it. Choosing it again, or Don't send, are saved the same way.
// - A note goes to the chief by itself only while it's fresh: within AUTO_MS of the recording
//   ending, the intent being chosen, or the user tapping Send on it. After that it waits in
//   NEEDS_OK, visible, until the user reads it and taps Send (or Don't send).
// - Each note goes once: its request ID is saved before the first try, every try uses it, and a
//   try after one whose outcome is unknown checks bb first.
// - Every try of either step is logged on the note (log), with its real error.
//
// Mac: one assistant, so `assistant` is always 0; the fields are the Android ones so notes read
// the same.

const { tr } = require('./util');

/** A note goes to the chief by itself only this long after it was recorded, chosen or confirmed. */
const AUTO_MS = 15 * 60_000;
/** A try that started this long ago and never ended (the app quit) no longer counts as under way. */
const SENDING_STALE_MS = 3 * 60_000;
/** The note's log keeps this many entries, the newest. */
const LOG_MAX = 80;

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const num = (v) => Number(v) || 0;

// ------------------------------------------------------------------ intent

/** The user chose to send this note to the chief (now). Nothing changes once it's sent. */
function wantChief(n, now) {
  if (sent(n)) return;
  n.intent = { to: 'chief', assistant: 0, at: now };
  delete n.intentDropped;
  n.route = 'chief';
}

/** Taken back (a second tap while it's only chosen, or Don't send). False once sent or under way. */
function dropChief(n, now) {
  if (sent(n) || sending(n, now)) return false;
  delete n.intent;
  n.intentDropped = now;
  delete n.chiefQueued;
  delete n.chiefNextTry;
  if (!has(n, 'chiefRequest')) delete n.route;
  return true;
}

/** The user tapped Send on this note: it goes now, also when it's old, and is tried again for a while. */
function confirm(n, now) {
  n.chiefOkAt = now;
}

/** Meant for the chief (chosen, or from before intents were saved: it was sent or tried). */
function meantForChief(n) {
  if (n.handsFree === true) return false;
  if (has(n, 'intentDropped') && !has(n, 'intent')) return false;
  if (n.intent && typeof n.intent === 'object') return n.intent.to === 'chief';
  return has(n, 'chiefThread') || has(n, 'chiefFailed') || has(n, 'chiefSending');
}

function chosenAt(n) {
  return n.intent && typeof n.intent === 'object' ? num(n.intent.at) : 0;
}

/** When the recording ended. */
function recordedAt(n) {
  return num(n.created) + Math.round(num(n.duration) * 1000);
}

/** The latest of: the recording ending, the intent being chosen, the user tapping Send. */
function anchor(n) {
  return Math.max(recordedAt(n), chosenAt(n), num(n.chiefOkAt));
}

/** Whether it may still go to the chief by itself. */
function fresh(n, now) {
  const ok = num(n.chiefOkAt);
  // Cut off without Stop (the microphone, quitting): it may be half a sentence, so it waits for the user.
  if (n.interrupted === true && ok === 0) return false;
  if (num(n.stoppedAt) > ok) return false;
  return now - anchor(n) <= AUTO_MS;
}

// ------------------------------------------------------------------ delivery

const Delivery = {
  NONE: 'NONE',
  NEEDS_TRANSCRIPT: 'NEEDS_TRANSCRIPT',
  DUE: 'DUE',
  SENDING: 'SENDING',
  WAITING: 'WAITING',
  NEEDS_OK: 'NEEDS_OK',
  SENT: 'SENT',
};

function sent(n) {
  return has(n, 'chiefThread') && !has(n, 'chiefFailed') && !has(n, 'chiefSending');
}

function sending(n, now) {
  const at = num(n.chiefSending);
  return at > 0 && now - at < SENDING_STALE_MS;
}

function transcribed(n) {
  return n.status === 'complete' && String(n.text || '').trim() !== '';
}

function delivery(n, now) {
  if (n.handsFree === true) return has(n, 'chiefThread') ? Delivery.SENT : Delivery.NONE;
  if (sent(n)) return Delivery.SENT;
  if (!meantForChief(n)) return Delivery.NONE;
  if (!transcribed(n)) return Delivery.NEEDS_TRANSCRIPT;
  if (sending(n, now)) return Delivery.SENDING;
  if (!fresh(n, now)) return Delivery.NEEDS_OK;
  if (num(n.chiefTries) > 0 && n.chiefQueued !== true) return Delivery.NEEDS_OK;
  if (n.chiefQueued === true && num(n.chiefNextTry) > now) return Delivery.WAITING;
  return Delivery.DUE;
}

/** A try starts: its request ID (the note's first one, kept for every try) is saved before anything goes out. */
function beginSend(n, request, now) {
  n.chiefRequest = request;
  n.chiefSending = now;
  n.route = 'chief';
  n.assistant = 0;
}

/** The wait before try number tries + 1 (Outbox.delayMs). */
function delayMs(tries) {
  const steps = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  return tries <= 0 ? 0 : tries <= steps.length ? steps[tries - 1] : 900_000;
}

/** A try failed (why: plain words with the real error): tried again by itself while fresh, else it waits for Send. */
function sendFailed(n, why, now) {
  delete n.chiefSending;
  const tries = num(n.chiefTries) + 1;
  n.chiefFailed = why;
  n.chiefTries = tries;
  if (!has(n, 'chiefFailedAt')) n.chiefFailedAt = now;
  n.chiefLastTry = now;
  if (fresh(n, now)) {
    n.chiefQueued = true;
    n.chiefNextTry = now + delayMs(tries);
  } else {
    delete n.chiefQueued;
    delete n.chiefNextTry;
  }
}

/** It got there. chiefTries and chiefFailedAt stay, to say it took a while. */
function sendDone(n, chief, link, now) {
  for (const k of ['chiefSending', 'chiefQueued', 'chiefNextTry', 'chiefFailed']) delete n[k];
  n.chiefThread = chief;
  n.chiefLink = link || '';
  n.chiefSent = now;
}

/** Notes from before 0.4.0 queued to go again for two days: now only fresh ones do. */
function settle(n, now) {
  if (n.chiefQueued !== true || fresh(n, now)) return false;
  delete n.chiefQueued;
  delete n.chiefNextTry;
  return true;
}

// ------------------------------------------------------------------ writing it down

function speechFailed(n, why, now) {
  n.transcribeFailed = why;
  if (!has(n, 'speechFailedAt')) n.speechFailedAt = now;
  n.speechLastTry = now;
  n.speechTries = num(n.speechTries) + 1;
}

function speechDone(n) {
  delete n.transcribeFailed;
}

// ------------------------------------------------------------------ the note's log

/** One try of a step, on the note: when, which step ("speech", "bb"), what it went to, how long, the result. */
function log(n, at, step, target, ms, error) {
  if (!Array.isArray(n.log)) n.log = [];
  const e = { at, step, target: target || '', ms };
  if (error == null) e.ok = true;
  else Object.assign(e, { ok: false, error });
  n.log.push(e);
  while (n.log.length > LOG_MAX) n.log.shift();
  return e;
}

/** Something that happened rather than a try ("you chose …"). */
function event(n, at, what) {
  if (!Array.isArray(n.log)) n.log = [];
  n.log.push({ at, step: 'event', what });
  while (n.log.length > LOG_MAX) n.log.shift();
}

/** Fields this flow owns besides writing it down: a transcription's copy takes them from the saved note. */
const OWNED = [
  'intent', 'intentDropped', 'chiefOkAt', 'stoppedAt', 'route', 'assistant', 'chiefRequest', 'chiefSending', 'chiefTries',
  'chiefFailed', 'chiefFailedAt', 'chiefLastTry', 'chiefQueued', 'chiefNextTry', 'chiefThread', 'chiefLink', 'chiefSent',
  'chiefReply', 'chiefReplyAt',
];

/** Takes over the OWNED fields (and log entries it lacks) from saved into mine. */
function merge(mine, saved) {
  if (!saved) return;
  for (const k of OWNED) {
    if (has(saved, k)) mine[k] = saved[k];
    else delete mine[k];
  }
  if (!Array.isArray(saved.log)) return;
  if (!Array.isArray(mine.log)) {
    mine.log = saved.log.slice();
    return;
  }
  const all = new Map();
  for (const e of [...saved.log, ...mine.log]) if (e && typeof e === 'object') all.set(String(num(e.at)).padStart(15, '0') + '|' + JSON.stringify(e), e);
  mine.log = [...all.keys()].sort().map((k) => all.get(k));
  while (mine.log.length > LOG_MAX) mine.log.shift();
}

// ------------------------------------------------------------------ in words

const pad = (v) => String(v).padStart(2, '0');

function clock(ms) {
  if (!(ms > 0)) return '?';
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** "13:06" today, "9 Nov 18:12" before. */
function when(ms, now) {
  if (!(ms > 0)) return '?';
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return clock(ms);
  return d.getDate() + ' ' + d.toLocaleString('en-GB', { month: 'short' }) + ' ' + clock(ms);
}

/** Why a note that wasn't tried doesn't go by itself, in words. */
function waitReason(n, now) {
  const ok = num(n.chiefOkAt);
  if (num(n.stoppedAt) > ok) return tr('you stopped it');
  if (n.interrupted === true && ok === 0) return tr('the recording was cut off without Stop');
  return tr('it was recorded %1$s', when(recordedAt(n), now));
}

/** Where a note is, in one line, and whether it needs the user. to: "your chief of staff". */
function status(n, now, transcribing, audioKept, to) {
  const state = String(n.status || '');
  const d = delivery(n, now);
  const failed = String(n.transcribeFailed || '');
  const forChief = meantForChief(n);
  const prefix = forChief && d !== Delivery.SENT ? tr('For %1$s: ', to) : '';
  if (transcribing) return { line: prefix + tr('being written down…'), problem: false };
  if (!transcribed(n)) {
    if (state === 'no speech') return { line: prefix + tr('no speech was recognized, nothing to send.'), problem: forChief };
    if (state === 'audio discarded') return { line: prefix + tr('you discarded the audio; nothing was written down or sent.'), problem: false };
    if (!audioKept) return { line: prefix + tr('not written down, and its audio is gone (%1$s).', state || '?'), problem: true };
    if (failed) {
      const tries = num(n.speechTries);
      return {
        line:
          prefix +
          (tries > 1
            ? tr('not written down (%1$d rounds of tries, last at %2$s): %3$s The audio is kept.', tries, clock(num(n.speechLastTry)), failed)
            : tr('not written down: %1$s The audio is kept.', failed)) +
          (forChief ? ' ' + tr("It goes to %1$s once it's written down.", to) : ''),
        problem: true,
      };
    }
    return {
      line:
        prefix +
        (n.interrupted === true
          ? tr('not written down: the recording was cut off without Stop. The audio is kept.')
          : tr('not written down yet (the app stopped). The audio is kept.')),
      problem: true,
    };
  }
  switch (d) {
    case Delivery.NONE:
      return { line: tr('Written down.'), problem: false };
    case Delivery.NEEDS_TRANSCRIPT:
      return { line: prefix + tr('waiting for the transcript.'), problem: false };
    case Delivery.SENDING:
      return { line: tr('Sending to %1$s…', to), problem: false };
    case Delivery.DUE:
      return { line: tr('Going to %1$s now.', to), problem: false };
    case Delivery.WAITING:
      return {
        line: tr('Not sent to %1$s yet (%2$d× tried): %3$s Next try by itself at %4$s.', to, num(n.chiefTries), String(n.chiefFailed || ''), clock(num(n.chiefNextTry))),
        problem: true,
      };
    case Delivery.NEEDS_OK:
      return {
        line: has(n, 'chiefFailed')
          ? tr("Not sent to %1$s (%2$d× tried, last at %3$s): %4$s It doesn't go by itself any more: read it, then Send.", to, num(n.chiefTries), clock(num(n.chiefLastTry) || num(n.chiefFailedAt)), String(n.chiefFailed))
          : tr("Not sent to %1$s: %2$s, so it waits for you. Read it, then Send or Don't send.", to, waitReason(n, now)),
        problem: true,
      };
    default:
      return {
        line:
          tr('Sent to %1$s at %2$s', to, when(num(n.chiefSent), now)) +
          (n.chiefRequest ? ' · ' + tr('request %1$s', n.chiefRequest) : '') +
          (num(n.chiefTries) > 0 ? ' · ' + tr('on try %1$d', num(n.chiefTries) + 1) : ''),
        problem: false,
      };
  }
}

/** A short badge for the notes list; null for a plain finished dictation. */
function badge(n, now, transcribing, audioKept) {
  if (transcribing) return tr('writing down');
  const state = String(n.status || '');
  if (!transcribed(n)) {
    if (state === 'no speech') return tr('no speech');
    return audioKept ? (has(n, 'transcribeFailed') ? tr('failed: writing down') : tr('unfinished')) : tr('audio gone');
  }
  const who = tr('chief of staff');
  switch (delivery(n, now)) {
    case Delivery.NONE:
      return null;
    case Delivery.WAITING:
      return who + ' · ' + tr('not sent yet');
    case Delivery.NEEDS_OK:
      return who + ' · ' + tr('not sent');
    case Delivery.SENT:
      return who;
    default:
      return who + ' · ' + tr('sending');
  }
}

/** The note's details as text, to read or copy: state, intent, each step, every try, and its network log lines. */
function details(n, statusLine, netLines, app) {
  const full = (ms) => {
    const d = new Date(num(ms));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };
  let s = 'Note ' + (n.id || '') + ' · ' + app + '\n';
  s += 'State: ' + statusLine + '\n';
  s += 'Recorded: ' + full(n.created) + ', ' + num(n.duration).toFixed(1) + ' s, model ' + (n.model || '') + '\n';
  s +=
    'Meant for: ' +
    (n.intent
      ? 'the chief, chosen ' + full(n.intent.at)
      : has(n, 'intentDropped')
        ? 'nothing (choice taken back ' + full(n.intentDropped) + ')'
        : meantForChief(n)
          ? 'the chief (from before 0.4.0)'
          : 'just a dictation') +
    '\n';
  if (has(n, 'chiefOkAt')) s += 'Send tapped: ' + full(n.chiefOkAt) + '\n';
  s += 'Writing down: ' + (n.status || '');
  if (has(n, 'transcribeFailed')) s += ' · failed: ' + n.transcribeFailed;
  if (has(n, 'speechTries')) s += ' · ' + num(n.speechTries) + ' failed round(s)';
  if (has(n, 'fallbackUsed')) s += ' · written down by the fallback ' + n.fallbackUsed;
  s += '\n';
  if (meantForChief(n) || has(n, 'chiefRequest')) {
    s += 'Delivery: ' + delivery(n, Date.now()).toLowerCase().replace('_', ' ');
    if (has(n, 'chiefRequest')) s += ' · request ' + n.chiefRequest;
    if (has(n, 'chiefTries')) s += ' · ' + num(n.chiefTries) + ' failed tries';
    if (has(n, 'chiefFailed')) s += ' · last error: ' + n.chiefFailed;
    if (has(n, 'chiefNextTry')) s += ' · next try ' + full(n.chiefNextTry);
    if (has(n, 'chiefSent')) s += ' · sent ' + full(n.chiefSent);
    s += '\n';
  }
  const entries = Array.isArray(n.log) ? n.log : [];
  s += '\nSteps and tries (' + entries.length + '):\n';
  if (!entries.length) s += '(none recorded; notes from before 0.4.0 have no step log)\n';
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    s += full(e.at) + ' | ';
    if (e.step === 'event') s += e.what;
    else
      s +=
        (e.step === 'speech' ? 'writing down' : e.step === 'bb' ? 'to the chief' : e.step) +
        ' | ' + (e.target || '') + ' | ' + num(e.ms) + ' ms | ' + (e.ok ? 'ok' : 'failed: ' + e.error);
    s += '\n';
  }
  if (Array.isArray(n.steps) && n.steps.length) s += '\nActivity steps (cost): ' + JSON.stringify(n.steps) + '\n';
  s += '\nNetwork log for this note (requests, results, sizes, error bodies; kept a week):\n' + (netLines && netLines.trim() ? netLines : '(none in the log)\n');
  return s;
}

module.exports = {
  AUTO_MS,
  SENDING_STALE_MS,
  LOG_MAX,
  OWNED,
  Delivery,
  wantChief,
  dropChief,
  confirm,
  meantForChief,
  recordedAt,
  anchor,
  fresh,
  sent,
  sending,
  transcribed,
  delivery,
  beginSend,
  delayMs,
  sendFailed,
  sendDone,
  settle,
  speechFailed,
  speechDone,
  log,
  event,
  merge,
  when,
  waitReason,
  status,
  badge,
  details,
};
