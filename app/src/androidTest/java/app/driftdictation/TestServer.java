package app.driftdictation;

import android.content.Context;
import java.io.*;
import java.math.BigDecimal;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/**
 * The fake OpenRouter (scripts/fakes/fake_openrouter.py; scripts/device-test.sh starts it and
 * forwards it with adb reverse). Tests queue the transcripts, Jev's answers and Refine's replies
 * they expect, and read back what the app sent.
 */
final class TestServer {
  /** What the fake reports per call as usage.cost; notes show exactly these. */
  static final BigDecimal SPEECH = new BigDecimal("0.001"),
      JEV = new BigDecimal("0.00002"),
      TEXT = new BigDecimal("0.0003");

  /** The fake accepts any key except "bad". */
  static final String KEY = "sk-or-v1-fake", BAD_KEY = "bad";

  /** The fake's control API lives next to /api/v1. */
  private static String root() {
    return BuildConfig.OPENROUTER_URL.replaceFirst("/api/v1/?$", "");
  }

  static void reset() throws Exception {
    post("/test/reset", new JSONObject());
  }

  /** Saves the fake key, as setup does after checking it. */
  static void useKey(Context context) throws Exception {
    new Vault(context).put(OpenRouter.KEY, KEY);
  }

  static void removeKey(Context context) {
    new Vault(context).remove(OpenRouter.KEY);
  }

  /** Queues transcripts; null queues an error that isn't tried again (HTTP 400). */
  static void transcripts(String... texts) throws Exception {
    post("/test/script", new JSONObject().put("transcribe", answers(texts)));
  }

  /** Queues one answer of Jev: the refine and chief probabilities and the template ("none"). */
  static void decide(double refine, double chief, String template) throws Exception {
    script("decide", new JSONObject().put("refine", refine).put("chief", chief).put("template", template));
  }

  /**
   * Queues Jev's hands-free answers, one per check at a pause: "over", "question", "request"
   * (sent), "end", "unfinished" or "more" (listens on). Without one the fake says "over".
   */
  static void turns(String... choices) throws Exception {
    for (String c : choices) script("decide", new JSONObject().put("turn", c));
  }

  /** Queues text-model replies; null queues an error that isn't tried again (HTTP 400). */
  static void replies(String... texts) throws Exception {
    post("/test/script", new JSONObject().put("text", answers(texts)));
  }

  /** Queues one error answer of the given kind ("transcribe", "decide", "text"): "credits" is a 402. */
  static void error(String kind, String error) throws Exception {
    script(kind, new JSONObject().put("error", error));
  }

  /** Queues one answer as the fake takes it, e.g. {"text": "…", "cost": null} for no usage.cost. */
  static void script(String kind, JSONObject item) throws Exception {
    post("/test/script", new JSONObject().put(kind, new JSONArray().put(item)));
  }

  /** The requests the fake received since the last reset, oldest first: {"kind", "body"}. */
  static JSONArray requests() throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(root() + "/test/requests").openConnection();
    try (InputStream in = c.getInputStream()) {
      return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8))
          .getJSONArray("requests");
    } finally {
      c.disconnect();
    }
  }

  // ------------------------------------------------------------------ the fake bb MCP server

  /** The fake bb (scripts/fakes/fake_bb_mcp.py) listens on the OpenRouter fake's port + 1. */
  static String bbRoot() {
    java.net.URI u = java.net.URI.create(root());
    return u.getScheme() + "://" + u.getHost() + ":" + (u.getPort() + 1);
  }

  /** The custom MCP address the app uses for the fake. */
  static String bbUrl() {
    return bbRoot() + "/mcp";
  }

  /** The chief id the fake hands out when a thread is spawned. */
  static final String CHIEF = "thr_fakechief";

  static void bbReset() throws Exception {
    postTo(bbRoot(), "/test/reset", new JSONObject());
  }

  /** Queues one failure for the next "spawn", "tell", "show" (or "any") call: "tool", "http503"… */
  static void bbFail(String kind, String error) throws Exception {
    postTo(bbRoot(), "/test/fail", new JSONObject().put("kind", kind).put("error", error));
  }

  /** Queues one failure for the next call of that kind for that thread only (a tell to the talker). */
  static void bbFail(String kind, String error, String thread) throws Exception {
    postTo(bbRoot(), "/test/fail", new JSONObject().put("kind", kind).put("error", error).put("thread", thread));
  }

  /** The fake's REST upload answers with this status (200 to take files). */
  static void bbUploadStatus(int status) throws Exception {
    postTo(bbRoot(), "/test/config", new JSONObject().put("uploadStatus", status));
  }

  /** Every upload the fake bb took: {"name", "mimeType", "size", "sha256", "via", "path"}. */
  static JSONArray bbUploads() throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(bbRoot() + "/test/uploads").openConnection();
    try (InputStream in = c.getInputStream()) {
      return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getJSONArray("uploads");
    } finally {
      c.disconnect();
    }
  }

  /** Each tell to the fake takes this long (0: at once). */
  static void bbTellDelay(int ms) throws Exception {
    postTo(bbRoot(), "/test/config", new JSONObject().put("tellDelayMs", ms));
  }

  /** The fake requires this bearer token from now on ("" turns that off). */
  static void bbToken(String token) throws Exception {
    postTo(bbRoot(), "/test/config", new JSONObject().put("token", token));
  }

  /** What the fake bb has installed: {"installed": {name: hash}, "files": {name: content}}. */
  static JSONObject bbSkills() throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(bbRoot() + "/test/skills").openConnection();
    try (InputStream in = c.getInputStream()) {
      return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
    } finally {
      c.disconnect();
    }
  }

  /** The installed hash of one fake bb skill, "" when missing or unreadable. */
  static String bbSkillsOr(String name) {
    try {
      return bbSkills().getJSONObject("installed").optString(name);
    } catch (Exception ex) {
      return "";
    }
  }

  /** Sets what the fake bb has installed ({name: hash}), and whether installing stalls. */
  static void bbSetSkills(JSONObject installed, boolean stall) throws Exception {
    postTo(bbRoot(), "/test/skills", new JSONObject().put("installed", installed).put("stall", stall));
  }

  /** The fake's install thread leaves out these skills (as if bb refused them). */
  static void bbSkipSkills(String... names) throws Exception {
    postTo(bbRoot(), "/test/skills", new JSONObject().put("skip", new JSONArray(java.util.List.of(names))));
  }

  /** Marks bb's skills as current for this app, so tests about other things don't install. */
  static void skillsCurrent(android.content.Context context) throws Exception {
    String summary = ChiefSkills.summary(ChiefSkills.filled(context, 0));
    context
        .getSharedPreferences("settings", 0)
        .edit()
        .putString(ChiefSkills.INSTALLED, summary)
        .putInt(ChiefSkills.CHECKED_VERSION, BuildConfig.VERSION_CODE)
        .putBoolean(ChiefSkills.CHIEF_TOLD, true)
        .commit();
  }

  /** MCP requests the fake received since the last reset: {"method", "tool", "code", "auth"}. */
  static JSONArray bbRequests() throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(bbRoot() + "/test/requests").openConnection();
    try (InputStream in = c.getInputStream()) {
      return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8))
          .getJSONArray("requests");
    } finally {
      c.disconnect();
    }
  }

  /** The snippets sent with the run tool, oldest first. */
  static java.util.List<String> bbSnippets() throws Exception {
    java.util.List<String> out = new java.util.ArrayList<>();
    JSONArray all = bbRequests();
    for (int i = 0; i < all.length(); i++)
      if (all.getJSONObject(i).optString("tool").equals("run"))
        out.add(all.getJSONObject(i).getString("code"));
    return out;
  }

  // ------------------------------------------------------------------ the fake ntfy

  /** The fake ntfy (scripts/fakes/fake_ntfy.py) listens on the OpenRouter fake's port + 2. */
  static String ntfyRoot() {
    java.net.URI u = java.net.URI.create(root());
    return u.getScheme() + "://" + u.getHost() + ":" + (u.getPort() + 2);
  }

  static void ntfyReset() throws Exception {
    postTo(ntfyRoot(), "/test/reset", new JSONObject());
  }

  /** Publishes as the chief would: text to paste, tagged with the request ID. */
  /** A spoken reply from the chief in hands-free mode, as the dictate-and-delegate skill posts it. */
  static void ntfySpeak(String topic, String request, String text) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(ntfyRoot() + "/" + topic).openConnection();
    try {
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Title", "Spoken reply");
      // Without a request (""): as the talker passes on the chief's results.
      c.setRequestProperty("Tags", ChiefText.SPEAK_TAG + (request.isEmpty() ? "" : "," + BbBridge.requestTag(request)));
      try (OutputStream out = c.getOutputStream()) {
        out.write(text.getBytes(StandardCharsets.UTF_8));
      }
      if (c.getResponseCode() >= 300) throw new IOException("ntfy publish → HTTP " + c.getResponseCode());
    } finally {
      c.disconnect();
    }
  }

  static void ntfyPaste(String topic, String request, String text) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(ntfyRoot() + "/" + topic).openConnection();
    try {
      byte[] payload = text.getBytes(StandardCharsets.UTF_8);
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Title", "Text to paste");
      c.setRequestProperty("Tags", BbBridge.PASTE_TAG + "," + BbBridge.requestTag(request));
      try (OutputStream out = c.getOutputStream()) {
        out.write(payload);
      }
      if (c.getResponseCode() >= 300) throw new IOException("ntfy publish → HTTP " + c.getResponseCode());
    } finally {
      c.disconnect();
    }
  }

  /** What the fake ntfy saw: publishes and subscriptions, oldest first. */
  static JSONArray ntfyRequests() throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(ntfyRoot() + "/test/requests").openConnection();
    try (InputStream in = c.getInputStream()) {
      return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8))
          .getJSONArray("requests");
    } finally {
      c.disconnect();
    }
  }

  private static JSONArray answers(String... texts) throws JSONException {
    JSONArray list = new JSONArray();
    for (String t : texts)
      // A failure that isn't tried again (400): a provider error (5xx) is "busy" since 3.8.0 and
      // would take the next queued answers on its retries.
      list.put(t == null ? new JSONObject().put("error", "invalid") : new JSONObject().put("text", t));
    return list;
  }

  private static void post(String path, JSONObject body) throws Exception {
    postTo(root(), path, body);
  }

  /** The fake streaming speech server (scripts/fakes/fake_streaming.py): its control API. */
  private static String liveRoot() {
    return BuildConfig.ASSEMBLYAI_URL.replaceFirst("^ws", "http").replaceFirst("/v3/ws/?$", "");
  }

  /** Queues what live transcription hears, a text per stretch of speech; null drops the connection then. */
  static void liveTexts(String... texts) throws Exception {
    JSONArray a = new JSONArray();
    for (String t : texts) a.put(t == null ? new JSONObject().put("drop", true) : t);
    postTo(liveRoot(), "/test/script", new JSONObject().put("texts", a));
  }

  static void liveReset() throws Exception {
    postTo(liveRoot(), "/test/reset", new JSONObject());
  }

  /** What the fake streaming server saw: connections ("open", with its path), "force", "final", "closed". */
  static JSONArray liveLog() throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(liveRoot() + "/test/log").openConnection();
    try (InputStream in = c.getInputStream()) {
      return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getJSONArray("log");
    } finally {
      c.disconnect();
    }
  }

  private static void postTo(String root, String path, JSONObject body) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(root + path).openConnection();
    try {
      byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      try (OutputStream out = c.getOutputStream()) {
        out.write(payload);
      }
      if (c.getResponseCode() >= 300)
        throw new IOException(path + " → HTTP " + c.getResponseCode() + " (is the fake running?)");
    } finally {
      c.disconnect();
    }
  }
}
