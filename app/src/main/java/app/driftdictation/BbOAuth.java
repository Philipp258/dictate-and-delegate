package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Signing in to bb Connect (https://<handle>.getbb.app/mcp) with OAuth 2.1: authorization code
 * with PKCE (S256), no client secret. The client ID is the URL of our client metadata document
 * (oauth/client.json, served as JSON from the gh-pages branch by GitHub Pages; bb rejects the
 * text/plain of raw.githubusercontent.com); bb has no registration endpoint. The browser comes back
 * to oauth/callback.html there, which opens talkrouter://oauth/callback (BbSignInActivity). Tokens are kept encrypted in Vault and
 * refreshed when they expire or bb answers 401.
 */
final class BbOAuth {
  static final String CLIENT_ID =
      "https://philipp258.github.io/dictate-and-delegate/oauth/client.json";

  /**
   * Before the rename to Dictate & Delegate (3.1.0) the app was Talk Router, with its client
   * document at the old address. Tokens bb issued then belong to that client ID, so they're
   * refreshed and revoked with it; the old document stays published for that.
   */
  static final String LEGACY_CLIENT_ID = "https://philipp258.github.io/talk-router/oauth/client.json",
      LEGACY_REDIRECT = "https://philipp258.github.io/talk-router/oauth/callback.html";
  /**
   * bb only accepts an https redirect next to the client ID, not an app scheme: a static page there
   * hands the code on to talkrouter://oauth/callback (BbSignInActivity). PKCE keeps the code useless
   * to anyone else.
   */
  static final String REDIRECT = "https://philipp258.github.io/dictate-and-delegate/oauth/callback.html",
      SCOPE = "bb";

  /** bb's authorization server, used when its metadata can't be read. */
  static final String ISSUER = "https://getbb.app";

  /** Vault entries: the tokens, and the sign-in waiting for the browser to come back. */
  static final String TOKENS = "bbAuth", PENDING = "bbPending";

  record Endpoints(String issuer, String authorize, String token, String revoke) {
    static final Endpoints DEFAULT =
        new Endpoints(
            ISSUER, ISSUER + "/oauth/authorize", ISSUER + "/oauth/token", ISSUER + "/oauth/revoke");
  }

  private BbOAuth() {}

  // ------------------------------------------------------------------ pure parts (unit-tested)

  /** "someone", "someone.getbb.app" or a link into it → "someone"; "" if not a handle. */
  static String handle(String input) {
    String s = input == null ? "" : input.trim().toLowerCase(Locale.ROOT);
    s = s.replaceFirst("^[a-z]+://", "");
    int slash = s.indexOf('/');
    if (slash >= 0) s = s.substring(0, slash);
    s = s.replaceFirst("\\.getbb\\.app$", "");
    return s.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?") ? s : "";
  }

  static String origin(String handle) {
    return "https://" + handle + ".getbb.app";
  }

  /** The MCP address bb Connect serves for a handle; also the OAuth resource. */
  static String resource(String handle) {
    return origin(handle) + "/mcp";
  }

  /** A PKCE code verifier: 32 random bytes, base64url without padding (43 characters). */
  static String verifier() {
    return random(32);
  }

  static String random(int bytes) {
    byte[] b = new byte[bytes];
    new SecureRandom().nextBytes(b);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  /** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))), without padding. */
  static String challenge(String verifier) {
    try {
      byte[] hash =
          MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
      return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
    } catch (Exception ex) {
      throw new IllegalStateException(ex);
    }
  }

  static String authorizeUrl(String endpoint, String resource, String challenge, String state) {
    Map<String, String> q = new LinkedHashMap<>();
    q.put("response_type", "code");
    q.put("client_id", CLIENT_ID);
    q.put("redirect_uri", REDIRECT);
    q.put("scope", SCOPE);
    q.put("code_challenge", challenge);
    q.put("code_challenge_method", "S256");
    q.put("state", state);
    q.put("resource", resource);
    return endpoint + (endpoint.contains("?") ? "&" : "?") + form(q);
  }

  static String form(Map<String, String> values) {
    StringBuilder s = new StringBuilder();
    for (Map.Entry<String, String> e : values.entrySet()) {
      if (s.length() > 0) s.append('&');
      s.append(encode(e.getKey())).append('=').append(encode(e.getValue()));
    }
    return s.toString();
  }

  private static String encode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
  }

  // ------------------------------------------------------------------ sign-in

  /**
   * Finds bb's endpoints for a handle and remembers the sign-in; returns the address to open in
   * the browser. Throws with a readable message when there is no bb at that handle.
   */
  static String begin(Context context, String handle) throws Exception {
    JSONObject meta;
    try {
      meta = getJson(origin(handle) + "/.well-known/oauth-protected-resource/mcp");
    } catch (HttpError ex) {
      throw new IOException(
          ex.status == 404
              ? tr("bb Connect has no server called “%1$s”. Check the handle, and that bb Connect is on in bb.", handle)
              : tr("%1$s.getbb.app answered with HTTP %2$d. Try again in a moment.", handle, ex.status),
          ex);
    }
    String resource = meta.optString("resource", resource(handle));
    JSONArray servers = meta.optJSONArray("authorization_servers");
    String issuer = servers == null || servers.length() == 0 ? ISSUER : servers.optString(0);
    Endpoints endpoints = discover(issuer);
    String verifier = verifier(), state = random(24);
    new Vault(context)
        .put(
            PENDING,
            new JSONObject()
                .put("handle", handle)
                .put("resource", resource)
                .put("issuer", endpoints.issuer())
                .put("token", endpoints.token())
                .put("revoke", endpoints.revoke())
                .put("verifier", verifier)
                .put("clientId", CLIENT_ID)
                .put("redirect", REDIRECT)
                .put("state", state)
                .put("started", System.currentTimeMillis())
                .toString());
    return authorizeUrl(endpoints.authorize(), resource, challenge(verifier), state);
  }

  /** The authorization server's metadata (RFC 8414); bb's known endpoints if it can't be read. */
  static Endpoints discover(String issuer) {
    try {
      JSONObject m = getJson(issuer.replaceAll("/+$", "") + "/.well-known/oauth-authorization-server");
      Endpoints d = Endpoints.DEFAULT;
      return new Endpoints(
          m.optString("issuer", issuer),
          m.optString("authorization_endpoint", d.authorize()),
          m.optString("token_endpoint", d.token()),
          m.optString("revocation_endpoint", d.revoke()));
    } catch (Exception ex) {
      return issuer.equals(ISSUER)
          ? Endpoints.DEFAULT
          : new Endpoints(issuer, issuer + "/oauth/authorize", issuer + "/oauth/token", issuer + "/oauth/revoke");
    }
  }

  /**
   * The browser came back with talkrouter://oauth/callback?code=…&state=…&iss=… (or ?error=…).
   * Checks it belongs to the sign-in we started, exchanges the code and saves the tokens; returns
   * the handle.
   */
  static String complete(Context context, Map<String, String> query) throws Exception {
    Vault vault = new Vault(context);
    String saved = vault.get(PENDING);
    if (saved.isEmpty())
      throw new IOException(tr("This sign-in wasn't started here, or it already finished. Start it again."));
    JSONObject p = new JSONObject(saved);
    String error = query.get("error");
    if (error != null) {
      vault.remove(PENDING);
      String detail = query.getOrDefault("error_description", "");
      throw new IOException(
          error.equals("access_denied")
              ? tr("bb didn't allow the sign-in.")
              : tr("bb refused the sign-in: %1$s", (error + " " + detail).trim()));
    }
    if (!p.optString("state").equals(query.get("state")))
      throw new IOException(tr("This sign-in doesn't match the one started here. Start it again."));
    String iss = query.get("iss");
    if (iss != null && !iss.equals(p.optString("issuer")))
      throw new IOException(tr("The sign-in came back from an unexpected server (%1$s).", iss));
    String code = query.get("code");
    if (code == null || code.isEmpty()) throw new IOException(tr("bb sent no sign-in code. Start it again."));
    Map<String, String> body = new LinkedHashMap<>();
    body.put("grant_type", "authorization_code");
    body.put("code", code);
    body.put("redirect_uri", p.has("redirect") ? p.optString("redirect") : LEGACY_REDIRECT);
    body.put("client_id", clientIdOf(p));
    body.put("code_verifier", p.optString("verifier"));
    body.put("resource", p.optString("resource"));
    JSONObject tokens = postForm(p.optString("token"), body);
    vault.remove(PENDING);
    save(vault, p, tokens, null);
    return p.optString("handle");
  }

  private static void save(Vault vault, JSONObject endpoints, JSONObject tokens, String oldRefresh)
      throws Exception {
    String access = tokens.optString("access_token");
    if (access.isEmpty()) throw new IOException(tr("bb's sign-in answer had no token."));
    long expiresIn = tokens.optLong("expires_in", 0);
    vault.put(
        TOKENS,
        new JSONObject()
            .put("handle", endpoints.optString("handle"))
            .put("resource", endpoints.optString("resource"))
            .put("issuer", endpoints.optString("issuer"))
            .put("token", endpoints.optString("token"))
            .put("revoke", endpoints.optString("revoke"))
            .put("clientId", clientIdOf(endpoints))
            .put("access", access)
            .put("refresh", tokens.optString("refresh_token", oldRefresh == null ? "" : oldRefresh))
            .put("expires", expiresIn > 0 ? System.currentTimeMillis() + expiresIn * 1000 : 0)
            .toString());
  }

  static boolean signedIn(Context context) {
    try {
      return !new Vault(context).get(TOKENS).isEmpty();
    } catch (Exception ex) {
      return false;
    }
  }

  /** The handle the saved tokens belong to, or "". */
  static String signedInHandle(Context context) {
    try {
      String s = new Vault(context).get(TOKENS);
      return s.isEmpty() ? "" : new JSONObject(s).optString("handle");
    } catch (Exception ex) {
      return "";
    }
  }

  /**
   * The client ID saved tokens (or a pending sign-in) belong to: their own, or the old Talk Router
   * one for tokens saved before the field existed.
   */
  static String clientIdOf(JSONObject saved) {
    String id = saved.optString("clientId");
    return id.isEmpty() ? LEGACY_CLIENT_ID : id;
  }

  /** The refresh request for saved tokens, with the client ID they were issued to. */
  static Map<String, String> refreshBody(JSONObject saved) {
    Map<String, String> body = new LinkedHashMap<>();
    body.put("grant_type", "refresh_token");
    body.put("refresh_token", saved.optString("refresh"));
    body.put("client_id", clientIdOf(saved));
    body.put("resource", saved.optString("resource"));
    return body;
  }

  /** An access token, refreshed first when it expires within a minute or when forced (after 401). */
  static synchronized String accessToken(Context context, boolean forceRefresh) throws Exception {
    Vault vault = new Vault(context);
    String saved = vault.get(TOKENS);
    if (saved.isEmpty()) throw new SignedOut();
    JSONObject t = new JSONObject(saved);
    long expires = t.optLong("expires");
    boolean stale = expires > 0 && expires - 60_000 < System.currentTimeMillis();
    if (!forceRefresh && !stale) return t.optString("access");
    String refresh = t.optString("refresh");
    if (refresh.isEmpty()) {
      vault.remove(TOKENS);
      throw new SignedOut();
    }
    Map<String, String> body = refreshBody(t);
    JSONObject tokens;
    try {
      tokens = postForm(t.optString("token"), body);
    } catch (HttpError ex) {
      if (ex.status == 400 || ex.status == 401) {
        // The refresh token was revoked or expired: signed out for good.
        vault.remove(TOKENS);
        throw new SignedOut();
      }
      throw ex;
    }
    save(vault, t, tokens, refresh);
    return tokens.optString("access_token");
  }

  /** Revokes the tokens at bb (best effort) and forgets them. Network: not on the main thread. */
  static void signOut(Context context) {
    revoke(forget(context));
  }

  /** Forgets the tokens on this phone right away; returns them for revoke(). */
  static String forget(Context context) {
    Vault vault = new Vault(context);
    String saved;
    try {
      saved = vault.get(TOKENS);
    } catch (Exception ex) {
      saved = "";
    }
    vault.remove(TOKENS);
    vault.remove(PENDING);
    return saved;
  }

  /** Asks bb to revoke forgotten tokens (RFC 7009); failures don't matter, they're gone here. */
  static void revoke(String saved) {
    if (saved == null || saved.isEmpty()) return;
    try {
      JSONObject t = new JSONObject(saved);
      String endpoint = t.optString("revoke");
      if (endpoint.isEmpty()) return;
      for (String[] token :
          new String[][] {{t.optString("refresh"), "refresh_token"}, {t.optString("access"), "access_token"}}) {
        if (token[0].isEmpty()) continue;
        Map<String, String> body = new LinkedHashMap<>();
        body.put("token", token[0]);
        body.put("token_type_hint", token[1]);
        body.put("client_id", clientIdOf(t));
        try {
          postForm(endpoint, body);
        } catch (Exception ignored) {
          /* Forgotten here anyway. */
        }
      }
    } catch (Exception ignored) {
      /* Nothing readable to revoke. */
    }
  }

  /** The saved sign-in is gone or no longer accepted. */
  static final class SignedOut extends IOException {
    SignedOut() {
      super(tr("You're signed out of bb. Sign in again in Settings → bb."));
    }
  }

  // ------------------------------------------------------------------ HTTP

  static final class HttpError extends IOException {
    final int status;

    HttpError(int status, String message) {
      super(message);
      this.status = status;
    }
  }

  static JSONObject getJson(String url) throws Exception {
    return json(request("GET", url, null, null));
  }

  static JSONObject postForm(String url, Map<String, String> values) throws Exception {
    return json(request("POST", url, form(values), "application/x-www-form-urlencoded"));
  }

  private static JSONObject json(String body) throws IOException {
    try {
      return new JSONObject(body);
    } catch (Exception ex) {
      throw new IOException(tr("bb's sign-in server sent something unexpected."), ex);
    }
  }

  /** A small HTTPS call; errors carry the server's OAuth error text when it sent one. */
  static String request(String method, String url, String body, String type) throws Exception {
    return NetLog.request(what(body), method, url, net -> exchange(method, url, body, type, net));
  }

  /** What a sign-in call is for, in the network log (from its form; never the form's values). */
  static String what(String form) {
    if (form == null) return "bb sign-in setup";
    if (form.contains("grant_type=refresh_token")) return "bb token refresh";
    if (form.contains("grant_type=authorization_code")) return "bb sign-in";
    if (form.contains("token_type_hint=")) return "bb sign-out";
    return "bb sign-in";
  }

  private static String exchange(String method, String url, String body, String type, NetLog.Call net) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    try {
      c.setConnectTimeout(15_000);
      c.setReadTimeout(30_000);
      c.setInstanceFollowRedirects(false);
      c.setRequestMethod(method);
      c.setRequestProperty("Accept", "application/json");
      if (body != null) {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", type);
        c.setFixedLengthStreamingMode(payload.length);
        net.sent(payload.length);
        try (OutputStream out = c.getOutputStream()) {
          out.write(payload);
        }
      }
      int status = c.getResponseCode();
      net.status(status);
      InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
      byte[] got = stream == null ? new byte[0] : stream.readNBytes(1_000_000);
      net.received(got.length);
      String text = new String(got, StandardCharsets.UTF_8);
      if (status >= 200 && status < 300) return text;
      String detail = text.trim();
      try {
        JSONObject e = new JSONObject(text);
        detail = (e.optString("error") + " " + e.optString("error_description")).trim();
      } catch (Exception ignored) {
        /* Plain text. */
      }
      if (detail.length() > 200) detail = detail.substring(0, 200) + "…";
      throw new HttpError(
          status,
          detail.isEmpty()
              ? tr("bb's sign-in server answered with HTTP %1$d.", status)
              : tr("bb's sign-in server answered with HTTP %1$d: %2$s", status, detail));
    } catch (java.net.UnknownHostException | java.net.ConnectException ex) {
      throw new IOException(tr("No connection to %1$s. Check your internet connection.", new URL(url).getHost()), ex);
    } catch (java.net.SocketTimeoutException ex) {
      throw new IOException(tr("%1$s didn't answer in time. Try again.", new URL(url).getHost()), ex);
    } finally {
      c.disconnect();
    }
  }
}
