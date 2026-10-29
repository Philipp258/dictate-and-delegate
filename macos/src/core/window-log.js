'use strict';
// The window log (Settings → Data, opt-in): what macOS and the app did with the windows and the
// focus — the app activated, a window shown or focused, which code opened the main window, a
// click on the floating panel and whether the app was active then — to see why a window appeared
// when it shouldn't. Off by default; never text, keys or addresses.

const HandsFreeLog = require('./handsfree-log');
const { stamp } = require('./net-log');

/** Pref: keep the window log. */
const PREF = 'windowLog';

const KEEP = 2000;

class WindowLog {
  /** file: where it's kept; enabled(): whether to write now. */
  constructor({ file, enabled, now = () => Date.now() }) {
    this.file = file;
    this.enabled = enabled;
    this.now = now;
  }

  log(what, detail = '') {
    if (!this.file || !this.enabled()) return;
    HandsFreeLog.append(this.file, stamp(this.now()) + ' | ' + what + (detail ? ' | ' + detail : ''), KEEP);
  }

  read() {
    return this.file ? HandsFreeLog.read(this.file) : '';
  }
}

/**
 * Which code got here, from a stack: the app's own frames (src/…), innermost first, as
 * "function file:line", without the log's own. "" without any.
 */
function caller(stack, frames = 4) {
  const out = [];
  for (const l of String(stack || '').split('\n').slice(1)) {
    const m = /at (?:(.+?) \()?.*[/\\](src[/\\][^:]+):(\d+):\d+\)?$/.exec(l.trim());
    if (!m || /window-log\.js$/.test(m[2])) continue;
    out.push((m[1] ? m[1].replace(/^Object\.|^Timeout\./, '') + ' ' : '') + m[2].replace(/\\/g, '/') + ':' + m[3]);
    if (out.length >= frames) break;
  }
  return out.join(' ← ');
}

module.exports = { WindowLog, caller, PREF, KEEP };
