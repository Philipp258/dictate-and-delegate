'use strict';
// What hasn't reached the chief yet, and what went wrong on the way (Outbox.java). The notes' own
// state (note-flow.js) says what's due: a note whose send failed is sent again by itself, further
// apart each time (delayMs), also after the app restarts or the Mac woke up, but only while it's
// fresh (NoteFlow.AUTO_MS); after that it waits for the user, who gets a notification. The same
// request ID goes each time, and a try after one that may have arrived checks first, so the chief
// never gets a note twice.
//
// Failures (a note not sent, a hands-free message not sent, a recording not transcribed) are kept,
// and once bb takes a message again they go to the chief as one "[app failure report]", with the
// network log around them, so it can find out why. Send report does that at once.
//
// Mac: no JobScheduler. A timer does the tries while the app runs; the app's start and the Mac's
// wake (powerMonitor 'resume') start one at once.

const netLog = require('./net-log');
const flow = require('./note-flow');

/** The failures kept for the next report, at most. */
const FAILURES_MAX = 20;

/** Network log lines in a report, at most, and how far before the first failure they start. */
const LOG_LINES = 80;
const LOG_BEFORE_MS = 2 * 60_000;

const LABEL = '[app failure report]';

/** The wait before try number tries + 1: 15 s, 30 s, 1, 2, 5, 10 min, then every 15 min. */
function delayMs(tries) {
  const steps = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  return tries <= 0 ? 0 : tries <= steps.length ? steps[tries - 1] : 900_000;
}

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ------------------------------------------------------------------ failures

/**
 * Keeps a failure for the next report: one entry per key (a request, or "recording:…"), with when
 * it first and last failed, how often and the last reason. At most FAILURES_MAX, oldest out.
 */
function addFailure(list, key, kind, what, why, now) {
  for (const f of list) {
    if (f.key === key && !has(f, 'resolved')) {
      f.last = now;
      f.count = (f.count || 1) + 1;
      f.why = why;
      return list;
    }
  }
  list.push({ key, kind, what, why, first: now, last: now, count: 1 });
  while (list.length > FAILURES_MAX) list.shift();
  return list;
}

/** The failure with this key worked in the end, at now (the report says so). */
function resolve(list, key, now) {
  for (const f of list) if (f.key === key && !has(f, 'resolved')) f.resolved = now;
}

function firstFailure(list, now) {
  let first = now;
  for (const f of list) first = Math.min(first, Number(f.first) || now);
  return first;
}

/** "16:20:00" in the network log's time (its stamp), so the report and the log lines match. */
function hms(ms) {
  return netLog.stamp(ms).slice(11, 19);
}

/**
 * The report for the chief: the label, what failed and when, the network log from shortly before
 * the first failure until now, and the report's ID (so a try that may have arrived isn't sent
 * twice). Never keys, tokens or what was said.
 */
function report(app, failures, log, now, zone, id) {
  const offset = netLog.stamp(now).slice(-6);
  let s =
    LABEL +
    ' ' +
    app +
    (failures.length === 1 ? ': something went wrong' : ': ' + failures.length + ' things went wrong') +
    ", and this report got through now. Find out why if you can, and fix what's on bb's side; tell me only if I need to do something.\n\nWhat failed (times " +
    zone +
    ', UTC' +
    offset +
    '):';
  for (const f of failures) {
    const first = Number(f.first);
    const last = Number(f.last || first);
    const count = f.count || 1;
    s += '\n• ' + f.what + ': ';
    if (f.kind === 'asked') s += 'I tapped Send report at ' + hms(first);
    else {
      s += (count === 1 ? 'failed at ' : 'failed ' + count + '× from ') + hms(first);
      if (count > 1) s += ' to ' + hms(last);
      if (has(f, 'resolved')) s += ', went through at ' + hms(Number(f.resolved));
      else if (f.kind === 'chief') s += ', still queued';
    }
    if (f.why) s += (f.kind === 'asked' ? ': ' : '. Last error: ') + f.why;
  }
  const from = firstFailure(failures, now) - LOG_BEFORE_MS;
  const lines = excerpt(log, from, LOG_LINES);
  s +=
    '\n\nNetwork log from ' +
    hms(from) +
    ' (' +
    lines.length +
    (lines.length === 1 ? ' line' : ' lines') +
    '; when each request started, what, request, target, result, duration, retry, sizes, network):\n';
  s += lines.length ? lines.join('\n') : '(no entries)';
  s += '\n\nReport ID: r-' + id;
  return s;
}

/**
 * The log's lines from the time from on, the last max of them (each at most 400 characters). A
 * line is stamped when its request started, so one still running at from counts too: a request
 * that hung for minutes before it failed was left out of the report.
 */
function excerpt(log, from, max) {
  const out = [];
  for (const line of String(log || '').split('\n')) {
    const t = netLog.time(line);
    if (t < 0) continue;
    if (t < from && t + Math.max(0, duration(line)) < from) continue;
    out.push(line.length > 1200 ? line.substring(0, 1200) + '…' : line);
  }
  return out.length <= max ? out : out.slice(out.length - max);
}

/** How long a line's request took (its "123 ms" field), or -1 for a line without one. */
function duration(line) {
  for (const field of String(line).split(' | ')) {
    const m = /^(\d{1,10}) ms$/.exec(field);
    if (m) return Number(m[1]);
  }
  return -1;
}

// ------------------------------------------------------------------ on the Mac

/**
 * The queue's runner. o: prefs (store.js), notes() → the recent notes (plain objects with id),
 * sendNote(id, mode) → null or why (mode 'AUTO' or 'NOW', see Dictation.sendNote), update(id,
 * change) (one note changed and saved), notify({ id, title, text }) (a notification until it's
 * resolved), tell(chiefId, text) (checks first, never twice), chiefId(),
 * connected(), inCall(), readLog() → the network log, app (its name and version), zone, clock,
 * timers, requestId(), log(line).
 */
class Outbox {
  constructor(o) {
    this.prefs = o.prefs;
    this.notes = o.notes;
    this.sendNote = o.sendNote;
    this.update = o.update || (async () => {});
    this.notify = o.notify || (() => {});
    this.tell = o.tell;
    this.chiefId = o.chiefId || (() => '');
    this.connected = o.connected || (() => false);
    this.inCall = o.inCall || (() => false);
    this.readLog = o.readLog || (() => '');
    this.app = o.app || 'Dictate & Delegate';
    this.zone = o.zone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    this.clock = o.clock || (() => Date.now());
    this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    this.newId = o.requestId || (() => Math.random().toString(36).slice(2, 8));
    this.log = o.log || (() => {});
    this.timer = null;
    this.flushing = null;
  }

  failures() {
    const v = this.prefs.get('outboxFailures', []);
    return Array.isArray(v) ? v.map((f) => ({ ...f })) : [];
  }

  setFailures(list) {
    this.prefs.set('outboxFailures', list);
  }

  /** Keeps a failure for the next report (see addFailure), and makes sure a try is scheduled. */
  failure(key, kind, what, why) {
    this.setFailures(addFailure(this.failures(), key, kind, what, why, this.clock()));
    this.schedule(delayMs(1));
  }

  /** The failure with this key went through in the end. */
  resolved(key) {
    const list = this.failures();
    resolve(list, key, this.clock());
    this.setFailures(list);
  }

  failuresWaiting() {
    return this.failures().length;
  }

  /** Send report: what failed goes to the chief now, or as soon as bb takes it. */
  askReport(what, why) {
    this.setFailures(addFailure(this.failures(), 'asked:' + this.clock(), 'asked', what, why, this.clock()));
    this.prefs.set('outboxReportTries', 0);
    this.prefs.set('outboxReportNext', 0);
  }

  async recent() {
    try {
      return (await this.notes()).filter((n) => n && typeof n === 'object');
    } catch {
      return [];
    }
  }

  /** Notes on their way to the chief that the outbox may send: due now, or waiting for their next try. */
  async queued() {
    const now = this.clock();
    return (await this.recent()).filter((n) => [flow.Delivery.DUE, flow.Delivery.WAITING].includes(flow.delivery(n, now)));
  }

  /** Notes that stopped going by themselves (too old, or the window ran out while failing): told once. */
  async settle() {
    const now = this.clock();
    for (const n of await this.recent()) {
      if (n.handsFree === true || has(n, 'chiefAskedAt') || !flow.meantForChief(n) || flow.sent(n)) continue;
      const settled = n.chiefQueued === true && !flow.fresh(n, now);
      if (!settled && flow.delivery(n, now) !== flow.Delivery.NEEDS_OK) continue;
      // Notes from long ago (before 0.4.0) stay quiet: the notes list shows them as not sent.
      const last = Math.max(flow.anchor(n), Number(n.chiefLastTry) || 0, Number(n.chiefFailedAt) || 0);
      if (now - last > 2 * 24 * 3600_000) continue;
      try {
        await this.update(n.id, (e) => {
          flow.settle(e, now);
          e.chiefAskedAt = now;
          flow.event(e, now, 'stopped going by itself; waits for you');
        });
        this.notify({
          id: n.id,
          title: 'Not sent to your chief of staff' + (has(n, 'chiefFailed') ? '' : ': waits for you'),
          text: has(n, 'chiefFailed')
            ? String(n.chiefFailed) + " It doesn't go by itself any more."
            : flow.waitReason(n, now).replace(/^./, (c) => c.toUpperCase()) + ", so it doesn't go by itself. Open it to read it, then Send or Don't send.",
        });
      } catch (ex) {
        this.log('outbox: ' + (ex && ex.message));
      }
    }
  }

  async waiting() {
    return (await this.queued()).length > 0;
  }

  /** Something reached bb: what's waiting goes now. */
  worked() {
    this.flush(true).catch(() => {});
  }

  /** The app started or the Mac woke up: a try soon. */
  async kick() {
    // Also for notes that wait for the user: one may need its notification.
    const now = this.clock();
    const open = (await this.recent()).some((n) => ![flow.Delivery.NONE, flow.Delivery.SENT].includes(flow.delivery(n, now)));
    if (open || this.failuresWaiting() > 0) this.schedule(0);
  }

  /**
   * Sends the queued notes that are due (all: every queued one, as bb just took something), then,
   * if none of them failed, the failure report. Schedules the next try. Resolves whether all went.
   */
  flush(all) {
    if (this.flushing) return this.flushing.then(() => false);
    this.flushing = (async () => {
      try {
        const now = this.clock();
        let failedOne = false;
        let went = all;
        await this.settle();
        // Once one went, bb takes messages again: the rest go too, also those not due yet.
        for (let pass = 0; pass < 2 && !failedOne; pass++) {
          for (const n of await this.queued()) {
            if (!went && flow.delivery(n, now) !== flow.Delivery.DUE) continue;
            if ((await this.sendNote(n.id, went ? 'NOW' : 'AUTO')) != null) {
              failedOne = true;
              break; // bb can't be reached: the others wait for the next try.
            }
            went = true;
          }
        }
        if (!failedOne) failedOne = !(await this.sendReport(went));
        return !failedOne;
      } finally {
        this.flushing = null;
        await this.scheduleNext();
      }
    })();
    return this.flushing;
  }

  /** Sends the failure report, if there's one and it's due. False when it couldn't be sent. */
  async sendReport(force) {
    const list = this.failures();
    if (!list.length) return true;
    const now = this.clock();
    if (!force && (Number(this.prefs.get('outboxReportNext', 0)) || 0) > now) return true;
    // Nobody to tell yet, or a call is on (the chief would read it out): kept for later.
    const call = this.inCall();
    if (!this.connected() || !this.chiefId() || call) {
      this.prefs.set('outboxReportNext', now + (call ? 5 : 15) * 60_000);
      return true;
    }
    let id = this.prefs.get('outboxReportId', '');
    if (!id) {
      id = this.newId();
      this.prefs.set('outboxReportId', id);
    }
    const text = report(this.app, list, this.readLog(), now, this.zone, id);
    try {
      await this.tell(this.chiefId(), text);
    } catch (ex) {
      const tries = (Number(this.prefs.get('outboxReportTries', 0)) || 0) + 1;
      this.prefs.set('outboxReportTries', tries);
      this.prefs.set('outboxReportNext', this.clock() + delayMs(tries));
      this.log('outbox: the failure report didn\'t go: ' + (ex && ex.message));
      return false;
    }
    // Only what the report held goes; a failure kept meanwhile waits for the next.
    const reported = new Set(list.map((f) => f.key + '@' + f.last));
    this.setFailures(this.failures().filter((f) => !reported.has(f.key + '@' + f.last)));
    this.prefs.remove('outboxReportTries');
    this.prefs.remove('outboxReportNext');
    this.prefs.remove('outboxReportId');
    this.log('outbox: failure report sent (r-' + id + ')');
    return true;
  }

  /** The next try: the earliest queued note's, or the report's. */
  async scheduleNext() {
    const now = this.clock();
    let next = Infinity;
    const notes = await this.queued();
    for (const n of notes) next = Math.min(next, flow.delivery(n, now) === flow.Delivery.DUE ? now + 5_000 : Number(n.chiefNextTry) || now);
    // A try under way: should the app quit mid-way, it's due again once it counts as cut off.
    for (const n of await this.recent())
      if (flow.delivery(n, now) === flow.Delivery.SENDING) next = Math.min(next, Number(n.chiefSending) + flow.SENDING_STALE_MS + 1_000);
    // The report goes after the notes, when one of them got through; alone, at its own time.
    if (!notes.length && this.failuresWaiting() > 0) next = Math.max(now, Number(this.prefs.get('outboxReportNext', now)) || now);
    if (next !== Infinity) this.schedule(Math.max(0, next - now));
    else this.cancel();
  }

  /** A try in delay ms. Replaces the one scheduled. */
  schedule(delay) {
    this.cancel();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush(false).catch(() => {});
    }, delay);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  cancel() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = {
  FAILURES_MAX,
  LOG_LINES,
  LABEL,
  delayMs,
  addFailure,
  resolve,
  report,
  excerpt,
  Outbox,
};
