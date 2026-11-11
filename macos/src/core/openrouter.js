'use strict';
// OpenRouter: speech, Jev's decisions and the text model, each called directly with the user's own
// key (kept in the vault). Every call reports what it cost (usage.cost); notes and Activity show
// that, and nothing when it's missing.

const { tr, sleep } = require('./util');
const netLog = require('./net-log');
const decimal = require('./decimal');

/** The vault entry that holds the key. */
const KEY = 'openrouterKey';

/** Word hints per transcription; the providers accept about this many. */
const MAX_WORDS = 100;

const DEFAULT_URL = 'https://openrouter.ai/api/v1';

/** The base URL: an option, else DD_OPENROUTER_URL (the fake in tests), else OpenRouter's. */
function base(baseUrl) {
  return baseUrl || process.env.DD_OPENROUTER_URL || DEFAULT_URL;
}

/** The decisions endpoint lives at /api/alpha, beside the /api/v1 base. */
function decisionsUrl(baseUrl) {
  return base(baseUrl).replace(/\/api\/v1\/?$/, '') + '/api/alpha/decisions';
}

/** A plain JSON object, or null (org.json's optJSONObject). */
function obj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function hasKey(vault) {
  try {
    const key = vault.get(KEY);
    return typeof key === 'string' && key.trim() !== '';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ errors

/** HTTP 401, turned into a readable message by the callers. */
class Unauthorized extends Error {}

/**
 * The model's host is busy or rate-limited (HTTP 429) or had a problem (5xx): nothing was written
 * down, and the same request may pass a moment later or with another model. Its message is plain
 * words with what OpenRouter said (status, provider, its message).
 */
class Busy extends Error {
  constructor(status, detail, retryAfterMs = 0) {
    super(
      status === 429
        ? tr('The model is busy or rate-limited (%1$s).', detail)
        : tr('The model provider had a problem (%1$s).', detail),
    );
    this.status = status;
    this.detail = detail;
    this.busy = true;
    /** Shown as it is (dictation's friendly()). */
    this.friendly = this.message;
    /** What the answer's Retry-After asked for, 0 without. */
    this.retryAfterMs = retryAfterMs;
  }

  /** For the panel's "trying again" line. */
  shortWhy() {
    return this.status === 429 ? tr('the model is busy (HTTP 429)') : tr('the model provider had a problem (HTTP %1$d)', this.status);
  }
}

/** Whether an answer with this status means: busy, try again (or another model). Not 504/524: the model may have run. */
function busyStatus(status) {
  return [429, 500, 502, 503, 529].includes(status);
}

/** A busy answer that says the request wasn't run, so nothing was charged. */
function notRun(status) {
  return status === 429 || status === 503;
}

const STATUS_NAMES = { 429: ' too many requests', 500: ' server error', 502: ' bad gateway', 503: ' unavailable', 504: ' gateway timeout', 400: ' bad request', 401: ' unauthorized', 402: ' payment required', 404: ' not found', 413: ' too large' };

const shorten = (s, max) => (s.length > max ? s.substring(0, max) + '…' : s);

/** What an error answer says, on one line: "HTTP 429 too many requests from Azure: … (raw)". */
function describe(status, body) {
  let s = 'HTTP ' + status + (STATUS_NAMES[status] || '');
  let error = null;
  try {
    error = obj(obj(JSON.parse(body)) && JSON.parse(body).error);
  } catch {
    error = null;
  }
  const message = error ? String(error.message == null ? '' : error.message) : String(body || '').replace(/\s+/g, ' ').trim();
  const meta = error ? obj(error.metadata) : null;
  const provider = meta && typeof meta.provider_name === 'string' ? meta.provider_name : '';
  const raw = meta && meta.raw != null ? (typeof meta.raw === 'string' ? meta.raw : JSON.stringify(meta.raw)).replace(/\s+/g, ' ').trim() : '';
  if (provider) s += ' from ' + provider;
  if (message) s += ': ' + shorten(message, 200);
  if (raw && raw !== message) s += ' (' + shorten(raw, 300) + ')';
  return s;
}

/** Retry-After in ms (seconds or an HTTP date); 0 without one. */
function retryAfter(value, now = Date.now()) {
  if (value == null || !String(value).trim()) return 0;
  const n = Number(String(value).trim());
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/**
 * The tries for one part of a recording while the model answers busy: [model, wait before (ms)]…
 * With a fallback: twice the chosen model, twice the fallback, then each once more after a longer
 * wait. Without: the chosen model five times, further apart (BusyPlan in OpenRouter.java).
 */
function busyPlan(model, fallback) {
  if (!fallback || fallback === model)
    return [[model, 0], [model, 4000], [model, 10000], [model, 20000], [model, 30000]];
  return [[model, 0], [model, 4000], [fallback, 0], [fallback, 5000], [model, 20000], [fallback, 30000]];
}
const noKey = () => tr("Add your OpenRouter key in Dictate & Delegate's Settings first.");
const badKey = () => tr("Your OpenRouter key isn't valid anymore. Change it in Dictate & Delegate's Settings.");

/** OpenRouter's own message is English and technical; Dictate & Delegate's users can read it. */
function error(status, message) {
  const detail = message.length > 300 ? message.substring(0, 300) + '…' : message;
  switch (status) {
    case 402:
      return tr('Your OpenRouter credits are used up. Add credits on openrouter.ai, then try again.');
    case 400:
    case 404:
    case 413:
    case 422:
      return detail.trim() === ''
        ? tr("OpenRouter couldn't run this request (HTTP %1$d).", status)
        : tr("OpenRouter couldn't run this request (HTTP %1$d): %2$s", status, detail);
    default:
      return tr('The model provider had a problem (HTTP %1$d). The recording is kept; try again.', status);
  }
}

function wrap(message, cause) {
  const e = new Error(message, { cause });
  return e;
}

// ------------------------------------------------------------------ transport

/**
 * One request. Java has a connect and a read timeout; fetch has one for the whole call, so the
 * longer (read) one is used.
 */
async function send(fetchImpl, method, url, body, key, timeoutMs, retry = 0) {
  const headers = { 'X-Title': 'Dictate & Delegate' }; // OpenRouter's app attribution
  if (key) headers.Authorization = 'Bearer ' + key;
  if (body) headers['Content-Type'] = 'application/json';
  let res, text;
  try {
    res = await netLog.request(what(url, body), method, url, async (net) => {
      const payload = body ? JSON.stringify(body) : undefined;
      if (payload) net.sent(Buffer.byteLength(payload, 'utf8'));
      const r = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      net.status(r.status);
      text = await r.text();
      net.received(Buffer.byteLength(text, 'utf8'));
      if (r.status >= 400 || /"error"/.test(text.slice(0, 200))) {
        // All of an error answer is kept in the network log: what it said and when to try again.
        if (r.status >= 400) net.body(text);
        for (const h of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-generation-id', 'cf-ray'])
          if (r.headers && typeof r.headers.get === 'function') net.header(h, r.headers.get(h));
      }
      return r;
    }, { retry });
  } catch (ex) {
    if (ex && (ex.name === 'TimeoutError' || ex.name === 'AbortError'))
      throw wrap(tr('The model took too long. The recording is kept; try again.'), ex);
    throw wrap(tr('No connection to OpenRouter. Check your internet connection, then try again.'), ex);
  }
  const status = res.status;
  if (status === 401) throw new Unauthorized();
  const after = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (busyStatus(status)) throw new Busy(status, describe(status, text), retryAfter(after));
  let json;
  try {
    json = obj(JSON.parse(text)) || {};
  } catch {
    json = {};
  }
  // OpenRouter may answer 200 with an error object when the provider failed mid-way.
  const err = obj(json.error);
  if (status >= 200 && status < 300 && !err) return json;
  // 200 with an error: the provider failed mid-way; its own code says whether it's "busy".
  if (err && status < 300 && busyStatus(Number(err.code))) throw new Busy(Number(err.code), describe(Number(err.code), text) + ' ' + tr('(inside an HTTP %1$d answer)', status), 0);
  const message = err && err.message !== undefined && err.message !== null ? String(err.message) : '';
  // The real answer too, unless the words carry it already (a provider's details are added).
  const words = error(status, message);
  const said = status >= 300 ? describe(status, text) : '';
  const e = new Error(words + (said && (!message || !words.includes(message) || / from /.test(said)) ? ' [' + said + ']' : ''));
  e.status = status;
  throw e;
}

/** What a request is for, in the network log: "OpenRouter transcribe <model>", "Jev <model>"… */
function what(url, body) {
  const model = body && typeof body.model === 'string' ? ' ' + body.model : '';
  const path = String(url);
  if (path.endsWith('/audio/transcriptions')) return 'OpenRouter transcribe' + model;
  if (path.endsWith('/chat/completions')) return 'OpenRouter chat' + model;
  if (path.includes('/decisions')) return 'Jev' + model;
  if (path.endsWith('/key')) return 'OpenRouter key check';
  if (path.endsWith('/models')) return 'OpenRouter models';
  return 'OpenRouter';
}

// ------------------------------------------------------------------ request bodies

/** OpenRouter's speech-to-text request, with the word hints in the model host's own format. */
function transcriptionBody(model, audio, words) {
  const body = { model, response_format: 'json', input_audio: { format: 'wav', data: audio } };
  const provider = providerOptions(model, words);
  if (provider) body.provider = provider;
  return body;
}

/**
 * Routing options that carry the word hints to the model's host; null without words or for a
 * model whose host ignores them. Profile.OFFERED lists the models where this demonstrably works.
 */
function providerOptions(model, words) {
  const { OFFERED } = require('./profile'); // lazily: profile.js needs text-model.js, which needs this
  const terms = [];
  for (const w of words || []) if (w.trim() !== '' && terms.length < MAX_WORDS) terms.push(w.trim());
  if (terms.length === 0 || !OFFERED.has(model)) return null;
  let options;
  if (model.startsWith('openai/')) {
    const openai = { prompt: terms.join(', ') };
    if (model === 'openai/gpt-transcribe') openai.keywords = terms;
    options = { openai };
  } else if (model.startsWith('microsoft/')) {
    // Azure forwards its own fields; MAI takes keyword biasing as phraseList.phrases.
    options = { azure: { phraseList: { phrases: terms } } };
  } else options = { assemblyai: { keyterms_prompt: terms } };
  return { options };
}

/**
 * A chat completion that reports its cost. fast: no thinking at all, for answers that must come
 * back quickly. Messages with files (PDFs) get OpenRouter's free text parser.
 */
function chatBody(model, messages, maxTokens, fast) {
  const body = { model, usage: { include: true }, max_tokens: maxTokens, messages };
  if (fast) body.reasoning = { enabled: false };
  if (hasFile(messages)) body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  return body;
}

function hasFile(messages) {
  for (const m of messages || []) {
    const parts = obj(m) && Array.isArray(m.content) ? m.content : null;
    for (const part of parts || []) if (obj(part) && part.type === 'file') return true;
  }
  return false;
}

/** usage.cost as a Number, or null when missing or unreadable: an unknown cost is never shown as free. */
function cost(response) {
  const usage = obj(response && response.usage);
  const c = usage ? usage.cost : undefined;
  if (typeof c !== 'number' && typeof c !== 'string') return null;
  const value = decimal.parse(c);
  if (!value || decimal.signum(value) < 0) return null;
  return decimal.toNumber(value);
}

// ------------------------------------------------------------------ the client

/**
 * The client: { vault, fetch, baseUrl, retryMs, sleep }. A call returns { text, cost } (cost null
 * when OpenRouter reported none).
 */
class OpenRouter {
  constructor({ vault, fetch: fetchImpl, baseUrl, retryMs = 1500, sleep: wait = sleep, noConnectionMs = NO_CONNECTION_MS } = {}) {
    this.vault = vault;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.baseUrl = baseUrl;
    this.retryMs = retryMs;
    this.sleep = wait;
    this.noConnectionMs = noConnectionMs;
  }

  base() {
    return base(this.baseUrl);
  }

  key() {
    const key = this.vault ? this.vault.get(KEY) : null;
    if (!key || key.trim() === '') throw new Error(noKey());
    return key;
  }

  /**
   * wav: a Buffer (or Uint8Array) holding a WAV file. busyTries: how often a busy answer is tried
   * again here (a dictation passes 0 and switches models itself, busyPlan).
   */
  async transcribe(wav, model, words = [], { busyTries = 2 } = {}) {
    const r = await this.call('/audio/transcriptions', transcriptionBody(model, Buffer.from(wav).toString('base64'), words), busyTries);
    if (typeof r.text !== 'string')
      throw new Error(tr('The speech model returned no transcript. The recording is kept; try again.'));
    return { text: r.text.trim(), cost: cost(r) };
  }

  /** A chat completion (body from chatBody); the answer's text, never empty. */
  async chat(body) {
    const r = await this.call('/chat/completions', body);
    const choices = Array.isArray(r.choices) ? r.choices : null;
    const message = !choices || choices.length === 0 ? null : obj(obj(choices[0]) && choices[0].message);
    const text = !message || typeof message.content !== 'string' ? '' : message.content.trim();
    // A reply of nothing is still a paid call (e.g. all tokens spent on reasoning).
    if (text === '') throw new Error(tr('The text model returned nothing. Try again.'));
    return { text, cost: cost(r) };
  }

  /**
   * Jev's decisions (POST /api/alpha/decisions, next to /api/v1): the whole answer, once. No
   * retries and a short timeout, because nothing waits for it.
   */
  async decide(body, timeoutMs) {
    const key = this.key();
    try {
      // Android gives Jev a connect and a read timeout of timeoutMs each; fetch has one for both.
      return await send(this.fetch, 'POST', decisionsUrl(this.baseUrl), body, key, timeoutMs * 2);
    } catch (ex) {
      if (ex instanceof Unauthorized) throw wrap(badKey(), ex);
      if (ex instanceof Busy) throw wrap(ex.message, ex);
      throw ex;
    }
  }

  async call(path, body, busyTries = 2) {
    const key = this.key();
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(this.fetch, 'POST', this.base() + path, body, key, 120000, attempt);
      } catch (ex) {
        if (ex instanceof Unauthorized) throw wrap(badKey(), ex);
        if (!(ex instanceof Busy)) {
          // No connection yet (a network switch): nothing reached OpenRouter, so nothing ran or was
          // charged. Tried again a little later, a few times.
          if (attempt >= this.noConnectionMs.length || !unreached(ex)) throw ex;
          await this.sleep(this.noConnectionMs[attempt]);
          continue;
        }
        // Some hosts answer 429 or 5xx in bursts; the same request usually passes a moment later.
        if (attempt >= busyTries) throw ex;
        await this.sleep(Math.max(this.retryMs * (attempt + 1), Math.min(ex.retryAfterMs || 0, 30_000)));
      }
    }
  }
}

/** The waits before each new try when OpenRouter couldn't be reached at all. */
const NO_CONNECTION_MS = [2_000, 5_000, 10_000];

/** The request never got to OpenRouter: no DNS, no connection, no route. */
function unreached(ex) {
  const k = netLog.classify(ex);
  return ['DNS failure', 'connect timeout', 'connection refused', 'network unreachable', 'no route to host'].includes(k);
}

/** Checks a key before it is saved (GET /key); throws with a readable message if it doesn't work. */
async function check(key, { fetch: fetchImpl, baseUrl } = {}) {
  try {
    await send(fetchImpl || globalThis.fetch, 'GET', base(baseUrl) + '/key', null, key.trim(), 120000);
  } catch (ex) {
    if (ex instanceof Unauthorized) throw wrap(tr("This key isn't valid. Check that you copied all of it."), ex);
    if (ex instanceof Busy) throw wrap(ex.message, ex);
    throw ex;
  }
}

/** OpenRouter's model catalog (GET /models), for the Refine model picker. */
async function models({ fetch: fetchImpl, baseUrl } = {}) {
  try {
    return await send(fetchImpl || globalThis.fetch, 'GET', base(baseUrl) + '/models', null, '', 60000);
  } catch (ex) {
    if (ex instanceof Busy) throw wrap(ex.message, ex);
    throw ex;
  }
}

module.exports = {
  OpenRouter,
  Busy,
  busyStatus,
  notRun,
  describe,
  retryAfter,
  busyPlan,
  KEY,
  MAX_WORDS,
  DEFAULT_URL,
  base,
  decisionsUrl,
  hasKey,
  check,
  models,
  transcriptionBody,
  providerOptions,
  chatBody,
  cost,
  error,
  unreached,
  NO_CONNECTION_MS,
};
