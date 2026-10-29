package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import java.io.*;
import java.math.BigDecimal;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.*;

/**
 * Anthropic's Messages API, called directly with the user's own Anthropic key (Vault), for
 * Refine only. Plain HTTP, no SDK, like OpenRouter. Anthropic reports tokens, not a price, so the
 * cost is computed at list price and marked as approximate. When a call fails, TextModel sends
 * the same request through OpenRouter.
 */
final class Anthropic {
  /** The Vault entry that holds the key. */
  static final String KEY = "anthropicKey";

  static final String VERSION = "2023-06-01";

  /** A Claude model Refine can use on the user's key, with its list price in dollars per million tokens. */
  record Claude(String id, String name, BigDecimal input, BigDecimal output) {}

  /**
   * The current Claude models, Sonnet (the default) first. Anthropic's API reports no price, so
   * the cost comes from here (Haiku's price for prompts up to 100K tokens; Refine's are far shorter).
   */
  static final List<Claude> MODELS =
      List.of(
          new Claude("claude-sonnet-5-5", "Claude Sonnet 5.5", new BigDecimal("2"), new BigDecimal("10")),
          new Claude("claude-opus-5-5", "Claude Opus 5.5", new BigDecimal("4"), new BigDecimal("20")),
          new Claude("claude-haiku-5-5", "Claude Haiku 5.5", new BigDecimal("0.10"), new BigDecimal("0.50")),
          new Claude("claude-fable-5-1", "Claude Fable 5.1", new BigDecimal("10"), new BigDecimal("50")));

  /** One of MODELS by ID, or null. */
  static Claude claude(String id) {
    for (Claude c : MODELS) if (c.id().equals(id)) return c;
    return null;
  }

  /** Why a call failed, which decides whether the note warns about the key. */
  enum Problem {
    KEY,
    CREDITS,
    BUSY,
    OTHER
  }

  /** A failed call: a readable message, and the kind of problem. */
  static final class Failure extends IOException {
    final Problem problem;

    Failure(Problem problem, String message, Throwable cause) {
      super(message, cause);
      this.problem = problem;
    }
  }

  private final Vault vault;

  Anthropic(Context context) {
    vault = new Vault(context.getApplicationContext());
  }

  static String base() {
    return BuildConfig.ANTHROPIC_URL;
  }

  static boolean hasKey(Context context) {
    try {
      return !new Vault(context).get(KEY).isBlank();
    } catch (Exception ex) {
      return false;
    }
  }

  /** Anthropic's ID for one of its models on OpenRouter: anthropic/claude-sonnet-5.5 → claude-sonnet-5-5. */
  static String model(String openRouterModel) {
    return openRouterModel.replaceFirst("^anthropic/", "").replace('.', '-');
  }

  /** Checks a key before it is saved (GET /v1/models); throws with a readable message. */
  static void check(String key) throws Exception {
    send("GET", base() + "/v1/models", null, key.trim(), 20000, 30000);
  }

  // ------------------------------------------------------------------ the call

  /**
   * The Messages API request for Refine: the system prompt, and the user's message as text or as
   * parts converted from OpenRouter's (text, image_url data URLs, file data URLs). Low effort:
   * Refine is a rewrite, and quick. Sonnet 5.5 can turn thinking off (between_tools); the others
   * reject that and think adaptively.
   */
  static JSONObject body(String model, String system, Object user, int maxTokens) throws JSONException {
    Object content = user instanceof JSONArray parts ? parts(parts) : user;
    JSONObject body =
        new JSONObject()
            .put("model", model)
            .put("max_tokens", maxTokens)
            .put("system", system)
            .put("output_config", new JSONObject().put("effort", "low"))
            .put(
                "messages",
                new JSONArray().put(new JSONObject().put("role", "user").put("content", content)));
    if (model.equals("claude-sonnet-5-5")) body.put("thinking", new JSONObject().put("type", "between_tools"));
    return body;
  }

  /** OpenRouter's message parts as Anthropic content blocks; documents and images go first. */
  static JSONArray parts(JSONArray openRouter) throws JSONException {
    JSONArray media = new JSONArray(), text = new JSONArray();
    for (int i = 0; i < openRouter.length(); i++) {
      JSONObject p = openRouter.getJSONObject(i);
      switch (p.optString("type")) {
        case "image_url" -> {
          String[] data = dataUrl(p.getJSONObject("image_url").optString("url"));
          if (data != null) media.put(block("image", data));
        }
        case "file" -> {
          String[] data = dataUrl(p.getJSONObject("file").optString("file_data"));
          if (data != null) media.put(block("document", data));
        }
        default -> text.put(new JSONObject().put("type", "text").put("text", p.optString("text")));
      }
    }
    for (int i = 0; i < text.length(); i++) media.put(text.get(i));
    return media;
  }

  private static JSONObject block(String type, String[] data) throws JSONException {
    return new JSONObject()
        .put("type", type)
        .put(
            "source",
            new JSONObject().put("type", "base64").put("media_type", data[0]).put("data", data[1]));
  }

  /** data:<type>;base64,<data> → {type, data}; null for anything else. */
  static String[] dataUrl(String url) {
    int comma = url.indexOf(',');
    if (!url.startsWith("data:") || comma < 0 || !url.substring(0, comma).endsWith(";base64")) return null;
    return new String[] {url.substring(5, comma - 7), url.substring(comma + 1)};
  }

  /** The answer's text (thinking blocks skipped) and its cost at the model's list price. */
  static OpenRouter.Result parse(JSONObject response, String model) throws IOException {
    if ("refusal".equals(response.optString("stop_reason")))
      throw new Failure(Problem.OTHER, tr("Claude declined to refine this text."), null);
    StringBuilder text = new StringBuilder();
    JSONArray content = response.optJSONArray("content");
    for (int i = 0; content != null && i < content.length(); i++) {
      JSONObject b = content.optJSONObject(i);
      if (b != null && b.optString("type").equals("text")) text.append(b.optString("text"));
    }
    String t = text.toString().trim();
    if (t.isEmpty()) throw new Failure(Problem.OTHER, tr("The text model returned nothing. Try again."), null);
    return new OpenRouter.Result(t, cost(response, model));
  }

  /** usage at the model's list price; null when the usage or the price is missing. */
  static BigDecimal cost(JSONObject response, String model) {
    JSONObject usage = response.optJSONObject("usage");
    Claude price = claude(model);
    if (usage == null || !usage.has("input_tokens") || price == null) return null;
    long in =
        usage.optLong("input_tokens")
            + usage.optLong("cache_creation_input_tokens")
            + usage.optLong("cache_read_input_tokens");
    BigDecimal million = new BigDecimal(1_000_000);
    return price
        .input()
        .multiply(BigDecimal.valueOf(in))
        .add(price.output().multiply(BigDecimal.valueOf(usage.optLong("output_tokens"))))
        .divide(million);
  }

  /** A Messages API call, with two retries when Anthropic is busy (429, 529). */
  OpenRouter.Result messages(JSONObject body) throws Exception {
    String key = vault.get(KEY);
    if (key.isBlank()) throw new Failure(Problem.KEY, tr("No Anthropic key is set."), null);
    for (int attempt = 0; ; attempt++) {
      try {
        return parse(send("POST", base() + "/v1/messages", body, key, 20000, 120000, attempt), body.getString("model"));
      } catch (Failure f) {
        if (f.problem != Problem.BUSY || attempt >= 2) throw f;
        Thread.sleep(1500L * (attempt + 1));
      }
    }
  }

  // ------------------------------------------------------------------ transport

  private static JSONObject send(String method, String url, JSONObject body, String key, int connectMs, int readMs)
      throws IOException {
    return send(method, url, body, key, connectMs, readMs, 0);
  }

  private static JSONObject send(String method, String url, JSONObject body, String key, int connectMs, int readMs, int retry)
      throws IOException {
    String what = body == null ? "Anthropic key check" : "Anthropic " + body.optString("model");
    return NetLog.request(what, method, url, retry, net -> exchange(method, url, body, key, connectMs, readMs, net));
  }

  private static JSONObject exchange(String method, String url, JSONObject body, String key, int connectMs, int readMs, NetLog.Call net)
      throws IOException {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    try {
      c.setConnectTimeout(connectMs);
      c.setReadTimeout(readMs);
      c.setInstanceFollowRedirects(false);
      c.setRequestMethod(method);
      c.setRequestProperty("x-api-key", key);
      c.setRequestProperty("anthropic-version", VERSION);
      if (body != null) {
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("content-type", "application/json");
        c.setFixedLengthStreamingMode(payload.length);
        net.sent(payload.length);
        try (OutputStream out = c.getOutputStream()) {
          out.write(payload);
        }
      }
      int status = c.getResponseCode();
      net.status(status);
      InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
      byte[] got = stream == null ? new byte[0] : stream.readNBytes(4_000_000);
      net.received(got.length);
      String text = new String(got, StandardCharsets.UTF_8);
      JSONObject json;
      try {
        json = new JSONObject(text);
      } catch (JSONException ex) {
        json = new JSONObject();
      }
      if (status >= 200 && status < 300) return json;
      JSONObject error = json.optJSONObject("error");
      throw failure(status, error == null ? "" : error.optString("message"));
    } catch (SocketTimeoutException ex) {
      throw new Failure(Problem.OTHER, tr("Anthropic took too long."), ex);
    } catch (UnknownHostException | ConnectException ex) {
      throw new Failure(Problem.OTHER, tr("No connection to Anthropic."), ex);
    } finally {
      c.disconnect();
    }
  }

  /** Anthropic's error ({"type": "error", "error": {"type", "message"}}) as a readable failure. */
  static Failure failure(int status, String message) {
    String detail = message.length() > 300 ? message.substring(0, 300) + "…" : message;
    if (status == 401 || status == 403)
      return new Failure(Problem.KEY, tr("Your Anthropic key isn't valid. Check it in Settings → Models & providers → Anthropic key."), null);
    if (status == 400 && message.toLowerCase(java.util.Locale.ROOT).contains("credit balance"))
      return new Failure(Problem.CREDITS, tr("Your Anthropic credits are used up."), null);
    if (status == 429 || status == 529) return new Failure(Problem.BUSY, tr("Anthropic is busy right now."), null);
    if (status >= 500) return new Failure(Problem.OTHER, tr("Anthropic had a problem (HTTP %1$d).", status), null);
    return new Failure(
        Problem.OTHER,
        detail.isBlank()
            ? tr("Anthropic couldn't run this request (HTTP %1$d).", status)
            : tr("Anthropic couldn't run this request (HTTP %1$d): %2$s", status, detail),
        null);
  }
}
