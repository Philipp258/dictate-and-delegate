package app.driftdictation;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class NetLogTest {
  private File dir, file;
  private final AtomicLong now = new AtomicLong(1793301303123L); // 2026-10-29T20:15:03.123+01:00
  private Fake server;

  /** A tiny HTTP server for one test: each request (method, path, body) to the answer's status, headers and body. */
  static final class Fake implements AutoCloseable {
    interface Handler {
      String[] answer(String method, String path, String body) throws Exception; // {status, extra headers, body}
    }

    final java.net.ServerSocket socket = new java.net.ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"));

    Fake(Handler h) throws IOException {
      Thread t =
          new Thread(
              () -> {
                while (!socket.isClosed()) {
                  try (java.net.Socket s = socket.accept()) {
                    java.io.InputStream in = new java.io.BufferedInputStream(s.getInputStream());
                    String[] request = line(in).split(" ");
                    int length = 0;
                    for (String l; !(l = line(in)).isEmpty(); )
                      if (l.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(l.substring(15).trim());
                    String body = new String(in.readNBytes(length), StandardCharsets.UTF_8);
                    String[] a = h.answer(request[0], request[1], body);
                    byte[] b = a[2].getBytes(StandardCharsets.UTF_8);
                    s.getOutputStream().write(("HTTP/1.1 " + a[0] + " X\r\n" + a[1] + "Content-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    s.getOutputStream().write(b);
                  } catch (Exception ex) {
                    /* Closed, or a broken request: the next one. */
                  }
                }
              });
      t.setDaemon(true);
      t.start();
    }

    int port() {
      return socket.getLocalPort();
    }

    private static String line(java.io.InputStream in) throws IOException {
      StringBuilder b = new StringBuilder();
      for (int c; (c = in.read()) != -1 && c != '\n'; ) if (c != '\r') b.append((char) c);
      return b.toString();
    }

    @Override
    public void close() throws IOException {
      socket.close();
    }
  }

  @Before
  public void setUp() throws Exception {
    dir = Files.createTempDirectory("netlog").toFile();
    file = new File(dir, "network.log");
    NetLog.clock = now::get;
    NetLog.zone = ZoneId.of("Europe/Berlin");
    NetLog.init(file, () -> "wifi, v4+v6");
  }

  @After
  public void tearDown() {
    if (server != null)
      try {
        server.close();
      } catch (IOException ignored) {
        /* Closed. */
      }
    NetLog.init(null, null);
    NetLog.clock = System::currentTimeMillis;
    NetLog.zone = ZoneId.systemDefault();
  }

  // ------------------------------------------------------------------ redaction

  @Test
  public void anAddressKeepsHostAndPathButNoSecrets() {
    assertEquals("ntfy.sh/***/json?since=1793300000", NetLog.target("https://ntfy.sh/my-topic/json?since=1793300000", "my-topic"));
    // A long random topic is masked even when it isn't named.
    assertEquals("ntfy.sh/***/json?since=abc&poll=1", NetLog.target("https://ntfy.sh/talkrouter-Zq8_kLmNpQrs_tUvW5xYz_aB1c/json?since=abc&poll=1"));
    assertEquals("x.getbb.app/api/v1/plugins/bb--mcp/http/mcp", NetLog.target("https://user:pw@x.getbb.app/api/v1/plugins/bb--mcp/http/mcp"));
    assertEquals("api.example.com:8443/v1/stream?token=***&sample_rate=16000&keyterms_prompt=***",
        NetLog.target("wss://api.example.com:8443/v1/stream?token=sk-secret-1234&sample_rate=16000&keyterms_prompt=%5B%22Jev%22%5D"));
    assertEquals("openrouter.ai/api/v1/generation?id=gen-1", NetLog.target("https://openrouter.ai/api/v1/generation?id=gen-1"));
    assertEquals("(unreadable address)", NetLog.target("not a url"));
    assertEquals("abc123", NetLog.requestIn("words\n\n[request: abc123]"));
    assertEquals("", NetLog.requestIn("no request here"));
  }

  @Test
  public void aBbMessageIsLoggedWithItsRequestButNeverItsTextOrToken() throws Exception {
    List<String> methods = new ArrayList<>();
    server =
        new Fake(
            (method, path, body) -> {
              JSONObject m = new JSONObject(body);
              methods.add(m.optString("method"));
              if (!m.has("id")) return new String[] {"202", "Mcp-Session-Id: s1\r\n", ""};
              String result =
                  m.optString("method").equals("tools/call")
                      ? "{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"delivery\\\":\\\"queued\\\"}\"}]}"
                      : "{}";
              return new String[] {
                "200", "Mcp-Session-Id: s1\r\nContent-Type: application/json\r\n", "{\"jsonrpc\":\"2.0\",\"id\":" + m.get("id") + ",\"result\":" + result + "}"
              };
            });
    String url = "http://127.0.0.1:" + server.port() + "/mcp";
    Mcp.Connection c = new Mcp.Connection(new Mcp.Server("bb", url, "secret-access-token-123"));
    c.what = "bb " + BbBridge.what(BbBridge.tellSnippet("thr_chief", "my private words\n\n[request: abc123]"), "run", "thr_chief", "thr_talk");
    c.open();
    c.callResult("run", new JSONObject().put("code", BbBridge.tellSnippet("thr_chief", "my private words\n\n[request: abc123]")));
    assertEquals(List.of("initialize", "notifications/initialized", "tools/call"), methods);
    String log = NetLog.read();
    String[] lines = log.split("\n");
    assertEquals(log, 3, lines.length);
    assertTrue(log, lines[2].startsWith("2026-10-29T20:15:03.123+01:00 | bb tell chief | req abc123 | POST 127.0.0.1:" + server.port() + "/mcp | HTTP 200 | "));
    assertTrue(log, lines[2].contains(" ms | ↑"));
    assertTrue(log, lines[2].endsWith(" | wifi, v4+v6 | tools/call run"));
    assertTrue(log, lines[0].endsWith("| initialize"));
    assertFalse(log, log.contains("private words"));
    assertFalse(log, log.contains("secret-access-token"));
  }

  @Test
  public void aTokenRefreshNeverShowsTheRefreshToken() throws Exception {
    server = new Fake((method, path, body) -> new String[] {"400", "", "{\"error\":\"invalid_grant\"}"});
    String url = "http://127.0.0.1:" + server.port() + "/token?client_secret=shh";
    try {
      BbOAuth.request("POST", url, "grant_type=refresh_token&refresh_token=rt-very-secret", "application/x-www-form-urlencoded");
      fail("400 throws");
    } catch (BbOAuth.HttpError expected) {
      assertEquals(400, expected.status);
    }
    String log = NetLog.read();
    assertTrue(log, log.contains(" | bb token refresh | POST 127.0.0.1:" + server.port() + "/token?client_secret=*** | HTTP 400 bad request | "));
    assertFalse(log, log.contains("rt-very-secret"));
    assertFalse(log, log.contains("shh"));
  }

  // ------------------------------------------------------------------ failures

  @Test
  public void failuresAreClassifiedWithoutTheirText() {
    assertEquals("DNS failure", NetLog.classify(new java.net.UnknownHostException("Unable to resolve host \"x.getbb.app\"")));
    assertEquals("connect timeout", NetLog.classify(new java.net.SocketTimeoutException("failed to connect to x/1.2.3.4 (port 443) after 15000ms")));
    assertEquals("read timeout", NetLog.classify(new java.net.SocketTimeoutException("Read timed out")));
    assertEquals("connection refused", NetLog.classify(new java.net.ConnectException("failed to connect: ECONNREFUSED (Connection refused)")));
    assertEquals("network unreachable", NetLog.classify(new java.net.ConnectException("ENETUNREACH (Network is unreachable)")));
    assertEquals("no route to host", NetLog.classify(new java.net.NoRouteToHostException("No route")));
    assertEquals("connection reset", NetLog.classify(new java.net.SocketException("Connection reset")));
    assertEquals("connection aborted", NetLog.classify(new java.net.SocketException("Software caused connection abort")));
    assertEquals("broken pipe", NetLog.classify(new java.net.SocketException("Broken pipe")));
    assertEquals("closed by the app", NetLog.classify(new java.net.SocketException("Socket closed")));
    assertEquals("TLS handshake failed", NetLog.classify(new javax.net.ssl.SSLHandshakeException("handshake")));
    assertEquals("TLS certificate error", NetLog.classify(new javax.net.ssl.SSLPeerUnverifiedException("peer")));
    assertEquals("TLS error", NetLog.classify(new javax.net.ssl.SSLException("bad record")));
    assertEquals("connection closed early", NetLog.classify(new java.io.EOFException()));
    assertEquals("connection closed early", NetLog.classify(new java.net.ProtocolException("unexpected end of stream on https://x/...")));
    assertEquals("cancelled", NetLog.classify(new java.io.InterruptedIOException("interrupted")));
    // A readable wrapper of ours: the cause says what happened.
    assertEquals("DNS failure", NetLog.classify(new IOException("bb isn't reachable right now.", new java.net.UnknownHostException("h"))));
    assertEquals("app error (IllegalStateException)", NetLog.classify(new IllegalStateException("my private words")));

    assertEquals("HTTP 502 bad gateway", NetLog.result(502, new IOException("bb isn't reachable right now (HTTP 502).")));
    assertEquals("HTTP 504 gateway timeout", NetLog.result(504, null));
    assertEquals("HTTP 200, then read timeout", NetLog.result(200, new java.net.SocketTimeoutException("Read timed out")));
    assertEquals("no answer", NetLog.result(0, null));
  }

  @Test
  public void aRefusedConnectionIsLoggedAsSuch() throws Exception {
    int port;
    try (java.net.ServerSocket s = new java.net.ServerSocket(0)) {
      port = s.getLocalPort();
    }
    String url = "http://127.0.0.1:" + port + "/x";
    try {
      NetLog.request(
          "test",
          "GET",
          url,
          2,
          net -> {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(2000);
            return net.status(c.getResponseCode());
          });
      fail("nothing listens there");
    } catch (java.net.ConnectException expected) {
      /* Thrown on, as it was. */
    }
    assertTrue(NetLog.read(), NetLog.read().contains(" | test | GET 127.0.0.1:" + port + "/x | connection refused | "));
    assertTrue(NetLog.read(), NetLog.read().contains(" | retry 2 | wifi, v4+v6"));
  }

  // ------------------------------------------------------------------ the line and the file

  @Test
  public void aLineSaysEverythingInOrder() {
    assertEquals(
        "2026-10-29T20:15:03.123+01:00 | bb tell talker | req abc123 | POST x.getbb.app/mcp | HTTP 200 | 412 ms | retry 1 | ↑1.2 kB ↓310 B | mobile Vodafone.de (data SIM, slot 2), v6 only | tools/call run",
        NetLog.line(now.get(), "bb tell talker", "abc123", "POST", "x.getbb.app/mcp", "HTTP 200", 412, 1, "mobile Vodafone.de (data SIM, slot 2), v6 only", 1234, 310, "tools/call run"));
    assertEquals(now.get(), NetLog.time(NetLog.stamp(now.get()) + " | x"));
    assertEquals(-1, NetLog.time("garbage | x"));
    // The network changing during a request shows both.
    String[] net = {"wifi, v4+v6"};
    NetLog.init(file, () -> net[0]);
    NetLog.Call c = NetLog.begin("x", "GET", "https://h/p");
    net[0] = "mobile";
    c.status(200).end();
    c.end(); // Once only.
    assertEquals(1, NetLog.read().split("\n").length);
    assertTrue(NetLog.read(), NetLog.read().contains(" | wifi, v4+v6 → mobile"));
  }

  @Test
  public void anNtfyMessageIsLoggedByIdAndRequestNotText() throws Exception {
    JSONObject m =
        new JSONObject()
            .put("id", "Xy12")
            .put("event", "message")
            .put("time", now.get() / 1000 - 3)
            .put("tags", new org.json.JSONArray().put("talkrouter-speak").put("req-abc123"))
            .put("message", "Your train leaves at nine.");
    ChiefText.received("ntfy replies", m);
    ChiefText.received("ntfy replies", new JSONObject().put("event", "keepalive"));
    String log = NetLog.read();
    assertEquals(log, 1, log.split("\n").length);
    assertTrue(log, log.contains(" | ntfy replies message | req abc123 | id Xy12 (spoken) | wifi, v4+v6 | published 2026-10-29T20:15:00.000+01:00, here 3 s later, 26 B"));
    assertFalse(log, log.contains("train"));
  }

  @Test
  public void itKeepsTheLastThousandLinesOfTheLastSevenDaysAcrossRestarts() throws Exception {
    now.addAndGet(-8L * 24 * 3600 * 1000); // Eight days ago: dropped once trimmed.
    NetLog.append(NetLog.line(now.get(), "old", "", "GET", "h/old", "HTTP 200", 1, 0, "", -1, -1, ""));
    now.addAndGet(8L * 24 * 3600 * 1000);
    for (int i = 0; i < 1100; i++) {
      now.incrementAndGet();
      NetLog.append(NetLog.line(now.get(), "e" + i, "", "GET", "h/p", "HTTP 200", 1, 0, "", -1, -1, ""));
    }
    long fileLines = Files.readAllLines(file.toPath()).size();
    assertTrue("trimmed on the way: " + fileLines, fileLines < 1100);
    // A restart: the same file, read again.
    NetLog.init(null, null);
    NetLog.init(file, () -> "");
    String[] lines = NetLog.read().split("\n");
    assertEquals(NetLog.KEEP, lines.length);
    assertTrue(lines[0].contains(" | e100 | "));
    assertTrue(lines[lines.length - 1].contains(" | e1099 | "));
    assertFalse(NetLog.read().contains(" | old | "));
    // Seven days later, all of it is too old.
    now.addAndGet(NetLog.KEEP_MS + 1000);
    assertEquals("", NetLog.read());
  }

  @Test
  public void copyLastCallTakesTheEntriesSinceThatCallStarted() {
    NetLog.append(NetLog.line(now.get(), "before", "", "GET", "h/p", "HTTP 200", 1, 0, "", -1, -1, ""));
    NetLog.callStarted();
    NetLog.append(NetLog.line(now.get(), "first call", "", "GET", "h/p", "HTTP 200", 1, 0, "", -1, -1, ""));
    NetLog.callStarted();
    NetLog.append(NetLog.line(now.get(), "second call", "", "GET", "h/p", "HTTP 200", 1, 0, "", -1, -1, ""));
    String log = NetLog.read();
    String last = NetLog.lastCalls(log, 1);
    assertTrue(last, last.startsWith("2026-10-29T20:15:03.123+01:00 | ── hands-free call started ──\n"));
    assertTrue(last.contains("second call") && !last.contains("first call"));
    assertTrue(NetLog.lastCalls(log, 2).contains("first call") && !NetLog.lastCalls(log, 2).contains("before"));
    assertEquals(log, NetLog.lastCalls(log, 5));
    String report = NetLog.report("Dictate & Delegate 3.2.19", last);
    assertTrue(report, report.startsWith("Network log · Dictate & Delegate 3.2.19 · copied 2026-10-29T20:15:03.123+01:00 · 2 entries\nTimes: local (Europe/Berlin, UTC+01:00)"));
    NetLog.networkChanged("mobile");
    NetLog.networkChanged("mobile");
    assertEquals(1, NetLog.read().split("network now").length - 1);
  }
}
