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
      throw new IOException(ex.getMessage(), ex);
    }
  }

  /** OpenRouter's model catalog (GET /models), for the Refine model picker. */
  static JSONObject models() throws Exception {
    try {
      return send("GET", base() + "/models", null, "", 20000, 60000);
    } catch (Busy ex) {
      throw new IOException(ex.getMessage(), ex);
    }
  }

  // ------------------------------------------------------------------ calls

  Result transcribe(byte[] wav, String model, List<String> words) throws Exception {
    return transcribe(wav, model, words, new Control(RETRY_BUDGET_MS));
  }

  /** The same, tried again within control's budget, and stopped by its Cancel. */
  Result transcribe(byte[] wav, String model, List<String> words, Control control) throws Exception {
    JSONObject r =
        call(
            "/audio/transcriptions",
            transcriptionBody(model, Base64.getEncoder().encodeToString(wav), words),
            control);
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
      throw new IOException(ex.getMessage(), ex);
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
    return call(path, body, new Control(RETRY_BUDGET_MS));
  }

  private JSONObject call(String path, JSONObject body, Control control) throws Exception {
    String key = vault.get(KEY);
    if (key.isBlank()) throw new IOException(tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
    return post(base() + path, body, key, control);
  }

  /** A POST with call's retries, for any address (tests use their own). */
  static JSONObject post(String url, JSONObject body, String key) throws Exception {
    return post(url, body, key, new Control(RETRY_BUDGET_MS));
  }

  /**
   * The POST, tried again while that can't cost twice, until control's budget is spent: a new try
   * only starts if it can within budgetMs of the first (the one under way may finish). Cancel stops
   * it at once, also mid-upload.
   */
  static JSONObject post(String url, JSONObject body, String key, Control control) throws Exception {
    long first = System.nanoTime();
    boolean fresh = false;
    int waited = 0;
    for (int attempt = 0; ; attempt++) {
      if (control.cancelled()) throw new Cancelled(null);
      IOException last;
      long wait;
      String why;
      try {
        return send("POST", url, body, key, 20000, 120000, attempt, control);
      } catch (Unauthorized ex) {
        throw new IOException(tr("Your OpenRouter key isn't valid anymore. Change it in Dictate & Delegate's Settings."), ex);
      } catch (Busy ex) {
        // Some hosts answer 429 or 5xx in bursts; the same request usually passes a moment later.
        // A transcription tries again itself (busyTries 0), so it can switch to another model.
        if (attempt >= control.busyTries) throw ex;
        last = ex;
        wait = Math.max(1500L * (attempt + 1), Math.min(ex.retryAfterMs, 30_000));
        why = ex.shortWhy();
      } catch (Cancelled ex) {
        throw ex;
      } catch (IOException ex) {
        if (control.cancelled()) throw new Cancelled(ex);
        // No connection yet (a tunnel, a network switch), or one that broke off before OpenRouter
        // could have the whole request (Dropped), so nothing ran or was charged. A dropped one is
        // often a kept-alive connection the network forgot while idle, so the first new try goes
        // at once (on a new connection); then a little later each time.
        boolean dropped = ex instanceof Dropped;
        if (!dropped && !unreached(ex)) throw ex;
        last = ex;
        if (dropped && !fresh) {
          fresh = true;
          wait = 0;
        } else if (waited >= RETRY_WAITS_MS.length) throw ex;
        else wait = RETRY_WAITS_MS[waited++];
        why = dropped ? tr("the connection was lost") : tr("no connection");
      }
      long spent = (System.nanoTime() - first) / 1_000_000;
      if (spent + wait > control.budgetMs) throw last;
      control.retrying(attempt + 1, wait, why);
      control.pause(wait);
    }
  }

  /** The waits before each new try when OpenRouter couldn't be reached or the upload broke off. */
  static volatile long[] RETRY_WAITS_MS = {2_000, 5_000, 10_000, 20_000, 30_000};

  /** How long a recording's transcription keeps trying by itself before it's kept as failed. */
  static volatile long RETRY_BUDGET_MS = 90_000;

  /**
   * How soon after a small request was handed over (on a kept-alive connection) a broken
   * connection still counts as Dropped: a network that forgot the connection answers its first
   * bytes with a reset within a round trip. Later, the model may be working already and a new try
   * could be charged twice. Uploads have connections of their own: for them only a break while
   * writing counts.
   */
  static volatile long DROP_MS = 1_000;

  /**
   * The socket's send buffer for OpenRouter. Android grows it to megabytes, so a whole recording
   * was "written" at once while it was in fact still going out, and a reset during the upload
   * looked like one after it. With a small buffer the write lasts as long as the upload, so a reset
   * while writing is one OpenRouter can't have acted on yet.
   */
  static final int SEND_BUFFER = 64 * 1024;

  /** The upload is written in pieces of this size, each one counting as progress. */
  static final int PIECE = 16 * 1024;

  /**
   * An upload (or connecting for it) that makes no progress this long is given up and tried again:
   * nothing else ends a write that hangs (Android's HTTP stack has no write timeout, so a dead
   * mobile connection held a recording for minutes).
   */
  static volatile long STALL_MS = 25_000;

  /** Tries again when an upload made no progress: a single thread for every upload's check. */
  private static final java.util.concurrent.ScheduledExecutorService WATCH =
      java.util.concurrent.Executors.newSingleThreadScheduledExecutor(
          r -> {
            Thread t = new Thread(r, "openrouter-watch");
            t.setDaemon(true);
            return t;
          });

  /** What one call can be told from outside, and tells: Cancel, and the next try coming. */
  static final class Control {
    final long budgetMs;
    /** How often an answer of "busy" (429, 5xx) is tried again here; 0: the caller does it. */
    volatile int busyTries = 2;
    private volatile boolean cancelled, awaiting;
    private volatile Runnable abort;
    private volatile Retrying listener;

    Control(long budgetMs) {
      this.budgetMs = budgetMs;
    }

    Control onRetry(Retrying l) {
      listener = l;
      return this;
    }

    /**
     * Stop trying: a wait ends and no new try starts; an upload under way is broken off. Once the
     * whole request is out, its answer is still taken: OpenRouter may be working on it already and
     * charge for it, so throwing it away would only make a retry pay twice.
     */
    void cancel() {
      stop(false);
    }

    /** Stops the call at once, also while its answer is awaited (the note is gone). */
    void kill() {
      stop(true);
    }

    private void stop(boolean hard) {
      cancelled = true;
      Runnable a = abort;
      // Closing a connection can do network I/O: never on the caller's (often the main) thread.
      if (a != null && (hard || !awaiting))
        WATCH.execute(
            () -> {
              if (hard || !awaiting) a.run(); // the upload may have finished meanwhile
            });
      synchronized (this) {
        notifyAll();
      }
    }

    boolean cancelled() {
      return cancelled;
    }

    /** How to break off the request under way (null: none). */
    void using(Runnable a) {
      abort = a;
      awaiting = false;
      if (cancelled && a != null) WATCH.execute(a);
    }

    /** The request is out whole; from now on its answer is awaited. */
    void awaiting() {
      awaiting = true;
    }

    /** The request under way is out whole and its answer awaited. */
    boolean sent() {
      return awaiting;
    }

    void retrying(int attempt, long waitMs, String why) {
      Retrying l = listener;
      if (l != null) l.next(attempt, waitMs, why);
    }

    /** Waits ms, or until cancelled. */
    synchronized void pause(long ms) throws InterruptedException, Cancelled {
      long end = System.nanoTime() + ms * 1_000_000;
      for (long left = ms; !cancelled && left > 0; left = (end - System.nanoTime()) / 1_000_000) wait(left);
      if (cancelled) throw new Cancelled(null);
    }
  }

  /** Told before each new try: its number (1 = the second), how long until it, and why. */
  interface Retrying {
    void next(int attempt, long waitMs, String why);
  }

  /** Stopped with Cancel. */
  static final class Cancelled extends IOException {
    Cancelled(Throwable cause) {
      super(tr("Stopped. The recording is kept in your notes; retry it there."), cause);
    }
  }

  /**
   * The connection broke off (reset, broken pipe, closed, or an upload that stalled) before
   * OpenRouter could have the whole request, before any answer: it didn't get or start it.
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

  /**
   * Dropped: broken before any answer, while the request was still being written (sentAt 0: its
   * end wasn't handed over, so OpenRouter can't have all of it) or within DROP_MS after.
   */
  static boolean dropped(Throwable ex, int status, long sentAt, long now) {
    return status == 0 && broken(ex) && (sentAt == 0 || now - sentAt <= DROP_MS * 1_000_000);
  }

  /** The request never got to OpenRouter: no DNS, no connection, no route. */
  static boolean unreached(Throwable ex) {
    String kind = NetLog.classify(ex);
    return kind.equals("DNS failure") || kind.equals("connect timeout") || kind.equals("connection refused")
        || kind.equals("network unreachable") || kind.equals("no route to host") || kind.equals("connect failed");
  }

  /** HTTP 401, turned into a readable message by the callers. */
  private static final class Unauthorized extends IOException {}

  /**
   * The model's host is busy or rate-limited (HTTP 429) or had a problem (HTTP 5xx): nothing was
   * written down or charged, and the same request may pass a moment later or with another model.
   * Its message is plain words with what OpenRouter said (status, provider, its message).
   */
  static final class Busy extends IOException {
    final int status;
    final String detail;
    /** What the answer's Retry-After asked for, 0 without. */
    final long retryAfterMs;

    Busy(int status, String detail, long retryAfterMs) {
      super(
          status == 429
              ? tr("The model is busy or rate-limited (%1$s).", detail)
              : tr("The model provider had a problem (%1$s).", detail));
      this.status = status;
      this.detail = detail;
      this.retryAfterMs = retryAfterMs;
    }

    /** For the panel's "trying again" line. */
    String shortWhy() {
      return status == 429 ? tr("the model is busy (HTTP 429)") : tr("the model provider had a problem (HTTP %1$d)", status);
    }
  }

  /**
   * The tries for one part of a recording while the model answers busy: model, wait before it
   * (ms), model, wait, … With a fallback: twice the chosen model, twice the fallback, then each once
   * more after a longer wait (a Retry-After asking longer is honoured for the same model, up to a
   * minute). Without: the chosen model five times, further apart.
   */
  static String[] busyPlan(String model, String fallback) {
    if (fallback == null || fallback.isEmpty() || fallback.equals(model))
      return new String[] {model, "0", model, "4000", model, "10000", model, "20000", model, "30000"};
    return new String[] {model, "0", model, "4000", fallback, "0", fallback, "5000", model, "20000", fallback, "30000"};
  }

  /** Whether an answer with this status means: busy, try again (or another model). */
  static boolean busyStatus(int status) {
    // Not 504/524 (timeouts): the model may have run and charged, so they're never tried again.
    return status == 429 || status == 500 || status == 502 || status == 503 || status == 529;
  }

  /** A busy answer that says the request wasn't run, so nothing was charged. */
  static boolean notRun(int status) {
    return status == 429 || status == 503;
  }

  /**
   * What an error answer says, on one line: "HTTP 429 too many requests · Azure: Rate limit is
   * exceeded…". OpenRouter's error JSON has message and, from the provider, metadata.provider_name
   * and metadata.raw.
   */
  static String describe(int status, String body) {
    StringBuilder s = new StringBuilder("HTTP ").append(status).append(NetLog.statusName(status));
    JSONObject error = null;
    try {
      error = new JSONObject(body).optJSONObject("error");
    } catch (JSONException ignored) {
      /* Not JSON: the text itself. */
    }
    String message = error == null ? body.replaceAll("\\s+", " ").trim() : error.optString("message");
    JSONObject meta = error == null ? null : error.optJSONObject("metadata");
    String provider = meta == null ? "" : meta.optString("provider_name");
    Object raw = meta == null ? null : meta.opt("raw");
    String rawText = raw == null ? "" : raw.toString().replaceAll("\\s+", " ").trim();
    if (!provider.isEmpty()) s.append(" from ").append(provider);
    if (!message.isEmpty()) s.append(": ").append(shorten(message, 200));
    if (!rawText.isEmpty() && !rawText.equals(message)) s.append(" (").append(shorten(rawText, 300)).append(")");
    return s.toString();
  }

  private static String shorten(String s, int max) {
    return s.length() > max ? s.substring(0, max) + "…" : s;
  }

  /** Retry-After in ms (seconds or an HTTP date); 0 without one. */
  static long retryAfter(String value, long now) {
    if (value == null || value.isBlank()) return 0;
    try {
      return Math.max(0, Math.round(Double.parseDouble(value.trim()) * 1000));
    } catch (NumberFormatException ex) {
      try {
        return Math.max(0, java.time.ZonedDateTime.parse(value.trim(), java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - now);
      } catch (RuntimeException e) {
        return 0;
      }
    }
  }

  private static JSONObject send(
      String method, String url, JSONObject body, String key, int connectMs, int readMs)
      throws Exception {
    return send(method, url, body, key, connectMs, readMs, 0, new Control(0));
  }

  private static JSONObject send(
      String method, String url, JSONObject body, String key, int connectMs, int readMs, int retry, Control control)
      throws Exception {
    return NetLog.request(what(url, body), method, url, retry, net -> exchange(method, url, body, key, connectMs, readMs, net, control));
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

  /**
   * TLS sockets with a small send buffer (SEND_BUFFER), so writing lasts as long as the upload.
   * One per upload: the upload gets a connection of its own (never one the network may have
   * forgotten while it was idle), and close() breaks it off even in the middle of a write.
   */
  private static final class SmallSendBuffer extends javax.net.ssl.SSLSocketFactory {
    private final javax.net.ssl.SSLSocketFactory d = javax.net.ssl.HttpsURLConnection.getDefaultSSLSocketFactory();
    /** The plain sockets under the TLS ones: closing them ends a write without TLS I/O. */
    private final java.util.List<Socket> sockets = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final Control control;

    SmallSendBuffer(Control control) {
      this.control = control;
    }

    private static <S extends Socket> S small(S s) {
      try {
        s.setSendBufferSize(SEND_BUFFER);
      } catch (IOException ignored) {
        /* Then only the stall check and the time after writing tell. */
      }
      return s;
    }

    void close() {
      for (Socket s : sockets)
        try {
          s.close();
        } catch (IOException ignored) {
          /* Closed already. */
        }
    }

    @Override
    public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
      sockets.add(s);
      if (control.cancelled()) {
        s.close();
        throw new SocketException("Socket closed");
      }
      small(s);
      return small(d.createSocket(s, host, port, autoClose));
    }

    @Override
    public Socket createSocket(String host, int port) throws IOException {
      return small(d.createSocket(host, port));
    }

    @Override
    public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
      return small(d.createSocket(host, port, local, localPort));
    }

    @Override
    public Socket createSocket(InetAddress host, int port) throws IOException {
      return small(d.createSocket(host, port));
    }

    @Override
    public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException {
      return small(d.createSocket(host, port, local, localPort));
    }

    @Override
    public String[] getDefaultCipherSuites() {
      return d.getDefaultCipherSuites();
    }

    @Override
    public String[] getSupportedCipherSuites() {
      return d.getSupportedCipherSuites();
    }
  }

  private static JSONObject exchange(
      String method, String url, JSONObject body, String key, int connectMs, int readMs, NetLog.Call net, Control control)
      throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    byte[] payload = body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8);
    // An upload (a recording, a file) gets a connection of its own, see SmallSendBuffer; small
    // requests (Jev, a text) keep sharing kept-alive ones, which saves a round trip.
    boolean own = c instanceof javax.net.ssl.HttpsURLConnection && payload != null && payload.length > SEND_BUFFER;
    SmallSendBuffer sockets = own ? new SmallSendBuffer(control) : null;
    if (own) {
      ((javax.net.ssl.HttpsURLConnection) c).setSSLSocketFactory(sockets);
      c.setRequestProperty("Connection", "close");
    }
    Runnable abort =
        () -> {
          try {
            c.disconnect(); // Android's HTTP stack closes the socket, also mid-write
          } catch (RuntimeException ignored) {
            /* It's closing anyway. */
          }
          if (sockets != null) sockets.close();
        };
    control.using(abort);
    int status = 0;
    long sentAt = 0; // System.nanoTime() once the request is written
    long[] written = {0};
    long total = 0;
    boolean[] stalled = {false};
    boolean writing = false; // connected, the body going out: OpenRouter can't have all of it yet
    java.util.concurrent.ScheduledFuture<?> watch = null;
    try {
      c.setConnectTimeout(connectMs);
      c.setReadTimeout(readMs);
      c.setInstanceFollowRedirects(false);
      c.setRequestMethod(method);
      if (!key.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + key);
      c.setRequestProperty("X-Title", "Dictate & Delegate"); // OpenRouter's app attribution
      if (payload != null) {
        total = payload.length;
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setFixedLengthStreamingMode(payload.length);
        net.sent(payload.length);
        long[] progressAt = {System.nanoTime()};
        watch =
            WATCH.scheduleWithFixedDelay(
                () -> {
                  if (System.nanoTime() - progressAt[0] < STALL_MS * 1_000_000) return;
                  stalled[0] = true;
                  abort.run(); // the write that hangs fails now
                },
                Math.min(1000, STALL_MS),
                Math.min(1000, STALL_MS),
                java.util.concurrent.TimeUnit.MILLISECONDS);
        try (OutputStream out = c.getOutputStream()) {
          writing = true;
          for (int at = 0; at < payload.length; at += PIECE) {
            if (control.cancelled()) throw new Cancelled(null);
            int n = Math.min(PIECE, payload.length - at);
            out.write(payload, at, n);
            written[0] = at + n;
            progressAt[0] = System.nanoTime();
          }
          // The HTTP stack keeps the last bytes in its buffer: out to the socket while the
          // watchdog still looks, or a dead connection would hang right here.
          out.flush();
          progressAt[0] = System.nanoTime();
        }
        watch.cancel(false);
      }
      writing = false;
      control.awaiting(); // Stop trying from now on lets the answer come

      sentAt = System.nanoTime();
      status = c.getResponseCode();
      net.status(status);
      InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
      byte[] got = stream == null ? new byte[0] : stream.readNBytes(4_000_000);
      net.received(got.length);
      String text = new String(got, StandardCharsets.UTF_8);
      if (status >= 400) {
        // All of an error answer is kept in the network log: what it said and when to try again.
        net.body(text);
        for (String h : new String[] {"retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-generation-id", "cf-ray"})
          net.header(h, c.getHeaderField(h));
      }
      if (status == 401) throw new Unauthorized();
      if (busyStatus(status)) throw new Busy(status, describe(status, text), retryAfter(c.getHeaderField("retry-after"), System.currentTimeMillis()));
      JSONObject json;
      try {
        json = new JSONObject(text);
      } catch (JSONException ex) {
        json = new JSONObject();
      }
      // OpenRouter may answer 200 with an error object when the provider failed mid-way.
      JSONObject error = json.optJSONObject("error");
      if (status >= 200 && status < 300 && error == null) return json;
      if (error != null && status < 300) {
        // 200 with an error: the provider failed mid-way. Its own code says whether it's "busy".
        net.body(text);
        int code = error.optInt("code");
        if (busyStatus(code)) throw new Busy(code, describe(code, text) + " " + tr("(inside an HTTP %1$d answer)", status), 0);
      }
      // The real answer too, unless the words carry it already (a provider's details are added).
      String message = error == null ? "" : error.optString("message"), words = error(status, message), said = status >= 300 ? describe(status, text) : "";
      throw new IOException(words + (!said.isEmpty() && (message.isEmpty() || !words.contains(message) || said.contains(" from ")) ? " [" + said + "]" : ""));
    } catch (SocketTimeoutException ex) {
      if (control.cancelled()) throw new Cancelled(ex);
      if (NetLog.classify(ex).equals("connect timeout"))
        throw new IOException(
            tr("No connection to OpenRouter. Check your internet connection, then try again."), ex);
      if (sentAt == 0 && status == 0) {
        // Timed out connecting or writing: OpenRouter hasn't got the whole request.
        net.note("timed out while sending (" + NetLog.size(written[0]) + " of " + NetLog.size(total) + ")");
        throw new Dropped(ex);
      }
      throw new IOException(tr("The model took too long. The recording is kept; try again."), ex);
    } catch (UnknownHostException | ConnectException ex) {
      if (control.cancelled()) throw new Cancelled(ex);
      throw new IOException(
          tr("No connection to OpenRouter. Check your internet connection, then try again."), ex);
    } catch (IOException ex) {
      if (ex instanceof Unauthorized || ex instanceof Busy || ex.getClass() == IOException.class && status > 0) throw ex;
      if (control.cancelled()) {
        net.note("stopped (" + NetLog.size(written[0]) + " of " + NetLog.size(total) + " sent)");
        throw new Cancelled(ex);
      }
      long now = System.nanoTime();
      if (stalled[0] && sentAt == 0) {
        net.note("upload stalled " + STALL_MS / 1000 + " s (" + NetLog.size(written[0]) + " of " + NetLog.size(total) + " sent)");
        throw new Dropped(ex);
      }
      if (writing && sentAt == 0 && status == 0) {
        // Any failure while the body was going out: the request never arrived whole.
        net.note("broke off while sending (" + NetLog.size(written[0]) + " of " + NetLog.size(total) + " sent)");
        throw new Dropped(ex);
      }
      // On an upload's own connection a break after it was written can't be a connection the
      // network forgot while idle: OpenRouter may have it all, so it's never tried again.
      if ((own && sentAt != 0) || !dropped(ex, status, sentAt, now)) {
        if (status == 0 && sentAt != 0 && broken(ex))
          net.note("broke off " + (now - sentAt) / 1_000_000 + " ms after sending; not tried again, OpenRouter may have started");
        throw ex;
      }
      net.note(sentAt == 0
          ? "broke off while sending (" + NetLog.size(written[0]) + " of " + NetLog.size(total) + " sent)"
          : "broke off " + (now - sentAt) / 1_000_000 + " ms after sending");
      throw new Dropped(ex);
    } finally {
      if (watch != null) watch.cancel(false);
      control.using(null);
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
