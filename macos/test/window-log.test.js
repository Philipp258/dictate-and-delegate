'use strict';
// The opt-in window log: what opened windows and took the focus, with the code path that did it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WindowLog, caller } = require('../src/core/window-log');

test('itWritesOnlyWhenTurnedOn', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wlog-')), 'window.log');
  let on = false;
  const log = new WindowLog({ file, enabled: () => on, now: () => 1793301303123 });
  log.log('main window: show');
  assert.equal(log.read(), '');
  on = true;
  log.log('main window: open (home)', 'openMain src/main/main.js:440');
  assert.match(log.read(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.123[+-]\d\d:\d\d \| main window: open \(home\) \| openMain src\/main\/main\.js:440\n$/);
});

test('theCallerNamesTheAppsOwnCodePathInnermostFirst', () => {
  const stack = [
    'Error',
    '    at WindowLog.log (/Applications/Dictate & Delegate.app/Contents/Resources/app.asar/src/core/window-log.js:24:5)',
    '    at openMain (/Applications/Dictate & Delegate.app/Contents/Resources/app.asar/src/main/main.js:440:5)',
    '    at panelAction (/Applications/Dictate & Delegate.app/Contents/Resources/app.asar/src/main/main.js:372:16)',
    '    at node:events:518:28',
    '    at Timeout._onTimeout (/Applications/Dictate & Delegate.app/Contents/Resources/app.asar/src/main/main.js:75:30)',
  ].join('\n');
  assert.equal(caller(stack), 'openMain src/main/main.js:440 ← panelAction src/main/main.js:372 ← _onTimeout src/main/main.js:75');
  assert.equal(caller(''), '');
});
