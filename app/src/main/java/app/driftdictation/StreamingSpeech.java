package app.driftdictation;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONObject;

/**
 * Hands-free's live transcription: the microphone's audio streams to a speech model as you talk
 * (AssemblyAI or ElevenLabs, with your own key), and its text comes back while you speak. A send
 * phrase at the end of it sends your turn at once; take() ends the turn with the model's final text.
 *
 * <p>Text comes in two kinds: final (a stretch the model is done with) and live (what it has of
 * the stretch going on, changing). The turn is the finals since the last take(), then the live
 * text. The connection is opened on the first speech and closed after IDLE_MS without any (the
 * providers bill the time it's open); the last RING_MS of audio is kept, so what you said while it
 * connected is sent first.
 */
abstract class StreamingSpeech implements HandsFreeSession.LiveText {
  /** A choice in Settings → Hands-free → Streaming transcription. */
  /** perHour: the provider's list price for an hour it's open, in dollars (October 2026). */
  record Choice(String id, String name, String note, String provider, String model, double perHour) {
    String label() {
      return name + " · " + note;
    }
  }

  static final String ASSEMBLYAI = "assemblyai", ELEVENLABS = "elevenlabs";
  /** Where each provider's key is kept (the Vault). */
  static final String ASSEMBLYAI_KEY = "assemblyaiKey", ELEVENLABS_KEY = "elevenlabsKey";

  /**
   * Measured on Philipp's dictations (October 2026): Universal-3.6 Pro made the fewest
   * meaning-changing mistakes (8 in 18 minutes), ElevenLabs 13 (and once dropped 30 s), Universal
   * Streaming English 16 but is the quickest and cheapest.
   */
  static final Choice AAI_PRO = new Choice("aai-pro", "AssemblyAI Universal-3.6 Pro", "most accurate", ASSEMBLYAI, "universal-3-6-pro", 0.45),
      ELEVEN = new Choice("eleven", "ElevenLabs Scribe v2 Realtime", "second best", ELEVENLABS, "scribe_v2_realtime", 0.39),
      AAI_EN = new Choice("aai-en", "AssemblyAI Universal Streaming (English)", "fastest, cheapest, less accurate", ASSEMBLYAI, "universal-streaming-english", 0.15);

  static final Choice[] CHOICES = {AAI_PRO, ELEVEN, AAI_EN};
  static final Choice DEFAULT = AAI_PRO;

  static Choice choice(String id) {
    for (Choice c : CHOICES) if (c.id().equals(id)) return c;
    return DEFAULT;
  }

  static String keyName(Choice c) {
    return c.provider().equals(ELEVENLABS) ? ELEVENLABS_KEY : ASSEMBLYAI_KEY;
  }

  /** Where the providers are (the device tests point these at a fake). */
  static volatile String assemblyAiUrl = BuildConfig.ASSEMBLYAI_URL, elevenLabsUrl = BuildConfig.ELEVENLABS_URL;

  static StreamingSpeech create(Choice c, String key, List<String> keyterms) {
    return c.provider().equals(ELEVENLABS) ? new ElevenLabs(c, key) : new AssemblyAi(c, key, keyterms);
  }

  /** Closed after this long without your speech; opened again when you speak. */
  static final long IDLE_MS = 60_000;
  /** Audio kept while it's closed (or connecting), sent first once it's open. */
  static final int RING_MS = 2000;
  /** Audio goes out in chunks of this much (the providers want 50 ms to 1 s). */
  static final int CHUNK_MS = 100;

  final Choice choice;
  final String key;
  private volatile WebSocket socket;
  private volatile boolean connecting, failed;
  private volatile String failure = "";
  /** The finals in order, the turn's first among them, and the live text. */
  private final List<String> finals = new ArrayList<>();
  private int turnStart;
  private String live = "";
  /** Finals asked for (take): counted up when one comes. */
  private int finalsSeen;
  /**
   * Stretches dropped (taken without their final, or discarded): their live text and late final
   * are ignored when they come, up to and including this stretch (finalsSeen counts them).
   */
  private int dropThrough = -1;
  /** A drop lasts at most until then: a final that never comes doesn't hide the next stretch. */
  private long dropUntil;
  /** How long a dropped stretch's late messages are waited for (tests shorten it). */
  static volatile long DROP_MS = 2000;
  /** Closed for good (the call ended): a connection opening meanwhile is closed at once. */
  private boolean closed;
  private final java.util.ArrayDeque<byte[]> ring = new java.util.ArrayDeque<>();
  private final java.io.ByteArrayOutputStream chunk = new java.io.ByteArrayOutputStream();
  private volatile long lastSpeech = Long.MIN_VALUE / 2;
  /** When it last opened, and how long that took (for the log). */
  volatile long openedMs = -1;
  /** When the first words of the turn came, after its first audio (for the log). */
  private final java.util.concurrent.ExecutorService sender = java.util.concurrent.Executors.newSingleThreadExecutor();
  volatile java.util.function.Consumer<String> changed = t -> {};
  volatile java.util.function.Consumer<String> events = e -> {};
  /** Hears once why it failed (the session says it on screen). */
  volatile java.util.function.Consumer<String> onFailure = why -> {};
  /** The time; tests set their own. */
  java.util.function.LongSupplier clock = System::currentTimeMillis;

  StreamingSpeech(Choice choice, String key) {
    this.choice = choice;
    this.key = key;
  }

  abstract String url();

  abstract java.util.Map<String, String> headers();

  /** One chunk of 16 kHz 16-bit mono audio, as this provider wants it sent. */
  abstract void sendAudio(WebSocket ws, byte[] pcm) throws Exception;

  /** Asks for the final text of what's live now. */
  abstract void force(WebSocket ws) throws Exception;

  /** A message from the provider: calls live() and finished() as it goes. */
  abstract void message(String text) throws Exception;

  /** The live text of the stretch going on. */
  final void live(String text) {
    String t;
    synchronized (this) {
      if (dropping()) return; // A dropped stretch's: not this turn's.
      live = text == null ? "" : text.trim();
      t = textLocked();
    }
    changed.accept(t);
  }

  /** A final text: what was live is done. */
  final void finished(String text) {
    String t;
    synchronized (this) {
      String f = text == null ? "" : text.trim();
      boolean dropped = dropping(); // Late, for a stretch already taken or dropped.
      if (!f.isEmpty() && !dropped) finals.add(f);
      if (!dropped) live = "";
      finalsSeen++;
      notifyAll();
      t = textLocked();
    }
    changed.accept(t);
  }

  /** The stretch going on is dropped: what still comes of it is ignored (under the lock). */
  private void drop() {
    boolean empty = live.isEmpty();
    if (!byTurn()) {
      dropThrough = finalsSeen;
      dropUntil = clock.getAsLong() + DROP_MS;
    }
    dropped(empty);
  }

  /** Is what comes now a dropped stretch's (under the lock)? Not past its time. */
  private boolean dropping() {
    if (finalsSeen > dropThrough) return false;
    if (clock.getAsLong() > dropUntil) {
      dropThrough = finalsSeen - 1;
      return false;
    }
    return true;
  }

  /** Does the provider say which stretch a message is of (then it drops by that)? */
  boolean byTurn() {
    return false;
  }

  /** Told when the stretch going on is dropped, and whether nothing of it had come yet (under the lock). */
  void dropped(boolean nothingYet) {}

  private String textLocked() {
    StringBuilder b = new StringBuilder();
    for (int i = turnStart; i < finals.size(); i++) b.append(b.length() == 0 ? "" : " ").append(finals.get(i));
    if (!live.isEmpty()) b.append(b.length() == 0 ? "" : " ").append(live);
    return b.toString();
  }

  @Override
  public synchronized String text() {
    return textLocked();
  }

  @Override
  public boolean working() {
    return !failed;
  }

  @Override
  public String failure() {
    return failure;
  }

  /** It can't be used for this call any more: why, once. */
  final void fail(String why) {
    synchronized (this) {
      if (failed) return;
      failed = true;
      failure = why;
      notifyAll();
    }
    // Not used again this call: closed now (it's billed while open).
    WebSocket ws = socket;
    socket = null;
    if (ws != null) ws.close();
    events.accept("streaming transcription failed: " + why);
    onFailure.accept(why);
  }

  @Override
  public void audio(byte[] frame) {
    if (failed) return;
    byte[] out = null;
    synchronized (this) {
      chunk.write(frame, 0, frame.length);
      if (chunk.size() >= AudioFiles.BYTES_PER_SECOND * CHUNK_MS / 1000) {
        out = chunk.toByteArray();
        chunk.reset();
      }
    }
    if (out == null) return;
    byte[] c = out;
    try {
      sender.execute(() -> deliver(c));
    } catch (java.util.concurrent.RejectedExecutionException closed) {
      /* Closed. */
    }
  }

  /** On the sender thread: the chunk goes out, or into the ring while it's closed. */
  private void deliver(byte[] c) {
    if (closedForGood()) return;
    WebSocket ws = socket;
    long now = clock.getAsLong();
    if (ws == null || !ws.open()) {
      ring.addLast(c);
      while (ring.size() > RING_MS / CHUNK_MS) ring.removeFirst();
      if (!connecting && now - lastSpeech < IDLE_MS) connect();
      return;
    }
    if (now - lastSpeech >= IDLE_MS && text().isEmpty()) {
      events.accept("streaming transcription closed: no speech for " + IDLE_MS / 1000 + " s (it's billed while open)");
      socket = null;
      ws.close();
      closed(now);
      ring.addLast(c);
      return;
    }
    try {
      sendAudio(ws, c);
    } catch (Exception ex) {
      ring.addLast(c);
    }
  }

  @Override
  public void speech() {
    lastSpeech = clock.getAsLong();
    if (failed || connecting) return;
    WebSocket ws = socket;
    if (ws == null || !ws.open())
      try {
        sender.execute(this::connect);
      } catch (java.util.concurrent.RejectedExecutionException closed) {
        /* Closed. */
      }
  }

  /** On the sender thread: opens the connection, then sends what the ring kept. */
  private synchronized boolean closedForGood() {
    return closed;
  }

  private void connect() {
    if (failed || connecting || closedForGood() || socket != null && socket.open()) return;
    connecting = true;
    long start = clock.getAsLong();
    int session = newSession();
    try {
      WebSocket ws =
          WebSocket.open(
              "live transcription " + choice.model(),
              url(),
              headers(),
              new WebSocket.Listener() {
                public void message(String text) {
                  if (session != sessions) return; // An earlier connection's, late: not this session's.
                  try {
                    StreamingSpeech.this.message(text);
                  } catch (Exception ex) {
                    events.accept("streaming transcription: a message not understood (" + ex.getMessage() + ")");
                  }
                }

                public void ended(int code, String why) {
                  if (session != sessions) return; // An earlier connection's: the new one is open.
                  closed(clock.getAsLong());
                  if (why.equals("closed")) return; // We closed it.
                  if (code == 1000) { // Ended normally by the provider (its session limit): opened again when you speak.
                    socket = null;
                    events.accept("streaming transcription: the provider ended the session" + (why.isEmpty() ? "" : " (" + why + ")") + "; it opens again when you speak");
                    return;
                  }
                  // Closed by the provider while in use: why (a bad key, no credit, its limit).
                  fail((why.isEmpty() ? "connection lost" : why) + (code == 1006 || code == 1005 ? "" : " (" + code + ")"));
                }
              },
              10_000);
      boolean late;
      synchronized (this) {
        late = closed;
        if (!late) socket = ws;
      }
      if (late) { // The call ended while it connected.
        ws.close();
        return;
      }
      openedMs = clock.getAsLong() - start;
      openSince = clock.getAsLong();
      events.accept(String.format(Locale.ROOT, "streaming transcription (%s) open in %d ms", choice.model(), openedMs));
      while (!ring.isEmpty()) sendAudio(ws, ring.removeFirst());
    } catch (Exception ex) {
      fail("couldn't connect: " + ex.getMessage());
    } finally {
      connecting = false;
    }
  }

  /** Connections opened so far: each is a session of its own at the provider. */
  private volatile int sessions;

  /**
   * A new connection is a new session at the provider: it counts its stretches from the start
   * again (AssemblyAI's turn_order from 0), and nothing more comes of the last one's. What was
   * still live of it is kept as final; a drop waiting for its late messages is over.
   */
  private int newSession() {
    synchronized (this) {
      if (!live.isEmpty()) finals.add(live);
      live = "";
      dropThrough = finalsSeen - 1;
      opened();
      return ++sessions;
    }
  }

  /** A new session starts (under the lock): what the provider counts starts again. */
  void opened() {}

  @Override
  public String take(long waitMs) throws Exception {
    if (failed) throw new java.io.IOException(failure);
    WebSocket ws = socket;
    int asked;
    boolean pending;
    synchronized (this) {
      asked = finalsSeen;
      pending = !live.isEmpty();
    }
    // Nothing live: the last final is the end of it (forcing would bring nothing).
    if (pending && ws != null && ws.open()) {
      try {
        java.util.concurrent.Future<Object> asking =
            sender.submit(
                () -> {
                  force(ws);
                  return null;
                });
        try {
          asking.get(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException stuck) {
          // Couldn't even ask (the connection is stuck): not used again this call.
          asking.cancel(true);
          fail("couldn't ask for the final text in " + waitMs + " ms");
        }
      } catch (java.util.concurrent.ExecutionException ex) {
        throw ex.getCause() instanceof Exception e ? e : ex;
      }
      long until = clock.getAsLong() + waitMs;
      synchronized (this) {
        while (finalsSeen == asked && !failed) {
          long left = until - clock.getAsLong();
          if (left <= 0) break;
          wait(left);
        }
      }
    }
    if (failed) throw new java.io.IOException(failure);
    boolean forced = pending && ws != null && ws.open();
    synchronized (this) {
      if (finalsSeen == asked && forced) {
        events.accept("streaming transcription: no final within " + waitMs + " ms; its live text is taken");
        drop(); // Its final, when it comes, isn't the next turn's.
      }
      if (!live.isEmpty()) finals.add(live);
      live = "";
      String t = textLocked();
      turnStart = finals.size();
      return t;
    }
  }

  @Override
  public void discard() {
    WebSocket ws = socket;
    synchronized (this) {
      // What's in flight of this stretch (its words may not have come yet: its audio went out
      // written down from the audio) is dropped when it comes, as its final (asked for below).
      if (ws != null && ws.open()) drop();
      turnStart = finals.size();
      live = "";
    }
    if (ws != null && ws.open())
      try {
        sender.execute(
            () -> {
              try {
                force(ws);
              } catch (Exception ignored) {
                /* Only a cleanup. */
              }
            });
      } catch (java.util.concurrent.RejectedExecutionException closed) {
        /* Closed. */
      }
  }

  /** When it was opened (0: it's closed), and how long it's been open in all. */
  private volatile long openSince, openMs;

  /** It closed: its time open counts. */
  private void closed(long now) {
    if (openSince > 0) openMs += now - openSince;
    openSince = 0;
  }

  /** How long it was open in this call, and what that costs at the provider's list price. */
  String usage() {
    long ms = openMs + (openSince > 0 ? clock.getAsLong() - openSince : 0);
    return String.format(Locale.ROOT, "open %d s in all, about $%.4f at %s's list price ($%.2f an hour)", ms / 1000, ms / 3_600_000.0 * choice.perHour(), choice.provider(), choice.perHour());
  }

  @Override
  public void close() {
    synchronized (this) {
      closed = true;
    }
    events.accept("streaming transcription: " + usage());
    sender.shutdownNow();
    WebSocket ws = socket;
    socket = null;
    if (ws != null) ws.close();
  }

  // ------------------------------------------------------------------ the providers

  /**
   * AssemblyAI's v3 streaming: raw PCM as binary messages; "Turn" messages with the words so far,
   * end_of_turn true when the turn's done (ForceEndpoint ends it now). Universal Streaming English
   * sends each turn's end twice, the second formatted: that one counts.
   */
  static class AssemblyAi extends StreamingSpeech {
    private final List<String> keyterms;
    /**
     * The last turn that came final, the turn live now, and the one dropped (-1: none); written on
     * the caller's thread, read on the connection's.
     */
    private volatile int lastTurn = -1, liveTurn = -1, droppedTurn = -1;
    /** The dropped turn hadn't shown up yet (a guess: the next one), and when it was dropped. */
    private volatile boolean guessed;
    private volatile long droppedAt;

    @Override
    boolean byTurn() {
      return true;
    }

    @Override
    void opened() {
      // Each session's turn_order starts at 0. Kept from the last session, its turns would count
      // as repeats of turns already final and be ignored: words lost after every reconnect
      // (Philipp's call, 27 October 2026: "Okay." and then "Over." sent nothing).
      lastTurn = liveTurn = droppedTurn = -1;
      guessed = false;
    }

    @Override
    void dropped(boolean nothingYet) {
      // Nothing of it had come: it's the turn after the last one seen.
      droppedTurn = nothingYet ? Math.max(liveTurn, lastTurn) + 1 : liveTurn;
      guessed = nothingYet;
      droppedAt = clock.getAsLong();
    }

    AssemblyAi(Choice c, String key, List<String> keyterms) {
      super(c, key);
      this.keyterms = keyterms;
    }

    String url() {
      StringBuilder u = new StringBuilder(assemblyAiUrl).append("?sample_rate=16000&encoding=pcm_s16le&speech_model=").append(choice.model());
      if (choice.model().equals(AAI_EN.model())) u.append("&format_turns=true");
      if (!keyterms.isEmpty()) {
        org.json.JSONArray terms = new org.json.JSONArray();
        for (String t : keyterms) if (terms.length() < 100 && t.length() <= 50) terms.put(t);
        try {
          u.append("&keyterms_prompt=").append(java.net.URLEncoder.encode(terms.toString(), "UTF-8"));
        } catch (java.io.UnsupportedEncodingException ignored) {
          /* UTF-8 is always there. */
        }
      }
      return u.toString();
    }

    java.util.Map<String, String> headers() {
      return java.util.Map.of("Authorization", key);
    }

    void sendAudio(WebSocket ws, byte[] pcm) throws Exception {
      ws.send(pcm, 0, pcm.length);
    }

    void force(WebSocket ws) throws Exception {
      ws.send("{\"type\":\"ForceEndpoint\"}");
    }

    void message(String text) throws Exception {
      JSONObject m = new JSONObject(text);
      String type = m.optString("type");
      if (type.equals("Turn")) {
        int order = m.optInt("turn_order", -1);
        int dropped = droppedTurn;
        if (dropped >= 0 && order == dropped && guessed && order != liveTurn && clock.getAsLong() - droppedAt > DROP_MS)
          dropped = droppedTurn = -1; // The guessed turn started long after: new speech, not the dropped audio.
        if (dropped >= 0 && order > dropped) dropped = droppedTurn = -1; // Past it.
        if (order >= 0) liveTurn = order;
        if (dropped >= 0 && order == dropped) { // The dropped turn's words, or its final: not this turn's.
          if (m.optBoolean("end_of_turn")) lastTurn = Math.max(lastTurn, order);
          return;
        }
        boolean formatted = !choice.model().equals(AAI_EN.model()) || m.optBoolean("turn_is_formatted");
        if (m.optBoolean("end_of_turn") && formatted) {
          // One final per turn (Universal-3.6 Pro sent one each in Philipp's runs; a repeat is dropped).
          int turn = m.optInt("turn_order", -1);
          if (turn >= 0 && turn <= lastTurn) return;
          lastTurn = Math.max(lastTurn, turn);
          finished(m.optString("transcript"));
        }
        else {
          String t = m.optString("transcript");
          if (t.isEmpty()) {
            StringBuilder w = new StringBuilder();
            org.json.JSONArray words = m.optJSONArray("words");
            for (int i = 0; words != null && i < words.length(); i++) w.append(i == 0 ? "" : " ").append(words.getJSONObject(i).optString("text"));
            t = w.toString();
          }
          live(t);
        }
      } else if (type.equals("Error") || m.has("error")) fail(m.optString("error", text));
    }
  }

  /**
   * ElevenLabs' Scribe v2 realtime: audio as base64 in JSON, committed by us (commit_strategy
   * manual: at once when asked, instead of after 1.5 s of silence, which took about 5 s).
   */
  static final class ElevenLabs extends StreamingSpeech {
    ElevenLabs(Choice c, String key) {
      super(c, key);
    }

    String url() {
      return elevenLabsUrl + "?model_id=" + choice.model() + "&audio_format=pcm_16000&language_code=en&commit_strategy=manual";
    }

    java.util.Map<String, String> headers() {
      return java.util.Map.of("xi-api-key", key);
    }

    private static String chunk(byte[] pcm, boolean commit) throws Exception {
      return new JSONObject()
          .put("message_type", "input_audio_chunk")
          .put("audio_base_64", java.util.Base64.getEncoder().encodeToString(pcm))
          .put("commit", commit)
          .put("sample_rate", 16000)
          .toString();
    }

    void sendAudio(WebSocket ws, byte[] pcm) throws Exception {
      ws.send(chunk(pcm, false));
    }

    void force(WebSocket ws) throws Exception {
      ws.send(chunk(new byte[0], true));
    }

    void message(String text) throws Exception {
      JSONObject m = new JSONObject(text);
      String type = m.optString("message_type");
      switch (type) {
        case "partial_transcript" -> live(m.optString("text"));
        case "committed_transcript" -> finished(m.optString("text"));
        case "session_started", "committed_transcript_with_timestamps" -> {}
        default -> {
          if (type.contains("error") || type.equals("quota_exceeded") || type.contains("limit")) fail(type + ": " + m.optString("error", m.optString("message", text)));
        }
      }
    }
  }
}
