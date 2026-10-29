'use strict';
// Text the chief sends back, through the user's ntfy topic. Text for pasting is tagged
// "talkrouter-paste" and "req-<request ID>" (the dictate-and-delegate skill); spoken replies in
// hands-free mode "talkrouter-speak". While the app waits for a request's text it reads the topic's
// JSON stream itself (Listener); hands-free mode reads the spoken replies (Replies). Mac: the app
// also keeps one general subscription (subscribe) to show the chief's notifications and texts to
// paste as macOS notifications, since there's no ntfy app on the Mac doing it.

const crypto = require('crypto');
const { sleep } = require('./util');
const bridgeLib = require('./bb-bridge');
const netLog = require('./net-log');

/** The ntfy tag on spoken replies in hands-free mode (the dictate-and-delegate skill). */
const SPEAK_TAG = 'talkrouter-speak';
const PASTE_TAG = bridgeLib.PASTE_TAG;

/** Six random lowercase letters and digits: short enough to read, unique enough per topic. */
function requestId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet.charAt(crypto.randomInt(alphabet.length));
  return s;
}

function isMessage(m) {
  return (m.event === undefined || m.event === null ? 'message' : m.event) === 'message';
}

function tagsOf(m) {
  return Array.isArray(m.tags) ? m.tags.map((t) => String(t).trim()) : [];
}

/** An ntfy message (one line of the JSON stream) that holds the text for this request. */
function matches(m, request) {
  if (!isMessage(m)) return false;
  let paste = false;
  let ours = false;
  for (const t of tagsOf(m)) {
    paste = paste || t.toLowerCase() === PASTE_TAG;
    ours = ours || t.toLowerCase() === bridgeLib.requestTag(request).toLowerCase();
  }
  return paste && ours;
}

/**
 * The text of a matching message. ntfy turns messages over 4,096 bytes into a text attachment;
 * then the text is fetched from its URL, but only from the ntfy server itself: an attachment
 * elsewhere (ntfy's Attach header) could make the app fetch any address.
 */
async function text(m, server, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const a = m.attachment && typeof m.attachment === 'object' ? m.attachment : null;
  const url = a && a.url ? String(a.url) : '';
  if (url && url.startsWith(server + '/')) {
    const type = a.type || 'text/plain';
    if (String(type).startsWith('text/')) return (await get(fetchImpl, url, 200_000, 'ntfy attachment')).trim();
  }
  return String(m.message || '').trim();
}

/** <server>/<topic>/json?since=…: the stream from that moment (unix seconds, or a message id), or a poll. */
function streamUrl(server, topic, since, poll = false) {
  return server + '/' + topic + '/json?since=' + since + (poll ? '&poll=1' : '');
}

async function get(fetchImpl, url, max, what = 'ntfy get', secret = '') {
  return netLog.request(what, 'GET', url, async (net) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    net.status(res.status);
    if (res.status >= 300) {
      await res.arrayBuffer().catch(() => {});
      throw new Error('HTTP ' + res.status);
    }
    const chunks = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        chunks.push(Buffer.from(chunk));
        size += chunk.length;
        if (size >= max) break;
      }
    }
    net.received(size);
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
  }, { secrets: [secret] });
}

/** A received ntfy message for the network log: its id, kind (from its tags), and how long after ntfy got it. */
function logMessage(what, m, clock = Date.now) {
  if (!m || typeof m !== 'object' || m.event === 'keepalive' || m.event === 'open') return;
  const tags = tagsOf(m).map((t) => t.toLowerCase());
  let request = '';
  for (const t of tagsOf(m)) if (t.toLowerCase().startsWith('req-')) request = t.substring(4);
  const kind = tags.includes(PASTE_TAG) ? 'paste' : tags.includes(SPEAK_TAG) ? 'speak' : isMessage(m) ? 'notification' : String(m.event);
  const time = Number(m.time) || 0;
  const delay = time ? ', ' + Math.max(0, clock() - time * 1000) + ' ms after ntfy got it' : '';
  netLog.event(what + ' message', '', 'id ' + String(m.id || '?'), request, kind + delay);
}

/**
 * Reads one connection of a JSON stream, handing each parsed line to onLine (which may return
 * true to stop). Gives up when nothing arrives for idleMs (ntfy sends a keepalive every 45 s) or
 * when signal aborts. Resolves when the stream ends.
 */
async function readStream(fetchImpl, url, { signal, onLine, connectMs = 15_000, idleMs = 90_000, what = 'ntfy stream', secret = '', reconnect = 0 }) {
  const controller = new AbortController();
  // Why it ended, for the network log: the app stopped it, or nothing came in time.
  let why = '';
  const abort = () => {
    why = why || 'closed by the app';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener('abort', abort, { once: true });
  }
  let opened = 0;
  let messages = 0;
  let timer = setTimeout(() => {
    why = 'connect timeout';
    controller.abort();
  }, connectMs);
  const idle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      why = 'nothing for ' + Math.round(idleMs / 1000) + ' s (read timeout)';
      controller.abort();
    }, idleMs);
  };
  let failure = null;
  try {
    const connecting = netLog.begin(what + ' connect', 'GET', url, secret).retry(reconnect);
    let res;
    try {
      res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
      connecting.status(res.status);
    } catch (ex) {
      connecting.fail(why === 'connect timeout' ? Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) : ex);
      why = '';
      throw ex;
    } finally {
      connecting.end();
    }
    if (res.status >= 300) {
      await res.arrayBuffer().catch(() => {});
      throw new Error('HTTP ' + res.status);
    }
    opened = Date.now();
    idle();
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      idle();
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, nl);
        buffer = buffer.substring(nl + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m && typeof m === 'object') {
          if (m.event !== 'keepalive' && m.event !== 'open') messages++;
          logMessage(what, m);
        }
        if (m && typeof m === 'object' && (await onLine(m))) {
          why = 'done';
          controller.abort();
          return;
        }
      }
    }
    why = why || 'ended by the server';
  } catch (ex) {
    failure = ex;
    throw ex;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
    if (opened) {
      const res = why || (failure ? netLog.classify(failure) : 'ended');
      const open = Date.now() - opened;
      netLog.event(what + ' closed', url, res, '', 'open ' + (open < 60_000 ? Math.round(open / 1000) + ' s' : Math.floor(open / 60_000) + ' min ' + Math.round((open % 60_000) / 1000) + ' s') + ', ' + messages + (messages === 1 ? ' message' : ' messages'), secret);
    }
  }
}

/**
 * Reads the topic's stream until the text for the request arrives or finish() is called;
 * reconnects after a dropped connection. found(text) is called once.
 */
class Listener {
  constructor(server, topic, request, sinceSeconds, found, { fetch: fetchImpl = globalThis.fetch, retryMs = 3000 } = {}) {
    this.server = server;
    this.topic = topic;
    this.request = request;
    this.since = sinceSeconds;
    this.found = found;
    this.fetch = fetchImpl;
    this.retryMs = retryMs;
    this.controller = new AbortController();
    this.stopped = false;
    this.done = null;
  }

  start() {
    if (!this.done) this.done = this.run();
    return this;
  }

  finish() {
    this.stopped = true;
    this.controller.abort();
  }

  async run() {
    for (let reconnect = 0; !this.stopped; reconnect++) {
      let got = null;
      try {
        await readStream(this.fetch, streamUrl(this.server, this.topic, this.since, false), {
          signal: this.controller.signal,
          what: 'ntfy paste text',
          secret: this.topic,
          reconnect,
          onLine: async (m) => {
            if (this.stopped || !matches(m, this.request)) return this.stopped;
            const t = await text(m, this.server, { fetch: this.fetch });
            if (!t) return false;
            got = t;
            return true;
          },
        });
      } catch {
        /* Dropped or unreachable: try again in a moment. */
      }
      if (got != null && !this.stopped) {
        this.stopped = true;
        this.found(got);
        return;
      }
      if (this.stopped) return;
      await sleep(this.retryMs);
    }
  }
}

/** The request ID of a spoken reply ("req-<id>" next to SPEAK_TAG), or "" for any other message. */
function spokenRequest(m) {
  if (!isMessage(m)) return '';
  let speak = false;
  let request = '';
  for (const t of tagsOf(m)) {
    if (t.toLowerCase() === SPEAK_TAG) speak = true;
    else if (t.toLowerCase().startsWith('req-')) request = t.substring(4);
  }
  return speak ? request : '';
}

/** Is it a spoken reply (SPEAK_TAG), with or without a request ID? */
function spoken(m) {
  if (!isMessage(m)) return false;
  return tagsOf(m).some((t) => t.toLowerCase() === SPEAK_TAG);
}

/**
 * Hands-free mode: reads the topic's stream until finish() and hands every spoken reply for one of
 * our requests to onReply(request, text, publishedMs, untagged), in order and once each;
 * reconnects after a dropped connection. ours(request) says whether a request is ours. A spoken
 * reply without a request ID counts as one for the request untagged() names ("" drops it): the
 * talker passes on the chief's results that way. publishedMs: when ntfy got it (whole seconds), 0
 * if unknown.
 */
class Replies {
  constructor({ server, topic, sinceSeconds, ours, untagged = () => '', onReply, fetch: fetchImpl = globalThis.fetch, retryMs = 3000 }) {
    this.server = server;
    this.topic = topic;
    this.since = String(sinceSeconds);
    this.ours = ours;
    this.untagged = untagged;
    this.onReply = onReply;
    this.fetch = fetchImpl;
    this.retryMs = retryMs;
    this.seen = new Set();
    this.controller = new AbortController();
    this.stopped = false;
    this.done = null;
  }

  start() {
    if (!this.done) this.done = this.run();
    return this;
  }

  finish() {
    this.stopped = true;
    this.controller.abort();
  }

  async run() {
    for (let reconnect = 0; !this.stopped; reconnect++) {
      try {
        await readStream(this.fetch, this.server + '/' + this.topic + '/json?since=' + this.since, {
          signal: this.controller.signal,
          what: 'ntfy replies',
          secret: this.topic,
          reconnect,
          onLine: async (m) => {
            if (this.stopped) return true;
            const id = m.id ? String(m.id) : '';
            if (id) this.since = id; // Reconnect from here, not from the start.
            let request = spokenRequest(m);
            const noTag = !request;
            if (noTag && spoken(m)) request = this.untagged() || '';
            if (!request || this.seen.has(id)) return false;
            this.seen.add(id);
            if (!this.ours(request)) return false;
            const t = await text(m, this.server, { fetch: this.fetch });
            if (t && !this.stopped) this.onReply(request, t, (Number(m.time) || 0) * 1000, noTag);
            return false;
          },
        });
      } catch {
        /* Dropped or unreachable: try again in a moment. */
      }
      if (this.stopped) return;
      await sleep(this.retryMs);
    }
  }
}

/**
 * The text for a request, from the messages the topic still holds (ntfy keeps them 12 h); "" when
 * it isn't there anymore. bridge gives the server and topic.
 */
async function fetchText(bridge, request, { fetch: fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  const server = bridge.ntfyServer();
  const since = Math.floor(clock() / 1000) - 12 * 3600;
  const all = await get(fetchImpl, streamUrl(server, bridge.ntfyTopic(), since, true), 2_000_000, 'ntfy poll', bridge.ntfyTopic());
  let found = '';
  for (const line of all.split('\n')) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // Not a message.
    }
    if (m && typeof m === 'object' && matches(m, request)) found = await text(m, server, { fetch: fetchImpl }); // The latest one wins.
  }
  return found;
}

// ------------------------------------------------------------------ Mac: the general subscription

/**
 * What a topic message is for the Mac: "paste" (text to paste, tagged talkrouter-paste and
 * req-<id>), "speak" (a spoken reply of a hands-free call) or "notification" (anything else the
 * chief posts). text is the message itself; a long paste text sits in an attachment (use text()).
 */
function classify(m) {
  const tags = tagsOf(m).map((t) => t.toLowerCase());
  let request = '';
  for (const t of tagsOf(m)) if (t.toLowerCase().startsWith('req-')) request = t.substring(4);
  const kind = tags.includes(PASTE_TAG) ? 'paste' : tags.includes(SPEAK_TAG) ? 'speak' : 'notification';
  return {
    kind,
    request,
    title: String(m.title || ''),
    text: String(m.message || '').trim(),
    click: String(m.click || ''),
    id: String(m.id || ''),
    time: Number(m.time) || 0,
  };
}

/**
 * Keeps reading the topic until stop(): hands every message (event "message") to onMessage once,
 * oldest first, from sinceSeconds (default: now) on. Reconnects after a dropped connection with a
 * growing pause (minBackoffMs doubling up to maxBackoffMs, back to the start once a connection
 * works), resuming after the last message seen; messages are told apart by their id. onState(
 * "open"|"retrying", error) says how the connection stands. Returns {stop, done}.
 */
function subscribe({
  server,
  topic,
  sinceSeconds,
  onMessage,
  onState = () => {},
  fetch: fetchImpl = globalThis.fetch,
  minBackoffMs = 1000,
  maxBackoffMs = 60_000,
  idleMs = 90_000,
  clock = () => Date.now(),
}) {
  const controller = new AbortController();
  let stopped = false;
  let since = String(sinceSeconds != null ? sinceSeconds : Math.floor(clock() / 1000));
  const seen = new Set();
  const order = [];
  const remember = (id) => {
    seen.add(id);
    order.push(id);
    if (order.length > 1000) seen.delete(order.shift());
  };
  let wake = null;
  const pause = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  const done = (async () => {
    let backoff = minBackoffMs;
    for (let reconnect = 0; !stopped; reconnect++) {
      let error = null;
      try {
        await readStream(fetchImpl, streamUrl(server, topic, since, false), {
          signal: controller.signal,
          idleMs,
          what: 'ntfy subscription',
          secret: topic,
          reconnect,
          onLine: async (m) => {
            if (stopped) return true;
            backoff = minBackoffMs; // It works: the next drop retries soon.
            if (m.event === 'open') {
              onState('open', null);
              return false;
            }
            if (!isMessage(m)) return false;
            const id = m.id ? String(m.id) : '';
            if (id) {
              since = id;
              if (seen.has(id)) return false;
              remember(id);
            }
            try {
              await onMessage(m);
            } catch {
              /* The app's problem; the subscription goes on. */
            }
            return false;
          },
        });
      } catch (ex) {
        error = ex;
      }
      if (stopped) return;
      onState('retrying', error);
      await pause(backoff);
      backoff = Math.min(maxBackoffMs, backoff * 2);
    }
  })();
  return {
    stop() {
      stopped = true;
      controller.abort();
      if (wake) wake();
      return done;
    },
    done,
  };
}

module.exports = {
  SPEAK_TAG,
  PASTE_TAG,
  requestId,
  matches,
  text,
  streamUrl,
  Listener,
  Replies,
  spokenRequest,
  spoken,
  fetchText,
  fetch: fetchText,
  classify,
  subscribe,
  readStream,
};
