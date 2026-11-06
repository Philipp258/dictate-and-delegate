'use strict';
// What the floating panel shows for each state (FloatingPanel.render), from snapshots.

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core/dictation');
const { panelModel } = require('../src/core/panel-model');

function snap(over = {}, session = {}) {
  return {
    state: D.COPIED,
    detail: '',
    visible: true,
    elapsedMs: 0,
    attached: 0,
    opacity: 65,
    chiefAvailable: true,
    ...over,
    session: { refine: D.IDLE, chief: D.IDLE, reply: '', message: '', ...session },
  };
}

const button = (m, id) => m.buttons.find((b) => b.id === id);
const ids = (m) => m.buttons.map((b) => b.id);

test('hiddenWhenThePanelIsClosedOrReady', () => {
  assert.equal(panelModel(snap({ visible: false })).mode, 'hidden');
  assert.deepEqual(panelModel(snap({ visible: false })).buttons, []);
  assert.equal(panelModel(null).mode, 'hidden');
});

test('recordingShowsTheTimerChoicesCallAttachAndCancelLast', () => {
  const m = panelModel(snap({ state: D.RECORDING, elapsedMs: 75_900, attached: 2 }));
  assert.equal(m.mode, 'recording');
  assert.deepEqual(ids(m), ['stop', 'refine', 'chief', 'call', 'attach', 'close']);
  assert.deepEqual(m.timer, { elapsed: '01:15', label: '● 01:15  ■' });
  assert.equal(button(m, 'stop').name, 'Stop recording');
  assert.equal(button(m, 'stop').fill, 'red');
  assert.equal(button(m, 'attach').label, '📎 2');
  assert.equal(button(m, 'attach').name, 'Add context to this dictation');
  assert.equal(button(m, 'call').name, 'Hands-free call with your chief');
  assert.equal(button(m, 'close').name, 'Cancel: nothing is transcribed or sent');
  // Without a chief: no 🧑‍💼 and no 📞.
  const alone = panelModel(snap({ state: D.RECORDING, chiefAvailable: false }));
  assert.deepEqual(ids(alone), ['stop', 'refine', 'attach', 'close']);
  assert.equal(button(alone, 'attach').label, '📎');
});

test('choicesWhileRecordingShowTheirCheck', () => {
  const m = panelModel(snap({ state: D.RECORDING }, { refine: D.QUEUED, chief: D.QUEUED }));
  assert.equal(button(m, 'refine').label, '✨ ✓');
  assert.equal(button(m, 'refine').name, '✨ Refine ✓');
  assert.equal(button(m, 'refine').ring, 'teal');
  assert.equal(button(m, 'chief').label, '🧑‍💼 ✓');
  assert.equal(button(m, 'chief').name, '🧑‍💼 Chief ✓');
  assert.equal(button(m, 'chief').ring, 'teal');
});

test('transcribingShowsABusyInsertAndNoClose', () => {
  for (const state of [D.STOPPING, D.UPLOADING]) {
    const m = panelModel(snap({ state }));
    assert.equal(m.mode, 'processing');
    assert.deepEqual(ids(m), ['insert', 'refine', 'chief']);
    assert.deepEqual(
      [button(m, 'insert').label, button(m, 'insert').name, button(m, 'insert').enabled, button(m, 'insert').fill],
      ['…', 'Transcribing…', false, 'pill'],
    );
    assert.equal(m.timer, null);
  }
});

test('theResultOffersInsertRefineChiefAndClose', () => {
  const m = panelModel(snap({}, { message: 'Copied instead, paste with ⌘V' }));
  assert.equal(m.mode, 'result');
  assert.deepEqual(ids(m), ['insert', 'refine', 'chief', 'close']);
  assert.deepEqual([button(m, 'insert').label, button(m, 'insert').name, button(m, 'insert').fill], ['📥', 'Insert', 'teal']);
  assert.equal(button(m, 'refine').name, '✨ Refine');
  assert.equal(button(m, 'chief').name, '🧑‍💼 Chief');
  assert.equal(button(m, 'close').name, 'Close');
  assert.equal(m.status, 'Copied instead, paste with ⌘V');
  assert.deepEqual(m.extra, []);
});

test('refineAndChiefShowWhereTheyAre', () => {
  const cases = [
    [D.RUNNING, '✨ …', '✨ Refining…', 'pill', 'teal'],
    [D.DONE, '✨ 📥', 'Insert refined', 'teal', null],
    [D.FAILED, '✨ ↻', '✨ Refine again', 'pill', null],
  ];
  for (const [state, label, name, fill, ring] of cases) {
    const b = button(panelModel(snap({}, { refine: state })), 'refine');
    assert.deepEqual([b.label, b.name, b.fill, b.ring], [label, name, fill, ring], state);
  }
  const chief = [
    [D.RUNNING, '🧑‍💼 …', '🧑‍💼 Sending…', 'teal'],
    [D.DONE, '🧑‍💼 ↗', 'Open chat ↗', null],
    [D.FAILED, '🧑‍💼 ↻', '🧑‍💼 Send again', null],
  ];
  for (const [state, label, name, ring] of chief) {
    const b = button(panelModel(snap({}, { chief: state })), 'chief');
    assert.deepEqual([b.label, b.name, b.ring], [label, name, ring], state);
  }
});

test('theChiefsTextAddsInsertFromChief', () => {
  const m = panelModel(snap({}, { chief: D.DONE, reply: 'Hi Tom', message: 'Your chief of staff sent text to insert' }));
  assert.deepEqual(m.extra, [{ id: 'insertFromChief', label: '🧑‍💼 📥', name: 'Insert from chief', enabled: true, fill: 'teal', ring: null }]);
  assert.equal(m.status, 'Your chief of staff sent text to insert');
});

test('errorsAndNoSpeechShowTheSmallIconWithTheirLine', () => {
  const e = panelModel(snap({ state: D.ERROR, detail: 'Saved recording found. Open Dictate & Delegate to retry or discard.' }));
  assert.equal(e.mode, 'message');
  assert.deepEqual(e.icon, { state: D.ERROR, name: 'Open recording recovery' });
  assert.equal(e.detail, 'Saved recording found. Open Dictate & Delegate to retry or discard.');
  assert.deepEqual(e.buttons, []);
  const empty = panelModel(snap({ state: D.EMPTY, detail: 'No speech recognized. Ready to record again.', opacity: 40 }));
  assert.equal(empty.icon.name, 'No speech recognized');
  assert.equal(empty.opacity, 40);
});

test('aRealDictationsSnapshotDrawsAsExpected', async () => {
  const { MemoryPrefs } = require('../src/core/store');
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  let frameSink;
  const d = new D.Dictation({
    prefs: new MemoryPrefs(),
    timers,
    microphone: { start: (f) => (frameSink = f), stop: () => {} },
    transcribe: async () => ({ text: 'hello', cost: 0 }),
  });
  await d.start();
  assert.equal(panelModel(d.snapshot()).mode, 'recording');
  assert.deepEqual(ids(panelModel(d.snapshot())), ['stop', 'refine', 'attach', 'close']);
  frameSink(Buffer.alloc(D.FRAME_BYTES * 10, 1));
  await d.stop();
  await d.idle();
  const m = panelModel(d.snapshot());
  assert.equal(m.mode, 'result');
  assert.deepEqual(ids(m), ['insert', 'refine', 'close']);
});
