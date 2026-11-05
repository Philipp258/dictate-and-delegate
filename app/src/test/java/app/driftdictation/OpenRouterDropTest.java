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
  private long dropMs, stallMs;

  @Before
  public void fast() {
    waits = OpenRouter.RETRY_WAITS_MS;
    dropMs = OpenRouter.DROP_MS;
    stallMs = OpenRouter.STALL_MS;
    OpenRouter.RETRY_WAITS_MS = new long[] {1, 1, 1};
  }

  @After
  public void restore() {
    OpenRouter.RETRY_WAITS_MS = waits;
    OpenRouter.DROP_MS = dropMs;
    OpenRouter.STALL_MS = stallMs;
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
      server = new ServerSocket();
      server.setReceiveBufferSize(8192); // a fake that stops reading holds the upload up soon
      server.bind(new java.net.InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), 50);
      thread =
          new Thread(
              () -> {
                while (!server.isClosed()) {
                  try {
                    Socket s = server.accept();
                    int n = connections.getAndIncrement();
                    // Each connection on its own, so one that hangs doesn't hold up the next.
                    Thread t =
                        new Thread(
                            () -> {
                              try (s) {
                                b.serve(n, s);
                              } catch (Exception ignored) {
                                /* next connection */
                              }
                            });
                    t.setDaemon(true);
                    t.start();
                  } catch (Exception ignored) {
                    /* closed */
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

  /** Much more than the sockets' buffers hold, so an upload nobody reads hangs. */
  private static JSONObject big() throws Exception {
    return new JSONObject().put("model", "microsoft/mai-transcribe-2").put("input_audio", new JSONObject().put("data", "A".repeat(30_000_000)));
  }

  /**
   * The mobile connection went dead mid-upload: the fake reads nothing for a while, then drops
   * it. Any failure while the body is going out is tried again (OpenRouter never got all of it).
   * Breaking the hanging write off at STALL_MS needs Android's HTTP stack, which closes the socket
   * on disconnect; the JVM's doesn't, so here the fake's close ends it.
   */
  @Test
  public void anUploadThatBreaksOffMidWayIsTriedAgain() throws Exception {
    OpenRouter.STALL_MS = 300;
    try (Fake fake =
        new Fake(
            (n, s) -> {
              if (n == 0) {
                s.getInputStream().readNBytes(50_000);
                Thread.sleep(1000);
                reset(s);
                return;
              }
              readRequest(s);
              answer(s, "{\"text\":\"hello\"}");
            })) {
      assertEquals("hello", OpenRouter.post(fake.url(), big(), "k").getString("text"));
      assertEquals(2, fake.connections.get());
    }
  }

  @Test
  public void triesStopWhenTheTimeIsUp() throws Exception {
    OpenRouter.RETRY_WAITS_MS = new long[] {200, 200, 200, 200, 200};
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              reset(s);
            })) {
      long t = System.nanoTime();
      assertThrows(IOException.class, () -> OpenRouter.post(fake.url(), body(), "k", new OpenRouter.Control(500)));
      long ms = (System.nanoTime() - t) / 1_000_000;
      // The first, one at once, then two after 200 ms each: a third wait would end past 500 ms.
      assertTrue("connections " + fake.connections.get(), fake.connections.get() >= 2 && fake.connections.get() <= 4);
      assertTrue("took " + ms + " ms", ms < 1500);
    }
  }

  @Test
  public void cancelDuringAnUploadIsNeverTriedAgain() throws Exception {
    OpenRouter.STALL_MS = 60_000;
    try (Fake fake =
        new Fake(
            (n, s) -> {
              Thread.sleep(1500);
              reset(s);
            })) {
      OpenRouter.Control control = new OpenRouter.Control(90_000);
      java.util.List<String> told = new java.util.concurrent.CopyOnWriteArrayList<>();
      control.onRetry((attempt, wait, why) -> told.add(why));
      new Thread(
              () -> {
                try {
                  Thread.sleep(300);
                } catch (InterruptedException ignored) {
                }
                control.cancel();
              })
          .start();
      assertThrows(OpenRouter.Cancelled.class, () -> OpenRouter.post(fake.url(), big(), "k", control));
      assertEquals(1, fake.connections.get());
      assertTrue(told.isEmpty());
    }
  }

  @Test
  public void cancelEndsAWaitBeforeTheNextTry() throws Exception {
    OpenRouter.RETRY_WAITS_MS = new long[] {10_000, 10_000};
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              reset(s);
            })) {
      OpenRouter.Control control = new OpenRouter.Control(90_000);
      java.util.List<Long> waits = new java.util.concurrent.CopyOnWriteArrayList<>();
      control.onRetry(
          (attempt, wait, why) -> {
            waits.add(wait);
            if (wait > 0) new Thread(control::cancel).start();
          });
      long t = System.nanoTime();
      assertThrows(OpenRouter.Cancelled.class, () -> OpenRouter.post(fake.url(), body(), "k", control));
      assertTrue(System.nanoTime() - t < 3_000_000_000L);
      assertEquals(java.util.List.of(0L, 10_000L), waits);
    }
  }

  /** Stop trying after the request went out whole: the answer still comes (it may be charged). */
  @Test
  public void stopTryingAfterTheUploadKeepsTheAnswer() throws Exception {
    try (Fake fake =
        new Fake(
            (n, s) -> {
              readRequest(s);
              Thread.sleep(600); // the model is working
              answer(s, "{\"text\":\"kept\"}");
            })) {
      OpenRouter.Control control = new OpenRouter.Control(90_000);
      new Thread(
              () -> {
                try {
                  Thread.sleep(300);
                } catch (InterruptedException ignored) {
                }
                control.cancel();
              })
          .start();
      assertEquals("kept", OpenRouter.post(fake.url(), body(), "k", control).getString("text"));
      assertTrue(control.cancelled());
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
