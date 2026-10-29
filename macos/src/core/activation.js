'use strict';
// macOS makes the app the active one when you click its floating panel or one of its
// notifications, and asks an activated Dock app to show its window. Those clicks must leave the
// window closed and give the focus back to the app you were typing in, so Insert lands in your
// text field, as it does after a dictation.

/** A click on the panel or a notification makes the activations right after it quiet: no window. */
class ActivationGate {
  constructor({ now = () => Date.now(), quietMs = 3000 } = {}) {
    this.now = now;
    this.quietMs = quietMs;
    this.until = 0;
  }

  /** The panel or a notification was used: activations in the next quietMs come from that. */
  quiet() {
    this.until = this.now() + this.quietMs;
  }

  /** On macOS's activate: open the window (a Dock click), unless the panel or a notification caused it. */
  opensWindow() {
    return this.now() >= this.until;
  }
}

/**
 * Before inserting: if a click made this app the active one, gives the focus back to the app you
 * were in and waits until it has it (at most waitMs), so ⌘V reaches your text field. mac: the
 * native module (appActive, deactivate) or null off macOS; hide: hides the app, the fallback when
 * deactivating doesn't take. Resolves to 'unavailable', 'not-active', 'deactivated' or 'hidden'.
 */
async function giveFocusBack({ mac, hide, sleep, waitMs = 1000, settleMs = 80 }) {
  if (!mac || typeof mac.appActive !== 'function') return 'unavailable';
  if (!mac.appActive()) return 'not-active';
  mac.deactivate();
  for (let waited = 0; mac.appActive() && waited < waitMs; waited += 25) await sleep(25);
  let how = 'deactivated';
  if (mac.appActive()) {
    hide();
    await sleep(350);
    how = 'hidden';
  }
  await sleep(settleMs); // The app in front puts the focus back in its field.
  return how;
}

module.exports = { ActivationGate, giveFocusBack };
