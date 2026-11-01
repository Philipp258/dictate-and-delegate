package app.driftdictation;

import static org.junit.Assert.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * A connection that breaks off before any answer (a kept-alive one the network forgot) is tried
 * again on a new one; one that broke off after an answer started, or long after the request went
 * out, isn't (the model may have run and charged).
 */
public class OpenRouterDropTest {
  private long[] waits;
  private long dropMs;

  @Before
  public void fast() {
    waits = OpenRouter.NO_CONNECTION_MS;
    dropMs = OpenRouter.DROP_MS;
    OpenRouter.NO_CONNECTION_MS = new long[] {1, 1, 1};
  }

  @After
  public void restore() {
    OpenRouter.NO_CONNECTION_MS = waits;
    OpenRouter.DROP_MS = dropMs;
  }

  /** What the fake does with each connection, by its number (0 first). */
  interface Behaviour {
    void serve(int n, Socket s) throws Exception;
  }

  private static final class Fake implements AutoCloseable {
    final ServerSocket server;
    final AtomicInteger connections = new AtomicInteger();
    final Thread thread;

    Fake(Behaviour b) throws IOException {
      server = new ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress());
      thread =
          new Thread(
              () -> {
                while (!server.isClosed()) {
                  try (Socket s = server.accept()) {
                    b.serve(connections.getAndIncrement(), s);
                  } catch (Exception ignored) {
                    /* next connection */
                  }
                }
              });
      thread.setDaemon(true);
      thread.start();
    }

    String url() {
      return "http://127.0.0.1:" + server.getLocalPort() + "/api/v1/audio/transcriptions";
    }

    @Override
    public void close() throws IOException {
      server.close();
    }
  }

  /** Reads one request: headers, then Content-Length bytes. */
  private static void readRequest(Socket s) throws IOException {
    InputStream in = s.getInputStream();
    ByteArrayOutputStream head = new ByteArrayOutputStream();
    while (!head.toString(StandardCharsets.ISO_8859_1).endsWith("\r\n\r\n")) {
      int b = in.read();
      if (b < 0) throw new IOException("closed");
      head.write(b);
    }
    int length = 0;
    for (String line : head.toString(StandardCharsets.ISO_8859_1).split("\r\n"))
      if (line.toLowerCase().startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
    in.readNBytes(length);
  }

  private static void reset(Socket s) throws IOException {
    s.setSoLinger(true, 0); // close() sends RST: "connection reset" at the client
    s.close();
  }

  private static void answer(Socket s, String json) throws IOException {
    byte[] body = json.getBytes(StandardCharsets.UTF_8);
    OutputStream out = s.getOutputStream();
    out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
    out.write(body);
    out.flush();
  }

  private static JSONObject body() throws Exception {
    // About 1 MB, like a recording's chunk.
    return new JSONObject().put("model", "microsoft/mai-transcribe-2").put("input_audio", new JSONObject().put("data", "A".repeat(1_000_000)));
  }

  @Test
  public void aResetBeforeAnyAnswerIsTriedAgainOnANewConnection() throws Exception {
    try (Fake fake =
        new Fake(
            (n, s) -> {
              if (n == 0) {
                s.getInputStream().readNBytes(100); // a little of the upload, then gone
                reset(s);
                return;
              }
              readRequest(s);
              answer(s, "{\"text\":\"hello\"}");
            })) {
      JSONObject r = OpenRouter.post(fake.url(), body(), "k");
      assertEquals("hello", r.getString("text"));
      assertEquals(2, fake.connections.get());
    }
  }

  @Test
  public void aResetRightAfterTheRequestWentOutIsTriedAgain() throws Exception {
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              if (n == 0) reset(s);
              else answer(s, "{\"text\":\"hello\"}");
            })) {
      assertEquals("hello", OpenRouter.post(fake.url(), body(), "k").getString("text"));
      assertEquals(2, fake.connections.get());
    }
  }

  @Test
  public void aConnectionThatKeepsBreakingIsTriedFiveTimesInAll() throws Exception {
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              reset(s);
            })) {
      IOException failed = assertThrows(IOException.class, () -> OpenRouter.post(fake.url(), body(), "k"));
      assertTrue(String.valueOf(failed) + " / " + failed.getCause(), failed instanceof OpenRouter.Dropped);
      // The first try, one at once on a new connection, then after each of the three waits.
      assertEquals(5, fake.connections.get());
    }
  }

  @Test
  public void aResetLongAfterTheRequestWentOutIsNotTriedAgain() throws Exception {
    OpenRouter.DROP_MS = 100;
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              Thread.sleep(400); // the model is working
              reset(s);
            })) {
      assertThrows(IOException.class, () -> OpenRouter.post(fake.url(), body(), "k"));
      assertEquals(1, fake.connections.get());
    }
  }

  @Test
  public void aResetAfterTheAnswerStartedIsNotTriedAgain() throws Exception {
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{\"text\":".getBytes(StandardCharsets.ISO_8859_1));
              s.getOutputStream().flush();
              Thread.sleep(50);
              reset(s);
            })) {
      assertThrows(IOException.class, () -> OpenRouter.post(fake.url(), body(), "k"));
      assertEquals(1, fake.connections.get());
    }
  }

  @Test
  public void onlyBrokenConnectionsBeforeAnAnswerCount() {
    long now = 10_000_000_000L;
    IOException reset = new IOException("x", new java.net.SocketException("Connection reset"));
    IOException pipe = new IOException("x", new java.net.SocketException("Broken pipe"));
    IOException eof = new IOException("unexpected end of stream", new java.io.EOFException());
    assertTrue(OpenRouter.dropped(reset, 0, 0, now)); // while sending
    assertTrue(OpenRouter.dropped(pipe, 0, 0, now));
    assertTrue(OpenRouter.dropped(eof, 0, now - 190_000_000L, now)); // 190 ms after sending
    assertFalse(OpenRouter.dropped(reset, 0, now - (OpenRouter.DROP_MS + 1) * 1_000_000, now)); // the model may run
    assertFalse(OpenRouter.dropped(reset, 200, now, now)); // an answer had started
    // Timeouts are never a broken connection: the model may have run.
    assertFalse(OpenRouter.dropped(new IOException("x", new java.net.SocketTimeoutException("Read timed out")), 0, 0, now));
    assertFalse(OpenRouter.dropped(new IOException("The model provider had a problem (HTTP 502)."), 0, 0, now));
  }
}
