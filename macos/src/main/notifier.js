'use strict';
// The chief's ntfy messages on the Mac, where there's no ntfy app: every notification on the
// topic becomes a macOS notification (a click opens its thread in bb), and text to paste
// (tagged talkrouter-paste) comes with Insert and Copy. Spoken replies (talkrouter-speak) belong
// to hands-free calls and aren't shown.

const { Notification } = require('electron');
const chiefText = require('../core/chief-text');

/** Pref: show the chief's notifications on this Mac (on by default). */
const PREF = 'macNotifications';

class Notifier {
  /**
   * ctx: the app context; handlers: { openUrl(url), insert(text), copy(text), pasteArrived(request, text),
   * clicked() }. clicked runs first on every click on a notification (macOS activates the app then).
   * pasteArrived lets an open dictation panel offer Insert from chief itself; it returns true when it did.
   */
  constructor(ctx, handlers) {
    this.ctx = ctx;
    this.handlers = handlers;
    this.sub = null;
    this.key = '';
    this.shown = new Set(); // Notifications stay referenced until closed, or macOS drops their clicks.
    this.state = 'off';
  }

  /** (Re)connects when the topic, server or setting changed. */
  refresh() {
    const { prefs, bb, log } = this.ctx;
    let topic = '';
    try {
      topic = bb.hasNtfyTopic() ? bb.ntfyTopic() : '';
    } catch {
      topic = '';
    }
    const on = prefs.get(PREF, true) !== false && !!topic && bb.ready();
    const key = on ? `${bb.ntfyServer()}|${topic}` : '';
    if (key === this.key) return;
    this.stop();
    this.key = key;
    if (!on) return;
    const server = bb.ntfyServer();
    log(`ntfy: listening on ${server} for the chief's notifications`);
    this.sub = chiefText.subscribe({
      server,
      topic,
      onMessage: (m) => this.message(m, server).catch((e) => log(`ntfy: message not shown (${e.message})`)),
      onState: (state, err) => {
        this.state = state;
        if (state === 'retrying') log(`ntfy: connection lost (${err ? err.message || err : 'closed'}); retrying`);
      },
    });
  }

  stop() {
    if (this.sub) this.sub.stop();
    this.sub = null;
    this.key = '';
    this.state = 'off';
  }

  async message(m, server) {
    const c = chiefText.classify(m);
    if (c.kind === 'speak') return;
    if (c.kind === 'paste') {
      const text = (await chiefText.text(m, server)) || c.text;
      if (this.handlers.pasteArrived && this.handlers.pasteArrived(c.request, text)) return;
      this.show({
        title: c.title || 'Text to paste',
        body: text,
        actions: [
          { type: 'button', text: 'Insert' },
          { type: 'button', text: 'Copy' },
        ],
        onAction: (i) => (i === 0 ? this.handlers.insert(text) : this.handlers.copy(text)),
        // A click on the notification inserts too: banners show their buttons only on hover.
        onClick: () => this.handlers.insert(text),
      });
      return;
    }
    this.show({
      title: c.title || 'Your chief of staff',
      body: c.text,
      onClick: () => c.click && this.handlers.openUrl(c.click),
    });
  }

  show({ title, body, actions = [], onAction, onClick }) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: body.length > 600 ? body.slice(0, 600) + '…' : body, actions, silent: false });
    this.shown.add(n);
    const forget = () => this.shown.delete(n);
    const clicked = () => this.handlers.clicked && this.handlers.clicked();
    n.on('click', () => {
      forget();
      clicked();
      onClick && onClick();
    });
    n.on('action', (_e, index) => {
      forget();
      clicked();
      onAction && onAction(index);
    });
    n.on('close', forget);
    n.show();
  }
}

module.exports = { Notifier, PREF };
