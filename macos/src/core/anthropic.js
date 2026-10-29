'use strict';
// Anthropic's Messages API, called directly with the user's own Anthropic key (vault), for Refine
// only. Plain HTTP, no SDK, like OpenRouter. Anthropic reports tokens, not a price, so the cost is
// computed at list price and marked as approximate. When a call fails, TextModel sends the same
// request through OpenRouter.

const { tr, sleep } = require('./util');
const netLog = require('./net-log');
const decimal = require('./decimal');

/** The vault entry that holds the key. */
const KEY = 'anthropicKey';

const VERSION = '2023-06-01';

const DEFAULT_URL = 'https://api.anthropic.com';

/** The base URL: an option, else DD_ANTHROPIC_URL (the fake in tests), else Anthropic's. */
function base(baseUrl) {
  return baseUrl || process.env.DD_ANTHROPIC_URL || DEFAULT_URL;
}

/**
 * The current Claude models, Sonnet (the default) first, with their list prices in dollars per
 * million tokens (strings, kept exact). Anthropic's API reports no price, so the cost comes from
 * here (Haiku's price for prompts up to 100K tokens; Refine's are far shorter).
 */
const MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', input: '2', output: '10' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: '4', output: '20' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', input: '0.10', output: '0.50' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', input: '10', output: '50' },
];

/** One of MODELS by ID, or null. */
function claude(id) {
  return MODELS.find((c) => c.id === id) || null;
}

/** Why a call failed, which decides whether the note warns about the key. */
const Problem = Object.freeze({ KEY: 'KEY', CREDITS: 'CREDITS', BUSY: 'BUSY', OTHER: 'OTHER' });

/** A failed call: a readable message, and the kind of problem. */
class Failure extends Error {
  constructor(problem, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'Failure';
    this.problem = problem;
  }
}

function hasKey(vault) {
  try {
    const key = vault.get(KEY);
    return typeof key === 'string' && key.trim() !== '';
  } catch {
    return false;
  }
}

/** Anthropic's ID for one of its models on OpenRouter: anthropic/claude-sonnet-5.5 → claude-sonnet-5-5. */
function model(openRouterModel) {
  return openRouterModel.replace(/^anthropic\//, '').replace(/\./g, '-');
}

// ------------------------------------------------------------------ the call

const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * The Messages API request for Refine: the system prompt, and the user's message as text or as
 * parts converted from OpenRouter's (text, image_url data URLs, file data URLs). Low effort:
 * Refine is a rewrite, and quick. Sonnet 5.5 can turn thinking off (between_tools); the others
 * reject that and think adaptively.
 */
function body(modelId, system, user, maxTokens) {
  const content = Array.isArray(user) ? parts(user) : user;
  const b = {
    model: modelId,
    max_tokens: maxTokens,
    system,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content }],
  };
  if (modelId === 'claude-sonnet-5-5') b.thinking = { type: 'between_tools' };
  return b;
}

/** OpenRouter's message parts as Anthropic content blocks; documents and images go first. */
function parts(openRouter) {
  const media = [];
  const text = [];
  for (const p of openRouter) {
    switch (str(p.type)) {
      case 'image_url': {
        const data = dataUrl(str(obj(p.image_url) && p.image_url.url));
        if (data) media.push(block('image', data));
        break;
      }
      case 'file': {
        const data = dataUrl(str(obj(p.file) && p.file.file_data));
        if (data) media.push(block('document', data));
        break;
      }
      default:
        text.push({ type: 'text', text: str(p.text) });
    }
  }
  return media.concat(text);
}

function block(type, data) {
  return { type, source: { type: 'base64', media_type: data[0], data: data[1] } };
}

/** data:<type>;base64,<data> → [type, data]; null for anything else. */
function dataUrl(url) {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0 || !url.substring(0, comma).endsWith(';base64')) return null;
  return [url.substring(5, comma - 7), url.substring(comma + 1)];
}

/** The answer's text (thinking blocks skipped) and its cost at the model's list price: { text, cost }. */
function parse(response, modelId) {
  if (str(response.stop_reason) === 'refusal')
    throw new Failure(Problem.OTHER, tr('Claude declined to refine this text.'));
  let text = '';
  const content = Array.isArray(response.content) ? response.content : [];
  for (const b of content) if (obj(b) && b.type === 'text') text += str(b.text);
  const t = text.trim();
  if (t === '') throw new Failure(Problem.OTHER, tr('The text model returned nothing. Try again.'));
  return { text: t, cost: cost(response, modelId) };
}

/** org.json's optLong: a number (truncated) or a numeric string; else 0. */
function optLong(o, key) {
  const v = o[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
}

/** usage at the model's list price, as a Number; null when the usage or the price is missing. */
function cost(response, modelId) {
  const usage = obj(response && response.usage);
  const price = claude(modelId);
  if (!usage || !('input_tokens' in usage) || !price) return null;
  const tokensIn =
    optLong(usage, 'input_tokens') + optLong(usage, 'cache_creation_input_tokens') + optLong(usage, 'cache_read_input_tokens');
  const total = decimal.add(
    decimal.multiply(decimal.of(price.input), { u: tokensIn, s: 0 }),
    decimal.multiply(decimal.of(price.output), { u: optLong(usage, 'output_tokens'), s: 0 }),
  );
  return decimal.toNumber(decimal.shift(total, -6));
}

// ------------------------------------------------------------------ transport

async function send(fetchImpl, method, url, payload, key, timeoutMs, retry = 0) {
  const headers = { 'x-api-key': key, 'anthropic-version': VERSION };
  if (payload) headers['content-type'] = 'application/json';
  let res, text;
  const what = payload && typeof payload.model === 'string' ? 'Anthropic ' + payload.model : 'Anthropic key check';
  try {
    res = await netLog.request(what, method, url, async (net) => {
      const body = payload ? JSON.stringify(payload) : undefined;
      if (body) net.sent(Buffer.byteLength(body, 'utf8'));
      const r = await fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      net.status(r.status);
      text = await r.text();
      net.received(Buffer.byteLength(text, 'utf8'));
      return r;
    }, { retry });
  } catch (ex) {
    if (ex && (ex.name === 'TimeoutError' || ex.name === 'AbortError'))
      throw new Failure(Problem.OTHER, tr('Anthropic took too long.'), ex);
    throw new Failure(Problem.OTHER, tr('No connection to Anthropic.'), ex);
  }
  let json;
  try {
    json = obj(JSON.parse(text)) || {};
  } catch {
    json = {};
  }
  if (res.status >= 200 && res.status < 300) return json;
  const error = obj(json.error);
  throw failure(res.status, error ? str(error.message) : '');
}

/** Anthropic's error ({"type": "error", "error": {"type", "message"}}) as a readable failure. */
function failure(status, message) {
  const detail = message.length > 300 ? message.substring(0, 300) + '…' : message;
  if (status === 401 || status === 403)
    return new Failure(Problem.KEY, tr("Your Anthropic key isn't valid. Check it in Settings → Models & providers → Anthropic key."));
  if (status === 400 && message.toLowerCase().includes('credit balance'))
    return new Failure(Problem.CREDITS, tr('Your Anthropic credits are used up.'));
  if (status === 429 || status === 529) return new Failure(Problem.BUSY, tr('Anthropic is busy right now.'));
  if (status >= 500) return new Failure(Problem.OTHER, tr('Anthropic had a problem (HTTP %1$d).', status));
  return new Failure(
    Problem.OTHER,
    detail.trim() === ''
      ? tr("Anthropic couldn't run this request (HTTP %1$d).", status)
      : tr("Anthropic couldn't run this request (HTTP %1$d): %2$s", status, detail),
  );
}

/** The client: { vault, fetch, baseUrl, retryMs, sleep }. */
class Anthropic {
  constructor({ vault, fetch: fetchImpl, baseUrl, retryMs = 1500, sleep: wait = sleep } = {}) {
    this.vault = vault;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.baseUrl = baseUrl;
    this.retryMs = retryMs;
    this.sleep = wait;
  }

  /** A Messages API call, with two retries when Anthropic is busy (429, 529): { text, cost }. */
  async messages(request) {
    const key = this.vault ? this.vault.get(KEY) : null;
    if (!key || key.trim() === '') throw new Failure(Problem.KEY, tr('No Anthropic key is set.'));
    for (let attempt = 0; ; attempt++) {
      try {
        return parse(await send(this.fetch, 'POST', base(this.baseUrl) + '/v1/messages', request, key, 120000, attempt), request.model);
      } catch (f) {
        if (!(f instanceof Failure) || f.problem !== Problem.BUSY || attempt >= 2) throw f;
        await this.sleep(this.retryMs * (attempt + 1));
      }
    }
  }
}

/** Checks a key before it is saved (GET /v1/models); throws a Failure with a readable message. */
async function check(key, { fetch: fetchImpl, baseUrl } = {}) {
  await send(fetchImpl || globalThis.fetch, 'GET', base(baseUrl) + '/v1/models', null, key.trim(), 30000);
}

module.exports = {
  Anthropic,
  KEY,
  VERSION,
  DEFAULT_URL,
  MODELS,
  Problem,
  Failure,
  base,
  claude,
  hasKey,
  model,
  check,
  body,
  parts,
  dataUrl,
  parse,
  cost,
  failure,
};
