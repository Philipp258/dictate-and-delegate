'use strict';
// Signing in to bb Connect (https://<handle>.getbb.app/mcp) with OAuth 2.1: authorization code
// with PKCE (S256), no client secret. The client ID is the URL of our client metadata document
// (oauth/client.json on GitHub Pages); bb has no registration endpoint. The browser comes back to
// oauth/callback.html there, which opens talkrouter://oauth/callback; the Mac app registers that
// scheme too, so the same client document and redirect work unchanged. Tokens are kept in the
// vault and refreshed when they expire or bb answers 401.

const crypto = require('crypto');
const netLog = require('./net-log');
const { tr, SerialQueue } = require('./util');
const { networkKind } = require('./mcp');

const CLIENT_ID = 'https://philipp258.github.io/dictate-and-delegate/oauth/client.json';

/**
 * Before the rename to Dictate & Delegate (3.1.0) the app was Talk Router, with its client
 * document at the old address. Tokens bb issued then belong to that client ID, so they're
 * refreshed and revoked with it. (Only the phone can have such tokens; kept for the same code.)
 */
const LEGACY_CLIENT_ID = 'https://philipp258.github.io/talk-router/oauth/client.json';
const LEGACY_REDIRECT = 'https://philipp258.github.io/talk-router/oauth/callback.html';

/**
 * bb only accepts an https redirect next to the client ID, not an app scheme: a static page there
 * hands the code on to talkrouter://oauth/callback. PKCE keeps the code useless to anyone else.
 */
const REDIRECT = 'https://philipp258.github.io/dictate-and-delegate/oauth/callback.html';
const SCOPE = 'bb';

/** bb's authorization server, used when its metadata can't be read. */
const ISSUER = 'https://getbb.app';

/** Vault entries: the tokens, and the sign-in waiting for the browser to come back. */
const TOKENS = 'bbAuth';
const PENDING = 'bbPending';

const DEFAULT_ENDPOINTS = {
  issuer: ISSUER,
  authorize: ISSUER + '/oauth/authorize',
  token: ISSUER + '/oauth/token',
  revoke: ISSUER + '/oauth/revoke',
};

// ------------------------------------------------------------------ pure parts (unit-tested)

/** "someone", "someone.getbb.app" or a link into it → "someone"; "" if not a handle. */
function handle(input) {
  let s = input == null ? '' : String(input).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.substring(0, slash);
  s = s.replace(/\.getbb\.app$/, '');
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : '';
}

function origin(h) {
  return 'https://' + h + '.getbb.app';
}

/** The MCP address bb Connect serves for a handle; also the OAuth resource. */
function resource(h) {
  return origin(h) + '/mcp';
}

function random(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** A PKCE code verifier: 32 random bytes, base64url without padding (43 characters). */
function verifier() {
  return random(32);
}

/** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))), without padding. */
function challenge(v) {
  return crypto.createHash('sha256').update(Buffer.from(v, 'ascii')).digest('base64url');
}

/** URLEncoder.encode, with %20 for spaces: what bb's form parser and the tests expect. */
function encode(s) {
  return encodeURIComponent(s).replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function form(values) {
  return Object.entries(values)
    .map(([k, v]) => encode(k) + '=' + encode(v == null ? '' : String(v)))
    .join('&');
}

function authorizeUrl(endpoint, res, chal, state) {
  const q = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    code_challenge: chal,
    code_challenge_method: 'S256',
    state,
    resource: res,
  };
  return endpoint + (endpoint.includes('?') ? '&' : '?') + form(q);
}

/**
 * The client ID saved tokens (or a pending sign-in) belong to: their own, or the old Talk Router
 * one for tokens saved before the field existed.
 */
function clientIdOf(saved) {
  return (saved && saved.clientId) || LEGACY_CLIENT_ID;
}

/** The refresh request for saved tokens, with the client ID they were issued to. */
function refreshBody(saved) {
  return {
    grant_type: 'refresh_token',
    refresh_token: saved.refresh || '',
    client_id: clientIdOf(saved),
    resource: saved.resource || '',
  };
}

// ------------------------------------------------------------------ errors

/** The saved sign-in is gone or no longer accepted. */
class SignedOut extends Error {
  constructor() {
    super(tr("You're signed out of bb. Sign in again in Settings → bb."));
    this.name = 'SignedOut';
  }
}

/** An HTTP error from bb's sign-in server, with its status. */
class OAuthHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OAuthHttpError';
    this.status = status;
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ sign-in

/**
 * Sign-in to bb Connect with the vault as Android keeps it. originFor is there for tests (a local
 * fake instead of https://<handle>.getbb.app).
 */
class BbOAuth {
  constructor({ vault, fetch: fetchImpl = globalThis.fetch, clock = () => Date.now(), originFor = origin } = {}) {
    this.vault = vault;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.originFor = originFor;
    // accessToken is synchronized on Android: one refresh at a time, so a rotated refresh token
    // isn't used twice.
    this.queue = new SerialQueue();
  }

  origin(h) {
    return this.originFor(h);
  }

  resource(h) {
    return this.origin(h) + '/mcp';
  }

  readSaved(name) {
    const s = this.vault.get(name);
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  /**
   * Finds bb's endpoints for a handle and remembers the sign-in (state and verifier in the vault);
   * returns the address to open in the browser. Throws with a readable message when there is no bb
   * at that handle.
   */
  async begin(h) {
    let meta;
    try {
      meta = await this.getJson(this.origin(h) + '/.well-known/oauth-protected-resource/mcp');
    } catch (ex) {
      if (!(ex instanceof OAuthHttpError)) throw ex;
      const e = new Error(
        ex.status === 404
          ? tr('bb Connect has no server called “%1$s”. Check the handle, and that bb Connect is on in bb.', h)
          : tr('%1$s.getbb.app answered with HTTP %2$d. Try again in a moment.', h, ex.status),
      );
      e.cause = ex;
      throw e;
    }
    const res = meta.resource || this.resource(h);
    const servers = Array.isArray(meta.authorization_servers) ? meta.authorization_servers : [];
    const issuer = servers.length ? String(servers[0]) : ISSUER;
    const endpoints = await this.discover(issuer);
    const v = verifier();
    const state = random(24);
    this.vault.set(
      PENDING,
      JSON.stringify({
        handle: h,
        resource: res,
        issuer: endpoints.issuer,
        token: endpoints.token,
        revoke: endpoints.revoke,
        verifier: v,
        clientId: CLIENT_ID,
        redirect: REDIRECT,
        state,
        started: this.clock(),
      }),
    );
    return authorizeUrl(endpoints.authorize, res, challenge(v), state);
  }

  /** The authorization server's metadata (RFC 8414); bb's known endpoints if it can't be read. */
  async discover(issuer) {
    try {
      const m = await this.getJson(issuer.replace(/\/+$/, '') + '/.well-known/oauth-authorization-server');
      return {
        issuer: m.issuer || issuer,
        authorize: m.authorization_endpoint || DEFAULT_ENDPOINTS.authorize,
        token: m.token_endpoint || DEFAULT_ENDPOINTS.token,
        revoke: m.revocation_endpoint || DEFAULT_ENDPOINTS.revoke,
      };
    } catch {
      return issuer === ISSUER
        ? { ...DEFAULT_ENDPOINTS }
        : { issuer, authorize: issuer + '/oauth/authorize', token: issuer + '/oauth/token', revoke: issuer + '/oauth/revoke' };
    }
  }

  /**
   * The browser came back with talkrouter://oauth/callback?code=…&state=…&iss=… (or ?error=…).
   * query is that query as an object (or URLSearchParams). Checks it belongs to the sign-in we
   * started, exchanges the code and saves the tokens; returns the handle.
   */
  async complete(query) {
    const q = query instanceof URLSearchParams ? Object.fromEntries(query) : query || {};
    const p = this.readSaved(PENDING);
    if (!p) throw new Error(tr("This sign-in wasn't started here, or it already finished. Start it again."));
    if (q.error != null) {
      this.vault.remove(PENDING);
      const detail = q.error_description || '';
      throw new Error(
        q.error === 'access_denied'
          ? tr("bb didn't allow the sign-in.")
          : tr('bb refused the sign-in: %1$s', (q.error + ' ' + detail).trim()),
      );
    }
    if ((p.state || '') !== q.state) throw new Error(tr("This sign-in doesn't match the one started here. Start it again."));
    if (q.iss != null && q.iss !== (p.issuer || '')) {
      throw new Error(tr('The sign-in came back from an unexpected server (%1$s).', q.iss));
    }
    if (!q.code) throw new Error(tr('bb sent no sign-in code. Start it again.'));
    const tokens = await this.postForm(p.token || '', {
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: 'redirect' in p ? p.redirect || '' : LEGACY_REDIRECT,
      client_id: clientIdOf(p),
      code_verifier: p.verifier || '',
      resource: p.resource || '',
    });
    this.vault.remove(PENDING);
    this.save(p, tokens, null);
    return p.handle || '';
  }

  save(endpoints, tokens, oldRefresh) {
    const access = tokens.access_token || '';
    if (!access) throw new Error(tr("bb's sign-in answer had no token."));
    const expiresIn = Number(tokens.expires_in) || 0;
    this.vault.set(
      TOKENS,
      JSON.stringify({
        handle: endpoints.handle || '',
        resource: endpoints.resource || '',
        issuer: endpoints.issuer || '',
        token: endpoints.token || '',
        revoke: endpoints.revoke || '',
        clientId: clientIdOf(endpoints),
        access,
        refresh: tokens.refresh_token || oldRefresh || '',
        expires: expiresIn > 0 ? this.clock() + expiresIn * 1000 : 0,
      }),
    );
  }

  signedIn() {
    try {
      return !!this.vault.get(TOKENS);
    } catch {
      return false;
    }
  }

  /** The handle the saved tokens belong to, or "". */
  signedInHandle() {
    const t = this.readSaved(TOKENS);
    return (t && t.handle) || '';
  }

  /** An access token, refreshed first when it expires within a minute or when forced (after 401). */
  accessToken(forceRefresh = false) {
    return this.queue.run(() => this.accessTokenNow(forceRefresh));
  }

  async accessTokenNow(forceRefresh) {
    const saved = this.vault.get(TOKENS);
    if (!saved) throw new SignedOut();
    const t = parse(saved) || {};
    const expires = Number(t.expires) || 0;
    const stale = expires > 0 && expires - 60_000 < this.clock();
    if (!forceRefresh && !stale) return t.access || '';
    const refresh = t.refresh || '';
    if (!refresh) {
      this.vault.remove(TOKENS);
      throw new SignedOut();
    }
    let tokens;
    try {
      tokens = await this.postForm(t.token || '', refreshBody(t));
    } catch (ex) {
      if (ex instanceof OAuthHttpError && (ex.status === 400 || ex.status === 401)) {
        // The refresh token was revoked or expired: signed out for good.
        this.vault.remove(TOKENS);
        throw new SignedOut();
      }
      throw ex;
    }
    this.save(t, tokens, refresh);
    return tokens.access_token;
  }

  /** Revokes the tokens at bb (best effort) and forgets them. */
  async signOut() {
    await this.revoke(this.forget());
  }

  /** Forgets the tokens on this Mac right away; returns them for revoke(). */
  forget() {
    let saved;
    try {
      saved = this.vault.get(TOKENS) || '';
    } catch {
      saved = '';
    }
    this.vault.remove(TOKENS);
    this.vault.remove(PENDING);
    return saved;
  }

  /** Asks bb to revoke forgotten tokens (RFC 7009); failures don't matter, they're gone here. */
  async revoke(saved) {
    if (!saved) return;
    const t = parse(saved);
    if (!t || !t.revoke) return;
    for (const [token, hint] of [
      [t.refresh || '', 'refresh_token'],
      [t.access || '', 'access_token'],
    ]) {
      if (!token) continue;
      try {
        await this.postForm(t.revoke, { token, token_type_hint: hint, client_id: clientIdOf(t) });
      } catch {
        /* Forgotten here anyway. */
      }
    }
  }

  // ------------------------------------------------------------------ HTTP

  async getJson(url) {
    return json(await this.request('GET', url, null, null, 'bb sign-in setup'));
  }

  async postForm(url, values) {
    const what =
      values.grant_type === 'refresh_token' ? 'bb token refresh' : values.token_type_hint ? 'bb sign-out' : 'bb sign-in';
    return json(await this.request('POST', url, form(values), 'application/x-www-form-urlencoded', what));
  }

  /** A small HTTPS call; errors carry the server's OAuth error text when it sent one. */
  async request(method, url, body, type, what = 'bb sign-in') {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    let res, text;
    try {
      const headers = { Accept: 'application/json' };
      if (body != null) headers['Content-Type'] = type;
      res = await netLog.request(what, method, url, async (net) => {
        if (body != null) net.sent(Buffer.byteLength(body, 'utf8'));
        const r = await this.fetch(url, {
          method,
          headers,
          body: body == null ? undefined : body,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        net.status(r.status);
        text = (await r.text()).slice(0, 1_000_000);
        net.received(Buffer.byteLength(text, 'utf8'));
        return r;
      });
    } catch (ex) {
      const kind = networkKind(ex);
      const e = new Error(
        kind === 'timeout'
          ? tr("%1$s didn't answer in time. Try again.", host)
          : tr('No connection to %1$s. Check your internet connection.', host),
      );
      e.cause = ex;
      throw e;
    }
    const status = res.status;
    if (status >= 200 && status < 300) return text;
    let detail = text.trim();
    const e = parse(text);
    if (e && typeof e === 'object') detail = ((e.error || '') + ' ' + (e.error_description || '')).trim();
    if (detail.length > 200) detail = detail.substring(0, 200) + '…';
    throw new OAuthHttpError(
      status,
      !detail
        ? tr("bb's sign-in server answered with HTTP %1$d.", status)
        : tr("bb's sign-in server answered with HTTP %1$d: %2$s", status, detail),
    );
  }
}

function json(body) {
  const v = parse(body);
  if (!v || typeof v !== 'object') throw new Error(tr("bb's sign-in server sent something unexpected."));
  return v;
}

module.exports = {
  BbOAuth,
  CLIENT_ID,
  LEGACY_CLIENT_ID,
  LEGACY_REDIRECT,
  REDIRECT,
  SCOPE,
  ISSUER,
  TOKENS,
  PENDING,
  DEFAULT_ENDPOINTS,
  SignedOut,
  OAuthHttpError,
  handle,
  origin,
  resource,
  random,
  verifier,
  challenge,
  authorizeUrl,
  form,
  clientIdOf,
  refreshBody,
};
