package app.driftdictation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.Test;

public class StreamingSpeechTest {
  @Test
  public void assemblyAisTurnsAreLiveTextThenFinalAndTakeEndsTheTurn() throws Exception {
    StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of());
    List<String> changed = new CopyOnWriteArrayList<>();
    s.changed = changed::add;
    s.message("{\"type\":\"Turn\",\"turn_order\":0,\"end_of_turn\":false,\"transcript\":\"\",\"words\":[{\"text\":\"Book\"},{\"text\":\"the\"}]}");
    assertEquals("Book the", s.text());
    s.message("{\"type\":\"Turn\",\"turn_order\":0,\"end_of_turn\":true,\"transcript\":\"Book the table.\",\"words\":[]}");
    assertEquals("Book the table.", s.text());
    s.message("{\"type\":\"Turn\",\"turn_order\":1,\"end_of_turn\":false,\"transcript\":\"Over\"}");
    assertEquals("Book the table. Over", s.text());
    assertEquals(List.of("Book the", "Book the table.", "Book the table. Over"), changed);
    // Not connected: what's live is taken as it is.
    assertEquals("Book the table. Over", s.take(0));
    assertEquals("", s.text());
    s.message("{\"type\":\"Turn\",\"turn_order\":2,\"end_of_turn\":false,\"transcript\":\"Next\"}");
    assertEquals("the next turn starts after the taken one", "Next", s.text());
    s.discard();
    assertEquals("", s.text());
  }

  @Test
  public void universalStreamingEnglishCountsTheFormattedEndOfATurn() throws Exception {
    StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_EN, "k", List.of("over", "that's all"));
    assertTrue(s.url(), s.url().contains("speech_model=universal-streaming-english&format_turns=true"));
    assertTrue(s.url(), s.url().contains("&keyterms_prompt=%5B%22over%22%2C%22that%27s+all%22%5D"));
    assertFalse(StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of()).url().contains("format_turns"));
    s.message("{\"type\":\"Turn\",\"end_of_turn\":true,\"turn_is_formatted\":false,\"transcript\":\"book the table over\"}");
    assertEquals("book the table over", s.text());
    s.message("{\"type\":\"Turn\",\"end_of_turn\":true,\"turn_is_formatted\":true,\"transcript\":\"Book the table. Over.\"}");
    assertEquals("Book the table. Over.", s.text());
  }

  @Test
  public void elevenLabsPartialsAndCommitsAndAnErrorEndsIt() throws Exception {
    StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.ELEVEN, "k", List.of());
    assertTrue(s.url(), s.url().endsWith("?model_id=scribe_v2_realtime&audio_format=pcm_16000&language_code=en&commit_strategy=manual"));
    List<String> failures = new CopyOnWriteArrayList<>();
    s.onFailure = failures::add;
    s.message("{\"message_type\":\"session_started\",\"session_id\":\"x\"}");
    s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Remind me\"}");
    assertEquals("Remind me", s.text());
    s.message("{\"message_type\":\"committed_transcript\",\"text\":\"Remind me to call Jana.\"}");
    s.message("{\"message_type\":\"committed_transcript_with_timestamps\",\"text\":\"Remind me to call Jana.\",\"words\":null}");
    assertEquals("Remind me to call Jana.", s.text());
    assertTrue(s.working());
    s.message("{\"message_type\":\"quota_exceeded\",\"error\":\"You have used up your quota\"}");
    assertFalse(s.working());
    assertEquals(List.of("quota_exceeded: You have used up your quota"), failures);
    try {
      s.take(0);
      throw new AssertionError("a failed one can't be taken from");
    } catch (java.io.IOException expected) {
      assertEquals("quota_exceeded: You have used up your quota", expected.getMessage());
    }
  }

  @Test
  public void aWebSocketUpgradesSendsMaskedFramesAndReadsTextAndClose() throws Exception {
    try (ServerSocket server = new ServerSocket(0)) {
      List<String> got = new CopyOnWriteArrayList<>();
      String[] path = {""};
      Thread t =
          new Thread(
              () -> {
                try (Socket c = server.accept()) {
                  InputStream in = c.getInputStream();
                  OutputStream out = c.getOutputStream();
                  StringBuilder head = new StringBuilder();
                  while (!head.toString().endsWith("\r\n\r\n")) head.append((char) in.read());
                  path[0] = head.toString().split(" ")[1];
                  String key = head.toString().replaceAll("(?s).*Sec-WebSocket-Key: ([^\r]+).*", "$1");
                  assertTrue(head.toString(), head.toString().contains("Authorization: secret\r\n"));
                  out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + WebSocket.expectedAccept(key) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                  // The client's frame: masked text.
                  int b0 = in.read(), b1 = in.read();
                  assertEquals(0x81, b0);
                  assertTrue("masked", (b1 & 0x80) != 0);
                  byte[] mask = in.readNBytes(4), payload = in.readNBytes(b1 & 0x7f);
                  for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                  got.add(new String(payload, StandardCharsets.UTF_8));
                  // A text message in two fragments, then a close with its code and reason.
                  out.write(new byte[] {0x01, 3, 'h', 'e', 'l'});
                  out.write(new byte[] {(byte) 0x80, 2, 'l', 'o'});
                  out.write(new byte[] {(byte) 0x88, 6, 0x03, (byte) 0xf0, 'b', 'u', 's', 'y'});
                  out.flush();
                  in.readNBytes(8); // Its answer to the close.
                } catch (Exception ex) {
                  got.add("server: " + ex);
                }
              });
      t.start();
      List<String> messages = new CopyOnWriteArrayList<>();
      int[] code = {0};
      String[] why = {null};
      WebSocket ws =
          WebSocket.open(
              "ws://127.0.0.1:" + server.getLocalPort() + "/v3/ws?sample_rate=16000",
              java.util.Map.of("Authorization", "secret"),
              new WebSocket.Listener() {
                public void message(String text) {
                  messages.add(text);
                }

                public void ended(int c, String w) {
                  code[0] = c;
                  why[0] = w;
                }
              },
              2000);
      ws.send("{\"type\":\"ForceEndpoint\"}");
      t.join(3000);
      for (int i = 0; i < 100 && why[0] == null; i++) Thread.sleep(20);
      assertEquals("/v3/ws?sample_rate=16000", path[0]);
      assertEquals(List.of("{\"type\":\"ForceEndpoint\"}"), got);
      assertEquals(List.of("hello"), messages);
      assertEquals(1008, code[0]);
      assertEquals("busy", why[0]);
      assertFalse(ws.open());
    }
  }

  @Test
  public void aLateFinalOfATakenOrDroppedStretchStaysOutOfTheNextTurn() throws Exception {
    String was = StreamingSpeech.elevenLabsUrl;
    try (Server server = new Server(0, true)) {
      StreamingSpeech.elevenLabsUrl = server.url();
      lateFinals();
    } finally {
      StreamingSpeech.elevenLabsUrl = was;
    }
  }

  private void lateFinals() throws Exception {
    StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.ELEVEN, "k", List.of());
    s.speech();
    for (int i = 0; i < 100 && s.openedMs < 0; i++) Thread.sleep(20);
    s.message("{\"message_type\":\"partial_transcript\",\"text\":\"send the report over\"}");
    assertEquals("send the report over", s.take(100)); // No final in time: its live text is taken.
    s.message("{\"message_type\":\"partial_transcript\",\"text\":\"send the report over\"}");
    s.message("{\"message_type\":\"committed_transcript\",\"text\":\"Send the report. Over.\"}");
    assertEquals("its final, late, isn't the next turn's", "", s.text());
    s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Mm\"}");
    s.discard();
    s.message("{\"message_type\":\"committed_transcript\",\"text\":\"Mm.\"}");
    assertEquals("", s.text());
    s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Next\"}");
    assertEquals("Next", s.text());
    s.close();
    // AssemblyAI: a turn that came final twice counts once.
    StreamingSpeech a = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of());
    a.message("{\"type\":\"Turn\",\"turn_order\":0,\"end_of_turn\":true,\"transcript\":\"Book it.\"}");
    a.message("{\"type\":\"Turn\",\"turn_order\":0,\"end_of_turn\":true,\"transcript\":\"Book it.\"}");
    assertEquals("Book it.", a.text());
  }

  /**
   * A provider for several connections in turn: it answers each upgrade, sends what the test tells
   * it to on the latest connection, can end its session (close 1000, as AssemblyAI does at its
   * limit), and counts the connections and the ForceEndpoints it got.
   */
  static final class Provider implements AutoCloseable {
    final ServerSocket socket = new ServerSocket(0);
    final java.util.concurrent.atomic.AtomicInteger connections = new java.util.concurrent.atomic.AtomicInteger(),
        forces = new java.util.concurrent.atomic.AtomicInteger();
    private volatile OutputStream out;
    private volatile Socket last;

    /** The latest connection is cut (the network: no close frame). */
    void abort() throws Exception {
      Socket c = last;
      c.setSoLinger(true, 0);
      c.close();
    }

    Provider() throws Exception {
      Thread t =
          new Thread(
              () -> {
                while (!socket.isClosed())
                  try {
                    Socket c = socket.accept();
                    InputStream in = c.getInputStream();
                    StringBuilder head = new StringBuilder();
                    while (!head.toString().endsWith("\r\n\r\n")) head.append((char) in.read());
                    String key = head.toString().replaceAll("(?s).*Sec-WebSocket-Key: ([^\r]+).*", "$1");
                    OutputStream o = c.getOutputStream();
                    o.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + WebSocket.expectedAccept(key) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    o.flush();
                    out = o;
                    last = c;
                    connections.incrementAndGet();
                    Thread reader = new Thread(() -> read(c, in));
                    reader.setDaemon(true);
                    reader.start();
                  } catch (Exception closed) {
                    return;
                  }
              });
      t.setDaemon(true);
      t.start();
    }

    /** The client's frames (masked): text ones are looked at, the rest is audio. */
    private void read(Socket c, InputStream in) {
      try (c) {
        while (true) {
          int b0 = in.read(), b1 = in.read();
          if (b0 < 0 || b1 < 0) return;
          long n = b1 & 0x7f;
          if (n == 126) n = ((in.read() & 0xff) << 8) | (in.read() & 0xff);
          else if (n == 127) n = java.nio.ByteBuffer.wrap(in.readNBytes(8)).getLong();
          byte[] mask = in.readNBytes(4), payload = in.readNBytes((int) n);
          for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
          if ((b0 & 0x0f) == 0x8) return;
          if ((b0 & 0x0f) == 0x1 && new String(payload, StandardCharsets.UTF_8).contains("ForceEndpoint")) forces.incrementAndGet();
        }
      } catch (Exception gone) {
        /* Closed. */
      }
    }

    /** A text message on the latest connection. */
    void send(String text) throws Exception {
      byte[] b = text.getBytes(StandardCharsets.UTF_8);
      java.io.ByteArrayOutputStream f = new java.io.ByteArrayOutputStream();
      f.write(0x81);
      if (b.length < 126) f.write(b.length);
      else {
        f.write(126);
        f.write(b.length >> 8);
        f.write(b.length & 0xff);
      }
      f.write(b);
      synchronized (this) {
        out.write(f.toByteArray());
        out.flush();
      }
    }

    /** The provider ends the session (its time limit): close 1000. */
    void endSession() throws Exception {
      synchronized (this) {
        out.write(new byte[] {(byte) 0x88, 2, 0x03, (byte) 0xe8});
        out.flush();
      }
    }

    String url() {
      return "ws://127.0.0.1:" + socket.getLocalPort() + "/v3/ws";
    }

    @Override
    public void close() throws Exception {
      socket.close();
    }
  }

  /** Waits until the condition holds (at most 2 s). */
  static void until(java.util.function.BooleanSupplier c) throws Exception {
    for (int i = 0; i < 100 && !c.getAsBoolean(); i++) Thread.sleep(20);
    assertTrue(c.getAsBoolean());
  }

  /** An AssemblyAI turn message. */
  static String turn(int order, boolean end, String transcript) {
    return "{\"type\":\"Turn\",\"turn_order\":" + order + ",\"end_of_turn\":" + end + ",\"transcript\":\"" + transcript + "\"}";
  }

  /** 100 ms of audio (one chunk): what makes it check whether to close after a minute. */
  static void chunk(StreamingSpeech s) {
    for (int i = 0; i < StreamingSpeech.CHUNK_MS / HandsFree.Segmenter.FRAME_MS; i++) s.audio(new byte[640]);
  }

  /** Open, a minute without speech (closed: it's billed while open), then speech again: open anew. */
  static void reconnect(StreamingSpeech s, java.util.concurrent.atomic.AtomicLong now, Provider p) throws Exception {
    int before = p.connections.get();
    List<String> events = new CopyOnWriteArrayList<>();
    java.util.function.Consumer<String> was = s.events;
    s.events = e -> {
      events.add(e);
      was.accept(e);
    };
    now.addAndGet(StreamingSpeech.IDLE_MS);
    chunk(s);
    until(() -> String.join("\n", events).contains("closed: no speech"));
    s.events = was;
    s.speech();
    until(() -> p.connections.get() == before + 1);
    Thread.sleep(100);
  }

  @Test
  public void assemblyAiCountsTurnsAfreshOnANewConnection() throws Exception {
    // Philipp's call, 27 October 2026, 09:17:52: the connection closed after a minute without
    // speech and opened again; the new session's turns counted from 0 again and were taken for
    // repeats of the last session's: "Okay." never came, so "Over." alone sent nothing.
    String was = StreamingSpeech.assemblyAiUrl;
    try (Provider p = new Provider()) {
      StreamingSpeech.assemblyAiUrl = p.url();
      java.util.concurrent.atomic.AtomicLong now = new java.util.concurrent.atomic.AtomicLong(1_000_000);
      StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of());
      s.clock = now::get;
      s.speech();
      until(() -> p.connections.get() == 1);
      for (int i = 0; i <= 3; i++) {
        p.send(turn(i, true, "Message " + i + ". Over."));
        int n = i;
        until(() -> s.text().equals("Message " + n + ". Over."));
        s.take(100);
      }
      reconnect(s, now, p);
      p.send(turn(0, false, "Okay"));
      until(() -> s.text().equals("Okay"));
      p.send(turn(0, true, "Okay."));
      until(() -> s.text().equals("Okay."));
      p.send(turn(1, false, "Over."));
      until(() -> s.text().equals("Okay. Over."));
      p.send(turn(1, true, "Over."));
      assertEquals("Okay. Over.", s.take(1000));
      // And again after the next reconnect, also with a turn dropped just before it.
      p.send(turn(2, false, "Mm"));
      until(() -> s.text().equals("Mm"));
      s.discard();
      reconnect(s, now, p);
      p.send(turn(0, true, "So it seems to be stuck."));
      until(() -> s.text().equals("So it seems to be stuck."));
      s.close();
    } finally {
      StreamingSpeech.assemblyAiUrl = was;
    }
  }

  @Test
  public void aLostConnectionConnectsAgainAndItsTurnsCountAgain() throws Exception {
    // Philipp's call, 27 November 2026, 16:08:46: "software caused connection abort" after 20
    // minutes, and live transcription was gone for the rest of the call ("over" did nothing).
    String was = StreamingSpeech.assemblyAiUrl;
    long retry = StreamingSpeech.RETRY_MS;
    try (Provider p = new Provider()) {
      StreamingSpeech.assemblyAiUrl = p.url();
      StreamingSpeech.RETRY_MS = 50;
      List<String> events = new CopyOnWriteArrayList<>(), drops = new CopyOnWriteArrayList<>();
      StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of());
      s.events = events::add;
      s.onDropped = drops::add;
      s.speech();
      until(() -> p.connections.get() == 1);
      p.send(turn(3, true, "Book the table."));
      until(() -> s.text().equals("Book the table."));
      p.abort();
      until(() -> drops.size() == 1);
      until(() -> p.connections.get() == 2); // Connected again by itself (you're talking).
      assertTrue(s.working());
      until(() -> String.join("\n", events).contains("connecting again (1 of " + StreamingSpeech.RECONNECTS + ")"));
      Thread.sleep(100);
      p.send(turn(0, true, "Over."));
      until(() -> s.text().equals("Book the table. Over."));
      // Lost again and again: given up after RECONNECTS in a row, said once.
      List<String> failed = new CopyOnWriteArrayList<>();
      s.onFailure = failed::add;
      for (int i = 2; i <= StreamingSpeech.RECONNECTS + 1; i++) {
        int n = i;
        p.abort();
        if (i <= StreamingSpeech.RECONNECTS) until(() -> p.connections.get() == n + 1);
      }
      until(() -> failed.size() == 1);
      assertFalse(s.working());
      s.close();
    } finally {
      StreamingSpeech.assemblyAiUrl = was;
      StreamingSpeech.RETRY_MS = retry;
    }
  }

  @Test
  public void whatsLiveWhenTheProviderEndsTheSessionIsKept() throws Exception {
    String was = StreamingSpeech.assemblyAiUrl;
    try (Provider p = new Provider()) {
      StreamingSpeech.assemblyAiUrl = p.url();
      List<String> events = new CopyOnWriteArrayList<>();
      StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of());
      s.events = events::add;
      s.speech();
      until(() -> p.connections.get() == 1);
      p.send(turn(5, false, "Book the table"));
      until(() -> s.text().equals("Book the table"));
      p.endSession(); // Its final never comes.
      until(() -> String.join("\n", events).contains("the provider ended the session"));
      s.speech();
      until(() -> p.connections.get() == 2);
      Thread.sleep(100);
      p.send(turn(0, false, "for Friday"));
      until(() -> s.text().equals("Book the table for Friday"));
      p.send(turn(0, true, "for Friday."));
      until(() -> s.text().equals("Book the table for Friday."));
      s.close();
    } finally {
      StreamingSpeech.assemblyAiUrl = was;
    }
  }

  /** A server that answers the upgrade (after delayMs), then reads what comes and reports when it ends. */
  static final class Server implements AutoCloseable {
    final ServerSocket socket = new ServerSocket(0);
    final java.util.concurrent.CountDownLatch ended = new java.util.concurrent.CountDownLatch(1);

    Server(long delayMs, boolean read) throws Exception {
      new Thread(
              () -> {
                try (Socket c = socket.accept()) {
                  InputStream in = c.getInputStream();
                  StringBuilder head = new StringBuilder();
                  while (!head.toString().endsWith("\r\n\r\n")) head.append((char) in.read());
                  Thread.sleep(delayMs);
                  String key = head.toString().replaceAll("(?s).*Sec-WebSocket-Key: ([^\r]+).*", "$1");
                  c.getOutputStream().write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + WebSocket.expectedAccept(key) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                  if (!read) {
                    Thread.sleep(10_000);
                    return;
                  }
                  byte[] b = new byte[4096];
                  while (true) {
                    int n = in.read(b);
                    if (n < 0) break;
                    if (n >= 1 && (b[0] & 0x0f) == 0x8) break; // A close frame.
                  }
                  ended.countDown();
                } catch (Exception ex) {
                  ended.countDown();
                }
              })
          .start();
    }

    String url() {
      return "ws://127.0.0.1:" + socket.getLocalPort() + "/v3/ws";
    }

    @Override
    public void close() throws Exception {
      socket.close();
    }
  }

  /** Connected to a server that takes what comes, with drops lasting 300 ms. */
  private static void connected(String provider, Server server, java.util.concurrent.Callable<Void> test) throws Exception {
    String aai = StreamingSpeech.assemblyAiUrl, el = StreamingSpeech.elevenLabsUrl;
    long drop = StreamingSpeech.DROP_MS;
    try {
      StreamingSpeech.assemblyAiUrl = server.url();
      StreamingSpeech.elevenLabsUrl = server.url();
      StreamingSpeech.DROP_MS = 300;
      test.call();
    } finally {
      StreamingSpeech.assemblyAiUrl = aai;
      StreamingSpeech.elevenLabsUrl = el;
      StreamingSpeech.DROP_MS = drop;
    }
  }

  private static StreamingSpeech open(StreamingSpeech.Choice c) throws Exception {
    StreamingSpeech s = StreamingSpeech.create(c, "k", List.of());
    s.speech();
    for (int i = 0; i < 100 && s.openedMs < 0; i++) Thread.sleep(20);
    return s;
  }

  @Test
  public void wordsStillComingOfAStretchWrittenDownFromItsAudioStayOutOfTheNextTurn() throws Exception {
    // Send before its first live words: the turn went written down from its audio; then they come.
    try (Server server = new Server(0, true)) {
      connected("elevenlabs", server, () -> {
        StreamingSpeech s = open(StreamingSpeech.ELEVEN);
        assertEquals("", s.take(100));
        s.discard();
        s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Book the table\"}");
        s.message("{\"message_type\":\"committed_transcript\",\"text\":\"Book the table.\"}");
        assertEquals("", s.text());
        s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Next\"}");
        assertEquals("Next", s.text());
        s.close();
        return null;
      });
    }
  }

  @Test
  public void anElevenLabsDropWhoseFinalNeverComesEndsAfterAWhile() throws Exception {
    try (Server server = new Server(0, true)) {
      connected("elevenlabs", server, () -> {
        StreamingSpeech s = open(StreamingSpeech.ELEVEN);
        s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Mm\"}");
        s.discard(); // Its final never comes.
        s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Mm\"}");
        assertEquals("", s.text());
        Thread.sleep(400);
        s.message("{\"message_type\":\"partial_transcript\",\"text\":\"Book the table\"}");
        assertEquals("the next stretch's words show", "Book the table", s.text());
        s.close();
        return null;
      });
    }
  }

  @Test
  public void assemblyAiDropsTheTurnStillComingAndNotTheOneAfter() throws Exception {
    try (Server server = new Server(0, true)) {
      connected("assemblyai", server, () -> {
        StreamingSpeech s = open(StreamingSpeech.AAI_PRO);
        s.message("{\"type\":\"Turn\",\"turn_order\":0,\"end_of_turn\":true,\"transcript\":\"Hello.\"}");
        assertEquals("Hello.", s.take(100));
        s.discard(); // Turn 1's words haven't come yet.
        s.message("{\"type\":\"Turn\",\"turn_order\":1,\"end_of_turn\":false,\"transcript\":\"Book the\"}");
        s.message("{\"type\":\"Turn\",\"turn_order\":1,\"end_of_turn\":true,\"transcript\":\"Book the table.\"}");
        assertEquals("", s.text());
        s.message("{\"type\":\"Turn\",\"turn_order\":2,\"end_of_turn\":false,\"transcript\":\"Next\"}");
        assertEquals("Next", s.text());
        // Dropped with nothing coming after it: a turn starting much later is new speech.
        s.take(100);
        s.discard();
        Thread.sleep(400);
        s.message("{\"type\":\"Turn\",\"turn_order\":3,\"end_of_turn\":false,\"transcript\":\"Later\"}");
        assertEquals("Later", s.text());
        s.close();
        return null;
      });
    }
  }

  @Test
  public void closedWhileItConnectsTheNewConnectionIsClosedAtOnce() throws Exception {
    String was = StreamingSpeech.assemblyAiUrl;
    try (Server server = new Server(400, true)) {
      StreamingSpeech.assemblyAiUrl = server.url().replace("/v3/ws", "/v3/ws");
      StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of());
      s.speech(); // Connecting (the call starts).
      Thread.sleep(100);
      s.close(); // The call ends before it's open.
      assertTrue("the connection that opened after was closed", server.ended.await(3, java.util.concurrent.TimeUnit.SECONDS));
    } finally {
      StreamingSpeech.assemblyAiUrl = was;
    }
  }

  @Test
  public void askingForTheFinalTextThatHangsFailsInsteadOfFiringLater() throws Exception {
    String was = StreamingSpeech.assemblyAiUrl;
    try (Server server = new Server(0, true)) {
      StreamingSpeech.assemblyAiUrl = server.url();
      java.util.concurrent.CountDownLatch stuck = new java.util.concurrent.CountDownLatch(1);
      StreamingSpeech s =
          new StreamingSpeech.AssemblyAi(StreamingSpeech.AAI_PRO, "k", List.of()) {
            @Override
            void force(WebSocket ws) throws Exception {
              stuck.await(); // The connection's write hangs.
            }
          };
      s.speech();
      for (int i = 0; i < 100 && s.openedMs < 0; i++) Thread.sleep(20);
      s.message("{\"type\":\"Turn\",\"turn_order\":0,\"end_of_turn\":false,\"transcript\":\"Book the\"}");
      long start = System.currentTimeMillis();
      try {
        s.take(300);
        throw new AssertionError("it should fail");
      } catch (java.io.IOException expected) {
        assertTrue(expected.getMessage(), expected.getMessage().contains("couldn't ask for the final text"));
      }
      assertTrue(System.currentTimeMillis() - start < 2000);
      assertFalse(s.working());
      assertTrue("the stuck connection is closed (it's billed while open)", server.ended.await(2, java.util.concurrent.TimeUnit.SECONDS));
      s.close();
    } finally {
      StreamingSpeech.assemblyAiUrl = was;
    }
  }

  @Test
  public void aTlsHandshakeThatStallsGivesUp() throws Exception {
    try (ServerSocket silent = new ServerSocket(0)) {
      new Thread(
              () -> {
                try (Socket c = silent.accept()) {
                  Thread.sleep(5000); // Accepts, says nothing.
                } catch (Exception ignored) {
                }
              })
          .start();
      long start = System.currentTimeMillis();
      try {
        WebSocket.open("wss://127.0.0.1:" + silent.getLocalPort() + "/", java.util.Map.of(), null, 500);
        throw new AssertionError("it should give up");
      } catch (java.io.IOException expected) {
        assertTrue(String.valueOf(System.currentTimeMillis() - start), System.currentTimeMillis() - start < 3000);
      }
    }
  }

  @Test
  public void closeDoesntWaitBehindAWriteThatHangs() throws Exception {
    try (Server server = new Server(0, false)) { // It never reads: writes fill up and hang.
      WebSocket ws =
          WebSocket.open(
              server.url(),
              java.util.Map.of(),
              new WebSocket.Listener() {
                public void message(String text) {}

                public void ended(int code, String why) {}
              },
              2000);
      Thread writer =
          new Thread(
              () -> {
                byte[] big = new byte[1 << 20];
                try {
                  while (true) ws.send(big, 0, big.length);
                } catch (Exception gone) {
                  /* Closed under it. */
                }
              });
      writer.start();
      Thread.sleep(800); // By now a write hangs.
      long start = System.currentTimeMillis();
      ws.close();
      assertTrue(String.valueOf(System.currentTimeMillis() - start), System.currentTimeMillis() - start < 500);
      writer.join(2000);
      assertFalse("the hanging write ended too", writer.isAlive());
    }
  }

  @Test
  public void aLongFrameHasItsLengthInTwoOrEightBytes() {
    byte[] mask = {1, 2, 3, 4};
    byte[] f = WebSocket.encode(0x2, new byte[200], mask);
    assertEquals(0x82, f[0] & 0xff);
    assertEquals(0x80 | 126, f[1] & 0xff);
    assertEquals(200, ((f[2] & 0xff) << 8) | (f[3] & 0xff));
    assertEquals(4 + 4 + 200, f.length);
    byte[] g = WebSocket.encode(0x2, new byte[70_000], mask);
    assertEquals(0x80 | 127, g[1] & 0xff);
    assertEquals(70_000, ((g[6] & 0xff) << 24) | ((g[7] & 0xff) << 16) | ((g[8] & 0xff) << 8) | (g[9] & 0xff));
    assertEquals(2 + 8 + 4 + 70_000, g.length);
  }
}
