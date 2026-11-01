package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import java.io.*;
import java.math.BigDecimal;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import org.json.*;

/**
 * OpenRouter: speech, Jev's decisions and the text model, each called directly with the user's own key (kept encrypted in Vault). Every call
 * reports what it cost (usage.cost); notes and Activity show that, and nothing when it's missing.
 */
final class OpenRouter {
  /** The Vault entry that holds the key. */
  static final String KEY = "openrouterKey";

  /** Word hints per transcription; the providers accept about this many. */
  static final int MAX_WORDS = 100;

  /** What a call returned, and what OpenRouter charged for it; cost null when it reported none. */
  record Result(String text, BigDecimal cost) {}

  private final Vault vault;

  OpenRouter(Context context) {
    vault = new Vault(context.getApplicationContext());
  }

  static String base() {
    return BuildConfig.OPENROUTER_URL;
  }

  static boolean hasKey(Context context) {
    try {
      return !new Vault(context).get(KEY).isBlank();
    } catch (Exception ex) {
      return false;
    }
  }

  /** Checks a key before it is saved (GET /key); throws with a readable message if it doesn't work. */
  static void check(String key) throws Exception {
    try {
      send("GET", base() + "/key", null, key.trim(), 20000, 120000);
    } catch (Unauthorized ex) {
      throw new IOException(tr("This key isn't valid. Check that you copied all of it."), ex);
    } catch (Busy ex) {
      throw new IOException(busy(), ex);
    }
  }

  /** OpenRouter's model catalog (GET /models), for the Refine model picker. */
  static JSONObject models() throws Exception {
    try {
      return send("GET", base() + "/models", null, "", 20000, 60000);
    } catch (Busy ex) {
      throw new IOException(busy(), ex);
    }
  }

  // ------------------------------------------------------------------ calls

  Result transcribe(byte[] wav, String model, List<String> words) throws Exception {
    JSONObject r =
        call(
            "/audio/transcriptions",
            transcriptionBody(model, Base64.getEncoder().encodeToString(wav), words));
    if (!(r.opt("text") instanceof String text))
      throw new IOException(
          tr("The speech model returned no transcript. The recording is kept; try again."));
    return new Result(text.trim(), cost(r));
  }

  /** A chat completion (body from chatBody); the answer's text, never empty. */
  Result chat(JSONObject body) throws Exception {
    JSONObject r = call("/chat/completions", body);
    JSONArray choices = r.optJSONArray("choices");
    JSONObject message =
        choices == null || choices.length() == 0
            ? null
            : choices.getJSONObject(0).optJSONObject("message");
    String text =
        message == null || !(message.opt("content") instanceof String s) ? "" : s.trim();
    // A reply of nothing is still a paid call (e.g. all tokens spent on reasoning).
    if (text.isEmpty()) throw new IOException(tr("The text model returned nothing. Try again."));
    return new Result(text, cost(r));
  }

  /**
   * Jev's decisions (POST /api/alpha/decisions, next to /api/v1): the whole answer, once. No
   * retries and a short timeout, because nothing waits for it.
   */
  JSONObject decide(JSONObject body, int timeoutMs) throws Exception {
    String key = vault.get(KEY);
    if (key.isBlank()) throw new IOException(tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
    try {
      return send("POST", decisionsUrl(), body, key, timeoutMs, timeoutMs);
    } catch (Unauthorized ex) {
      throw new IOException(tr("Your OpenRouter key isn't valid anymore. Change it in Dictate & Delegate's Settings."), ex);
    } catch (Busy ex) {
      throw new IOException(busy(), ex);
    }
  }

  /** The decisions endpoint lives at /api/alpha, beside the /api/v1 base. */
  static String decisionsUrl() {
    return base().replaceFirst("/api/v1/?$", "") + "/api/alpha/decisions";
  }

  // ------------------------------------------------------------------ request bodies

  /** OpenRouter's speech-to-text request, with the word hints in the model host's own format. */
  static JSONObject transcriptionBody(String model, String audio, List<String> words)
      throws JSONException {
    JSONObject body =
        new JSONObject()
            .put("model", model)
            .put("response_format", "json")
            .put("input_audio", new JSONObject().put("format", "wav").put("data", audio));
    JSONObject provider = providerOptions(model, words);
    if (provider != null) body.put("provider", provider);
    return body;
  }

  /**
   * Routing options that carry the word hints to the model's host; null without words or for a
   * model whose host ignores them. Profile.OFFERED lists the models where this demonstrably works.
   */
  static JSONObject providerOptions(String model, List<String> words) throws JSONException {
    JSONArray terms = new JSONArray();
    for (String w : words) if (!w.isBlank() && terms.length() < MAX_WORDS) terms.put(w.trim());
    if (terms.length() == 0 || !Profile.OFFERED.contains(model)) return null;
    JSONObject options;
    if (model.startsWith("openai/")) {
      StringBuilder prompt = new StringBuilder();
      for (int i = 0; i < terms.length(); i++)
        prompt.append(i == 0 ? "" : ", ").append(terms.getString(i));
      JSONObject openai = new JSONObject().put("prompt", prompt.toString());
      if (model.equals("openai/gpt-transcribe")) openai.put("keywords", terms);
      options = new JSONObject().put("openai", openai);
    } else if (model.startsWith("microsoft/")) {
      // Azure forwards its own fields; MAI takes keyword biasing as phraseList.phrases.
      options =
          new JSONObject()
              .put("azure", new JSONObject().put("phraseList", new JSONObject().put("phrases", terms)));
    } else options = new JSONObject().put("assemblyai", new JSONObject().put("keyterms_prompt", terms));
    return new JSONObject().put("options", options);
  }

  /**
   * A chat completion that reports its cost. fast: no thinking at all, for answers that must come
   * back quickly (the request check). Messages with files (PDFs) get OpenRouter's free text parser.
   */
  static JSONObject chatBody(String model, JSONArray messages, int maxTokens, boolean fast)
      throws JSONException {
    JSONObject body =
        new JSONObject()
            .put("model", model)
            .put("usage", new JSONObject().put("include", true))
            .put("max_tokens", maxTokens)
            .put("messages", messages);
    if (fast) body.put("reasoning", new JSONObject().put("enabled", false));
    if (hasFile(messages))
      body.put(
          "plugins",
          new JSONArray()
              .put(
                  new JSONObject()
                      .put("id", "file-parser")
                      .put("pdf", new JSONObject().put("engine", "pdf-text"))));
    return body;
  }

  private static boolean hasFile(JSONArray messages) {
    for (int i = 0; i < messages.length(); i++) {
      JSONObject m = messages.optJSONObject(i);
      JSONArray parts = m == null ? null : m.optJSONArray("content");
      for (int j = 0; parts != null && j < parts.length(); j++) {
        JSONObject part = parts.optJSONObject(j);
        if (part != null && part.optString("type").equals("file")) return true;
      }
    }
    return false;
  }

  /** usage.cost, or null when missing or unreadable: an unknown cost is never shown as free. */
  static BigDecimal cost(JSONObject response) {
    JSONObject usage = response.optJSONObject("usage");
    Object cost = usage == null ? null : usage.opt("cost");
    if (!(cost instanceof Number) && !(cost instanceof String)) return null;
    try {
      BigDecimal value = new BigDecimal(cost.toString());
      return value.signum() < 0 ? null : value;
    } catch (NumberFormatException ex) {
      return null;
    }
  }

  // ------------------------------------------------------------------ transport

  private JSONObject call(String path, JSONObject body) throws Exception {
    String key = vault.get(KEY);
    if (key.isBlank()) throw new IOException(tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
    return post(base() + path, body, key);
  }

  /** A POST with call's retries, for any address (tests use their own). */
  static JSONObject post(String url, JSONObject body, String key) throws Exception {
    boolean fresh = false;
    int waited = 0;
    for (int attempt = 0; ; attempt++) {
      try {
        return send("POST", url, body, key, 20000, 120000, attempt);
      } catch (Unauthorized ex) {
        throw new IOException(tr("Your OpenRouter key isn't valid anymore. Change it in Dictate & Delegate's Settings."), ex);
      } catch (Busy ex) {
        // Some hosts answer 429 in bursts; the same request usually passes a moment later.
        if (attempt >= 2) throw new IOException(busy(), ex);
        Thread.sleep(1500L * (attempt + 1));
      } catch (IOException ex) {
        // No connection yet (a tunnel, a network switch), or one that broke off before any answer
        // (Dropped): OpenRouter never got the whole request, so nothing ran or was charged. A
        // dropped one is most often a kept-alive connection the network forgot while idle, so the
        // first new try goes at once (on a new connection); then a little later, a few times.
        boolean dropped = ex instanceof Dropped;
        if (!dropped && !unreached(ex)) throw ex;
        if (dropped && !fresh) {
          fresh = true;
          continue;
        }
        if (waited >= NO_CONNECTION_MS.length) throw ex;
        Thread.sleep(NO_CONNECTION_MS[waited++]);
      }
    }
  }

  /** The waits before each new try when OpenRouter couldn't be reached at all. */
  static volatile long[] NO_CONNECTION_MS = {2_000, 5_000, 10_000};

  /**
   * How soon after the request was written a broken connection still counts as Dropped. A
   * forgotten connection answers the first bytes with a reset within a round trip; later, the
   * model may be working already and a new try could be charged twice.
   */
  static volatile long DROP_MS = 2_000;

  /**
   * The connection broke off (reset, broken pipe, closed) while the request was going out or at
   * once after it, before any answer: OpenRouter didn't get or didn't start the request.
   */
  static final class Dropped extends IOException {
    Dropped(Throwable cause) {
      super(tr("The connection to OpenRouter was lost. Check your internet connection, then retry."), cause);
    }
  }

  /** A failure that is a broken connection, not a timeout or an answer. */
  static boolean broken(Throwable ex) {
    String kind = NetLog.classify(ex);
    return kind.equals("connection reset") || kind.equals("broken pipe") || kind.equals("connection aborted")
        || kind.equals("connection closed early");
  }

  /** Dropped: broken before any answer, while writing (sentAt 0) or within DROP_MS after it. */
  static boolean dropped(Throwable ex, int status, long sentAt, long now) {
    return status == 0 && broken(ex) && (sentAt == 0 || now - sentAt <= DROP_MS * 1_000_000);
  }

  /** The request never got to OpenRouter: no DNS, no connection, no route. */
  static boolean unreached(Throwable ex) {
    String kind = NetLog.classify(ex);
    return kind.equals("DNS failure") || kind.equals("connect timeout") || kind.equals("connection refused")
        || kind.equals("network unreachable") || kind.equals("no route to host") || kind.equals("connect failed");
  }

  /** HTTP 401 and 429, turned into readable messages by the callers. */
  private static final class Unauthorized extends IOException {}

  private static final class Busy extends IOException {}

  private static String busy() {
    return tr("The model is busy right now. Wait a moment, then try again.");
  }

  private static JSONObject send(
      String method, String url, JSONObject body, String key, int connectMs, int readMs)
      throws Exception {
    return send(method, url, body, key, connectMs, readMs, 0);
  }

  private static JSONObject send(
      String method, String url, JSONObject body, String key, int connectMs, int readMs, int retry)
      throws Exception {
    return NetLog.request(what(url, body), method, url, retry, net -> exchange(method, url, body, key, connectMs, readMs, net));
  }

  /** What a call is for, in the network log: "OpenRouter transcribe <model>", "Jev <model>"… */
  static String what(String url, JSONObject body) {
    String model = body == null ? "" : body.optString("model");
    String m = model.isEmpty() ? "" : " " + model;
    if (url.contains("/decisions")) return "Jev" + m;
    if (url.contains("/audio/transcriptions")) return "OpenRouter transcribe" + m;
    if (url.contains("/chat/completions")) return "OpenRouter chat" + m;
    if (url.endsWith("/key")) return "OpenRouter key check";
    if (url.endsWith("/models")) return "OpenRouter models";
    return "OpenRouter";
  }

  private static JSONObject exchange(
      String method, String url, JSONObject body, String key, int connectMs, int readMs, NetLog.Call net)
      throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    int status = 0;
    long sentAt = 0; // System.nanoTime() once the request is written
    try {
      c.setConnectTimeout(connectMs);
      c.setReadTimeout(readMs);
      c.setInstanceFollowRedirects(false);
      c.setRequestMethod(method);
      if (!key.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + key);
      c.setRequestProperty("X-Title", "Dictate & Delegate"); // OpenRouter's app attribution
      if (body != null) {
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setFixedLengthStreamingMode(payload.length);
        net.sent(payload.length);
        try (OutputStream out = c.getOutputStream()) {
          out.write(payload);
        }
      }
      sentAt = System.nanoTime();
      status = c.getResponseCode();
      net.status(status);
      InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
      byte[] got = stream == null ? new byte[0] : stream.readNBytes(4_000_000);
      net.received(got.length);
      String text = new String(got, StandardCharsets.UTF_8);
      if (status == 401) throw new Unauthorized();
      if (status == 429) throw new Busy();
      JSONObject json;
      try {
        json = new JSONObject(text);
      } catch (JSONException ex) {
        json = new JSONObject();
      }
      // OpenRouter may answer 200 with an error object when the provider failed mid-way.
      JSONObject error = json.optJSONObject("error");
      if (status >= 200 && status < 300 && error == null) return json;
      throw new IOException(error(status, error == null ? "" : error.optString("message")));
    } catch (SocketTimeoutException ex) {
      throw new IOException(tr("The model took too long. The recording is kept; try again."), ex);
    } catch (UnknownHostException | ConnectException ex) {
      throw new IOException(
          tr("No connection to OpenRouter. Check your internet connection, then try again."), ex);
    } catch (IOException ex) {
      long now = System.nanoTime();
      if (!dropped(ex, status, sentAt, now)) throw ex;
      net.note(sentAt == 0 ? "broke off while sending" : "broke off " + (now - sentAt) / 1_000_000 + " ms after sending");
      throw new Dropped(ex);
    } finally {
      c.disconnect();
    }
  }

  /** OpenRouter's own message is English and technical; Dictate & Delegate's users can read it. */
  static String error(int status, String message) {
    String detail = message.length() > 300 ? message.substring(0, 300) + "…" : message;
    return switch (status) {
      case 402 ->
          tr("Your OpenRouter credits are used up. Add credits on openrouter.ai, then try again.");
      case 400, 404, 413, 422 ->
          detail.isBlank()
              ? tr("OpenRouter couldn't run this request (HTTP %1$d).", status)
              : tr("OpenRouter couldn't run this request (HTTP %1$d): %2$s", status, detail);
      default ->
          tr(
              "The model provider had a problem (HTTP %1$d). The recording is kept; try again.",
              status);
    };
  }
}
