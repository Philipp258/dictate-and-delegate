'use strict';
// Port of NoteFlowTest.java.

const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../src/core/note-flow');

const T = 1_794_398_400_000; // 2026-11-11 13:00:00 in Berlin
const MIN = 60_000;

const note = (created, seconds) => ({ id: 'n1', created, duration: seconds, status: 'pending', text: '', model: 'microsoft/mai-transcribe-2' });
const written = (n) => Object.assign(n, { status: 'complete', text: 'Hello', original: 'Hello' });

test('aPlainDictationGoesNowhere', () => {
  const n = written(note(T, 10));
  assert.equal(flow.meantForChief(n), false);
  assert.equal(flow.delivery(n, T + MIN), flow.Delivery.NONE);
  assert.equal(flow.badge(n, T + MIN, false, false), null);
});

test('theChoiceIsKeptOnTheNoteAndWaitsForTheTranscript', () => {
  const n = note(T, 10);
  flow.wantChief(n, T + 5_000);
  assert.equal(flow.meantForChief(n), true);
  assert.equal(flow.delivery(n, T + 20_000), flow.Delivery.NEEDS_TRANSCRIPT);
  written(n);
  assert.equal(flow.delivery(n, T + 20_000), flow.Delivery.DUE);
});

test('takingTheChoiceBackMeansItIsJustADictation', () => {
  const n = written(note(T, 10));
  flow.wantChief(n, T + 11_000);
  assert.equal(flow.dropChief(n, T + 12_000), true);
  assert.equal(flow.delivery(n, T + 13_000), flow.Delivery.NONE);
  flow.wantChief(n, T + 14_000);
  assert.equal(flow.delivery(n, T + 15_000), flow.Delivery.DUE);
});

test('anOldNoteNeverGoesByItself', () => {
  const n = note(T - 2 * 24 * 60 * MIN, 30);
  flow.wantChief(n, T - 2 * 24 * 60 * MIN + 31_000);
  written(n);
  assert.equal(flow.delivery(n, T), flow.Delivery.NEEDS_OK);
  const s = flow.status(n, T, false, false, 'your chief of staff');
  assert.equal(s.problem, true);
  assert.match(s.line, /waits for you/);
  flow.confirm(n, T);
  assert.equal(flow.delivery(n, T + 1000), flow.Delivery.DUE);
});

test('itGoesByItselfOnlyWithinTheWindow', () => {
  const n = written(note(T, 60));
  flow.wantChief(n, T + 10_000);
  const end = T + 60_000;
  assert.equal(flow.fresh(n, end + flow.AUTO_MS), true);
  assert.equal(flow.fresh(n, end + flow.AUTO_MS + 1), false);
});

test('aFailedSendIsTriedAgainWhileFreshThenWaitsForTheUser', () => {
  const n = written(note(T, 10));
  flow.wantChief(n, T + 10_000);
  flow.beginSend(n, 'abc123', T + 11_000);
  assert.equal(flow.delivery(n, T + 12_000), flow.Delivery.SENDING);
  flow.sendFailed(n, 'bb answered with HTTP 502.', T + 12_000);
  assert.equal(flow.delivery(n, T + 13_000), flow.Delivery.WAITING);
  assert.equal(n.chiefNextTry, T + 12_000 + 15_000);
  assert.equal(flow.delivery(n, T + 27_000), flow.Delivery.DUE);
  assert.equal(n.chiefRequest, 'abc123');
  const late = T + 10_000 + flow.AUTO_MS + MIN;
  flow.beginSend(n, 'abc123', late);
  flow.sendFailed(n, 'still 502', late);
  assert.equal(n.chiefQueued, undefined);
  assert.equal(flow.delivery(n, late + 1), flow.Delivery.NEEDS_OK);
  const s = flow.status(n, late + 1, false, false, 'your chief of staff');
  assert.match(s.line, /still 502/);
  assert.match(s.line, /2× tried/);
});

test('aSentNoteStaysSentAndCannotBeTakenBack', () => {
  const n = written(note(T, 10));
  flow.wantChief(n, T + 10_000);
  flow.beginSend(n, 'abc123', T + 11_000);
  assert.equal(flow.dropChief(n, T + 11_500), false);
  flow.sendDone(n, 'thr_c', 'https://x/thr_c', T + 12_000);
  assert.equal(flow.delivery(n, T + 13_000), flow.Delivery.SENT);
  assert.equal(flow.dropChief(n, T + 14_000), false);
  assert.match(flow.status(n, T + 14_000, false, false, 'your chief of staff').line, /request abc123/);
});

test('aTryCutOffByQuittingCountsAsMaybeArrived', () => {
  const n = written(note(T, 10));
  flow.wantChief(n, T + 10_000);
  flow.beginSend(n, 'abc123', T + 11_000);
  assert.equal(flow.delivery(n, T + 11_000 + flow.SENDING_STALE_MS), flow.Delivery.DUE);
  assert.equal(n.chiefRequest, 'abc123');
});

test('interruptedRecordingsWaitForTheUser', () => {
  const cut = written(note(T, 10));
  cut.interrupted = true;
  flow.wantChief(cut, T + 5_000);
  assert.equal(flow.delivery(cut, T + 20_000), flow.Delivery.NEEDS_OK);
  assert.match(flow.status(cut, T + 20_000, false, false, 'your chief of staff').line, /cut off without Stop/);
  flow.confirm(cut, T + 30_000);
  assert.equal(flow.delivery(cut, T + 31_000), flow.Delivery.DUE);
});

test('notesFromBeforeIntentsAreReadFromWhatHappened', () => {
  const s = written(note(T, 10));
  Object.assign(s, { route: 'chief', chiefThread: 'thr_c', chiefRequest: 'r1' });
  assert.equal(flow.delivery(s, T + MIN), flow.Delivery.SENT);
  const q = written(note(T - 3 * 60 * MIN, 10));
  Object.assign(q, { route: 'chief', chiefFailed: '502', chiefTries: 3, chiefQueued: true, chiefNextTry: T });
  assert.equal(flow.delivery(q, T), flow.Delivery.NEEDS_OK);
  assert.equal(flow.settle(q, T), true);
  assert.equal(q.chiefQueued, undefined);
  const call = written(note(T, 5));
  Object.assign(call, { handsFree: true, route: 'chief', chiefThread: 'thr_c' });
  assert.equal(flow.meantForChief(call), false);
  assert.equal(flow.delivery(call, T), flow.Delivery.SENT);
});

test('aFailedTranscriptionSaysWhyAndThatTheChiefWaits', () => {
  const n = Object.assign(note(T, 180), { status: 'needs attention' });
  flow.wantChief(n, T + 100_000);
  flow.speechFailed(n, 'The model is busy or rate-limited (HTTP 429 too many requests from Azure: Rate limit exceeded).', T + 240_000);
  const s = flow.status(n, T + 300_000, false, true, 'your chief of staff');
  assert.equal(s.problem, true);
  assert.match(s.line, /^For your chief of staff: not written down/);
  assert.match(s.line, /HTTP 429/);
  assert.equal(flow.badge(n, T + 300_000, false, true), 'failed: writing down');
  assert.equal(flow.badge(n, T + 300_000, true, true), 'writing down');
});

test('aTranscriptionSavingItsCopyKeepsAChoiceMadeMeanwhile', () => {
  const saved = note(T, 10);
  const mine = JSON.parse(JSON.stringify(saved));
  flow.wantChief(saved, T + 12_000);
  flow.event(saved, T + 12_000, 'chose');
  flow.log(mine, T + 11_000, 'speech', 'm', 900, null);
  flow.merge(mine, saved);
  assert.equal(flow.meantForChief(mine), true);
  assert.equal(mine.log.length, 2);
  assert.equal(mine.log[0].at, T + 11_000);
  assert.equal(mine.log[1].step, 'event');
  flow.dropChief(saved, T + 13_000);
  flow.merge(mine, saved);
  assert.equal(flow.meantForChief(mine), false);
});

test('theLogKeepsEveryTryUpToItsLimit', () => {
  const n = note(T, 10);
  for (let i = 0; i < flow.LOG_MAX + 5; i++) flow.log(n, T + i, 'speech', 'm', 1, i % 2 === 0 ? 'HTTP 429' : null);
  assert.equal(n.log.length, flow.LOG_MAX);
  assert.equal(n.log[0].at, T + 5);
  const d = flow.details(n, 'state', 'line | note n1\n', 'app');
  assert.match(d, /failed: HTTP 429/);
  assert.match(d, /line \| note n1/);
});
