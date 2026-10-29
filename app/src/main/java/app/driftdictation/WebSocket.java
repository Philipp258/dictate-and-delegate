package app.driftdictation;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;

/**
 * A small WebSocket client (RFC 6455), for the streaming speech models: text and binary messages
 * out, text messages in (on its own thread), ping answered, close handled. ws:// for the test
 * fakes, wss:// (TLS, host name checked) for the providers. The app has no libraries; this is all
 * that streaming needs.
 */
final class WebSocket implements AutoCloseable {
  interface Listener {
    /** A text message came (on the reader thread). */
    void message(String text);

    /** The connection ended: closed by the server (code and reason), or failed (why). Once. */
    void ended(int code, String why);
  }

  private final Socket socket;
  private final InputStream in;
  private final OutputStream out;
  private final Listener listener;
  private final SecureRandom random = new SecureRandom();
  private volatile boolean ended;

  /** For the network log: what it's for, its address and when it opened. */
  private String what = "WebSocket", url = "";

  private final long opened = System.nanoTime();

  private WebSocket(Socket socket, InputStream in, Listener listener) throws IOException {
    this.socket = socket;
    this.in = in;
    this.out = socket.getOutputStream();
    this.listener = listener;
  }

  /** Connects and upgrades (headers: the provider's key, as it wants it); messages then come to the listener. */
  static WebSocket open(String url, Map<String, String> headers, Listener listener, int timeoutMs) throws IOException {
    return open("WebSocket", url, headers, listener, timeoutMs);
  }

  /** The same, in the network log as what (the handshake, then how the connection ended). */
  static WebSocket open(String what, String url, Map<String, String> headers, Listener listener, int timeoutMs) throws IOException {
    return NetLog.request(what + " connect", "GET", url, net -> connect(what, url, headers, listener, timeoutMs, net));
  }

  private static WebSocket connect(String what, String url, Map<String, String> headers, Listener listener, int timeoutMs, NetLog.Call net) throws IOException {
    URI u = URI.create(url);
    boolean tls = u.getScheme().equalsIgnoreCase("wss");
    String host = u.getHost();
    int port = u.getPort() > 0 ? u.getPort() : tls ? 443 : 80;
    Socket s = new Socket();
    try {
      s.connect(new InetSocketAddress(host, port), timeoutMs);
      s.setSoTimeout(timeoutMs); // Also for the TLS handshake: a stalled one gives up.
      if (tls) {
        javax.net.ssl.SSLSocket ssl = (javax.net.ssl.SSLSocket) ((javax.net.ssl.SSLSocketFactory) javax.net.ssl.SSLSocketFactory.getDefault()).createSocket(s, host, port, true);
        // The certificate must be for this host: checked in the handshake, and on Android once more
        // as its HTTPS connections check it.
        javax.net.ssl.SSLParameters params = ssl.getSSLParameters();
        params.setEndpointIdentificationAlgorithm("HTTPS");
        ssl.setSSLParameters(params);
        ssl.startHandshake();
        if ("The Android Project".equals(System.getProperty("java.vendor"))
            && !javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.getSession()))
          throw new IOException("the certificate isn't for " + host);
        s = ssl;
      }
      s.setSoTimeout(timeoutMs);
      String key = Base64.getEncoder().encodeToString(randomBytes(16));
      StringBuilder request = new StringBuilder();
      String path = (u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath()) + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
      request.append("GET ").append(path).append(" HTTP/1.1\r\n")
          .append("Host: ").append(host).append(u.getPort() > 0 ? ":" + port : "").append("\r\n")
          .append("Upgrade: websocket\r\nConnection: Upgrade\r\n")
          .append("Sec-WebSocket-Key: ").append(key).append("\r\nSec-WebSocket-Version: 13\r\n");
      for (Map.Entry<String, String> h : headers.entrySet()) request.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
      request.append("\r\n");
      OutputStream o = s.getOutputStream();
      o.write(request.toString().getBytes(StandardCharsets.UTF_8));
      o.flush();
      InputStream i = new java.io.BufferedInputStream(s.getInputStream());
      String status = line(i);
      java.util.regex.Matcher code = java.util.regex.Pattern.compile("^HTTP/1\\.1 (\\d{3})").matcher(status);
      if (code.find()) net.status(Integer.parseInt(code.group(1)));
      StringBuilder said = new StringBuilder();
      String accept = null;
      for (String h; !(h = line(i)).isEmpty(); ) {
        int colon = h.indexOf(':');
        if (colon > 0 && h.substring(0, colon).trim().equalsIgnoreCase("Sec-WebSocket-Accept")) accept = h.substring(colon + 1).trim();
      }
      if (!status.matches("HTTP/1\\.1 101.*")) {
        // What the provider said, for the log (its body may say why: a bad key, no credit).
        s.setSoTimeout(1000);
        try {
          byte[] b = new byte[512];
          int n = i.read(b);
          if (n > 0) said.append(new String(b, 0, n, StandardCharsets.UTF_8).trim());
        } catch (IOException ignored) {
          /* The status says enough. */
        }
        throw new IOException(status.replaceFirst("^HTTP/1\\.1 ", "HTTP ") + (said.length() == 0 ? "" : ": " + said));
      }
      if (!expectedAccept(key).equals(accept)) throw new IOException("not a WebSocket answer");
      s.setSoTimeout(0);
      WebSocket ws = new WebSocket(s, i, listener);
      ws.what = what;
      ws.url = url;
      new Thread(ws::read, "websocket-read").start();
      return ws;
    } catch (IOException | RuntimeException ex) {
      try {
        s.close();
      } catch (IOException ignored) {
        /* Failed anyway. */
      }
      throw ex instanceof IOException io ? io : new IOException(ex.getMessage(), ex);
    }
  }

  static String expectedAccept(String key) {
    try {
      byte[] sha = MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII));
      return Base64.getEncoder().encodeToString(sha);
    } catch (java.security.NoSuchAlgorithmException ex) {
      throw new IllegalStateException(ex);
    }
  }

  private static byte[] randomBytes(int n) {
    byte[] b = new byte[n];
    new SecureRandom().nextBytes(b);
    return b;
  }

  private static String line(InputStream in) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    for (int c; (c = in.read()) != -1; ) {
      if (c == '\n') break;
      if (c != '\r') b.write(c);
    }
    return b.toString(StandardCharsets.UTF_8.name());
  }

  void send(String text) throws IOException {
    frame(0x1, text.getBytes(StandardCharsets.UTF_8));
  }

  void send(byte[] data, int off, int n) throws IOException {
    frame(0x2, java.util.Arrays.copyOfRange(data, off, off + n));
  }

  /** One frame at a time goes out. */
  private final java.util.concurrent.locks.ReentrantLock writing = new java.util.concurrent.locks.ReentrantLock();

  /** A frame from the client: always masked. */
  private void frame(int opcode, byte[] payload) throws IOException {
    writing.lock();
    try {
      if (ended) throw new IOException("closed");
      out.write(encode(opcode, payload, randomMask()));
      out.flush();
    } finally {
      writing.unlock();
    }
  }

  private byte[] randomMask() {
    byte[] m = new byte[4];
    random.nextBytes(m);
    return m;
  }

  /** One final frame of opcode with payload, masked with mask (as a client sends it). */
  static byte[] encode(int opcode, byte[] payload, byte[] mask) {
    ByteArrayOutputStream b = new ByteArrayOutputStream(payload.length + 14);
    b.write(0x80 | opcode);
    int n = payload.length;
    if (n < 126) b.write(0x80 | n);
    else if (n < 65536) {
      b.write(0x80 | 126);
      b.write(n >> 8);
      b.write(n);
    } else {
      b.write(0x80 | 127);
      for (int i = 7; i >= 0; i--) b.write(i >= 4 ? 0 : n >> (8 * i));
    }
    b.write(mask, 0, 4);
    for (int i = 0; i < n; i++) b.write(payload[i] ^ mask[i & 3]);
    return b.toByteArray();
  }

  /** Reads frames until the connection ends: text messages to the listener (also in fragments). */
  private void read() {
    ByteArrayOutputStream message = new ByteArrayOutputStream();
    int code = 1006;
    String why = "the connection was lost";
    IOException lost = null;
    try {
      while (true) {
        int b0 = in.read(), b1 = in.read();
        if (b0 < 0 || b1 < 0) break;
        int opcode = b0 & 0x0f;
        long n = b1 & 0x7f;
        if (n == 126) n = (readByte() << 8) | readByte();
        else if (n == 127) {
          n = 0;
          for (int i = 0; i < 8; i++) n = (n << 8) | readByte();
        }
        byte[] mask = (b1 & 0x80) != 0 ? new byte[] {(byte) readByte(), (byte) readByte(), (byte) readByte(), (byte) readByte()} : null;
        if (n > 16 * 1024 * 1024) throw new IOException("a message too big (" + n + " bytes)");
        byte[] payload = new byte[(int) n];
        for (int at = 0; at < n; ) {
          int r = in.read(payload, at, (int) n - at);
          if (r < 0) throw new IOException("cut off");
          at += r;
        }
        if (mask != null) for (int i = 0; i < n; i++) payload[i] ^= mask[i & 3];
        if (opcode == 0x8) { // Close: its code and reason, answered.
          code = n >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
          why = n > 2 ? new String(payload, 2, (int) n - 2, StandardCharsets.UTF_8) : "";
          try {
            frame(0x8, n >= 2 ? new byte[] {payload[0], payload[1]} : new byte[0]);
          } catch (IOException ignored) {
            /* Gone already. */
          }
          break;
        }
        if (opcode == 0x9) {
          frame(0xA, payload);
          continue;
        }
        if (opcode == 0xA) continue;
        if (opcode == 0x1 || opcode == 0x0 || opcode == 0x2) {
          message.write(payload, 0, payload.length);
          if ((b0 & 0x80) != 0) {
            if (opcode != 0x2) listener.message(message.toString(StandardCharsets.UTF_8.name()));
            message.reset();
          }
        }
      }
    } catch (IOException ex) {
      if (!ended) why = String.valueOf(ex.getMessage()).toLowerCase(Locale.ROOT);
      lost = ex;
    } finally {
      boolean first;
      synchronized (this) {
        first = !ended;
        ended = true;
      }
      long s = (System.nanoTime() - opened) / 1_000_000_000;
      String reason = why.length() > 60 ? why.substring(0, 60) + "…" : why;
      NetLog.event(
          what + " closed",
          url,
          !first ? "closed by the app" : code != 1006 ? "closed by the server (" + code + (reason.isEmpty() ? "" : ", " + reason) + ")" : lost != null ? NetLog.classify(lost) : "connection lost",
          "",
          String.format(Locale.ROOT, "open %d:%02d min", s / 60, s % 60));
      try {
        socket.close();
      } catch (IOException ignored) {
        /* Closed. */
      }
      listener.ended(code, first ? why : "closed");
    }
  }

  private int readByte() throws IOException {
    int b = in.read();
    if (b < 0) throw new IOException("cut off");
    return b;
  }

  boolean open() {
    return !ended;
  }

  /** Closes it (a close frame, then the socket); the listener hears it ended. */
  @Override
  public void close() {
    // The socket closes at once (that ends the provider's session); no close frame, which could
    // wait behind a hanging write or a full send buffer on a dead network.
    synchronized (this) {
      ended = true;
    }
    try {
      socket.close();
    } catch (IOException ignored) {
      /* Closed. */
    }
  }

}
