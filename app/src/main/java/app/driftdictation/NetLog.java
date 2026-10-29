package app.driftdictation;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The network log (Settings → Copy network log): one line for every request the app makes, to
 * find out why something didn't arrive. Each line holds when the request started (local time with
 * milliseconds and the UTC offset, to match against bb's and ntfy's logs), what it was for, the
 * request ID where there is one, the method, host and path (secrets masked, no query values), the
 * HTTP status or the kind of failure, how long it took, the retry, the sizes and the network at
 * that moment. Never a token, key, cookie, message text or audio.
 *
 * <p>Lines are appended to a file, so the log survives restarts; it keeps the last KEEP lines
 * from the last KEEP_DAYS days. Without init (unit tests of other classes) nothing is written.
 */
final class NetLog {
  private NetLog() {}

  static final int KEEP = 1000;
  static final long KEEP_MS = 7L * 24 * 3600 * 1000;

  /** Past this size the file is trimmed at once, else every TRIM_EVERY lines. */
  static final long TRIM_BYTES = 400 * 1024;

  static final int TRIM_EVERY = 50;

  static final String SEP = " | ";

  private static final Object LOCK = new Object();
  private static volatile File file;
  private static volatile Supplier<String> network = () -> "";
  private static int appended;

  /** For tests: the wall clock and the time zone the lines are written in. */
  static volatile LongSupplier clock = System::currentTimeMillis;

  static volatile ZoneId zone = ZoneId.systemDefault();

  /** Where the log goes, and what describes the network at a moment ("wifi, v4+v6"). */
  static void init(File logFile, Supplier<String> net) {
    file = logFile;
    network = net == null ? () -> "" : net;
  }

  static File file() {
    return file;
  }

  // ------------------------------------------------------------------ requests

  /** Runs one request, logging it: its status (Call.status) or the failure it threw. */
  interface Request<T, E extends Exception> {
    T run(Call net) throws E;
  }

  static <T, E extends Exception> T request(String what, String method, String url, Request<T, E> r) throws E {
    return request(what, method, url, 0, r);
  }

  static <T, E extends Exception> T request(String what, String method, String url, int retry, Request<T, E> r) throws E {
    return request(begin(what, method, url).retry(retry), r);
  }

  /** The same for a call begun already (e.g. with secrets to mask in its address). */
  static <T, E extends Exception> T request(Call net, Request<T, E> r) throws E {
    try {
      return r.run(net);
    } catch (Throwable ex) {
      net.fail(ex);
      throw ex;
    } finally {
      net.end();
    }
  }

  static Call begin(String what, String method, String url, String... secrets) {
    return new Call(what, method, target(url, secrets));
  }

  /** One request: filled in as it goes, written once at end(). */
  static final class Call {
    final long started = clock.getAsLong();
    private final long startNanos = System.nanoTime();
    private final String what, method, target, netBefore;
    private String request = "", note = "";
    private int retry, status;
    private long sent = -1, received = -1;
    private Throwable failure;
    private boolean ended;

    private Call(String what, String method, String target) {
      this.what = what;
      this.method = method;
      this.target = target;
      this.netBefore = net();
    }

    Call request(String id) {
      request = id == null ? "" : id;
      return this;
    }

    Call retry(int n) {
      retry = n;
      return this;
    }

    Call status(int code) {
      status = code;
      return this;
    }

    Call sent(long bytes) {
      sent = bytes;
      return this;
    }

    Call received(long bytes) {
      received = bytes;
      return this;
    }

    /** A short plain fact about it (never content), e.g. "first byte 420 ms". */
    Call note(String s) {
      note = s == null ? "" : s;
      return this;
    }

    Call fail(Throwable ex) {
      if (failure == null) failure = ex;
      return this;
    }

    void end() {
      synchronized (this) {
        if (ended) return;
        ended = true;
      }
      long ms = (System.nanoTime() - startNanos) / 1_000_000;
      String netAfter = net();
      String net = netAfter.equals(netBefore) ? netAfter : netBefore + " → " + netAfter;
      append(line(started, what, request, method, target, result(status, failure), ms, retry, net, sent, received, note));
    }
  }

  /** "HTTP 200", "HTTP 502 bad gateway", "read timeout", "HTTP 200, then read timeout"; "no answer" without either. */
  static String result(int status, Throwable failure) {
    String http = status > 0 ? "HTTP " + status + statusName(status) : "";
    String fail = failure == null ? "" : classify(failure);
    if (http.isEmpty()) return fail.isEmpty() ? "no answer" : fail;
    // An HTTP error the code turned into an exception: the status says it.
    if (fail.isEmpty() || status >= 300 && fail.startsWith("app error")) return http;
    return http + ", then " + fail;
  }

  static String statusName(int status) {
    return switch (status) {
      case 101 -> " switching protocols";
      case 400 -> " bad request";
      case 401 -> " unauthorized";
      case 403 -> " forbidden";
      case 404 -> " not found";
      case 408 -> " request timeout";
      case 413 -> " too large";
      case 429 -> " too many requests";
      case 500 -> " server error";
      case 502 -> " bad gateway";
      case 503 -> " unavailable";
      case 504 -> " gateway timeout";
      default -> "";
    };
  }

  // ------------------------------------------------------------------ events

  /** Something on a connection that isn't one request: a stream opened or closed, a message came. */
  static void event(String what, String url, String result, String request, String note, String... secrets) {
    append(line(clock.getAsLong(), what, request, "", url.isEmpty() ? "" : target(url, secrets), result, -1, 0, net(), -1, -1, note));
  }

  /** A line that starts a hands-free call, so Copy last call finds the entries since. */
  static void callStarted() {
    append(stamp(clock.getAsLong()) + SEP + CALL_STARTED);
  }

  static final String CALL_STARTED = "── hands-free call started ──";

  /** The network changed (from the system's callback); the same as last time isn't repeated. */
  static void networkChanged(String now) {
    synchronized (LOCK) {
      if (now.equals(lastNetwork)) return;
      lastNetwork = now;
    }
    append(stamp(clock.getAsLong()) + SEP + "network now" + SEP + now);
  }

  private static String lastNetwork;

  // ------------------------------------------------------------------ the line

  private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSxxx", Locale.ROOT);

  static String stamp(long ms) {
    return STAMP.format(Instant.ofEpochMilli(ms).atZone(zone));
  }

  /** The time a line starts with, or -1 if it doesn't. */
  static long time(String line) {
    int end = line.indexOf(SEP);
    try {
      return OffsetDateTime.parse(end < 0 ? line : line.substring(0, end), STAMP).toInstant().toEpochMilli();
    } catch (RuntimeException ex) {
      return -1;
    }
  }

  static String line(
      long started, String what, String request, String method, String target, String result, long ms, int retry,
      String net, long sent, long received, String note) {
    StringBuilder s = new StringBuilder(stamp(started)).append(SEP).append(what);
    if (!request.isEmpty()) s.append(SEP).append("req ").append(request);
    if (!target.isEmpty()) s.append(SEP).append(method.isEmpty() ? "" : method + " ").append(target);
    if (!result.isEmpty()) s.append(SEP).append(result);
    if (ms >= 0) s.append(SEP).append(ms).append(" ms");
    if (retry > 0) s.append(SEP).append("retry ").append(retry);
    if (sent >= 0 || received >= 0)
      s.append(SEP).append(sent >= 0 ? "↑" + size(sent) : "").append(sent >= 0 && received >= 0 ? " " : "").append(received >= 0 ? "↓" + size(received) : "");
    if (!net.isEmpty()) s.append(SEP).append(net);
    if (!note.isEmpty()) s.append(SEP).append(note);
    return s.toString().replace('\n', ' ').replace('\r', ' ');
  }

  static String size(long bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return String.format(Locale.ROOT, "%.1f kB", bytes / 1024.0);
    return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024));
  }

  private static String net() {
    try {
      String n = network.get();
      return n == null ? "" : n;
    } catch (RuntimeException ex) {
      return "network unknown";
    }
  }

  // ------------------------------------------------------------------ redaction

  /** Query values shown as they are; every other one is masked. */
  private static final Set<String> PLAIN_QUERY = Set.of("since", "poll", "id", "sample_rate", "encoding", "model_id", "speech_model");

  /** A path segment that looks like a key or a secret topic: long, letters and digits mixed. */
  private static final Pattern TOKEN = Pattern.compile("(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9_\\-.~=+]{24,}");

  /**
   * host[:port]/path?keys, from a URL: no user info, secrets (e.g. the ntfy topic) and token-like
   * path segments as "***", query values masked except a few harmless ones.
   */
  static String target(String url, String... secrets) {
    if (url == null || url.isEmpty()) return "";
    URI u;
    try {
      u = URI.create(url.trim());
    } catch (IllegalArgumentException ex) {
      return "(unreadable address)";
    }
    if (u.getHost() == null) return "(unreadable address)";
    StringBuilder s = new StringBuilder(u.getHost());
    if (u.getPort() > 0) s.append(':').append(u.getPort());
    String path = u.getRawPath() == null ? "" : u.getRawPath();
    for (String seg : path.split("/", -1)) {
      if (seg.isEmpty()) continue;
      s.append('/').append(secret(seg, secrets) ? "***" : seg);
    }
    if (path.endsWith("/") && path.length() > 1) s.append('/');
    String query = u.getRawQuery();
    if (query != null && !query.isEmpty()) {
      List<String> parts = new ArrayList<>();
      for (String p : query.split("&")) {
        int eq = p.indexOf('=');
        String key = eq < 0 ? p : p.substring(0, eq);
        if (key.isEmpty()) continue;
        if (eq < 0) parts.add(key);
        else parts.add(key + "=" + (PLAIN_QUERY.contains(key) && !secret(p.substring(eq + 1), secrets) ? p.substring(eq + 1) : "***"));
      }
      if (!parts.isEmpty()) s.append('?').append(String.join("&", parts));
    }
    return s.toString();
  }

  private static boolean secret(String segment, String... secrets) {
    for (String x : secrets) if (x != null && !x.isEmpty() && segment.contains(x)) return true;
    return TOKEN.matcher(segment).matches();
  }

  /** The request ID in a message to the chief ("[request: abc123]"), "" without one. */
  static String requestIn(String text) {
    if (text == null) return "";
    Matcher m = REQUEST.matcher(text);
    return m.find() ? m.group(1) : "";
  }

  private static final Pattern REQUEST = Pattern.compile("\\[request: ([A-Za-z0-9_-]{1,40})\\]");

  // ------------------------------------------------------------------ failures

  /**
   * The kind of failure, from the exception or one it wraps: "DNS failure", "connect timeout",
   * "read timeout", "TLS error", "connection reset" and so on; never the message's text, which
   * may hold an answer or an address. Unknown ones by class name, as "app error (Name)".
   */
  static String classify(Throwable ex) {
    for (Throwable t = ex; t != null; t = t.getCause() == t ? null : t.getCause()) {
      String kind = kind(t);
      if (!kind.isEmpty()) return kind;
    }
    return ex == null ? "" : "app error (" + ex.getClass().getSimpleName() + ")";
  }

  private static String kind(Throwable t) {
    String m = String.valueOf(t.getMessage()).toLowerCase(Locale.ROOT);
    if (t instanceof java.net.UnknownHostException) return "DNS failure";
    if (t instanceof java.net.SocketTimeoutException)
      return m.contains("connect") ? "connect timeout" : "read timeout";
    if (t instanceof java.net.NoRouteToHostException) return "no route to host";
    if (t instanceof java.net.ConnectException) {
      if (m.contains("refused")) return "connection refused";
      if (m.contains("unreachable")) return "network unreachable";
      if (m.contains("timed out") || m.contains("timeout")) return "connect timeout";
      return "connect failed";
    }
    if (t instanceof javax.net.ssl.SSLPeerUnverifiedException || t instanceof java.security.cert.CertificateException)
      return "TLS certificate error";
    if (t instanceof javax.net.ssl.SSLHandshakeException) return "TLS handshake failed";
    if (t instanceof javax.net.ssl.SSLException) return m.contains("reset") ? "connection reset" : "TLS error";
    if (t instanceof java.net.SocketException) {
      if (m.contains("reset")) return "connection reset";
      if (m.contains("broken pipe")) return "broken pipe";
      if (m.contains("abort")) return "connection aborted";
      if (m.contains("unreachable")) return "network unreachable";
      if (m.contains("socket closed") || m.contains("socket is closed")) return "closed by the app";
      return "socket error";
    }
    if (t instanceof java.io.EOFException || t instanceof java.net.ProtocolException && m.contains("end of stream"))
      return "connection closed early";
    if (t instanceof java.net.ProtocolException) return "protocol error";
    if (t instanceof java.io.InterruptedIOException || t instanceof InterruptedException) return "cancelled";
    return "";
  }

  // ------------------------------------------------------------------ the file

  static void append(String line) {
    File f = file;
    if (f == null) return;
    byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
    synchronized (LOCK) {
      try {
        Files.write(f.toPath(), bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        if (f.length() > TRIM_BYTES || ++appended % TRIM_EVERY == 0) trim(f);
      } catch (IOException ignored) {
        /* The log is a help, not a must. */
      }
    }
  }

  /** Keeps the last KEEP lines of the last KEEP_MS: written to a temporary file that replaces the log. */
  private static void trim(File f) throws IOException {
    List<String> kept = bounded(Files.readAllLines(f.toPath(), StandardCharsets.UTF_8), clock.getAsLong());
    File temp = new File(f.getPath() + ".tmp");
    Files.write(temp.toPath(), (kept.isEmpty() ? "" : String.join("\n", kept) + "\n").getBytes(StandardCharsets.UTF_8));
    Files.move(temp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
  }

  /** The lines within the bounds at now: at most KEEP, none older than KEEP_MS (or unreadable). */
  static List<String> bounded(List<String> lines, long now) {
    List<String> out = new ArrayList<>();
    for (String l : lines) {
      long t = time(l);
      if (t >= 0 && now - t <= KEEP_MS) out.add(l);
    }
    return out.size() <= KEEP ? out : new ArrayList<>(out.subList(out.size() - KEEP, out.size()));
  }

  /** Delete local data: the log goes too (the next request starts a new one). */
  static void clear() {
    File f = file;
    if (f == null) return;
    synchronized (LOCK) {
      f.delete();
    }
  }

  /** The whole log within its bounds, oldest first; "" without one. */
  static String read() {
    File f = file;
    if (f == null) return "";
    synchronized (LOCK) {
      try {
        List<String> kept = bounded(Files.readAllLines(f.toPath(), StandardCharsets.UTF_8), clock.getAsLong());
        return kept.isEmpty() ? "" : String.join("\n", kept) + "\n";
      } catch (IOException ex) {
        return "";
      }
    }
  }

  /** The lines since the start of the last calls hands-free calls; the whole log if it holds fewer. */
  static String lastCalls(String log, int calls) {
    int from = log.length();
    for (int i = 0; i < calls; i++) {
      int at = from == 0 ? -1 : log.lastIndexOf(CALL_STARTED, from - 1);
      if (at < 0) return log;
      from = log.lastIndexOf('\n', at) + 1;
    }
    return log.substring(from);
  }

  /** What Copy network log copies: a header that says how to read the times, then the lines. */
  static String report(String app, String log) {
    long now = clock.getAsLong();
    String offset = DateTimeFormatter.ofPattern("xxx", Locale.ROOT).format(Instant.ofEpochMilli(now).atZone(zone));
    int lines = log.isEmpty() ? 0 : log.split("\n").length;
    return "Network log · " + app + " · copied " + stamp(now) + " · " + lines + (lines == 1 ? " entry" : " entries")
        + "\nTimes: local (" + zone.getId() + ", UTC" + offset + "), when each request started; then what, request, target, result, duration, retry, sizes, network.\n"
        + (log.isEmpty() ? "(no entries yet)\n" : log);
  }
}
