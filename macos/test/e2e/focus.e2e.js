'use strict';
// End to end in the real app (headless on Linux): a click on the floating panel or on a
// notification activates the app on macOS, and that must not open the window; Insert from a
// notification puts the text in (here: copies, as Linux has no Accessibility) without opening it.
// A Dock click (an activation with nothing clicked before) still opens the window.
// Run: scripts/e2e.sh focus

const assert = require('assert/strict');
const { app, clipboard } = require('electron');
const { waitFor, sleep } = require('../../src/core/util');

module.exports = async function (dd) {
  const noWindow = (why) => assert.ok(!dd.mainWindow(), why);
  noWindow('no window at the start');

  // The cursor on the panel (and a click on it), then the activation that click causes on macOS.
  const panel = dd.panel();
  await waitFor(() => !panel.webContents.isLoading(), 10000, 'panel loaded');
  await panel.webContents.executeJavaScript("window.dd.send('panel:action', 'touch')");
  await sleep(100);
  app.emit('activate', {}, false);
  await sleep(600);
  noWindow('a click on the panel opens no window');

  // A click on a paste notification: macOS activates the app, then the notifier inserts.
  dd.activation.until = 0;
  const notifier = dd.notifier();
  app.emit('activate', {}, false); // macOS may activate the app before the click's handler runs.
  notifier.handlers.clicked();
  await notifier.handlers.insert('Text from the chief.');
  await sleep(600);
  noWindow('a click on a notification opens no window');
  assert.equal(await clipboard.readText(), 'Text from the chief.');

  // A Dock click, with nothing clicked before: the window opens.
  dd.activation.until = 0;
  app.emit('activate', {}, false);
  await waitFor(() => !!dd.mainWindow(), 5000, 'a Dock click opens the window');
};
