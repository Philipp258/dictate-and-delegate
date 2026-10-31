'use strict';
// The main window's API: its pure helpers (usage per month, Home's card, the money formats) and
// the settings file (export and import validation). api.js loads Electron only in registerApi,
// so no mock is needed for these.

const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryEntry } = require('../src/core/history-entry');
const { MemoryVault } = require('../src/core/store');
const api = require('../src/main/api');

const entry = (json) => new HistoryEntry({ requests: 1, status: 'complete', ...json });
const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();

test('usageForMonthCountsOnlyThatMonth', () => {
  const from = at(2026, 9, 1, 0);
  const to = at(2026, 10, 1, 0);
  const entries = [
    entry({ id: 'a', created: at(2026, 9, 3), model: 'm/speech', duration: 60, knownCost: '0.002' }),
    entry({ id: 'b', created: at(2026, 8, 30), model: 'm/speech', duration: 600, knownCost: '1' }),
    entry({ id: 'c', created: at(2026, 10, 1), model: 'm/speech', duration: 600, knownCost: '1' }),
  ];
  const u = api.usageForMonth(entries, from, to);
  assert.equal(u.spent, 0.002);
  assert.equal(u.seconds, 60);
  assert.equal(u.count, 1);
  assert.equal(u.partial, false);
});

test('usageForMonthSplitsCostByModel', () => {
  const e = entry({
    id: 'n1',
    created: at(2026, 9, 5),
    model: 'microsoft/mai-transcribe-2',
    duration: 30,
    knownCost: '0.00107',
    textModel: 'anthropic/claude-sonnet-5.5',
    textCost: '0.000323',
    jevCost: '0.00002',
    voiceModel: 'hexgrad/kokoro-82m',
    voiceCost: '0.0001',
    anthropicCost: '0.004',
  });
  const u = api.usageForMonth([e], at(2026, 9, 1, 0), at(2026, 10, 1, 0));
  const by = Object.fromEntries(u.byModel.map((m) => [m.id, m]));
  assert.equal(by['microsoft/mai-transcribe-2'].cost, 0.000627); // 0.00107 − text − Jev − voice
  assert.equal(by['microsoft/mai-transcribe-2'].seconds, 30);
  assert.equal(by['anthropic/claude-sonnet-5.5'].cost, 0.000323);
  assert.equal(by['~typesafe/jev-latest'].cost, 0.00002);
  assert.equal(by['hexgrad/kokoro-82m'].cost, 0.0001);
  // Anthropic credits are kept apart, never in the total.
  assert.equal(u.spent, 0.00107);
  assert.equal(u.credits, 0.004);
  // Sorted by id, as Android's TreeMap.
  assert.deepEqual(u.byModel.map((m) => m.id), [...u.byModel.map((m) => m.id)].sort());
});

test('usageForMonthCountsRedoneVersionsOnceForTime', () => {
  const first = entry({ id: 'r1', created: at(2026, 9, 5), model: 'a/x', duration: 40, knownCost: '0.001' });
  const redo = entry({ id: 'r2', recordingId: 'r1', created: at(2026, 9, 5, 13), model: 'b/y', duration: 40, knownCost: '0.003' });
  const u = api.usageForMonth([first, redo], at(2026, 9, 1, 0), at(2026, 10, 1, 0));
  assert.equal(u.seconds, 40);
  assert.equal(u.count, 1);
  assert.equal(u.spent, 0.004);
});

test('usageForMonthMarksUnreportedCosts', () => {
  const e = entry({ id: 'p', created: at(2026, 9, 5), model: 'a/x', duration: 10, knownCost: '0', unpriced: 1 });
  assert.equal(api.usageForMonth([e], at(2026, 9, 1, 0), at(2026, 10, 1, 0)).partial, true);
});

test('homeStatsSumsMonthAndLastFourteenDays', () => {
  const now = at(2026, 9, 29, 15);
  const s = api.homeStats(
    [
      entry({ id: 't', created: at(2026, 9, 29, 9), duration: 30, knownCost: '0.01' }),
      entry({ id: 'y', created: at(2026, 9, 28, 9), duration: 30, knownCost: '0.02' }),
      entry({ id: 'old', created: at(2026, 9, 10, 9), duration: 30, knownCost: '0.5' }),
      entry({ id: 'last', created: at(2026, 8, 20, 9), duration: 30, knownCost: '1' }),
    ],
    now,
  );
  assert.equal(s.spent, 0.53);
  assert.equal(s.seconds, 90);
  assert.equal(s.days.length, 14);
  assert.equal(s.days[13], 0.01);
  assert.equal(s.days[12], 0.02);
  assert.equal(s.days.reduce((a, b) => a + b, 0), 0.03);
});

test('monthStartGoesBackWithoutOverflow', () => {
  const now = at(2026, 2, 31, 10); // 31 March: February has no 31st.
  assert.equal(new Date(api.monthStart(1, now)).getMonth(), 1);
  assert.equal(new Date(api.monthStart(1, now)).getDate(), 1);
  assert.equal(new Date(api.monthStart(-1, now)).getMonth(), 3);
});

test('moneyFormatsAsAndroid', () => {
  assert.equal(api.amount(0), '$0.00');
  assert.equal(api.amount(0.0123), '$0.0123');
  assert.equal(api.amount(7.137), '$7.14');
  assert.equal(api.cost(0, true), '–');
  assert.equal(api.cost(0.0004, false), '$0.0004');
  assert.equal(api.exact(0.000015), '$0.000015');
  assert.equal(api.exact(0.0003), '$0.0003');
  assert.equal(api.duration(42), '42 s');
  assert.equal(api.duration(600), '10 min');
  assert.equal(api.duration(3900), '1 h 5 min');
});

test('exportCarriesSettingsAndKeysButNoRuntimeState', () => {
  const vault = new MemoryVault({ openrouterKey: 'sk-or', anthropicKey: 'sk-ant', bbAuth: '{"refresh":"x"}', transcript: 'secret words', ntfyTopic: 'topic' });
  const out = api.buildExport({ model: 'openai/whisper-1', hfLive: false, sessionId: 's1', panelX: 3, skillsInstalled: 'abc' }, vault, '0.1.0');
  assert.equal(out.app, 'dictate-and-delegate');
  assert.deepEqual(out.prefs, { model: 'openai/whisper-1', hfLive: false });
  assert.deepEqual(out.keys, { openrouterKey: 'sk-or', anthropicKey: 'sk-ant', ntfyTopic: 'topic' });
});

test('importRoundTripsAnExport', () => {
  const vault = new MemoryVault({ openrouterKey: 'sk-or', elevenlabsKey: 'el' });
  const text = JSON.stringify(api.buildExport({ model: 'openai/whisper-1', hfTurnPauseMs: 2500 }, vault));
  const r = api.parseImport(text);
  assert.deepEqual(r.prefs, { model: 'openai/whisper-1', hfTurnPauseMs: 2500 });
  assert.deepEqual(r.keys, { openrouterKey: 'sk-or', elevenlabsKey: 'el' });
  assert.deepEqual(r.skipped, []);
});

test('importRejectsOtherFiles', () => {
  assert.throws(() => api.parseImport('not json'), /isn't a Dictate & Delegate settings file/);
  assert.throws(() => api.parseImport(JSON.stringify({ app: 'other', prefs: {} })), /isn't a Dictate & Delegate settings file/);
  assert.throws(() => api.parseImport(JSON.stringify([1, 2])), /isn't a Dictate & Delegate settings file/);
  assert.throws(() => api.parseImport(JSON.stringify({ app: 'dictate-and-delegate', prefs: [] })), /damaged/);
  assert.throws(() => api.parseImport('x'.repeat(3_000_000)), /isn't a Dictate & Delegate settings file/);
});

test('importChecksEachSettingAndSkipsBadOnes', () => {
  const r = api.parseImport(
    JSON.stringify({
      app: 'dictate-and-delegate',
      prefs: {
        model: { evil: 1 }, // not a value: skipped
        hfVoice: 'no-such-voice', // not one of the choices: skipped
        bubbleOpacity: 500, // out of range: skipped
        hfLive: 'yes', // a boolean setting: skipped
        talkerOn2: true,
        bbUrl: 'https://x.getbb.app/mcp',
        chiefTitle: 7, // a text setting given a number: skipped
        somethingUnknown: 'x', // not a setting this app has: skipped
        sessionId: 'runtime', // running state: dropped silently
        autoRefine: false,
        hfTurnPauseMs: 2500,
      },
      keys: { openrouterKey: 42, bbAuth: 'tokens', anthropicKey: ' sk-ant ' },
    }),
  );
  assert.deepEqual(r.prefs, { talkerOn2: true, bbUrl: 'https://x.getbb.app/mcp', autoRefine: false, hfTurnPauseMs: 2500 });
  assert.deepEqual(r.keys, { anthropicKey: 'sk-ant' });
  assert.deepEqual(r.skipped.sort(), ['bbAuth', 'bubbleOpacity', 'chiefTitle', 'hfLive', 'hfVoice', 'model', 'openrouterKey', 'somethingUnknown'].sort());
});

test('importTakesLongTemplates', () => {
  const templates = JSON.stringify([{ id: '1', name: 'Long', text: 'x'.repeat(500_000) }]);
  const r = api.parseImport(JSON.stringify({ app: 'dictate-and-delegate', prefs: { templates } }));
  assert.equal(r.prefs.templates, templates);
  assert.deepEqual(r.skipped, []);
});

test('plainHttpOnlyToThisComputer', () => {
  assert.equal(api.plainHttpAllowed('https://bb.example.com/mcp'), true);
  assert.equal(api.plainHttpAllowed('http://127.0.0.1:38886/api/v1/plugins/bb--mcp/http/mcp'), true);
  assert.equal(api.plainHttpAllowed('http://localhost:8080'), true);
  assert.equal(api.plainHttpAllowed('http://[::1]:8080'), true);
  assert.equal(api.plainHttpAllowed('http://ntfy.example.com'), false);
  assert.equal(api.plainHttpAllowed('http://127.0.0.1.evil.com'), false);
});

test('sameAcceleratorIgnoresModifierOrder', () => {
  assert.equal(api.sameAccelerator('Shift+Alt+Space', 'Alt+Shift+Space'), true);
  assert.equal(api.sameAccelerator('Cmd+Shift+D', 'Shift+Command+D'), true);
  assert.equal(api.sameAccelerator('Alt+Space', 'Alt+Shift+Space'), false);
  assert.equal(api.sameAccelerator('', ''), false);
});

test('routeAndBadgeLikeMainActivity', () => {
  const chief = entry({ id: 'c', chiefThread: 'thr_1' });
  const failed = entry({ id: 'f', route: 'chief', chiefFailed: 'bb down' });
  const refined = entry({ id: 'r', processed: 'x' });
  assert.equal(api.routeLabel(chief), 'Sent to chief of staff');
  assert.equal(api.routeLabel(failed), 'Not sent to chief of staff');
  assert.equal(api.routeLabel(refined), 'Refined');
  assert.equal(api.routeLabel(entry({ id: 'p' })), 'Transcript only');
  assert.equal(api.badge({ shown: chief, versions: [chief] }), 'chief of staff');
  assert.equal(api.badge({ shown: failed, versions: [failed] }), 'not sent');
  assert.equal(api.badge({ shown: entry({ id: 'x', status: 'pending' }), versions: [] }), 'in progress');
  assert.equal(api.badge({ shown: entry({ id: 'o', version: 'original' }), versions: [1] }), 'as said');
  assert.equal(api.checkDetail('text · Apartment application'), 'Refine · Apartment application');
  assert.equal(api.checkDetail('HTTP 500'), null);
});
