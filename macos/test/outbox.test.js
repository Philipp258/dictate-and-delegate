'use strict';
// Port of OutboxTest.java, and the Mac's runner (Outbox class) with fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const ob = require('../src/core/outbox');
const netLog = require('../src/core/net-log');
const BbBridge = require('../src/core/bb-bridge');
const { MemoryPrefs } = require('../src/core/store');

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

test('aFailedNoteIsQueuedWithItsNextTry', () => {
  const note = { route: 'chief' };
  ob.failed(note, "bb isn't reachable right now (HTTP 502).", 1, T);
  assert.equal(ob.state(note), ob.State.RETRYING);
  assert.equal(note.chiefFailedAt, T);
  assert.equal(note.chiefNextTry, T + 15_000);
  assert.ok(!ob.due(note, T + 14_999));
  assert.ok(ob.due(note, T + 15_000));
  // The second failure keeps when it first failed and waits longer.
  ob.failed(note, 'again', 2, T + 20_000);
  assert.equal(note.chiefFailedAt, T);
  assert.equal(note.chiefNextTry, T + 20_000 + 30_000);
  assert.equal(note.chiefTries, 2);
});

test('afterTwoDaysItIsNoLongerTriedByItself', () => {
  const note = {};
  ob.failed(note, 'first', 1, T);
  ob.failed(note, 'still', 40, T + ob.GIVE_UP_MS);
  assert.equal(ob.state(note), ob.State.FAILED);
  assert.ok(!('chiefNextTry' in note));
  assert.ok(!ob.due(note, T + ob.GIVE_UP_MS * 2));
});

test('aSentNoteLeavesTheQueueButSaysItTookTries', () => {
  const note = {};
  ob.failed(note, '502', 3, T);
  ob.sent(note);
  note.chiefThread = 'thr_c';
  assert.equal(ob.state(note), ob.State.SENT);
  assert.ok(!('chiefQueued' in note));
  assert.equal(note.chiefTries, 3);
  assert.ok('chiefFailedAt' in note);
});

test('notesFromBeforeTheOutboxCountAsFailed', () => {
  assert.equal(ob.state({ chiefFailed: 'old' }), ob.State.FAILED);
  assert.equal(ob.state({}), ob.State.NONE);
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

// ------------------------------------------------------------------ the runner (Mac)

function runner({ notes = [], bbUp = true, inCall = false } = {}) {
  let now = T;
  const told = [];
  const sentNotes = [];
  const timers = [];
  const o = new ob.Outbox({
    prefs: new MemoryPrefs(),
    notes: async () => notes,
    sendNote: async (id) => {
      sentNotes.push(id);
      const n = notes.find((x) => x.id === id);
      if (!o.bbUp) {
        ob.failed(n, 'HTTP 502', (n.chiefTries || 0) + 1, now);
        return 'HTTP 502';
      }
      ob.sent(n);
      n.chiefThread = 'thr_c';
      return null;
    },
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
  return { o, told, sentNotes, timers, notes, advance: (ms) => (now += ms) };
}

test('dueNotesGoAndOnceOneWentTheRestAndTheReportFollow', async () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  ob.failed(a, 'HTTP 502', 1, T - 20_000); // due
  ob.failed(b, 'HTTP 502', 3, T); // not due for a minute
  const r = runner({ notes: [b, a] });
  r.o.failure('chief:ra', 'chief', 'Note to you, request ra', 'HTTP 502');
  assert.equal(await r.o.flush(false), true);
  assert.deepEqual(r.sentNotes, ['a', 'b']);
  assert.equal(ob.state(a), ob.State.SENT);
  assert.equal(ob.state(b), ob.State.SENT);
  assert.equal(r.told.length, 1);
  assert.ok(r.told[0].text.startsWith('[app failure report]'));
  assert.ok(r.told[0].text.endsWith('Report ID: r-rep1'));
  assert.equal(r.o.failuresWaiting(), 0);
});

test('whileBbIsDownNothingElseIsTriedAndTheNextTryIsScheduled', async () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  ob.failed(a, 'HTTP 502', 1, T - 20_000);
  ob.failed(b, 'HTTP 502', 1, T - 20_000);
  const r = runner({ notes: [a, b], bbUp: false });
  r.o.failure('chief:ra', 'chief', 'Note', 'HTTP 502');
  assert.equal(await r.o.flush(false), false);
  assert.deepEqual(r.sentNotes, ['a']); // b waits: bb can't be reached
  assert.equal(r.told.length, 0);
  assert.equal(a.chiefTries, 2);
  // The next try: b's (due now), then a's.
  assert.equal(r.timers[r.timers.length - 1].ms, 0);
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
