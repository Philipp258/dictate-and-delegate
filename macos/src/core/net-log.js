'use strict';
// Port of NetLog.java.
//
// The network log (Copy network log): one line for every request the app makes, to find out why
// something didn't arrive. Each line holds when the request started (local time with milliseconds
// and the UTC offset, to match against bb's and ntfy's logs), what it was for, the request ID where
// there is one, the method, host and path (secrets masked, no query values), the HTTP status or the
// kind of failure, how long it took, the retry, the sizes and the network at that moment. Never a
// token, key, cookie, message text or audio.
//
// Lines are appended to a file, so the log survives restarts; it keeps the last KEEP lines from the
// last 7 days. Without init (unit tests of other modules) nothing is written. Node runs these
// synchronous file calls one at a time, so they need no lock.

const fs = require('fs');

const KEEP = 1000;
const KEEP_MS = 7 * 24 * 3600 * 1000;

/** Past this size the file is trimmed at once, else every TRIM_EVERY lines. */
const TRIM_BYTES = 400 * 1024;
const TRIM_EVERY = 50;

const SEP = ' | ';

const state = {
  file: null,
  network: () => '',
  /** Asked to look at the network again soon (after a failure); the Mac's network watcher. */
  stale: () => {},
  appended: 0,
  lastNetwork: null,
  /** For tests: the wall clock, and the UTC offset in minutes at a moment (the zone the lines are in). */
  clock: () => Date.now(),
  offset: (ms) => -new Date(ms).getTimezoneOffset(),
  zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
};

/** Where the log goes, and what describes the network at a moment ("wifi (en0), v4+v6"). */
function init(file, network, { stale } = {}) {
  state.file = file || null;
  state.network = typeof network === 'function' ? network : () => '';
  state.stale = typeof stale === 'function' ? stale : () => {};
}

/** For tests: { clock, offset, zone }. */
function configure(opts = {}) {
  for (const k of ['clock', 'offset', 'zone']) if (typeof opts[k] === 'function') state[k] = opts[k];
}

function file() {
  return state.file;
}

// ------------------------------------------------------------------ requests

/**
 * Runs one request, logging it: its status (call.status) or the failure it threw. fn(call) is
 * async; opts: { retry, request, secrets }.
 */
async function request(what, method, url, fn, { retry = 0, request: id = '', secrets = [] } = {}) {
  const net = begin(what, method, url, ...secrets).retry(retry).request(id);
  try {
    return await fn(net);
  } catch (ex) {
    net.fail(ex);
    throw ex;
  } finally {
    net.end();
  }
}

function begin(what, method, url, ...secrets) {
  return new Call(what, method, target(url, ...secrets));
}

/** One request: filled in as it goes, written once at end(). */
class Call {
  constructor(what, method, tgt) {
    this.started = state.clock();
    this.startHr = process.hrtime.bigint();
    this.what = what;
    this.method = method;
    this.target = tgt;
    this.netBefore = net();
    this._request = '';
    this._note = '';
    this._retry = 0;
    this._status = 0;
    this._sent = -1;
    this._received = -1;
    this.failure = null;
    this.ended = false;
  }

  request(id) {
    this._request = id == null ? '' : String(id);
    return this;
  }

  retry(n) {
    this._retry = n || 0;
    return this;
  }

  status(code) {
    this._status = code || 0;
    return this;
  }

  sent(bytes) {
    this._sent = bytes;
    return this;
  }

  received(bytes) {
    this._received = bytes;
    return this;
  }

  /** A short plain fact about it (never content), e.g. "first byte 420 ms". */
  note(s) {
    this._note = s == null ? '' : String(s);
    return this;
  }

  fail(ex) {
    if (this.failure == null) this.failure = ex == null ? new Error('failed') : ex;
    return this;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    const ms = Number((process.hrtime.bigint() - this.startHr) / 1_000_000n);
    if (this.failure != null) state.stale();
    const netAfter = net();
    const n = netAfter === this.netBefore ? netAfter : this.netBefore + ' → ' + netAfter;
    append(
      line(this.started, this.what, this._request, this.method, this.target, result(this._status, this.failure),
        ms, this._retry, n, this._sent, this._received, this._note),
    );
  }
}

/** "HTTP 200", "HTTP 502 bad gateway", "read timeout", "HTTP 200, then read timeout"; "no answer" without either. */
function result(status, failure) {
  const http = status > 0 ? 'HTTP ' + status + statusName(status) : '';
  let fail = failure == null ? '' : classify(failure);
  if (!http) return fail || 'no answer';
  // An HTTP error the code turned into an exception: the status says it.
  if (!fail || (status >= 300 && fail.startsWith('app error'))) return http;
  // fetch has one timeout for the whole call: after the headers came, it's the body that was slow.
  if (fail === 'timeout') fail = 'read timeout';
  return http + ', then ' + fail;
}

const STATUS_NAMES = {
  101: ' switching protocols',
  400: ' bad request',
  401: ' unauthorized',
  403: ' forbidden',
  404: ' not found',
  408: ' request timeout',
  413: ' too large',
  429: ' too many requests',
  500: ' server error',
  502: ' bad gateway',
  503: ' unavailable',
  504: ' gateway timeout',
};

function statusName(status) {
  return STATUS_NAMES[status] || '';
}

// ------------------------------------------------------------------ events

/** Something on a connection that isn't one request: a stream opened or closed, a message came. */
function event(what, url, res, req, note, ...secrets) {
  append(line(state.clock(), what, req || '', '', url ? target(url, ...secrets) : '', res || '', -1, 0, net(), -1, -1, note || ''));
}

const CALL_STARTED = '── hands-free call started ──';

/** A line that starts a hands-free call, so Copy last call finds the entries since. */
function callStarted() {
  append(stamp(state.clock()) + SEP + CALL_STARTED);
}

/** The network changed (from the Mac's network watcher); the same as last time isn't repeated. */
function networkChanged(now) {
  if (now === state.lastNetwork) return;
  state.lastNetwork = now;
  append(stamp(state.clock()) + SEP + 'network now' + SEP + now);
}

// ------------------------------------------------------------------ the line

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "2026-10-29T20:15:03.123+01:00": local time with milliseconds and the UTC offset. */
function stamp(ms) {
  const off = state.offset(ms);
  const d = new Date(ms + off * 60_000); // Its UTC fields are the local time.
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return (
    d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' +
    pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3) + sign + pad(Math.trunc(a / 60)) + ':' + pad(a % 60)
  );
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/** The time a line starts with, or -1 if it doesn't. */
function time(l) {
  const end = l.indexOf(SEP);
  const s = end < 0 ? l : l.substring(0, end);
  if (!STAMP.test(s)) return -1;
  const t = Date.parse(s);
  return Number.isNaN(t) ? -1 : t;
}

function line(started, what, req, method, tgt, res, ms, retry, n, sent, received, note) {
  let s = stamp(started) + SEP + what;
  if (req) s += SEP + 'req ' + req;
  if (tgt) s += SEP + (method ? method + ' ' : '') + tgt;
  if (res) s += SEP + res;
  if (ms >= 0) s += SEP + ms + ' ms';
  if (retry > 0) s += SEP + 'retry ' + retry;
  if (sent >= 0 || received >= 0) {
    s += SEP + (sent >= 0 ? '↑' + size(sent) : '') + (sent >= 0 && received >= 0 ? ' ' : '') + (received >= 0 ? '↓' + size(received) : '');
  }
  if (n) s += SEP + n;
  if (note) s += SEP + note;
  return s.replace(/[\r\n]/g, ' ');
}

function size(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function net() {
  try {
    const n = state.network();
    return n == null ? '' : String(n);
  } catch {
    return 'network unknown';
  }
}

// ------------------------------------------------------------------ redaction

/** Query values shown as they are; every other one is masked. */
const PLAIN_QUERY = new Set(['since', 'poll', 'id', 'sample_rate', 'encoding', 'model_id', 'speech_model']);

/** A path segment that looks like a key or a secret topic: long, letters and digits mixed. */
const TOKEN = /^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9_\-.~=+]{24,}$/;

/**
 * host[:port]/path?keys, from a URL: no user info, secrets (e.g. the ntfy topic) and token-like
 * path segments as "***", query values masked except a few harmless ones.
 */
function target(url, ...secrets) {
  if (url == null || url === '') return '';
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return '(unreadable address)';
  }
  if (!u.hostname) return '(unreadable address)';
  let s = u.hostname + (u.port ? ':' + u.port : '');
  const path = u.pathname || '';
  for (const seg of path.split('/')) {
    if (!seg) continue;
    s += '/' + (secret(seg, secrets) ? '***' : seg);
  }
  if (path.endsWith('/') && path.length > 1) s += '/';
  const query = u.search ? u.search.substring(1) : '';
  if (query) {
    const parts = [];
    for (const p of query.split('&')) {
      const eq = p.indexOf('=');
      const key = eq < 0 ? p : p.substring(0, eq);
      if (!key) continue;
      if (eq < 0) parts.push(key);
      else parts.push(key + '=' + (PLAIN_QUERY.has(key) && !secret(p.substring(eq + 1), secrets) ? p.substring(eq + 1) : '***'));
    }
    if (parts.length) s += '?' + parts.join('&');
  }
  return s;
}

function secret(segment, secrets) {
  for (const x of secrets) if (x && segment.includes(x)) return true;
  return TOKEN.test(segment);
}

const REQUEST = /\[request: ([A-Za-z0-9_-]{1,40})\]/;

/** The request ID in a message to the chief ("[request: abc123]"), "" without one. */
function requestIn(text) {
  if (text == null) return '';
  const m = REQUEST.exec(String(text));
  return m ? m[1] : '';
}

// ------------------------------------------------------------------ failures

const TLS_CERT = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)/;

/**
 * The kind of failure, from the error or one it wraps (cause, or an AggregateError's errors): "DNS
 * failure", "connect timeout", "read timeout", "TLS error", "connection reset" and so on; never
 * the message's text, which may hold an answer or an address. Unknown ones by name, as
 * "app error (Name)".
 */
function classify(ex) {
  const seen = new Set();
  const queue = [ex];
  while (queue.length) {
    const e = queue.shift();
    if (e == null || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const k = kind(e);
    if (k) return k;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors);
  }
  if (ex == null) return '';
  // fetch's own failure with nothing more to say.
  if (ex instanceof TypeError && ex.message === 'fetch failed') return 'network error';
  return 'app error (' + ((ex && ex.name) || (ex && ex.constructor && ex.constructor.name) || typeof ex) + ')';
}

function kind(e) {
  const code = String(e.code || '');
  const m = String(e.message || '').toLowerCase();
  if (e.name === 'TimeoutError') return 'timeout';
  if (e.name === 'AbortError') return 'cancelled';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_FAIL') return 'DNS failure';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'connect timeout';
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'read timeout';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code === 'EPIPE') return 'broken pipe';
  if (code === 'ECONNABORTED') return 'connection aborted';
  if (code === 'ENETUNREACH' || code === 'ENETDOWN') return 'network unreachable';
  if (code === 'EHOSTUNREACH' || code === 'EHOSTDOWN') return 'no route to host';
  if (TLS_CERT.test(code)) return 'TLS certificate error';
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || /^ERR_.*SSL/.test(code)) return 'TLS error';
  if (code === 'UND_ERR_SOCKET' || m === 'other side closed') return 'connection closed early';
  if (code === 'UND_ERR_CLOSED' || code === 'UND_ERR_DESTROYED') return 'closed by the app';
  // ws: a handshake that didn't finish in time.
  if (m === 'opening handshake has timed out') return 'connect timeout';
  return '';
}

// ------------------------------------------------------------------ the file

function append(l) {
  const f = state.file;
  if (!f) return;
  try {
    fs.appendFileSync(f, l + '\n');
    if (fs.statSync(f).size > TRIM_BYTES || ++state.appended % TRIM_EVERY === 0) trim(f);
  } catch {
    /* The log is a help, not a must. */
  }
}

/** Keeps the last KEEP lines of the last KEEP_MS: written to a temporary file that replaces the log. */
function trim(f) {
  const kept = bounded(readLines(f), state.clock());
  const temp = f + '.tmp';
  fs.writeFileSync(temp, kept.length ? kept.join('\n') + '\n' : '');
  fs.renameSync(temp, f);
}

function readLines(f) {
  const text = fs.readFileSync(f, 'utf8');
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The lines within the bounds at now: at most KEEP, none older than KEEP_MS (or unreadable). */
function bounded(lines, now) {
  const out = lines.filter((l) => {
    const t = time(l);
    return t >= 0 && now - t <= KEEP_MS;
  });
  return out.length <= KEEP ? out : out.slice(out.length - KEEP);
}

/** The whole log within its bounds, oldest first; "" without one. */
function read() {
  const f = state.file;
  if (!f) return '';
  try {
    const kept = bounded(readLines(f), state.clock());
    return kept.length ? kept.join('\n') + '\n' : '';
  } catch {
    return '';
  }
}

/** The lines since the start of the last calls hands-free calls; the whole log if it holds fewer. */
function lastCalls(log, calls) {
  let from = log.length;
  for (let i = 0; i < calls; i++) {
    const at = from === 0 ? -1 : log.lastIndexOf(CALL_STARTED, from - 1);
    if (at < 0) return log;
    from = log.lastIndexOf('\n', at) + 1;
  }
  return log.substring(from);
}

/** What Copy network log copies: a header that says how to read the times, then the lines. */
function report(app, log) {
  const now = state.clock();
  const offset = stamp(now).slice(-6);
  const lines = log ? log.split('\n').filter((l) => l !== '').length : 0;
  return (
    'Network log · ' + app + ' · copied ' + stamp(now) + ' · ' + lines + (lines === 1 ? ' entry' : ' entries') +
    '\nTimes: local (' + state.zone() + ', UTC' + offset + '), when each request started; then what, request, target, result, duration, retry, sizes, network.\n' +
    (log ? log : '(no entries yet)\n')
  );
}

module.exports = {
  KEEP,
  KEEP_MS,
  TRIM_BYTES,
  TRIM_EVERY,
  SEP,
  CALL_STARTED,
  init,
  configure,
  file,
  request,
  begin,
  Call,
  result,
  statusName,
  event,
  callStarted,
  networkChanged,
  stamp,
  time,
  line,
  size,
  target,
  requestIn,
  classify,
  append,
  bounded,
  read,
  lastCalls,
  report,
};
