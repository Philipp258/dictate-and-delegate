'use strict';
// Port of OutboxTest.java, and the Mac's runner (Outbox class) with fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const ob = require('../src/core/outbox');
const netLog = require('../src/core/net-log');
const BbBridge = require('../src/core/bb-bridge');
const { MemoryPrefs } = require('../src/core/store');
const flow = require('../src/core/note-flow');

/** A note meant for the chief, recorded a minute before at, written down, whose send failed at at (tries times). */
function failedNote(id, at, tries = 1) {
  const n = { id, created: at - 60_000, duration: 10, status: 'complete', text: 'Hello' };
  flow.wantChief(n, at - 50_000);
  for (let i = 0; i < tries; i++) {
    flow.beginSend(n, 'r' + id, at);
    flow.sendFailed(n, 'HTTP 502', at);
  }
  return n;
}

const T = 1_793_460_000_000; // 2026-10-31 16:20:00 in Berlin

// The log's (and the report's) local time: Berlin in winter, UTC+01:00.
netLog.configure({ offset: () => 60, zone: () => 'Europe/Berlin' });

test('triesComeFurtherApartUpToAQuarterHour', () => {
  assert.equal(ob.delayMs(0), 0);
  assert.equal(ob.delayMs(1), 15_000);
  assert.equal(ob.delayMs(2), 30_000);
  assert.equal(ob.delayMs(3), 60_000);
  assert.equal(ob.delayMs(6), 600_000);
  assert.equal(ob.delayMs(7), 900_000);
  assert.equal(ob.delayMs(50), 900_000);
});

test('failuresOfOneRequestBecomeOneEntry', () => {
  const list = [];
  ob.addFailure(list, 'chief:abc', 'chief', 'Note to you, request abc', 'HTTP 502', T);
  ob.addFailure(list, 'chief:abc', 'chief', 'Note to you, request abc', 'connect timeout', T + 30_000);
  ob.addFailure(list, 'recording:s1', 'recording', 'Recording', 'no connection', T + 40_000);
  assert.equal(list.length, 2);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].first, T);
  assert.equal(list[0].last, T + 30_000);
  assert.equal(list[0].why, 'connect timeout');
  ob.resolve(list, 'chief:abc', T + 60_000);
  assert.equal(list[0].resolved, T + 60_000);
  // A new failure of a resolved request starts a new entry.
  ob.addFailure(list, 'chief:abc', 'chief', 'Note to you, request abc', 'HTTP 503', T + 70_000);
  assert.equal(list.length, 3);
});

test('atMostTwentyFailuresAreKept', () => {
  const list = [];
  for (let i = 0; i < 25; i++) ob.addFailure(list, 'k' + i, 'chief', 'n', 'w', T + i);
  assert.equal(list.length, ob.FAILURES_MAX);
  assert.equal(list[0].key, 'k5');
});

test('theReportSaysWhatFailedWithTheLogAroundIt', () => {
  const list = [];
  ob.addFailure(list, 'chief:k3x9qa', 'chief', 'Note to you, request k3x9qa', "bb isn't reachable right now (HTTP 502).", T);
  ob.addFailure(list, 'chief:k3x9qa', 'chief', 'Note to you, request k3x9qa', "bb isn't reachable right now (HTTP 502).", T + 45_000);
  ob.resolve(list, 'chief:k3x9qa', T + 90_000);
  const old = netLog.stamp(T - 10 * 60_000) + ' | bb tell chief | HTTP 200';
  const near = netLog.stamp(T - 60_000) + ' | network now | wifi (en0), v4+v6';
  const bad = netLog.stamp(T) + ' | bb tell chief | req k3x9qa | POST lyricquest.getbb.app/mcp | HTTP 502 bad gateway | 120 ms';
  const text = ob.report('Dictate & Delegate 0.2.6 (macOS)', list, old + '\n' + near + '\n' + bad + '\n', T + 90_000, 'Europe/Berlin', 'abc123');
  assert.ok(text.startsWith('[app failure report] Dictate & Delegate 0.2.6 (macOS): something went wrong, and this report got through now.'), text);
  assert.ok(text.includes('(times Europe/Berlin, UTC+01:00)'), text);
  assert.ok(
    text.includes("• Note to you, request k3x9qa: failed 2× from 16:20:00 to 16:20:45, went through at 16:21:30. Last error: bb isn't reachable right now (HTTP 502)."),
    text,
  );
  assert.ok(text.includes('(2 lines;'), text);
  assert.ok(text.includes(near) && text.includes(bad) && !text.includes(old), text);
  assert.ok(text.endsWith('Report ID: r-abc123'), text);
  // The report's ID is its mark: a try that may have arrived isn't sent twice.
  assert.equal(BbBridge.mark(text), 'Report ID: r-abc123');
});

test('aSendReportTapIsSaidAsSuch', () => {
  const list = [];
  ob.addFailure(list, 'asked:1', 'asked', 'Recording (writing it down)', "it didn't finish: No connection to OpenRouter.", T);
  const text = ob.report('D&D', list, '', T, 'Europe/Berlin', 'x1');
  assert.ok(text.includes("• Recording (writing it down): I tapped Send report at 16:20:00: it didn't finish: No connection to OpenRouter."), text);
  assert.ok(text.includes('(no entries)'), text);
});

test('theExcerptKeepsTheLastLinesFromItsStart', () => {
  let log = 'not a line\n';
  for (let i = 0; i < 10; i++) log += netLog.stamp(T + i * 1000) + ' | x' + i + '\n';
  const lines = ob.excerpt(log, T + 2000, 5);
  assert.equal(lines.length, 5);
  assert.ok(lines[0].endsWith('x5'));
  assert.ok(lines[4].endsWith('x9'));
});

test('aRequestStillRunningWhenTheExcerptStartsIsIn', () => {
  // Started 15 minutes before the failure, and hung until it.
  const hung = netLog.stamp(T) + ' | OpenRouter transcribe m | POST openrouter.ai/api/v1/audio/transcriptions | connection reset | 900000 ms | ↑1.0 kB';
  const done = netLog.stamp(T + 1000) + ' | Jev j | POST openrouter.ai/api/alpha/decisions | HTTP 200 | 300 ms';
  const event = netLog.stamp(T + 2000) + ' | network now | wifi';
  assert.deepEqual(ob.excerpt([hung, done, event].join('\n'), T + 900_000 - 120_000, 10), [hung]);
});

// ------------------------------------------------------------------ the runner (Mac)

function runner({ notes = [], bbUp = true, inCall = false } = {}) {
  let now = T;
  const told = [];
  const sentNotes = [];
  const modes = [];
  const notified = [];
  const timers = [];
  const o = new ob.Outbox({
    prefs: new MemoryPrefs(),
    notes: async () => notes,
    sendNote: async (id, mode) => {
      sentNotes.push(id);
      modes.push(mode);
      const n = notes.find((x) => x.id === id);
      if (!o.bbUp) {
        flow.sendFailed(n, 'HTTP 502', now);
        return 'HTTP 502';
      }
      flow.sendDone(n, 'thr_c', '', now);
      return null;
    },
    update: async (id, change) => change(notes.find((x) => x.id === id)),
    notify: (p) => notified.push(p),
    tell: async (id, text) => {
      if (!o.bbUp) throw new Error("bb isn't reachable right now (HTTP 502).");
      told.push({ id, text });
    },
    chiefId: () => 'thr_c',
    connected: () => true,
    inCall: () => o.inCallNow,
    readLog: () => '',
    app: 'D&D 0.2.6',
    zone: 'Europe/Berlin',
    clock: () => now,
    timers: { setTimeout: (f, ms) => (timers.push({ f, ms }), timers.length), clearTimeout: () => {} },
    requestId: () => 'rep1',
  });
  o.bbUp = bbUp;
  o.inCallNow = inCall;
  return { o, told, sentNotes, modes, notified, timers, notes, advance: (ms) => (now += ms) };
}

test('dueNotesGoAndOnceOneWentTheRestAndTheReportFollow', async () => {
  const a = failedNote('a', T - 20_000); // due
  const b = failedNote('b', T, 3); // not due for a minute
  const r = runner({ notes: [b, a] });
  r.o.failure('chief:ra', 'chief', 'Note to you, request ra', 'HTTP 502');
  assert.equal(await r.o.flush(false), true);
  assert.deepEqual(r.sentNotes, ['a', 'b']);
  assert.deepEqual(r.modes, ['AUTO', 'NOW']);
  assert.equal(flow.delivery(a, T), flow.Delivery.SENT);
  assert.equal(flow.delivery(b, T), flow.Delivery.SENT);
  assert.equal(r.told.length, 1);
  assert.ok(r.told[0].text.startsWith('[app failure report]'));
  assert.ok(r.told[0].text.endsWith('Report ID: r-rep1'));
  assert.equal(r.o.failuresWaiting(), 0);
});

test('whileBbIsDownNothingElseIsTriedAndTheNextTryIsScheduled', async () => {
  const a = failedNote('a', T - 20_000);
  const b = failedNote('b', T - 20_000);
  const r = runner({ notes: [a, b], bbUp: false });
  r.o.failure('chief:ra', 'chief', 'Note', 'HTTP 502');
  assert.equal(await r.o.flush(false), false);
  assert.deepEqual(r.sentNotes, ['a']); // b waits: bb can't be reached
  assert.equal(r.told.length, 0);
  assert.equal(a.chiefTries, 2);
  // The next try: b's (due now, in a few seconds), then a's.
  assert.equal(r.timers[r.timers.length - 1].ms, 5_000);
});

test('theReportWaitsUntilTheCallIsOver', async () => {
  const r = runner({ inCall: true });
  r.o.failure('call:r1', 'call', 'Hands-free message r1', 'HTTP 502');
  assert.equal(await r.o.flush(false), true);
  assert.equal(r.told.length, 0);
  assert.equal(r.timers[r.timers.length - 1].ms, 5 * 60_000);
  r.o.inCallNow = false;
  r.advance(5 * 60_000);
  await r.o.flush(false);
  assert.equal(r.told.length, 1);
  assert.ok(r.told[0].text.includes('• Hands-free message r1: failed at 16:20:00. Last error: HTTP 502'));
});

test('aReportThatDidntGoIsTriedLaterWithTheSameId', async () => {
  const r = runner({ bbUp: false });
  r.o.askReport('Note to you, request q1', 'not sent yet');
  assert.equal(await r.o.flush(true), false);
  assert.equal(r.timers[r.timers.length - 1].ms, 15_000);
  r.o.bbUp = true;
  r.advance(15_000);
  assert.equal(await r.o.flush(false), true);
  assert.equal(r.told.length, 1);
  assert.ok(r.told[0].text.includes('I tapped Send report at 16:20:00: not sent yet'));
  assert.ok(r.told[0].text.endsWith('Report ID: r-rep1'));
});

test('anOldNoteIsNeverSentByItselfAndYouAreToldOnce', async () => {
  // Queued by 0.3.8, which tried for two days: three hours old now.
  const old = failedNote('old', T - 3 * 3600_000);
  old.chiefQueued = true;
  old.chiefNextTry = T - 1000;
  const r = runner({ notes: [old] });
  await r.o.flush(false);
  assert.deepEqual(r.sentNotes, []);
  assert.equal(old.chiefQueued, undefined);
  assert.equal(flow.delivery(old, T), flow.Delivery.NEEDS_OK);
  assert.equal(r.notified.length, 1);
  assert.equal(r.notified[0].id, 'old');
  await r.o.flush(false);
  assert.equal(r.notified.length, 1); // told once
});
