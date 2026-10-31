package app.driftdictation;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONObject;
import org.junit.Test;

public class HandsFreeTest {
  final List<String> send = HandsFree.list(HandsFree.DEFAULT_SEND), end = HandsFree.list(HandsFree.DEFAULT_END);

  @Test
  public void wordListsComeFromTheSetting() {
    // English, one word per action, by default: "over", which Jev confirms (see below).
    assertEquals(List.of("over"), send);
    assertEquals(List.of("end the call"), end);
    assertEquals(List.of("a", "b c"), HandsFree.list(" a ,, b c\n ,"));
    assertEquals(List.of(), HandsFree.list(""));
  }

  @Test
  public void aSendWordCountsOnlyAtTheEnd() {
    assertEquals("Book a table for Friday.", HandsFree.endsWith("Book a table for Friday. Over.", send));
    assertEquals("book a table", HandsFree.endsWith("book a table, over!", send));
    assertEquals("Buch einen Tisch.", HandsFree.endsWith("Buch einen Tisch. Schick ab.", HandsFree.list("over, schick ab")));
    assertEquals("", HandsFree.endsWith("Over.", send));
    // Not at the end, or only part of a word: keep listening.
    assertNull(HandsFree.endsWith("Over the weekend I want to rest.", send));
    assertNull(HandsFree.endsWith("We went to Hanover", send));
    assertNull(HandsFree.endsWith("I'll hand it over to her soon", send));
    // "over" ending a sentence matches too: whether it was the send word is Jev's to say.
    assertEquals("Let someone live there for 3 months until the period is", HandsFree.endsWith("Let someone live there for 3 months until the period is over.", send));
    // Apostrophes, accents and case don't matter.
    assertEquals("Thanks.", HandsFree.endsWith("Thanks. End the call.", end));
    assertEquals("Danke", HandsFree.endsWith("Danke, das war's!", HandsFree.list("das wars")));
    // "That's all" alone no longer ends hands-free.
    assertNull(HandsFree.endsWith("That's all.", end));

    assertNull(HandsFree.endsWith("", send));
  }

  // ------------------------------------------------------------------ voice activity

  static byte[] frame(int amplitude) {
    byte[] f = new byte[640];
    for (int i = 0; i < 320; i++) {
      int s = (int) (amplitude * Math.sin(i * 2 * Math.PI * 220 / 16000.0));
      f[2 * i] = (byte) s;
      f[2 * i + 1] = (byte) (s >> 8);
    }
    return f;
  }

  static void feed(HandsFree.Segmenter s, int amplitude, int ms) {
    for (int i = 0; i < ms / 20; i++) s.frame(frame(amplitude));
  }

  @Test
  public void speechBetweenPausesBecomesOneStretchWithoutTheSilence() {
    List<byte[]> out = new ArrayList<>();
    HandsFree.Segmenter s = new HandsFree.Segmenter(3000, out::add);
    feed(s, 50, 2000); // Room noise.
    feed(s, 6000, 1000); // Speech.
    feed(s, 50, 1500); // A short pause: still the same stretch.
    assertTrue(out.isEmpty());
    feed(s, 6000, 1000);
    feed(s, 50, 3100); // The pause that ends it.
    assertEquals(1, out.size());
    // 2 s of speech, the 1.5 s pause inside, and 0.3 s before and after; not the 3 s pause.
    double seconds = out.get(0).length / (double) AudioFiles.BYTES_PER_SECOND;
    assertEquals(4.1, seconds, 0.1);
    assertTrue(s.quietMs() >= 3000);
  }

  @Test
  public void aClickIsNotSpeechAndFlushEndsAStretch() {
    List<byte[]> out = new ArrayList<>();
    HandsFree.Segmenter s = new HandsFree.Segmenter(3000, out::add);
    feed(s, 50, 1000);
    feed(s, 9000, 20); // One loud frame.
    feed(s, 50, 4000);
    assertTrue(out.isEmpty());
    feed(s, 6000, 600);
    assertTrue(s.speaking());
    s.flush();
    assertEquals(1, out.size());
    assertFalse(s.speaking());
  }

  // ------------------------------------------------------------------ the session

  /** A session whose speech model returns queued texts, one per stretch. */
  static final class Fake {
    final List<String> transcripts = new CopyOnWriteArrayList<>(), sent = new CopyOnWriteArrayList<>(),
        spoken = new CopyOnWriteArrayList<>(), log = new CopyOnWriteArrayList<>();
    /** The prepared voices let go of (not played). */
    final List<Object> dropped = new CopyOnWriteArrayList<>();
    /** Ends the reply being read, played to the end. */
    volatile Runnable done, fail;
    /** The voice: its audio starts at once (as long as this is true), or never. */
    volatile boolean audioStarts = true, audioPlaying, stopped;
    volatile int heardChars;
    /** While set, the speech model waits for it (a slow transcription). */
    volatile java.util.concurrent.CountDownLatch slow;
    /** While set, delivering to bb waits for it (a slow bb). */
    volatile java.util.concurrent.CountDownLatch slowBb;
    /** How often the speech model was asked for a part, and for a whole turn of several. */
    final java.util.concurrent.atomic.AtomicInteger transcriptions = new java.util.concurrent.atomic.AtomicInteger(),
        wholes = new java.util.concurrent.atomic.AtomicInteger();
    /** What each part's audio was written down as: a whole turn is its parts' texts. */
    final java.util.Map<java.nio.ByteBuffer, String> heard = new java.util.concurrent.ConcurrentHashMap<>();
    /** Each stretch of speech a little louder than the last, so no two parts are the same audio. */
    int stretches;
    /** What a whole turn's pass makes of its parts' texts (it hears the words at their edges better). */
    volatile java.util.function.UnaryOperator<String> wholeAs = t -> t;
    /** The whole turn's pass fails. */
    volatile boolean wholeFails;
    /** While set, the whole turn's pass waits for it (a slow one). */
    volatile java.util.concurrent.CountDownLatch slowWhole;
    /** While set, bb can't be reached: nothing is delivered. */
    volatile boolean bbDown;
    /** While set, deliveries reach only one of the chief and the talker: "chief" or "talker" misses them. */
    volatile String missedBy;
    /** What preparing a reply does (fetching its audio); by default nothing. */
    volatile java.util.function.Function<String, Object> prepare = text -> text;
    final java.util.concurrent.atomic.AtomicLong now = new java.util.concurrent.atomic.AtomicLong(1_000_000);
    final HandsFreeSession session;

    Fake(String... texts) {
      transcripts.addAll(List.of(texts));
      session =
          new HandsFreeSession(
              1000,
              8000,
              HandsFree.DEFAULT_TAKE_MS,
              HandsFree.DEFAULT_GATE,
              HandsFree.LEVEL,
              HandsFree.list(HandsFree.DEFAULT_SEND),
              HandsFree.list(HandsFree.DEFAULT_END),
              wav -> {
                java.util.concurrent.CountDownLatch l = slow;
                if (l != null) l.await();
                List<java.nio.ByteBuffer> parts = parts(wav);
                if (parts.size() > 1) {
                  // The whole turn in one pass: what its parts were written down as (once they are).
                  StringBuilder all = new StringBuilder();
                  boolean known = heard.containsKey(parts.get(0)); // Else none was written down yet.
                  for (int i = 0; known && i < 100 && !heard.keySet().containsAll(parts); i++) Thread.sleep(20);
                  known &= heard.keySet().containsAll(parts);
                  for (java.nio.ByteBuffer p : parts) {
                    String t = heard.getOrDefault(p, "");
                    if (!t.isEmpty()) all.append(all.length() == 0 ? "" : " ").append(t);
                  }
                  if (known) {
                    wholes.incrementAndGet();
                    java.util.concurrent.CountDownLatch w = slowWhole;
                    if (w != null) w.await();
                    if (wholeFails) throw new java.io.IOException("Fake provider error");
                    return wholeAs.apply(all.toString());
                  }
                }
                // Parts never written down on their own (after a failure): written down together,
                // once (the same audio again gets the same text).
                java.nio.ByteBuffer key = java.nio.ByteBuffer.wrap(wav);
                synchronized (heard) {
                  String again = heard.get(key);
                  if (again != null) return again;
                  transcriptions.incrementAndGet();
                  String t = transcripts.remove(0);
                  for (java.nio.ByteBuffer p : parts) heard.put(p, "");
                  heard.put(parts.get(parts.size() - 1), t);
                  heard.put(key, t);
                  return t;
                }
              },
              new HandsFreeSession.Sender() {
                final java.util.concurrent.atomic.AtomicInteger ids = new java.util.concurrent.atomic.AtomicInteger();

                public String newRequest() {
                  return "r" + ids.incrementAndGet();
                }

                public void send(String said, String request) throws Exception {
                  java.util.concurrent.CountDownLatch l = slowBb;
                  if (l != null) l.await();
                  if (bbDown) throw new java.io.IOException("bb isn't reachable");
                  sent.add(said);
                  String missed = missedBy;
                  if (missed != null) throw new HandsFreeSession.PartlySent(request, missed.equals("chief"), "thread not found");
                }
              },
              new HandsFreeSession.Speaker() {
                volatile HandsFreeSession.Playback playback;

                public Object prepare(String request, String text) {
                  return prepare.apply(text);
                }

                public void play(String request, String text, Object prepared, HandsFreeSession.Playback p) {
                  playback = p;
                  done = () -> p.ended(true);
                  fail = () -> p.ended(false);
                  spoken.add(text);
                  if (audioStarts) p.started(2000);
                }

                public boolean playing() {
                  return audioPlaying;
                }

                public int heardChars() {
                  return heardChars;
                }

                public void drop(Object prepared) {
                  if (prepared != null) dropped.add(prepared);
                }

                public void stop() {
                  stopped = true;
                  HandsFreeSession.Playback p = playback;
                  playback = null;
                  done = null;
                  if (p != null) p.ended(false);
                }
              },
              () -> {});
      session.onEvent(log::add);
      session.clock = now::get;
    }

    /** Quiet room for a second, so the background is measured. */
    void quiet(int ms) {
      for (int i = 0; i < ms / 20; i++) session.frame(frame(50));
    }

    /** 1.2 s of speech close to the phone: enough to take the turn. */
    void speak() {
      int level = 6000 + 10 * stretches++;
      for (int i = 0; i < 60; i++) session.frame(frame(level));
    }

    /** Speech, then the pause that ends the stretch. */
    void talk() throws Exception {
      speak();
      quiet(1200);
      Thread.sleep(150);
    }
  }

  /** A WAV's parts: the session joins them with 0.3 s of exact silence. */
  static List<java.nio.ByteBuffer> parts(byte[] wav) {
    List<java.nio.ByteBuffer> out = new ArrayList<>();
    int start = 44, zeros = 0, gap = AudioFiles.BYTES_PER_SECOND * 3 / 10 / 2;
    for (int i = 44; i + 1 < wav.length; i += 2) {
      zeros = wav[i] == 0 && wav[i + 1] == 0 ? zeros + 1 : 0;
      if (zeros == gap) {
        out.add(java.nio.ByteBuffer.wrap(java.util.Arrays.copyOfRange(wav, start, i + 2 - 2 * gap)));
        start = i + 2;
        zeros = 0;
      }
    }
    out.add(java.nio.ByteBuffer.wrap(java.util.Arrays.copyOfRange(wav, start, wav.length)));
    return out;
  }

  static void until(java.util.function.BooleanSupplier c) throws Exception {
    for (int i = 0; i < 100 && !c.getAsBoolean(); i++) Thread.sleep(20);
    assertTrue(c.getAsBoolean());
  }

  @Test
  public void partsAddUpAndGoOnTheSendWord() throws Exception {
    // Each check writes down only the part that's new; the turn is the parts' texts joined.
    Fake f = new Fake("I was thinking about the trip.", "Let's book the hotel. Over.");
    f.talk();
    until(() -> f.session.pending().equals("I was thinking about the trip."));
    assertEquals(HandsFreeSession.Floor.YOU, f.session.floor());
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("I was thinking about the trip. Let's book the hotel.", f.sent.get(0));
    assertEquals("", f.session.pending());
    assertTrue(f.session.ours("r1"));
    assertFalse(f.session.ours("other"));
    until(() -> f.session.floor() == HandsFreeSession.Floor.OPEN);
  }

  @Test
  public void theEndPhraseSendsWhatCameBeforeAndEnds() throws Exception {
    Fake f = new Fake("Cancel the meeting. End the call.");
    f.talk();
    until(() -> f.session.state() == HandsFreeSession.State.ENDED);
    assertEquals(List.of("Cancel the meeting."), f.sent);
  }

  @Test
  public void chiefFirstOnAnOpenFloorIsReadAndItsEchoIsNeverYourTurn() throws Exception {
    Fake f = new Fake("Next question. Over.");
    f.quiet(1000);
    f.session.reply("r1", "First answer from what I know.");
    f.session.reply("r1", "The final answer.");
    until(() -> f.session.floor() == HandsFreeSession.Floor.CHIEF);
    assertEquals(List.of("First answer from what I know."), f.spoken);
    // What's left of the voice in the microphone after echo cancellation: nothing is captured.
    for (int i = 0; i < 100; i++) f.session.frame(frame(i % 5 == 0 ? 750 : 350));
    f.quiet(1200);
    Thread.sleep(150);
    assertEquals(1, f.transcripts.size());
    assertFalse(f.stopped);
    f.done.run(); // The first finished; the floor opens and the second, held, is read.
    until(() -> f.spoken.size() == 2);
    assertEquals(List.of("First answer from what I know.", "The final answer."), f.spoken);
    f.done.run();
    assertEquals(HandsFreeSession.Floor.OPEN, f.session.floor());
    // Its tail right after reading is dropped too.
    f.talk();
    assertEquals(1, f.transcripts.size());
    // After the tail, you're heard again, and nothing of the reply is in your turn.
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Next question.", f.sent.get(0));
  }

  /** The reasons on screen, newest first, as one text. */
  static String reasons(Fake f) {
    StringBuilder out = new StringBuilder();
    for (HandsFreeSession.Reason r : f.session.reasons()) out.append(r.text()).append('\n');
    return out.toString();
  }

  @Test
  public void aReplyWaitsWhileYouTalkIsNotDroppedBySendingAndPlaysAtThePause() throws Exception {
    Fake f = new Fake("Also check the train", "to Lisbon. Over.");
    f.quiet(1000);
    f.speak(); // You take the floor.
    assertEquals(HandsFreeSession.Floor.YOU, f.session.floor());
    f.session.reply("r0", "The flight leaves at nine in the morning and costs about two hundred euros, I think.");
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    assertEquals(1, f.session.held());
    assertTrue(reasons(f), reasons(f).contains("Reply waits: you're talking"));
    assertEquals(HandsFreeSession.Live.HEARING, f.session.live());
    f.quiet(1200); // A pause, with your words unsent: still your turn, it waits.
    Thread.sleep(150);
    assertTrue(f.spoken.isEmpty());
    f.talk();
    until(() -> f.sent.size() == 1);
    // Your message as said: nothing about the reply, which isn't dropped.
    assertEquals("Also check the train to Lisbon.\n\n[your reply hasn't played yet, it plays after this message: \"The flight leaves at nine in the morning and costs about two…\"]", f.sent.get(0));
    // Your turn is over: it plays now.
    until(() -> f.spoken.size() == 1);
    assertEquals("The flight leaves at nine in the morning and costs about two hundred euros, I think.", f.spoken.get(0));
    f.done.run();
    assertEquals(0, f.session.unheard());
    assertEquals("", f.session.endNote());
  }

  @Test
  public void aReplyNeverPlaysInALongThinkingPauseWithUnsentWordsOnlyOnceTheyreSent() throws Exception {
    Fake f = new Fake("Book the hotel");
    f.quiet(1000);
    f.speak();
    f.session.reply("r0", "Here's what I found.");
    f.quiet(1200);
    until(() -> f.session.pending().equals("Book the hotel"));
    // You think, quiet, your words unsent (no Jev here to say you're done): your turn goes on.
    f.quiet(6000);
    f.session.tick();
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    assertEquals(HandsFreeSession.Live.REPLY_WAITING, f.session.live());
    assertTrue(reasons(f), reasons(f).contains("Reply waits: your turn (unsent words)"));
    // The silence send (8 s here) ends your turn: your words go, then it plays.
    f.quiet(2000);
    f.session.tick();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel\n\n[your reply hasn't played yet, it plays after this message: \"Here's what I found.\"]", f.sent.get(0));
    until(() -> f.spoken.size() == 1);
    assertTrue(reasons(f), reasons(f).contains("Reply plays: your turn is over"));
    String log = String.join("\n", f.log);
    int yours = log.indexOf("turn: yours (unsent words)"), silence = log.indexOf("turn: silence (sent)"), ours = log.indexOf("turn: ours (a reply plays)");
    assertTrue(log, yours >= 0 && silence > yours && ours > silence);
  }

  @Test
  public void aReplyPlaysAtOnceInSilenceAndRightAfterYourMessageWent() throws Exception {
    Fake f = new Fake("Is the table booked? Over.");
    f.quiet(1000);
    // Silence: it plays as soon as its voice is ready.
    f.session.reply("r0", "Good morning.");
    until(() -> f.spoken.size() == 1);
    assertFalse(reasons(f), reasons(f).contains("Reply waits"));
    f.done.run();
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    sendTurn(f, 1);
    until(() -> f.session.yourTurn(f.now.get()) == null);
    // Right after your message went: silence again, no pause needed.
    f.session.reply("r1", "Yes, for eight.");
    until(() -> f.spoken.size() == 2);
  }

  @Test
  public void aReplyArrivingWhileYourMessageIsWrittenDownOrSentWaitsUntilItsGone() throws Exception {
    Fake f = new Fake("Is the table booked? Over.");
    java.util.concurrent.CountDownLatch slow = new java.util.concurrent.CountDownLatch(1);
    f.slow = slow;
    long timeout = HandsFreeSession.writeTimeoutMs;
    HandsFreeSession.writeTimeoutMs = 60_000;
    try {
      f.quiet(1000);
      f.talk();
      f.session.reply("r0", "Here's what I found.");
      until(() -> reasons(f).contains("Reply waits: checking whether you're done"));
      f.quiet(3000);
      f.session.tick();
      assertTrue(f.spoken.isEmpty());
      f.slowBb = new java.util.concurrent.CountDownLatch(1);
      slow.countDown(); // Written down: now it's being sent.
      until(() -> reasons(f).contains("Reply waits: your message is being sent"));
      f.session.tick();
      assertTrue(f.spoken.isEmpty());
      f.slowBb.countDown();
      until(() -> f.sent.size() == 1);
      until(() -> f.spoken.size() == 1);
    } finally {
      slow.countDown();
      HandsFreeSession.writeTimeoutMs = timeout;
    }
  }

  static int count(String text, String what) {
    return text.split(java.util.regex.Pattern.quote(what), -1).length - 1;
  }

  /** Talks, then waits for the message to go out. */
  private static void sendTurn(Fake f, int n) throws Exception {
    f.talk();
    until(() -> f.sent.size() == n);
  }

  /** A reply played to the end, and the microphone open again after it. */
  private static void hear(Fake f, int spoken) throws Exception {
    until(() -> f.spoken.size() == spoken);
    f.done.run();
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
  }

  @Test
  public void withATalkerAReplyToAnOlderMessageIsntPlayedAndTheNextMessageSaysSo() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    // The answer to the first message comes after the second went: it no longer fits.
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.session.reply("r2", "The train leaves at nine.");
    hear(f, 1);
    assertEquals(List.of("The train leaves at nine."), f.spoken);
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("chief message r1 dropped (27 characters): it answers an older message than your latest"));
    assertTrue(reasons(f), reasons(f).contains("An older reply wasn't played: you've said more since. Your next message says so"));
    sendTurn(f, 3);
    assertEquals("Anything else?\n\n[didn't hear your reply: \"Yes, it's booked for eight.\"]", f.sent.get(2));
    // Noted once.
    f.session.end();
    assertEquals("", f.session.endNote());
  }

  @Test
  public void withATalkerRepliesStillWaitingWhenYourMessageGoesArentPlayedAndTheNextMessageSaysSo() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    // You talk on; three answers to the first message (one an update without a request) wait.
    f.speak();
    f.session.reply("r1", "One moment, I'm checking the booking for you now.");
    f.session.reply("r1", "It's booked for eight.");
    f.session.reply(f.session.lastRequest(), "The chief says the window table is free.", 0, true);
    assertEquals(3, f.session.held());
    f.quiet(1200);
    until(() -> f.sent.size() == 2);
    // Dropped once your message was delivered; that message didn't know of it yet.
    assertEquals("And the train?", f.sent.get(1));
    until(() -> f.session.held() == 0);
    Thread.sleep(200);
    assertTrue(f.spoken.toString(), f.spoken.isEmpty());
    assertEquals("their voices let go", 3, f.dropped.size());
    assertTrue(reasons(f), reasons(f).contains("3 older replies weren't played: you've said more since"));
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("chief message r1 dropped (22 characters): it was waiting when your newer message r2 went"));
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    sendTurn(f, 3);
    assertEquals("Anything else?\n\n[didn't hear 3 replies: \"One moment, I'm checking the booking for you…\" and 2 more]", f.sent.get(2));
    f.session.end();
    assertEquals("", f.session.endNote());
  }

  @Test
  public void withATalkerACallEndingWithDroppedRepliesNotYetNotedSaysSoAtItsEnd() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.session.reply("r1", "The window table, as you asked.");
    f.session.end();
    assertEquals("\n\n[didn't hear 2 replies: \"Yes, it's booked for eight.\" and 1 more]", f.session.endNote());
    assertTrue(f.spoken.isEmpty());
  }

  @Test
  public void withoutATalkerAReplyToAnOlderMessageStillPlays() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.");
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    f.session.reply("r1", "Yes, it's booked for eight.");
    hear(f, 1);
    sendTurn(f, 3);
    assertEquals("Anything else?", f.sent.get(2));
    assertFalse(String.join("\n", f.log).contains("dropped"));
  }

  @Test
  public void withoutATalkerAReplyStillWaitingWhenYourNextMessageGoesIsNotedInItAndStillPlays() throws Exception {
    // Philipp's call, 31 October 2026: "Hi, can you hear me?" asked again before the first answer
    // played; the chief answered it again, and he heard "Yes, I can hear you" twice.
    Fake f = new Fake("Hi, can you hear me? Over.", "Hi, can you hear me? Over.", "Book the table. Over.");
    f.quiet(1000);
    sendTurn(f, 1);
    f.speak(); // You ask again; the answer to the first comes meanwhile and waits.
    f.session.reply("r1", "Yes, I hear you. Go ahead.");
    assertEquals(1, f.session.held());
    f.quiet(1200);
    until(() -> f.sent.size() == 2);
    // The chief hears that its answer is still to play: it doesn't answer the same again.
    assertEquals("Hi, can you hear me?\n\n[your reply hasn't played yet, it plays after this message: \"Yes, I hear you. Go ahead.\"]", f.sent.get(1));
    hear(f, 1);
    assertEquals(List.of("Yes, I hear you. Go ahead."), f.spoken);
    sendTurn(f, 3);
    assertEquals("played: not noted again", "Book the table.", f.sent.get(2));
    assertFalse(String.join("\n", f.log).contains("dropped"));
  }

  @Test
  public void withATalkerNoMessageSaysAReplyHasntPlayedYet() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    f.speak();
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.quiet(1200);
    until(() -> f.sent.size() == 2);
    assertEquals("And the train?", f.sent.get(1));
  }

  @Test
  public void severalRepliesNotPlayedYetAreNotedAsOne() {
    assertEquals("[2 replies haven't played yet, they play after this message: \"One moment, I'm checking the booking for you…\" and 1 more]",
        HandsFreeSession.notPlayedYet(List.of("One moment, I'm checking the booking for you now.", "It's booked.")));
  }

  @Test
  public void withATalkerAReplyArrivingWhileYourNewMessageIsOnItsWayWaitsAndIsOutdatedOnceItsDelivered() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
    f.session.reply("r1", "Yes, it's booked for eight."); // Tagged: an answer to the first message.
    // The talker's update without a request, while your message is on its way: it answers that one.
    f.session.reply(f.session.lastRequest(), "Let me check the trains.", 0, true);
    assertEquals(2, f.session.held());
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    f.slowBb.countDown();
    until(() -> f.sent.size() == 2);
    until(() -> f.spoken.size() == 1);
    assertEquals(List.of("Let me check the trains."), f.spoken);
    assertTrue(String.join("\n", f.log).contains("chief message r1 dropped (27 characters): it was waiting when your newer message r2 went"));
  }

  @Test
  public void withATalkerAReplyToTheMessageOnItsWayIsOursAndPlaysOnceItsDelivered() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    // The first message of the call: the talker answers before bb is done with the chief.
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
    assertTrue("ours while on its way", f.session.ours("r1"));
    assertEquals("an update without a request answers it", "r1", f.session.lastRequest());
    f.session.reply("r1", "Let me check.");
    f.slowBb.countDown();
    until(() -> f.sent.size() == 1);
    until(() -> f.spoken.size() == 1);
    f.done.run();
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    // The second: a tagged answer to it before it's delivered isn't outdated either.
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
    f.session.reply("r2", "Checking the trains.");
    f.slowBb.countDown();
    until(() -> f.sent.size() == 2);
    until(() -> f.spoken.size() == 2);
    assertEquals(List.of("Let me check.", "Checking the trains."), f.spoken);
    assertFalse(String.join("\n", f.log).contains("dropped"));
  }

  @Test
  public void notesOfAMessageTheChiefMissedGoAgainButNotWhenOnlyTheTalkerMissedIt() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.", "Thanks. Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.missedBy = "chief";
    sendTurn(f, 3);
    String note = "[didn't hear your reply: \"Yes, it's booked for eight.\"]";
    assertTrue(f.sent.get(2), f.sent.get(2).endsWith(note));
    // The chief didn't get it: the note goes with the next message.
    f.missedBy = "talker";
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    sendTurn(f, 4);
    assertEquals("Thanks.\n\n" + note, f.sent.get(3));
    // The chief got that one (the talker didn't): the note is done.
    f.session.end();
    assertEquals("", f.session.endNote());
  }

  @Test
  public void aMessageThatFailsAfterTheEndLeavesItsWordsAndNotesForTheEnd() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk(); // Carries the note; on its way when the call ends.
    until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
    f.session.end();
    f.bbDown = true;
    f.slowBb.countDown();
    assertTrue(f.session.awaitDelivered(5000));
    assertEquals(2, f.sent.size());
    String note = "[didn't hear your reply: \"Yes, it's booked for eight.\"]";
    assertTrue("its note is free again", f.session.endNote().contains(note));
    // Settled: its words go now, with the note; the end then has nothing left to say.
    f.bbDown = false;
    f.slowBb = null;
    assertTrue(f.session.sendLeftover(f.now.get() + 30_000));
    assertEquals("Anything else?\n\n" + note, f.sent.get(2));
    assertEquals("", f.session.endNote());
  }

  @Test
  public void aMessageThatFailsAfterTheEndSettledSendsItsWordsItselfTryingAgain() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.");
    f.session.dropsOutdated = true;
    long retry = HandsFreeSession.leftoverRetryMs;
    HandsFreeSession.leftoverRetryMs = 300;
    try {
      f.quiet(1000);
      sendTurn(f, 1);
      sendTurn(f, 2);
      f.session.reply("r1", "Yes, it's booked for eight.");
      f.slowBb = new java.util.concurrent.CountDownLatch(1);
      f.talk(); // Still in bb when the end has waited long enough.
      until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
      f.session.end();
      assertFalse(f.session.awaitDelivered(100));
      assertTrue("nothing left yet", f.session.sendLeftover(f.now.get() + 30_000));
      String end = f.session.endNote(); // The end goes now, without the message's note: it still carries it.
      assertFalse(end, end.contains("didn't hear"));
      // Then it fails: its words and note go by themselves, tried again until bb takes them.
      f.bbDown = true;
      f.slowBb.countDown();
      until(() -> String.join("\n", f.log).contains("a message failed after the call's end: its words are sent now"));
      Thread.sleep(100);
      f.bbDown = false;
      for (int i = 0; i < 100 && f.sent.size() < 3; i++) Thread.sleep(20);
      assertEquals(String.join("\n", f.log), "Anything else?\n\n[didn't hear your reply: \"Yes, it's booked for eight.\"]", f.sent.get(2));
    } finally {
      HandsFreeSession.leftoverRetryMs = retry;
    }
  }

  @Test
  public void wordsLeftAtTheEndAreTriedAFewTimesThenGivenUp() throws Exception {
    Fake f = new Fake("Is the table booked? Over.");
    long retry = HandsFreeSession.leftoverRetryMs;
    HandsFreeSession.leftoverRetryMs = 50;
    try {
      f.quiet(1000);
      f.bbDown = true;
      f.talk();
      for (int i = 0; i < 100 && !f.session.error().startsWith("Not sent"); i++) Thread.sleep(20);
      f.session.end(); // Your kept words go as your last words, and fail too.
      assertTrue(f.session.awaitDelivered(5000));
      assertFalse(f.session.sendLeftover(f.now.get() + 30_000));
      String log = String.join("\n", f.log);
      assertEquals(log, HandsFreeSession.LEFTOVER_TRIES, count(log, "words a message couldn't take before the end: sending them now"));
      assertTrue(log, log.contains("words left at the call's end couldn't be sent: they go with the end of the call"));
      // In the end line for both, so they aren't lost.
      assertEquals("\n\n[my last words, not sent before the end: \"Is the table booked?\"]", f.session.endNote());
    } finally {
      HandsFreeSession.leftoverRetryMs = retry;
    }
  }

  @Test
  public void lastWordsOnlyTheTalkerGotGoWithTheChiefsEndLineOnly() throws Exception {
    Fake f = new Fake("Is the table booked? Over.");
    f.quiet(1000);
    f.bbDown = true;
    f.talk();
    for (int i = 0; i < 100 && !f.session.error().startsWith("Not sent"); i++) Thread.sleep(20);
    f.session.end(); // Kept words go as last words, and fail.
    assertTrue(f.session.awaitDelivered(5000));
    f.bbDown = false;
    f.missedBy = "chief"; // Now only the talker gets them.
    assertTrue(f.session.sendLeftover(f.now.get() + 30_000));
    assertEquals("the talker's end line: nothing doubled", "", f.session.endNote());
    assertEquals("\n\n[my last words, not sent before the end: \"Is the table booked?\"]", f.session.endNoteForChief());
  }

  @Test
  public void aReplyAfterTheEndIsNotedWithTheEndWhileItsStillToGo() throws Exception {
    Fake f = new Fake();
    f.quiet(1000);
    f.session.end();
    f.session.reply("r1", "The table is booked.");
    assertEquals("\n\n[didn't hear your reply: \"The table is booked.\"]", f.session.endNote());
    f.session.reply("r1", "And the train too.");
    assertTrue(String.join("\n", f.log).contains("chief message r1 after the call's end (18 characters): not played, and the end was already sent"));
    assertTrue(f.spoken.isEmpty());
  }

  @Test
  public void pastAMinuteAReplyStillWaitsForASentenceButNotForEndlessSpeech() throws Exception {
    Fake f = new Fake("Book the hotel");
    f.quiet(1000);
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.session.reply("r0", "Here's what I found.");
    until(() -> f.log.stream().anyMatch(l -> l.startsWith("voice ready for r0")));
    f.session.tick();
    f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS);
    f.speak(); // You start a sentence just as the minute is up.
    f.now.addAndGet(1000);
    f.session.tick();
    Thread.sleep(100);
    assertTrue("not over your sentence", f.spoken.isEmpty());
    // Speech going on without a pause for 20 s: a TV, not you.
    f.now.addAndGet(HandsFreeSession.LONG_STRETCH_MS);
    f.speak();
    for (int i = 0; i < 50 && f.spoken.isEmpty(); i++) {
      f.session.tick();
      Thread.sleep(20);
    }
    assertEquals(String.join("\n", f.log), 1, f.spoken.size());
  }

  @Test
  public void pastTwiceTheCapASoundThatNeverBecomesSpeechNoLongerHoldsAReply() throws Exception {
    Fake f = new Fake("Book the hotel");
    f.quiet(1000);
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.session.reply("r0", "Here's what I found.");
    until(() -> f.log.stream().anyMatch(l -> l.startsWith("voice ready for r0")));
    // In the car: a click again and again, gaps shorter than a pause, never speech.
    f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS + 1000);
    for (int i = 0; i < 6; i++) {
      clatter(f.session, 2100, 3);
      clatter(f.session, 50, 22);
      f.session.tick();
    }
    Thread.sleep(100);
    assertTrue("a sound just starting still holds it", f.spoken.isEmpty());
    f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS);
    for (int i = 0; i < 50 && f.spoken.isEmpty(); i++) {
      clatter(f.session, 2100, 3);
      clatter(f.session, 50, 22);
      f.session.tick();
      Thread.sleep(20);
    }
    assertEquals(String.join("\n", f.log), List.of("Here's what I found."), f.spoken);
    assertEquals(0, f.transcriptions.get() - 1); // The clicks were never written down.
  }

  @Test
  public void speechAReplyStartsOverPastItsCapIsKeptInYourTurn() throws Exception {
    Fake f = new Fake("Book the hotel", "and the train");
    f.quiet(1000);
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.session.reply("r0", "Here's what I found.");
    until(() -> f.log.stream().anyMatch(l -> l.startsWith("voice ready for r0")));
    f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS);
    f.speak(); // Speech going on, then on past 20 s.
    f.now.addAndGet(HandsFreeSession.LONG_STRETCH_MS);
    f.speak();
    for (int i = 0; i < 50 && f.spoken.isEmpty(); i++) {
      f.session.tick();
      Thread.sleep(20);
    }
    assertEquals(1, f.spoken.size());
    // What was said up to the reply is a part of your turn, written down, not lost.
    until(() -> f.session.pending().equals("Book the hotel and the train"));
  }

  @Test
  public void withATalkerAnUpdateWithoutARequestWhenNothingIsOnItsWayPlays() throws Exception {
    Fake f = new Fake("Is the table booked? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    until(() -> f.session.yourTurn(f.now.get()) == null);
    f.session.reply(f.session.lastRequest(), "Booked for eight.", 0, true);
    until(() -> f.spoken.size() == 1);
  }

  @Test
  public void withATalkerASendThatFailsDropsNoWaitingReply() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    f.speak();
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.bbDown = true;
    f.quiet(1200);
    for (int i = 0; i < 100 && !f.session.error().startsWith("Not sent"); i++) Thread.sleep(20);
    assertTrue(String.join("\n", f.log), f.session.error().startsWith("Not sent"));
    assertEquals("still waiting, not dropped", 1, f.session.held());
    assertTrue(f.dropped.isEmpty());
    assertFalse(String.join("\n", f.log).contains("dropped"));
    // The call ends: it was never heard, and says so as a reply still waiting.
    f.session.end();
    assertEquals("\n\n[didn't hear your reply: \"Yes, it's booked for eight.\"]", f.session.endNote());
  }

  @Test
  public void notesOfAMessageThatCouldntBeSentGoWithTheCallsEnd() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    f.session.reply("r1", "Yes, it's booked for eight."); // Outdated: dropped, to be noted.
    f.bbDown = true;
    f.talk(); // Carries the note, and fails.
    for (int i = 0; i < 100 && !f.session.error().startsWith("Not sent"); i++) Thread.sleep(20);
    assertTrue(f.session.error().startsWith("Not sent"));
    f.session.end(); // Your kept words go as your last words, and fail too.
    assertTrue(f.session.awaitDelivered(5000));
    assertTrue(f.session.endNote(), f.session.endNote().contains("[didn't hear your reply: \"Yes, it's booked for eight.\"]"));
  }

  @Test
  public void aNoteGoesWithOneMessageOnlyWhenTheNextGoesBeforeItsDelivered() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.", "Anything else? Over.", "Thanks. Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    sendTurn(f, 2);
    f.session.reply("r1", "Yes, it's booked for eight.");
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk(); // A: carries the note, on its way.
    until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
    f.talk(); // B: handed over before A is delivered.
    Thread.sleep(300);
    f.slowBb.countDown();
    until(() -> f.sent.size() == 4);
    assertEquals("Anything else?\n\n[didn't hear your reply: \"Yes, it's booked for eight.\"]", f.sent.get(2));
    assertEquals("Thanks.", f.sent.get(3));
  }

  @Test
  public void withLiveTranscriptionEachStretchOfSpeechHoldsTheTurnAfreshForItsFirstWords() throws Exception {
    Fake f = new Fake();
    new FakeLive(f);
    f.quiet(1000);
    f.speak();
    f.now.addAndGet(HandsFreeSession.WORDLESS_MS + 1);
    assertNull(f.session.yourTurn(f.now.get()));
    f.quiet(1200); // A pause, then you go on.
    Thread.sleep(150);
    f.speak();
    assertEquals("speaking", f.session.yourTurn(f.now.get()));
  }

  @Test
  public void aSilenceSendThatFailsIsTriedAgainLaterNotEverySecond() throws Exception {
    Fake f = new Fake("Remind me to call Jana");
    f.quiet(1000);
    f.talk();
    until(() -> !f.session.pending().isEmpty());
    f.bbDown = true;
    f.quiet(8000);
    f.session.tick();
    until(() -> String.join("\n", f.log).contains("not sent (silence)"));
    for (int i = 0; i < 10; i++) {
      f.quiet(1000);
      f.now.addAndGet(1000);
      f.session.tick();
    }
    Thread.sleep(200);
    assertEquals(1, count(String.join("\n", f.log), "not sent (silence)"));
    f.now.addAndGet(HandsFreeSession.SILENCE_RETRY_MS);
    f.bbDown = false;
    f.session.tick();
    until(() -> f.sent.size() == 1);
    assertTrue(String.join("\n", f.log).contains("silence send: trying again (2)"));
  }

  @Test
  public void aReadyReplyWaitsAMinuteAtMostThroughATurnWithoutNewWords() throws Exception {
    Fake f = new Fake("Book the hotel");
    f.quiet(1000);
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.session.reply("r0", "Here's what I found.");
    until(() -> f.log.stream().anyMatch(l -> l.startsWith("voice ready for r0")));
    f.session.tick();
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    f.now.addAndGet(HandsFreeSession.HOLD_MAX_MS - 1000);
    f.session.tick();
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    f.now.addAndGet(1000);
    f.session.tick();
    until(() -> f.spoken.size() == 1);
    assertTrue(reasons(f), reasons(f).contains("Reply plays: it waited 60 s without new words from you"));
  }

  @Test
  public void withATalkerAMessageThatCouldntBeSentDoesntMakeTheRepliesBeforeItOutdated() throws Exception {
    Fake f = new Fake("Is the table booked? Over.", "And the train? Over.");
    f.session.dropsOutdated = true;
    f.quiet(1000);
    sendTurn(f, 1);
    f.bbDown = true;
    f.talk();
    for (int i = 0; i < 100 && !f.session.error().startsWith("Not sent"); i++) Thread.sleep(20);
    assertTrue(String.join("\n", f.log), f.session.error().startsWith("Not sent"));
    // Your words are kept (your turn): the reply waits, but isn't dropped.
    f.session.reply("r1", "Yes, it's booked for eight.");
    assertEquals(1, f.session.held());
    assertFalse(String.join("\n", f.log).contains("dropped"));
  }

  @Test
  public void aCallEndingWithRepliesStillWaitingTellsTheChiefOnce() throws Exception {
    Fake f = new Fake("Hold on");
    f.quiet(1000);
    f.speak();
    f.session.reply("r0", "The meeting moved to three.");
    f.session.end();
    assertEquals("\n\n[didn't hear your reply: \"The meeting moved to three.\"]", f.session.endNote());
  }

  @Test
  public void aTurnThatComesToNothingReleasesTheFloorAndTheHeldMessageIsRead() throws Exception {
    Fake f = new Fake("");
    f.quiet(1000);
    f.speak();
    f.session.reply("r0", "Here's what I found.");
    assertTrue(f.spoken.isEmpty());
    f.quiet(1200);
    until(() -> f.spoken.size() == 1);
    assertEquals("Here's what I found.", f.spoken.get(0));
    assertTrue(f.sent.isEmpty());
  }

  @Test
  public void noiseBelowTheThresholdsNeverTakesTheFloor() throws Exception {
    Fake f = new Fake("should not be transcribed");
    f.quiet(2000);
    // Distant voices: not much louder than the background.
    for (int i = 0; i < 100; i++) f.session.frame(frame(120));
    // A click-like loud sound: under the 0.1 s a loud burst needs, far under the voice to take the turn.
    for (int i = 0; i < 4; i++) f.session.frame(frame(6000));
    f.quiet(1000);
    Thread.sleep(150);
    assertEquals(1, f.transcripts.size());
    assertEquals(HandsFreeSession.Floor.OPEN, f.session.floor());
    // So a chief message is read right away.
    f.session.reply("r0", "An answer.");
    until(() -> f.spoken.size() == 1);
    assertEquals(List.of("An answer."), f.spoken);
    assertTrue(String.join("\n", f.log), String.join("\n", f.log).contains("noise ignored"));
  }

  @Test
  public void onceYouHaveTheFloorAShortOverStillCounts() throws Exception {
    Fake f = new Fake("Book the hotel", "over");
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    for (int i = 0; i < 20; i++) f.session.frame(frame(6000)); // 0.4 s: "Over."
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel", f.sent.get(0));
  }

  @Test
  public void aDictationSwitchedToHandsFreeStartsTheFirstTurn() throws Exception {
    Fake f = new Fake("I was dictating about the trip", "and the budget. Over.");
    java.io.ByteArrayOutputStream dictated = new java.io.ByteArrayOutputStream();
    for (int i = 0; i < 50; i++) dictated.writeBytes(frame(3000)); // A second of what was dictated.
    f.session.seed(dictated.toByteArray());
    until(() -> f.session.pending().equals("I was dictating about the trip"));
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("I was dictating about the trip and the budget.", f.sent.get(0));
  }

  @Test
  public void thePhaseIsListeningWorkingOrReading() throws Exception {
    Fake f = new Fake("Book the hotel. Over.");
    assertEquals(HandsFreeSession.Phase.LISTENING, f.session.phase());
    f.talk();
    until(() -> f.sent.size() == 1);
    until(() -> f.session.phase() == HandsFreeSession.Phase.WORKING);
    f.session.reply("r1", "On it, first thoughts.");
    until(() -> f.spoken.size() == 1);
    assertEquals(HandsFreeSession.Phase.READING, f.session.phase());
    f.done.run();
    assertEquals(HandsFreeSession.Phase.WORKING, f.session.phase());
    f.session.reply("r1", "The hotel is booked.");
    until(() -> f.spoken.size() == 2);
    f.done.run();
    assertEquals(HandsFreeSession.Phase.LISTENING, f.session.phase());
    assertEquals("", f.session.error());
  }

  @Test
  public void theButtonSendsAndALongSilenceSendsToo() throws Exception {
    Fake f = new Fake("Remind me to call Jana", "and buy milk");
    f.talk();
    until(() -> !f.session.pending().isEmpty());
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    assertEquals("Remind me to call Jana", f.sent.get(0));
    f.talk();
    until(() -> !f.session.pending().isEmpty());
    f.quiet(8000);
    f.session.tick();
    until(() -> f.sent.size() == 2);
    assertEquals("and buy milk", f.sent.get(1));
  }

  @Test
  public void theButtonPressedWhileTheLastPartIsBeingWrittenDownSendsIt() throws Exception {
    // The part ended (short pause) and the speech model is still working when the button is
    // pressed: it must go once written down, not be dropped as an empty turn.
    Fake f = new Fake("Book a table for four, tonight at eight");
    f.slow = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    assertEquals("", f.session.pending());
    f.session.sendNow();
    f.slow.countDown();
    until(() -> f.sent.size() == 1);
    assertEquals("Book a table for four, tonight at eight", f.sent.get(0));
    assertEquals("", f.session.pending());
  }

  @Test
  public void theButtonWaitsForEveryPartStillBeingWrittenDown() throws Exception {
    Fake f = new Fake("First part.", "Second part.");
    f.slow = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    f.talk();
    f.session.sendNow();
    f.slow.countDown();
    until(() -> f.sent.size() == 1);
    Thread.sleep(200);
    assertEquals(1, f.sent.size());
    assertEquals("First part. Second part.", f.sent.get(0));
  }

  @Test
  public void aPressShowsSendingAtOnceAndASecondPressDoesNothing() throws Exception {
    Fake f = new Fake("Book the table");
    f.slow = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    f.session.sendNow();
    assertEquals(HandsFreeSession.Phase.SENDING, f.session.phase());
    f.session.sendNow();
    f.slow.countDown();
    until(() -> f.sent.size() == 1);
    Thread.sleep(200);
    assertEquals(1, f.sent.size());
    assertTrue(f.log.stream().anyMatch(l -> l.contains("send pressed again")));
  }

  @Test
  public void aPressRightAfterAMessageWentDoesntSendTheNextWordsOnTheirOwn() throws Exception {
    // Philipp's "don't see the": a second press for the same message sent the next fragment.
    Fake f = new Fake("That was the whole thing.", "don't see the");
    f.talk();
    until(() -> !f.session.pending().isEmpty());
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    f.talk();
    until(() -> f.session.pending().equals("don't see the"));
    f.session.sendNow(); // Same instant on the fake clock: a repeated press.
    Thread.sleep(200);
    assertEquals(1, f.sent.size());
    assertEquals("don't see the", f.session.pending());
    f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
    f.session.sendNow();
    until(() -> f.sent.size() == 2);
    assertEquals("don't see the", f.sent.get(1));
  }

  @Test
  public void whatYouSayNextIsWrittenDownWhileBbIsSlow() throws Exception {
    // Delivering a message must not hold up writing down the next turn, and messages keep their order.
    Fake f = new Fake("First message. Over.", "Second message. Over.");
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.session.phase() == HandsFreeSession.Phase.SENDING);
    f.talk();
    until(() -> f.log.stream().anyMatch(l -> l.contains("Second message")));
    assertEquals(0, f.sent.size());
    f.slowBb.countDown();
    until(() -> f.sent.size() == 2);
    assertEquals("First message.", f.sent.get(0));
    assertEquals("Second message.", f.sent.get(1));
  }

  @Test
  public void theLastMessageStillGoesWhenTheCallEndsWithIt() throws Exception {
    Fake f = new Fake("Order the parts, end the call");
    f.slowBb = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.session.state() == HandsFreeSession.State.ENDED);
    f.slowBb.countDown();
    assertTrue(f.session.awaitDelivered(2000));
    assertEquals(1, f.sent.size());
    assertEquals("Order the parts", f.sent.get(0));
  }

  // ------------------------------------------------------------------ the chief's side

  @Test
  public void spokenRepliesAreFoundByTagAndRequest() throws Exception {
    JSONObject m = new JSONObject().put("event", "message").put("tags", new org.json.JSONArray().put("talkrouter-speak").put("req-abc234"));
    assertEquals("abc234", ChiefText.spokenRequest(m));
    JSONObject paste = new JSONObject().put("tags", new org.json.JSONArray().put("talkrouter-paste").put("req-abc234"));
    assertEquals("", ChiefText.spokenRequest(paste));
    assertEquals("", ChiefText.spokenRequest(new JSONObject().put("event", "keepalive")));
    // The talker's updates from the chief: spoken, without a request.
    JSONObject untagged = new JSONObject().put("event", "message").put("tags", new org.json.JSONArray().put("talkrouter-speak"));
    assertEquals("", ChiefText.spokenRequest(untagged));
    assertTrue(ChiefText.spoken(untagged));
    assertTrue(ChiefText.spoken(m));
    assertFalse(ChiefText.spoken(paste));
    assertFalse(ChiefText.spoken(new JSONObject().put("event", "keepalive")));
  }

  @Test
  public void handsFreeMessagesAreTaggedAndTheSkillExplainsThem() throws Exception {
    String m = BbBridge.message("Book a table", List.of(), HandsFree.TAG, "k3x9qa");
    assertEquals("Book a table\n\n[hands-free]\n\n[request: k3x9qa]", m);
    String skill =
        new String(
            java.nio.file.Files.readAllBytes(java.nio.file.Path.of("src/main/assets/skills/dictate-and-delegate/SKILL.md")),
            java.nio.charset.StandardCharsets.UTF_8);
    assertTrue(skill.contains("[hands-free]"));
    assertTrue(skill.contains("Tags: talkrouter-speak,req-<id>"));
    assertTrue(skill.contains("send one spoken reply, soon"));
    assertTrue(skill.contains("[your reply hasn't played yet, it plays after this message: "));
    assertTrue(skill.contains("[hands-free call started]") && skill.contains("[hands-free call ended]"));
    assertTrue(skill.contains("[didn't hear your reply:"));
    assertFalse(skill.contains("quick spoken reaction"));
  }

  @Test
  public void theVoiceRequestNamesModelAndVoice() throws Exception {
    JSONObject b = Voice.body(Voice.KOKORO, "Hello");
    assertEquals("hexgrad/kokoro-82m", b.getString("model"));
    assertEquals("af_heart", b.getString("voice"));
    assertEquals("mp3", b.getString("response_format"));
    assertEquals(Voice.KOKORO, Voice.choice("nonsense"));
    assertEquals(Voice.ELEVEN, Voice.choice("eleven"));
  }

  // ------------------------------------------------------------------ the voice never leaves you stuck

  @Test
  public void whileAReplysAudioIsFetchedTheFloorStaysOpenAndYouCanTalk() throws Exception {
    Fake f = new Fake("Wait, one more thing. Over.");
    java.util.concurrent.CountDownLatch fetched = new java.util.concurrent.CountDownLatch(1);
    f.prepare =
        text -> {
          try {
            fetched.await();
          } catch (InterruptedException ignored) {
            /* Go on. */
          }
          return text;
        };
    f.quiet(1000);
    f.session.reply("r0", "Here's the answer.");
    Thread.sleep(100);
    // Not read yet: the microphone is on and the floor open.
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertEquals(HandsFreeSession.Floor.OPEN, f.session.floor());
    f.speak(); // You take it meanwhile.
    fetched.countDown();
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty()); // Held: the floor is yours.
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Wait, one more thing.\n\n[your reply hasn't played yet, it plays after this message: \"Here's the answer.\"]", f.sent.get(0));
    until(() -> f.spoken.size() == 1); // Not dropped: it plays once your turn is over.
    assertEquals("Here's the answer.", f.spoken.get(0));
  }

  @Test
  public void audioThatNeverStartsIsGivenUpSoonAndNotedAsNotHeard() throws Exception {
    Fake f = new Fake("What did you say? Over.");
    f.audioStarts = false;
    f.quiet(1000);
    f.session.reply("r0", "The meeting moved to three.");
    until(() -> f.spoken.size() == 1);
    assertEquals(HandsFreeSession.State.READING, f.session.state());
    f.session.tick();
    assertEquals(HandsFreeSession.State.READING, f.session.state()); // Not yet.
    // Tried once more (its voice fetched afresh), then it counts as not heard.
    for (int i = 1; i <= 1 + HandsFreeSession.RETRIES; i++) {
      int tries = i;
      until(() -> f.spoken.size() == tries);
      f.now.addAndGet(HandsFreeSession.START_MS + 1);
      f.session.tick();
    }
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertEquals(1, f.session.unheard());
    assertEquals(1 + HandsFreeSession.RETRIES, f.spoken.size());
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("What did you say?\n\n[didn't hear your reply: \"The meeting moved to three.\"]", f.sent.get(0));
    assertEquals(0, f.session.unheard());
  }

  @Test
  public void audioThatPlaysFarTooLongIsLetGo() throws Exception {
    Fake f = new Fake();
    f.quiet(1000);
    f.session.reply("r0", "A reply of two seconds.");
    until(() -> f.spoken.size() == 1);
    f.now.addAndGet(2000 + HandsFreeSession.OVERRUN_MS - 100);
    f.session.tick();
    assertEquals(HandsFreeSession.State.READING, f.session.state()); // Still within its length.
    f.now.addAndGet(200);
    f.session.tick();
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertTrue(String.join("\n", f.log), String.join("\n", f.log).contains("played too long"));
  }

  @Test
  public void aVoiceThatFailsReturnsToListeningAtOnce() throws Exception {
    Fake f = new Fake();
    f.audioStarts = false;
    f.quiet(1000);
    f.session.reply("r0", "Can't be played.");
    for (int i = 1; i <= 1 + HandsFreeSession.RETRIES; i++) {
      int tries = i;
      until(() -> f.spoken.size() == tries);
      f.fail.run(); // The player reports an error before any audio.
    }
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertEquals(1, f.session.unheard());
  }

  @Test
  public void aReplyWhoseVoiceFailsIsTriedAgainAndHeard() throws Exception {
    Fake f = new Fake();
    f.audioStarts = false;
    f.quiet(1000);
    f.session.reply("r0", "The table is booked.");
    until(() -> f.spoken.size() == 1);
    f.audioStarts = true; // Played the second time.
    f.fail.run(); // Android's voice couldn't play it.
    until(() -> f.spoken.size() == 2); // Its voice fetched again, and played.
    f.done.run();
    assertEquals(0, f.session.unheard());
    assertTrue(reasons(f), reasons(f).contains("Reply couldn't be played (the voice stopped): trying again"));
  }

  @Test
  public void writingDownThatHangsIsGivenUpTriedOnceMoreAndShown() throws Exception {
    long was = HandsFreeSession.writeTimeoutMs;
    HandsFreeSession.writeTimeoutMs = 300;
    try {
      Fake f = new Fake("Book the table", "Book the table");
      f.slow = new java.util.concurrent.CountDownLatch(1); // Both tries hang.
      f.talk();
      until(() -> f.session.checkStep().equals("writing"));
      assertEquals(HandsFreeSession.Live.WRITING, f.session.live());
      until(() -> reasons(f).contains("Writing down took over 0 s: trying once more"));
      until(() -> reasons(f).contains("Couldn't write down"));
      f.slow.countDown();
      // Kept: Send writes it down and sends it.
      f.session.sendNow();
      until(() -> f.sent.size() == 1);
    } finally {
      HandsFreeSession.writeTimeoutMs = was;
    }
  }

  @Test
  public void wordsNotSentWhenTheCallEndsAreSentBeforeItsEnd() throws Exception {
    Fake f = new Fake("And also look at the latency");
    f.session.judge = said -> verdict("more", 0.1, 0);
    f.talk();
    until(() -> f.session.pending().equals("And also look at the latency"));
    f.session.end();
    assertTrue(f.session.awaitDelivered(2000));
    assertEquals(List.of("And also look at the latency"), f.sent);
    assertTrue(String.join("\n", f.log), String.join("\n", f.log).contains("they're sent before the call's end"));
  }

  @Test
  public void wordsNotYetWrittenDownWhenTheCallEndsAreWrittenDownAndSent() throws Exception {
    Fake f = new Fake("Order the parts");
    f.quiet(1000);
    f.speak(); // Still talking when the call ends: the part ends with it.
    f.session.end();
    assertTrue(f.session.awaitDelivered(3000));
    assertEquals(List.of("Order the parts"), f.sent);
  }

  @Test
  public void aTranscriptionThatFailsKeepsYourWordsAndTheNextCheckTriesAgain() throws Exception {
    Fake f = new Fake(); // No transcripts queued: the speech model fails.
    f.quiet(1000);
    f.talk();
    until(() -> !f.session.error().isEmpty());
    // Your turn is kept: a reply waits for it.
    assertEquals(HandsFreeSession.Floor.YOU, f.session.floor());
    f.session.reply("r0", "Read now.");
    f.quiet(400);
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    f.transcripts.add("Book the hotel. Over.");
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel.\n\n[your reply hasn't played yet, it plays after this message: \"Read now.\"]", f.sent.get(0));
    until(() -> f.spoken.size() == 1); // Your turn is over.
  }

  @Test
  public void aReplyLongerThanItsEstimateIsNeverCutWhileItsAudioPlays() throws Exception {
    Fake f = new Fake();
    f.quiet(1000);
    f.session.reply("r0", "A long reply that takes longer than the voice said.");
    until(() -> f.spoken.size() == 1);
    f.audioPlaying = true;
    for (int i = 0; i < 30; i++) { // A minute past its two seconds, still playing.
      f.now.addAndGet(2000);
      f.session.tick();
    }
    assertEquals(HandsFreeSession.State.READING, f.session.state());
    f.done.run(); // Played to the end: heard.
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertEquals(0, f.session.unheard());
  }

  // ------------------------------------------------------------------ talking over a reply

  static final String LONG_REPLY =
      "The flight leaves at nine in the morning from gate twelve. The train to Lisbon costs about forty euros if you book today.";

  /** A reply playing, what's left of its echo after the phone's echo cancellation in the mic. */
  static Fake playingReply(String... transcripts) throws Exception {
    Fake f = new Fake(transcripts);
    f.quiet(1000);
    f.session.reply("r1", LONG_REPLY);
    until(() -> f.spoken.size() == 1);
    for (int i = 0; i < 100; i++) f.session.frame(frame(i % 7 == 0 ? 700 : 300)); // Its leftover echo.
    assertFalse("its own echo doesn't stop it", f.stopped);
    f.heardChars = LONG_REPLY.indexOf("from gate");
    return f;
  }

  /** Feeds your speech over the reply until it stops (at most limit frames): how many it took. */
  static int framesToStop(Fake f, int amplitude, int limit) {
    for (int i = 1; i <= limit; i++) {
      f.session.frame(frame(amplitude));
      if (f.stopped) return i;
    }
    return -1;
  }

  @Test
  public void talkingOverAReplyStopsItDropsTheRestAndYourNextMessageSaysHowFarYouHeard() throws Exception {
    Fake f = playingReply("Hold on, book the train instead.", "Over.");
    f.heardChars = LONG_REPLY.indexOf("Lisbon");
    int frames = framesToStop(f, 8000, 40); // You, over the reply.
    assertEquals("stopped after 300 ms of your speech", HandsFreeSession.BARGE_MS / 20, frames);
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertEquals("nothing had to be written down to stop it", 0, f.transcriptions.get());
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("barge-in: speech 300 ms → stopped"));
    assertTrue(reasons(f), reasons(f).contains("Reply stopped: you talked over it; the chief will hear how far you got"));
    assertEquals("the rest is dropped, not waiting", 0, f.session.held());
    // You go on: all of it is your turn.
    for (int i = 0; i < 30; i++) f.session.frame(frame(8000));
    f.quiet(1200);
    until(() -> f.session.pending().equals("Hold on, book the train instead."));
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Hold on, book the train instead.\n\n[heard up to: \"…the morning from gate twelve. The train to\"]", f.sent.get(0));
    // Nothing of it plays again.
    f.quiet(3000);
    f.now.addAndGet(30_000);
    f.session.tick();
    Thread.sleep(200);
    assertEquals(List.of(LONG_REPLY), f.spoken);
    assertEquals(0, f.session.unheard());
  }

  @Test
  public void aReplyTalkedOverWithNoMessageAfterItIsNotedWithTheCallsEnd() throws Exception {
    Fake f = playingReply("");
    f.heardChars = LONG_REPLY.indexOf("twelve");
    framesToStop(f, 8000, 40);
    f.quiet(1200); // What you said had no words: nothing to send.
    until(() -> f.transcriptions.get() == 1);
    Thread.sleep(100);
    f.session.end();
    assertEquals("\n\n[heard up to: \"…leaves at nine in the morning from gate\"]", f.session.endNote());
    assertTrue(f.sent.isEmpty());
  }

  @Test
  public void aReplyArrivingWhileYouTalkStillWaitsAndPlays() throws Exception {
    Fake f = new Fake("I was thinking about the trip");
    f.quiet(1000);
    f.speak();
    f.session.reply("r1", "Your table is booked.");
    Thread.sleep(150);
    assertTrue("it waits while you talk", f.spoken.isEmpty());
    f.quiet(1600); // Your pause: your words unsent, still your turn.
    Thread.sleep(150);
    assertTrue("it waits through your turn", f.spoken.isEmpty());
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    until(() -> f.spoken.size() == 1);
    assertEquals("Your table is booked.", f.spoken.get(0));
    f.done.run();
    assertEquals(0, f.session.unheard());
  }

  @Test
  public void clattersAndItsOwnEchoNeverStopAReply() throws Exception {
    Fake f = playingReply();
    for (int i = 0; i < 6; i++) {
      for (int k = 0; k < 10; k++) f.session.frame(frame(9000)); // 200 ms, far louder than the room.
      for (int k = 0; k < 80; k++) f.session.frame(frame(300)); // 1.6 s of its leftover echo.
    }
    assertFalse(f.stopped);
    assertEquals(HandsFreeSession.State.READING, f.session.state());
    assertEquals(HandsFreeSession.Live.PLAYING, f.session.live());
    assertEquals(0, f.transcriptions.get());
    f.done.run();
    assertEquals(0, f.session.unheard());
    assertEquals("", f.session.pending());
  }

  @Test
  public void theNotesSayHowMuchOfAReplyWasHeard() {
    assertEquals("[heard up to: \"…leaves at nine in the morning from gate\"]", HandsFreeSession.heardUpTo(LONG_REPLY, LONG_REPLY.indexOf("twelve")));
    // A word cut in the middle isn't counted as heard.
    assertEquals("[heard up to: \"The flight\"]", HandsFreeSession.heardUpTo(LONG_REPLY, LONG_REPLY.indexOf("leaves") + 3));
    // Hardly anything heard: as if not heard at all.
    assertTrue(HandsFreeSession.heardUpTo(LONG_REPLY, 3).startsWith("[didn't hear your reply:"));
  }

  // ------------------------------------------------------------------ taking the turn, and the send word

  @Test
  public void speechWithLittleGapsTakesTheTurn() throws Exception {
    // Real dead calls: "Hi, can you hear me" in short loud bits, never a second without a gap.
    Fake f = new Fake("Hi, can you hear me?");
    for (int i = 0; i < 100; i++) f.session.frame(frame(212)); // A room: background about 150.
    for (int b = 0; b < 3; b++) { // 0.2 s bits at about 5× the background, 0.2 s gaps.
      for (int i = 0; i < 10; i++) f.session.frame(frame(1100));
      for (int i = 0; i < 10; i++) f.session.frame(frame(212));
    }
    assertEquals(HandsFreeSession.Floor.YOU, f.session.floor());
    for (int i = 0; i < 60; i++) f.session.frame(frame(212));
    until(() -> f.session.pending().equals("Hi, can you hear me?"));
  }

  @Test
  public void aShortClearlyLoudBurstTakesTheTurn() throws Exception {
    Fake f = new Fake("Hello?");
    f.quiet(1000);
    for (int i = 0; i < 6; i++) f.session.frame(frame(6000)); // 0.12 s, far louder than the room.
    f.quiet(1200);
    until(() -> f.session.pending().equals("Hello?"));
  }

  @Test
  public void theBackgroundIsLearnedFastAtTheStart() {
    HandsFree.Segmenter s = new HandsFree.Segmenter(800, pcm -> {});
    feed(s, 50, 600);
    assertTrue("background " + s.background(), s.background() < 60);
  }

  @Test
  public void sendWritesDownSoundsThatDidntCountAsSpeech() throws Exception {
    Fake f = new Fake("Hi, can you hear me?");
    for (int i = 0; i < 100; i++) f.session.frame(frame(212));
    for (int b = 0; b < 2; b++) { // Two bits too short to take the turn.
      for (int i = 0; i < 4; i++) f.session.frame(frame(1100));
      for (int i = 0; i < 60; i++) f.session.frame(frame(212));
    }
    assertEquals(HandsFreeSession.Floor.OPEN, f.session.floor());
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    assertEquals("Hi, can you hear me?", f.sent.get(0));
    assertTrue(reasons(f), reasons(f).contains("Send: writing down what didn't count as speech"));
  }

  @Test
  public void theSendWordOnItsOwnAfterSendIsntAnEmptyTurn() throws Exception {
    // 22:37: Send pressed while the part was written down, then "over." came as a part of its own.
    Fake f = new Fake("Maybe it's also not needed", "over.");
    f.talk();
    until(() -> !f.session.pending().isEmpty());
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    f.talk();
    until(() -> reasons(f).contains("Send word heard: your message had already gone"));
    assertEquals(1, f.sent.size());
    assertFalse(String.join("\n", f.log), String.join("\n", f.log).contains("your turn ended without a message"));
  }

  @Test
  public void eachCheckWritesDownOnlyTheNewPartAndSendRightAfterWritesNothing() throws Exception {
    Fake f = new Fake("Book the", "hotel for Friday");
    f.talk();
    until(() -> f.session.pending().equals("Book the"));
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel for Friday"));
    assertEquals(2, f.transcriptions.get());
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel for Friday", f.sent.get(0));
    assertEquals("Send after a check: nothing written down again", 2, f.transcriptions.get());
  }

  @Test
  public void onlyTheNewPartIsWrittenDownAtAPauseButTheWholeTurnInOnePassIsWhatGoes() throws Exception {
    // On its own, a part's first word came out wrong; in one pass with the rest it's right.
    Fake f = new Fake("Book that", "hotel for Friday. Over.");
    f.wholeAs = t -> t.replace("Book that", "Book the");
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return said.endsWith("Over.") ? verdict("over", 0.95, 0) : verdict("unfinished", 0.1, 0);
    };
    f.talk();
    until(() -> f.session.pending().equals("Book that"));
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel for Friday.", f.sent.get(0));
    assertEquals("each part written down once, on its own", 2, f.transcriptions.get());
    assertEquals("Jev judges the parts' text, whole", List.of("Book that", "Book that hotel for Friday. Over."), asked);
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("check (pause): 2 part(s), "));
    assertTrue(log, log.contains("1 new (1.") && log.contains(" s) written down in "));
    assertTrue(log, log.contains("whole turn (2 parts) written down in "));
    assertTrue(log, log.contains("it changed 1 of 6 words of the parts' text"));
  }

  @Test
  public void whenTheWholeTurnsPassFailsThePartsTextGoes() throws Exception {
    Fake f = new Fake("Book the hotel", "for Friday. Over.");
    f.wholeFails = true;
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel for Friday.", f.sent.get(0));
    assertTrue(String.join("\n", f.log).contains("the whole turn couldn't be written down (Fake provider error): the parts' text goes"));
  }

  @Test
  public void endingTheCallWhileTheWholePassIsWaitedForSendsYourWordsOnce() throws Exception {
    Fake f = new Fake("Book the hotel", "for Friday. Over.");
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.slowWhole = new java.util.concurrent.CountDownLatch(1);
    f.talk(); // Jev (none: the send word) says done; sending waits for the whole pass.
    until(() -> f.wholes.get() >= 1);
    f.session.end();
    f.slowWhole.countDown();
    Thread.sleep(500);
    assertEquals(String.join("\n", f.log), 1, f.sent.size());
    assertTrue(f.sent.get(0), f.sent.get(0).startsWith("Book the hotel for Friday"));
  }

  @Test
  public void talkingOnWhileTheWholePassIsWaitedForMeansNoSendYet() throws Exception {
    Fake f = new Fake("Book the hotel", "for Friday. Over.", "and the car. Over.");
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.slowWhole = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.wholes.get() >= 1);
    f.speak(); // On you go, mid-sentence.
    f.slowWhole.countDown();
    Thread.sleep(300);
    assertEquals(0, f.sent.size());
    f.slowWhole = null;
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel for Friday. Over. and the car.", f.sent.get(0));
  }

  @Test
  public void whenThePartsHaveNoWordsButTheWholePassHasThemTheyGo() throws Exception {
    // Each part alone came out empty (the first kept: you talked on while it was checked); in one
    // pass the words are there.
    Fake f = new Fake("", "");
    f.wholeAs = t -> "Book the table.";
    f.session.judge = said -> verdict("request", 0.95, 0);
    f.slow = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    until(() -> f.session.checkStep().equals("writing"));
    f.speak(); // On you go while it's written down.
    f.slow.countDown();
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table.", f.sent.get(0));
  }

  @Test
  public void yourLastWordsGoAsFarAsTheyWereWrittenDownWhenThRestFails() throws Exception {
    Fake f = new Fake("Book the hotel"); // The next part's transcription fails.
    f.session.judge = said -> verdict("more", 0.1, 0);
    f.talk();
    until(() -> f.session.pending().equals("Book the hotel"));
    f.speak();
    f.session.end();
    for (int i = 0; i < 250 && f.sent.isEmpty(); i++) Thread.sleep(20); // The fake waits 2 s for the part's text.
    assertEquals(String.join("\n", f.log), List.of("Book the hotel"), f.sent);
    assertTrue(String.join("\n", f.log).contains("some of your last words couldn't be written down"));
  }

  @Test
  public void aReplyThatStopsPartWayIsNotPlayedAgainAndYourNextMessageSaysHowFar() throws Exception {
    Fake f = new Fake("Thanks. Over.");
    f.quiet(1000);
    f.session.reply("r1", LONG_REPLY);
    until(() -> f.spoken.size() == 1);
    f.heardChars = LONG_REPLY.indexOf("Lisbon");
    f.fail.run(); // Its audio stopped coming part-way.
    Thread.sleep(300);
    assertEquals("not played again", 1, f.spoken.size());
    assertTrue(reasons(f), reasons(f).contains("Reply stopped part-way"));
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Thanks.\n\n[heard up to: \"…the morning from gate twelve. The train to\"]", f.sent.get(0));
  }

  @Test
  public void wordsChangedCountsWordsAddedDroppedOrChanged() {
    assertEquals(0, HandsFreeSession.wordsChanged("Book the hotel.", "book the  hotel"));
    assertEquals(1, HandsFreeSession.wordsChanged("Book that hotel", "Book the hotel"));
    assertEquals(2, HandsFreeSession.wordsChanged("Book the hotel", "Book the hotel for Friday"));
    assertEquals(3, HandsFreeSession.wordsChanged("", "one two three"));
  }

  // ------------------------------------------------------------------ live transcription

  /** Live transcription that says what the test tells it to, and counts what it heard. */
  static final class FakeLive implements HandsFreeSession.LiveText {
    final HandsFreeSession session;
    volatile String text = "";
    /** What the model's final text of it will be (null: the live text as it is). */
    volatile String finalText;
    volatile boolean failed;
    final List<String> taken = new CopyOnWriteArrayList<>();
    final java.util.concurrent.atomic.AtomicInteger frames = new java.util.concurrent.atomic.AtomicInteger(),
        loud = new java.util.concurrent.atomic.AtomicInteger(), discards = new java.util.concurrent.atomic.AtomicInteger();

    FakeLive(Fake f) {
      session = f.session;
      session.live = this;
    }

    /** The model's live text is now this. */
    void say(String t) {
      text = t;
      session.liveText(t);
    }

    void fail(String why) {
      failed = true;
      session.liveFailed(why);
    }

    public void audio(byte[] frame) {
      frames.incrementAndGet();
      if (HandsFree.Segmenter.level(frame, frame.length) > 250) loud.incrementAndGet();
    }

    public void speech() {}

    public String text() {
      return text;
    }

    public String take(long waitMs) throws Exception {
      if (failed) throw new java.io.IOException("connection lost");
      String t = finalText != null ? finalText : text;
      finalText = null;
      text = "";
      taken.add(t);
      return t;
    }

    public void discard() {
      text = "";
      discards.incrementAndGet();
    }

    public boolean working() {
      return !failed;
    }

    public String failure() {
      return failed ? "connection lost" : "";
    }

    public void close() {}
  }

  @Test
  public void aSendWordAtTheEndOfTheLiveTextSendsAtOnceWithoutAPauseOnceJevAgrees() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return verdict("over", 0.95, 0);
    };
    f.quiet(1000);
    f.speak(); // Still talking: no pause yet.
    live.say("Book the table for Friday");
    assertEquals("Book the table for Friday", f.session.pending());
    live.finalText = "Book the table for Friday. Over.";
    live.say("Book the table for Friday over");
    Thread.sleep(100);
    assertEquals("not before you're quiet a moment after it", 0, f.sent.size());
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table for Friday.", f.sent.get(0));
    assertEquals("nothing written down from audio", 0, f.transcriptions.get());
    assertEquals("Jev asked once, about the live text", List.of("Book the table for Friday over"), asked);
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("live text ends with the send phrase: \"Book the table for Friday over\""));
    assertTrue(log, log.contains("Jev on the send phrase in "));
    assertTrue(log, log.contains("send phrase: quiet "));
    assertTrue(log, log.contains("ms after the phrase was heard)"));
    // The stretch it was said in ends at the pause: it went with the message, nothing more is checked.
    f.quiet(1200);
    Thread.sleep(150);
    assertTrue(String.join("\n", f.log).contains("the rest of the stretch with the phrase"));
    assertEquals(1, f.sent.size());
    assertFalse(reasons(f), reasons(f).contains("heard no words"));
    assertEquals(HandsFreeSession.Floor.OPEN, f.session.floor());
  }

  @Test
  public void withoutJevTheSendWordSendsAndEndTheCallEndsIt() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    f.speak();
    live.say("Remind me to call Jana. Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("Remind me to call Jana.", f.sent.get(0));
    f.quiet(1200);
    Thread.sleep(150);
    f.speak();
    live.say("Thanks, that was everything. End the call.");
    f.quiet(800);
    Thread.sleep(200);
    // No Jev to confirm the goodbye: not at once; at the pause the end words still end it.
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertTrue(String.join("\n", f.log).contains("Jev couldn't confirm the goodbye (no judge): not ended"));
    f.quiet(600);
    until(() -> f.session.state() == HandsFreeSession.State.ENDED);
    until(() -> f.sent.size() == 2); // The last words go after the end.
    assertEquals("Thanks, that was everything.", f.sent.get(1));
  }

  @Test
  public void aSendWordWhoseFinalTextGoesOnSendsNothing() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.session.judge = said -> verdict("over", 0.9, 0); // Jev took it for the end: the final text says otherwise.
    f.quiet(1000);
    f.speak();
    // The live text ended with "over" for a moment; the final text goes on.
    live.finalText = "The game is over and then we left";
    live.say("The game is over");
    f.quiet(400);
    until(() -> String.join("\n", f.log).contains("doesn't end with the phrase"));
    assertEquals(0, f.sent.size());
    live.say("and the train was late. Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("The game is over and then we left and the train was late.", f.sent.get(0));
  }

  @Test
  public void endTheCallWithoutAPauseAfterItIsAHesitationNotAGoodbye() throws Exception {
    // "Should we end the call … tomorrow": a hesitation after "call" doesn't hang up.
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    f.speak();
    live.say("Should we end the call");
    f.quiet(300); // A hesitation, shorter than hanging up waits for.
    f.speak();
    live.say("Should we end the call tomorrow");
    f.quiet(800);
    Thread.sleep(200);
    String log = String.join("\n", f.log);
    assertEquals(log, HandsFreeSession.State.LISTENING, f.session.state());
    assertTrue(log, log.contains("you went on after the phrase: not an ending"));
    assertEquals(log, 0, f.sent.size());
  }

  @Test
  public void jevConfirmsAGoodbyeBeforeTheCallEnds() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return said.contains("Thanks") ? verdict("end", 0.9, 0.95) : verdict("request", 0.2, 0.1);
    };
    f.quiet(1000);
    f.speak();
    live.say("Ask Jana how to end the call"); // Then quiet: but it's not a goodbye.
    f.quiet(800);
    until(() -> String.join("\n", f.log).contains("Jev: not a goodbye"));
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    f.speak();
    live.say("Ask Jana how to end the call and tell her. Thanks, end the call.");
    f.quiet(800);
    until(() -> f.session.state() == HandsFreeSession.State.ENDED);
    assertEquals("Ask Jana how to end the call and tell her. Thanks", f.sent.get(0));
  }

  @Test
  public void aReplyAfterASendPhraseDoesntCostTheNextStretch() throws Exception {
    Fake f = new Fake("Second.");
    FakeLive live = new FakeLive(f);
    f.session.judge = HandsFreeTest::overIsDone;
    f.quiet(1000);
    f.speak();
    live.say("Book the table. Over.");
    f.quiet(400); // Sent while the stretch goes on: its rest went with the message.
    until(() -> f.sent.size() == 1);
    f.session.reply("r1", "Done.");
    f.quiet(1200);
    until(() -> f.spoken.size() == 1);
    f.done.run();
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    live.fail("connection lost");
    f.talk(); // The next stretch is yours, written down.
    f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
    f.session.sendNow();
    for (int i = 0; i < 100 && f.sent.size() < 2; i++) Thread.sleep(20);
    assertEquals(String.join("\n", f.log), List.of("Book the table.", "Second."), f.sent);
  }

  @Test
  public void audioWithoutLiveTextIsWrittenDownNotDropped() throws Exception {
    // Send pressed before the first live words came (or a short turn they never came for).
    Fake f = new Fake("Book the table.");
    new FakeLive(f);
    f.quiet(1000);
    f.talk();
    until(() -> f.session.pending().equals("Book the table."));
    assertTrue(String.join("\n", f.log).contains("no live text for 1."));
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table.", f.sent.get(0));
  }

  @Test
  public void wordsTakenForAPhraseMidSentenceAreNotWrittenDownAgainAfterAFailure() throws Exception {
    Fake f = new Fake("and the train was late. Over.");
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    f.speak();
    live.finalText = "The game is over and then we left";
    live.say("The game is over");
    f.quiet(400);
    until(() -> String.join("\n", f.log).contains("doesn't end with the phrase"));
    f.quiet(1200); // That stretch ends: its words are in the turn already.
    live.fail("connection lost");
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("The game is over and then we left and the train was late.", f.sent.get(0));
    assertEquals("only the new part written down", 1, f.transcriptions.get());
  }

  @Test
  public void aClickAfterASendPhraseDoesntCostTheNextStretch() throws Exception {
    Fake f = new Fake("Book the table.", "Second.");
    FakeLive live = new FakeLive(f);
    f.session.judge = HandsFreeTest::overIsDone;
    f.quiet(1000);
    f.talk(); // No live words came: written down from its audio, not done yet.
    until(() -> f.session.pending().equals("Book the table."));
    // A click going on (too short to count) as "Over." comes and is acted on. (Live words of the
    // part written down still coming late are dropped: they'd be there twice.)
    for (int i = 0; i < 3; i++) f.session.frame(frame(7000));
    live.say("Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table.", f.sent.get(0));
    f.quiet(1200); // The click ends as noise: the next stretch is yours again.
    live.fail("connection lost");
    f.talk();
    f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
    f.session.sendNow();
    for (int i = 0; i < 100 && f.sent.size() < 2; i++) Thread.sleep(20);
    assertEquals(String.join("\n", f.log), 2, f.sent.size());
    assertEquals("Second.", f.sent.get(1));
  }

  @Test
  public void atAPauseWithoutASendWordJevJudgesTheLiveText() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return verdict("question", 0.95, 0);
    };
    f.quiet(1000);
    f.speak();
    live.say("can you check when the next train leaves");
    live.finalText = "Can you check when the next train leaves?";
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals(List.of("can you check when the next train leaves"), asked);
    assertEquals("the model's final text goes", "Can you check when the next train leaves?", f.sent.get(0));
    assertEquals(0, f.transcriptions.get());
    assertTrue(String.join("\n", f.log).contains("final live text in "));
  }

  @Test
  public void whenLiveTranscriptionFailsItSaysSoAndYourWordsAreWrittenDownFromTheirAudio() throws Exception {
    Fake f = new Fake("Book the table. Over.");
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    f.speak();
    live.say("Book the");
    live.fail("connection lost");
    until(() -> reasons(f).contains("Live transcription failed (connection lost): your words are written down instead"));
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table.", f.sent.get(0));
    assertEquals(1, f.transcriptions.get());
  }

  @Test
  public void aTurnWhoseLiveTextLooksStuckIsWrittenDownFromItsAudio() throws Exception {
    // ElevenLabs once stayed on "Mm." for 30 s while Philipp talked.
    Fake f = new Fake("Book the table for four tonight at eight. Over.");
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    for (int i = 0; i < 4; i++) f.speak(); // 4.8 s of speech.
    live.say("Mm.");
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table for four tonight at eight.", f.sent.get(0));
    assertTrue(String.join("\n", f.log).contains("live text looks stuck (1 words for 5."));
    assertTrue(reasons(f), reasons(f).contains("Live transcription looks stuck"));
  }

  @Test
  public void wordsLiveTranscriptionHearsWhileNobodyHasTheFloorAreDropped() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    live.say("and now the weather"); // A radio: nobody took the floor.
    assertEquals("", f.session.pending());
    f.quiet(3200);
    f.session.tick();
    assertEquals(1, live.discards.get());
    assertTrue(String.join("\n", f.log).contains("live text heard words while nobody had the floor: dropped (\"and now the weather\")"));
  }

  @Test
  public void aSendPhraseThatDoesntActAlwaysSaysWhyInTheLog() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    // Nobody took the floor: the phrase is only noise's words.
    live.say("game over");
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("live text ends with the send phrase, not acted on: nobody had the floor (no speech heard) (\"game over\")"));
    live.say("game over"); // Repeats aren't logged again.
    assertEquals(1, count(String.join("\n", f.log), "not acted on: nobody had the floor"));
    // A reply playing.
    f.session.reply("r0", "Here's what I found.");
    until(() -> f.spoken.size() == 1);
    live.say("thanks over");
    assertTrue(String.join("\n", f.log).contains("not acted on: a reply is playing (\"thanks over\")"));
    f.done.run();
    // Live transcription failed: written down from audio, and the log says so.
    live.fail("connection lost");
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    f.speak();
    live.say("book it over");
    assertTrue(String.join("\n", f.log).contains("not acted on: live transcription isn't working (\"book it over\")"));
  }

  @Test
  public void tenSecondsIntoACallTheLogSaysWhetherLiveTranscriptionWorks() throws Exception {
    Fake f = new Fake();
    new FakeLive(f);
    f.session.tick();
    f.now.addAndGet(HandsFreeSession.LIVE_CHECK_MS);
    f.session.tick();
    f.session.tick();
    assertEquals(1, count(String.join("\n", f.log), "live transcription 10 s into the call: working"));
    Fake off = new Fake();
    off.session.tick();
    off.now.addAndGet(HandsFreeSession.LIVE_CHECK_MS);
    off.session.tick();
    assertTrue(String.join("\n", off.log).contains("live transcription 10 s into the call: not used (off, or no key)"));
  }

  @Test
  public void wordsLiveTranscriptionHearsWhileNobodyHasTheFloorDontHoldAReply() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    live.say("and now the weather"); // A radio.
    f.session.reply("r1", "Your table is booked.");
    until(() -> f.spoken.size() == 1);
    assertEquals("", f.session.pending());
  }

  @Test
  public void withLiveTranscriptionYourTurnIsYourUnsentWordsNotLoudness() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    // Speech without words yet: your turn a moment (the live text's delay), then not.
    f.speak();
    assertEquals("speaking", f.session.yourTurn(f.now.get()));
    f.session.reply("r1", "Your table is booked.");
    Thread.sleep(100);
    assertTrue(f.spoken.isEmpty());
    f.now.addAndGet(HandsFreeSession.WORDLESS_MS);
    assertNull("loud, but no words: not your turn", f.session.yourTurn(f.now.get()));
    f.session.tick();
    until(() -> f.spoken.size() == 1);
    f.done.run();
    f.now.addAndGet(HandsFreeSession.TAIL_MS + 1);
    f.quiet(1200);
    Thread.sleep(150);
    // Words: your turn, however quiet you are.
    f.speak();
    live.say("Book the hotel");
    f.quiet(1500);
    until(() -> "unsent words".equals(f.session.yourTurn(f.now.get()))); // Once its check is done.
    f.session.reply("r2", "Anything else?");
    f.quiet(5000);
    f.session.tick();
    Thread.sleep(100);
    assertEquals(1, f.spoken.size());
    assertTrue(reasons(f), reasons(f).contains("Reply waits: your turn (unsent words)"));
    assertTrue(String.join("\n", f.log).contains("turn: yours (unsent words)"));
  }

  @Test
  public void aReplyIsSilenceToLiveTranscriptionUntilYouTalkOverIt() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.quiet(1000);
    f.session.reply("r1", LONG_REPLY);
    until(() -> f.spoken.size() == 1);
    int before = live.loud.get();
    for (int i = 0; i < 100; i++) f.session.frame(frame(i % 7 == 0 ? 700 : 300)); // Its leftover echo.
    assertEquals("its echo isn't sent", before, live.loud.get());
    // You, over it, with little gaps: it takes a while to count as you; all of it goes to live
    // transcription once it does, from the start (not only the last half second).
    int loud = 0;
    for (int i = 0; i < 80 && f.session.state() == HandsFreeSession.State.READING; i++) {
      boolean voiced = i % 4 < 2;
      if (voiced) loud++;
      f.session.frame(frame(voiced ? 8000 : 50));
    }
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    assertTrue(loud + " loud frames, " + (live.loud.get() - before) + " sent", live.loud.get() - before >= loud);
  }

  // ------------------------------------------------------------------ the send word, checked by Jev

  /** Jev as it should answer: done once "over" is a sentence of its own at the end, else more to come. */
  static HandsFreeSession.Verdict overIsDone(String said) {
    return said.matches("(?is)(.*[.!?,]\\s*)?over[.!?]?") ? verdict("over", 0.95, 0) : verdict("more", 0.1, 0);
  }

  @Test
  public void overThatsAWordOfTheSentenceIsHeldBackByJevAndTheTurnGoesOn() throws Exception {
    // The sentence from Philipp's call that "over" alone used to send in the middle of.
    String sentence = "Let someone live there for 3 months until the period is over.";
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return said.equals(sentence) ? verdict("unfinished", 0.2, 0) : overIsDone(said);
    };
    f.quiet(1000);
    f.speak();
    live.say(sentence);
    f.quiet(400);
    until(() -> reasons(f).contains("Not sent: you seem mid-sentence (20% done)"));
    Thread.sleep(100);
    assertEquals(0, f.sent.size());
    assertEquals(HandsFreeSession.Floor.YOU, f.session.floor());
    assertEquals("the live text wasn't taken: it goes on", sentence, live.text());
    assertTrue(String.join("\n", f.log).contains("send phrase: Jev says you're not done (done 0.20): not sent, the turn goes on"));
    // The live text repeats it (its final): not asked again.
    live.say(sentence);
    Thread.sleep(100);
    assertEquals(List.of(sentence), asked);
    // You go on, and end with "over" as the send word.
    f.speak();
    live.say(sentence + " Then we sell it. Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals(sentence + " Then we sell it.", f.sent.get(0));
    assertEquals(List.of(sentence, sentence + " Then we sell it. Over."), asked);
  }

  @Test
  public void jevIsAskedAtOnceOnTheSendWordWhileTheQuietAfterItIsWaitedFor() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    java.util.concurrent.CountDownLatch answer = new java.util.concurrent.CountDownLatch(1);
    f.session.judge = said -> {
      asked.add(said);
      answer.await();
      return verdict("over", 0.95, 0);
    };
    f.quiet(1000);
    f.speak();
    live.say("Book the table for Friday. Over.");
    until(() -> asked.size() == 1); // Before you were quiet after it.
    f.quiet(400);
    Thread.sleep(100);
    assertEquals("it waits for Jev", 0, f.sent.size());
    answer.countDown();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table for Friday.", f.sent.get(0));
    assertTrue(reasons(f), reasons(f).contains("Sent: you said \"over\""));
  }

  @Test
  public void whenJevCantTellOnASendWordTheSendWordSends() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.session.judge = said -> {
      throw new java.io.IOException("HTTP 502");
    };
    f.quiet(1000);
    f.speak();
    live.say("Book the table. Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table.", f.sent.get(0));
    assertTrue(String.join("\n", f.log).contains("Jev couldn't tell whether you're done (HTTP 502): the send word decides"));
    // Too slow: given up after phraseJudgeMs, and sent.
    long was = HandsFreeSession.phraseJudgeMs;
    HandsFreeSession.phraseJudgeMs = 200;
    try {
      Fake g = new Fake();
      FakeLive l = new FakeLive(g);
      g.session.judge = said -> {
        Thread.sleep(5000);
        return verdict("more", 0.1, 0);
      };
      g.quiet(1000);
      g.speak();
      l.say("Book the train. Over.");
      g.quiet(400);
      until(() -> g.sent.size() == 1);
      assertEquals("Book the train.", g.sent.get(0));
      assertTrue(String.join("\n", g.log).contains("Jev couldn't tell whether you're done (no answer in 200 ms)"));
    } finally {
      HandsFreeSession.phraseJudgeMs = was;
    }
  }

  // ------------------------------------------------------------------ words before and after a send word

  @Test
  public void aSendWordAfterAPauseSendsTheWordsBeforeItWhenLiveTranscriptionReconnected() throws Exception {
    // Philipp's call, 27 October 2026, 09:17:53–09:18:03, with AssemblyAI as it answered: the
    // connection had closed after a minute without speech and opened again. "Okay.", a pause
    // (Jev: more), then "Over." alone, and "Build it." in the same breath. It sent nothing: "Only
    // the send word was heard", and "Build it." was dropped as heard "while nobody had the floor".
    String was = StreamingSpeech.assemblyAiUrl;
    try (StreamingSpeechTest.Provider p = new StreamingSpeechTest.Provider()) {
      StreamingSpeech.assemblyAiUrl = p.url();
      Fake f = new Fake();
      StreamingSpeech s = StreamingSpeech.create(StreamingSpeech.AAI_PRO, "k", List.of("over"));
      long t0 = System.currentTimeMillis();
      s.clock = () -> f.now.get() + System.currentTimeMillis() - t0; // The session's time, running (take waits by it).
      s.events = f.log::add;
      List<String> asked = new CopyOnWriteArrayList<>();
      f.session.judge = said -> {
        asked.add(said);
        return switch (said) {
          case "Okay." -> verdict("more", 0.33, 0);
          case "Okay. Over." -> verdict("over", 0.9, 0);
          case "Build it." -> verdict("request", 0.9, 0);
          default -> verdict("more", 0.1, 0);
        };
      };
      // The call so far: a first connection with turns 0 to 3, then it closes and opens again.
      s.speech();
      StreamingSpeechTest.until(() -> p.connections.get() == 1);
      for (int i = 0; i <= 3; i++) {
        p.send(StreamingSpeechTest.turn(i, true, "Earlier " + i + "."));
        int n = i;
        StreamingSpeechTest.until(() -> s.text().equals("Earlier " + n + "."));
        s.take(100);
      }
      StreamingSpeechTest.reconnect(s, f.now, p);
      s.changed = f.session::liveText;
      f.session.live = s;
      f.quiet(1000);
      f.speak();
      p.send(StreamingSpeechTest.turn(0, false, "Okay"));
      p.send(StreamingSpeechTest.turn(0, true, "Okay."));
      until(() -> f.session.pending().equals("Okay."));
      f.quiet(1200); // The pause: Jev says more.
      until(() -> reasons(f).contains("Not sent: you seem to have more to say (33% done)"));
      f.speak();
      p.send(StreamingSpeechTest.turn(1, false, "Over."));
      until(() -> f.session.pending().equals("Okay. Over."));
      f.quiet(400);
      // Its final doesn't come (as in the log): after 1.5 s its live text is taken.
      for (int i = 0; i < 200 && f.sent.isEmpty(); i++) Thread.sleep(20);
      assertEquals(String.join("\n", f.log), List.of("Okay."), f.sent);
      // "Build it.", in the same stretch: the next turn's, not dropped.
      f.speak();
      p.send(StreamingSpeechTest.turn(2, false, "Build it."));
      until(() -> f.session.pending().equals("Build it."));
      f.quiet(3200);
      f.session.tick();
      for (int i = 0; i < 200 && f.sent.size() < 2; i++) {
        Thread.sleep(20);
        f.session.tick();
      }
      String log = String.join("\n", f.log);
      assertEquals(log, List.of("Okay.", "Build it."), f.sent);
      assertFalse(log, log.contains("Only the send word"));
      assertFalse(log, log.contains("nobody had the floor"));
      assertTrue(log, log.contains("words after the phrase, in the same stretch: they're your turn's (\"Build it.\")"));
      assertEquals(List.of("Okay.", "Okay. Over.", "Build it."), asked);
      s.close();
    } finally {
      StreamingSpeech.assemblyAiUrl = was;
    }
  }

  @Test
  public void aSendWordAfterAPauseSendsWordsWrittenDownFromAudioThatLiveTranscriptionMissed() throws Exception {
    // Philipp's call, 27 October 2026, 09:19:24–09:19:33: live transcription took 2.7 s to open,
    // so it missed the turn's first words; they were written down from their audio (Jev:
    // unfinished), then "Over." alone came as the live text and sent nothing.
    Fake f = new Fake("So it seems to be stuck right over");
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return said.equals("So it seems to be stuck right over") ? verdict("unfinished", 0.07, 0) : verdict("over", 0.9, 0);
    };
    f.quiet(1000);
    f.talk(); // No live text for it.
    until(() -> reasons(f).contains("Not sent: you seem mid-sentence (7% done)"));
    String log = String.join("\n", f.log);
    assertTrue(log, log.contains("no live text for 1."));
    assertTrue(log, log.contains("these words start your turn: live transcription didn't hear them"));
    assertEquals("nothing came of it late: nothing dropped (a drop would guess at your next words)", 0, live.discards.get());
    f.speak();
    live.say("Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("So it seems to be stuck right over", f.sent.get(0));
    assertEquals(List.of("So it seems to be stuck right over", "So it seems to be stuck right over Over."), asked);
    assertEquals("written down once", 1, f.transcriptions.get());
    assertFalse(reasons(f), reasons(f).contains("Only the send word"));
  }

  @Test
  public void liveWordsOfAPartWrittenDownFromAudioThatComeLateAreDroppedNotSentTwice() throws Exception {
    Fake f = new Fake("So it seems to be stuck right over");
    FakeLive live = new FakeLive(f);
    f.session.judge = said -> said.equals("So it seems to be stuck right over") ? verdict("unfinished", 0.07, 0) : verdict("over", 0.9, 0);
    java.util.concurrent.CountDownLatch slow = new java.util.concurrent.CountDownLatch(1);
    f.slow = slow;
    f.quiet(1000);
    f.talk(); // No live text yet: written down from its audio (slowly).
    until(() -> String.join("\n", f.log).contains("no live text for 1."));
    live.say("to be stuck right over"); // Its words, late, while it's written down.
    slow.countDown();
    until(() -> reasons(f).contains("Not sent: you seem mid-sentence (7% done)"));
    assertEquals(1, live.discards.get());
    f.speak();
    live.say("Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("So it seems to be stuck right over", f.sent.get(0));
  }

  @Test
  public void wordsSaidWhileAPartIsWrittenDownFromAudioAreJudgedWithItAndSentOnce() throws Exception {
    // You went on while live transcription's missing part was written down: the next check, with
    // your new words, decides, not the one about the part alone.
    Fake f = new Fake("So it seems to be stuck");
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return verdict("request", 0.9, 0);
    };
    java.util.concurrent.CountDownLatch slow = new java.util.concurrent.CountDownLatch(1);
    f.slow = slow;
    f.quiet(1000);
    f.talk();
    until(() -> String.join("\n", f.log).contains("no live text for 1."));
    f.speak();
    live.say("Okay.");
    f.quiet(1200); // That stretch ends too: its check waits behind the first.
    Thread.sleep(100);
    slow.countDown();
    until(() -> f.sent.size() == 1);
    assertEquals("So it seems to be stuck Okay.", f.sent.get(0));
    assertEquals(List.of("So it seems to be stuck Okay."), asked);
    f.quiet(1200);
    f.now.addAndGet(9000);
    f.session.tick();
    Thread.sleep(200);
    assertEquals(String.join("\n", f.log), 1, f.sent.size());
  }

  @Test
  public void aSendWordJevHeldBackDoesntSendWhenJevFailsAtThePause() throws Exception {
    String sentence = "Let someone live there for 3 months until the period is over.";
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
    f.session.judge = said -> {
      if (calls.incrementAndGet() == 1) return verdict("unfinished", 0.2, 0);
      throw new java.io.IOException("HTTP 502");
    };
    f.quiet(1000);
    f.speak();
    live.say(sentence);
    f.quiet(400);
    until(() -> reasons(f).contains("Not sent: you seem mid-sentence (20% done)"));
    f.quiet(1200); // The pause: Jev fails.
    until(() -> calls.get() == 2);
    Thread.sleep(200);
    assertEquals(String.join("\n", f.log), 0, f.sent.size());
  }

  @Test
  public void sendPressedRightAfterASendWordWhileYouGoOnSendsWhatYouSaidSince() throws Exception {
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.session.judge = said -> said.endsWith("Over.") ? verdict("over", 0.95, 0) : verdict("more", 0.1, 0);
    f.quiet(1000);
    f.speak();
    live.say("Book the table. Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    f.speak(); // The same stretch goes on.
    live.say("And the car");
    f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
    f.session.sendNow(); // Send goes, without asking Jev.
    until(() -> f.sent.size() == 2);
    assertEquals("And the car", f.sent.get(1));
    until(() -> f.session.live() != HandsFreeSession.Live.SENDING);
  }

  @Test
  public void wordsWrittenDownFromAudioComeBeforeTheLiveTextAfterThem() throws Exception {
    Fake f = new Fake("So it seems to be stuck");
    FakeLive live = new FakeLive(f);
    f.session.judge = said -> said.endsWith("Over.") ? verdict("over", 0.95, 0) : verdict("unfinished", 0.1, 0);
    f.quiet(1000);
    f.talk();
    until(() -> reasons(f).contains("Not sent: you seem mid-sentence (10% done)"));
    f.speak();
    live.say("right after the reply.");
    f.quiet(1200); // A pause: Jev is asked about all of it.
    until(() -> count(reasons(f), "mid-sentence") >= 1 && String.join("\n", f.log).contains("\"So it seems to be stuck right after the reply.\""));
    f.speak();
    live.say("right after the reply. Over.");
    f.quiet(400);
    until(() -> f.sent.size() == 1);
    assertEquals("So it seems to be stuck right after the reply.", f.sent.get(0));
  }

  @Test
  public void onlyTheSendWordThenMoreWordsInTheSameBreathAreTheTurn() throws Exception {
    // "Over." on its own gives the turn up; what you say right after it isn't lost.
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    f.session.judge = said -> said.equals("Build it.") ? verdict("request", 0.9, 0) : overIsDone(said);
    f.quiet(1000);
    f.speak();
    live.say("Over.");
    f.quiet(400);
    until(() -> reasons(f).contains("Only the send word was heard: nothing to send"));
    assertEquals("the live text was taken: nothing of it is dropped (what comes next would be)", 0, live.discards.get());
    f.speak();
    live.say("Build it.");
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Build it.", f.sent.get(0));
  }

  @Test
  public void aSendWordThatWasntTheEndThenMoreInTheSameStretchIsCheckedAtItsPause() throws Exception {
    // 09:15:56: "Mac, over." came out as "Mac, oh, this shit." and the stretch went on for 30 s;
    // its pause asked nothing, so only a later pause or the long silence could send it.
    Fake f = new Fake();
    FakeLive live = new FakeLive(f);
    List<String> asked = new CopyOnWriteArrayList<>();
    f.session.judge = said -> {
      asked.add(said);
      return said.endsWith("?") ? verdict("question", 0.95, 0) : overIsDone(said);
    };
    f.quiet(1000);
    f.speak();
    live.finalText = "Mac, oh, this shit.";
    live.say("Mac, over.");
    f.quiet(400);
    until(() -> String.join("\n", f.log).contains("doesn't end with the phrase"));
    f.speak();
    live.say("So is it still not fully ported or what?");
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Mac, oh, this shit. So is it still not fully ported or what?", f.sent.get(0));
    assertEquals(List.of("Mac, over.", "Mac, oh, this shit. So is it still not fully ported or what?"), asked);
  }

  // ------------------------------------------------------------------ Jev: is the turn done?

  static HandsFreeSession.Verdict verdict(String choice, double send, double end) {
    return new HandsFreeSession.Verdict(choice, send, end, new java.math.BigDecimal("0.00002"));
  }

  @Test
  public void atAPauseJevDecidesWhetherYourTurnIsDoneAndSaysWhy() throws Exception {
    Fake f = new Fake("Can you check", "when the next train to Lisbon leaves?");
    List<String> asked = new CopyOnWriteArrayList<>();
    java.util.ArrayDeque<HandsFreeSession.Verdict> answers =
        new java.util.ArrayDeque<>(List.of(verdict("unfinished", 0.04, 0.0), verdict("question", 0.98, 0.0)));
    f.session.judge = said -> {
      asked.add(said);
      return answers.poll();
    };
    f.talk();
    until(() -> reasons(f).contains("Not sent: you seem mid-sentence (4% done)"));
    assertEquals(0, f.sent.size());
    assertEquals(HandsFreeSession.Live.WAITING_SEND, f.session.live());
    f.talk(); // On: the next pause asks again, with the whole turn.
    until(() -> f.sent.size() == 1);
    assertEquals("Can you check when the next train to Lisbon leaves?", f.sent.get(0));
    assertEquals(List.of("Can you check", "Can you check when the next train to Lisbon leaves?"), asked);
    assertTrue(reasons(f), reasons(f).contains("Sent: you asked your question (98%)"));
    assertTrue(String.join("\n", f.log), String.join("\n", f.log).contains("Jev in "));
  }

  @Test
  public void jevHearingYouWantToEndTheCallSendsWhatCameBeforeAndEnds() throws Exception {
    Fake f = new Fake("Thanks, that's all. End the call.");
    f.session.judge = said -> verdict("end", 0.5, 0.99);
    f.talk();
    until(() -> f.session.state() == HandsFreeSession.State.ENDED);
    assertEquals(List.of("Thanks, that's all."), f.sent);
    assertTrue(reasons(f), reasons(f).contains("Ending the call: you said goodbye"));
  }

  @Test
  public void sendAlwaysSendsAtOnceWithoutAskingJev() throws Exception {
    Fake f = new Fake("I was thinking about the trip and");
    java.util.concurrent.atomic.AtomicInteger asked = new java.util.concurrent.atomic.AtomicInteger();
    f.session.judge = said -> {
      asked.incrementAndGet();
      return verdict("unfinished", 0.01, 0);
    };
    f.speak(); // Still talking: Send ends the part and sends it.
    f.session.sendNow();
    until(() -> f.sent.size() == 1);
    assertEquals("I was thinking about the trip and", f.sent.get(0));
    assertEquals(0, asked.get());
  }

  @Test
  public void talkingOnWhileJevIsAskedMeansNoDecision() throws Exception {
    Fake f = new Fake("Book the hotel", "and the car");
    java.util.concurrent.CountDownLatch asking = new java.util.concurrent.CountDownLatch(1), answer = new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.atomic.AtomicInteger asked = new java.util.concurrent.atomic.AtomicInteger();
    f.session.judge = said -> {
      if (asked.incrementAndGet() == 1) {
        asking.countDown();
        answer.await();
      }
      return verdict("request", 0.95, 0);
    };
    f.talk();
    asking.await();
    f.speak(); // You go on while Jev thinks.
    answer.countDown();
    Thread.sleep(150);
    assertEquals(0, f.sent.size());
    f.quiet(1200);
    until(() -> f.sent.size() == 1);
    assertEquals("Book the hotel and the car", f.sent.get(0));
  }

  @Test
  public void whenJevCantBeAskedTheSendWordStillWorks() throws Exception {
    Fake f = new Fake("Book the table.", "Over.");
    f.session.judge = said -> {
      throw new java.io.IOException("timeout");
    };
    f.talk();
    until(() -> reasons(f).contains("Couldn't ask whether you're done (timeout)"));
    assertEquals(0, f.sent.size());
    f.talk();
    until(() -> f.sent.size() == 1);
    assertEquals("Book the table.", f.sent.get(0));
  }

  @Test
  public void jevsAnswerIsReadAsDoneAndEnd() throws Exception {
    JSONObject r =
        new JSONObject(
            "{\"answers\":{\"turn\":{\"type\":\"choice\",\"choice\":\"question\",\"probabilities\":{\"over\":0.02,\"question\":0.9,\"request\":0.05,\"end\":0.01,\"unfinished\":0.01,\"more\":0.01}}},\"usage\":{\"cost\":0.00002}}");
    HandsFreeSession.Verdict v = Jev.turnVerdict(r);
    assertEquals("question", v.choice());
    assertEquals(0.97, v.send(), 1e-9);
    assertEquals(0.01, v.end(), 1e-9);
    JSONObject body = Jev.turnBody("Hi", List.of("over"), List.of("end the call"));
    JSONObject criteria = body.getJSONObject("questions").getJSONObject("turn").getJSONObject("criteria");
    assertEquals("over", criteria.keys().next()); // First: a fake without a script says done.
    assertTrue(criteria.getString("over").contains("\"over\""));
    assertTrue(criteria.getString("end").contains("\"end the call\""));
  }

  @Test
  public void theBackgroundComesDownOnceTheStartsNoiseHasPassed() {
    HandsFree.Segmenter s = new HandsFree.Segmenter(800, pcm -> {});
    feed(s, 900, 2000); // Handling noise at the start: about 640.
    feed(s, 50, 1000); // Then the quiet car.
    assertTrue("background " + s.background(), s.background() < 100); // Was about 600 a second later.
  }

  // ------------------------------------------------------------------ every decision has a visible reason

  @Test
  public void everyEarlyReturnOfSendShowsItsReason() throws Exception {
    Fake f = new Fake("Book the table", "Next words");
    f.session.sendNow();
    assertEquals("Send ignored: nothing heard yet", f.session.reasons().get(0).text());
    // Already sending: the first press waits for the speech model.
    f.slow = new java.util.concurrent.CountDownLatch(1);
    f.talk();
    f.session.sendNow();
    f.session.sendNow();
    assertEquals("Send ignored: already sending", f.session.reasons().get(0).text());
    f.slow.countDown();
    until(() -> f.sent.size() == 1);
    // Right after the message went: the same press.
    f.slow = null;
    f.talk();
    until(() -> f.session.pending().equals("Next words"));
    f.session.sendNow();
    assertTrue(f.session.reasons().get(0).text(), f.session.reasons().get(0).text().startsWith("Send ignored: just sent ("));
    assertEquals("Next words", f.session.pending());
    // A reply playing and nothing of yours to send.
    f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
    f.session.sendNow();
    until(() -> f.sent.size() == 2);
    f.session.reply("r2", "An answer.");
    until(() -> f.spoken.size() == 1);
    f.now.addAndGet(HandsFreeSession.REPRESS_MS + 1);
    f.session.sendNow();
    assertEquals("Send ignored: a reply is playing and you have nothing unsent", f.session.reasons().get(0).text());
    // The same reason again counts up instead of filling the list.
    f.session.sendNow();
    assertEquals(2, f.session.reasons().get(0).times());
    assertTrue(String.join("\n", f.log), String.join("\n", f.log).contains("→ Send ignored: nothing heard yet"));
  }

  @Test
  public void soundsMarkTheMomentsAndNeverStartYourSpeech() throws Exception {
    Fake f = new Fake("Book the table. Over.");
    List<HandsFreeSession.Cue> cues = new CopyOnWriteArrayList<>();
    f.session.cues = cues::add; // Each plays.
    f.quiet(1000);
    f.talk();
    until(() -> f.sent.size() == 1);
    until(() -> cues.size() == 2);
    assertEquals(List.of(HandsFreeSession.Cue.HEARD, HandsFreeSession.Cue.SENT), cues);
    // The sent sound coming back through the microphone: no speech.
    for (int i = 0; i < 15; i++) f.session.frame(frame(8000));
    assertFalse(f.session.speaking());
    assertEquals(HandsFreeSession.Live.SENT, f.session.live());
    f.audioStarts = false; // Its voice fails before any audio.
    f.session.reply("r1", "Done.");
    until(() -> cues.size() == 3);
    assertEquals(HandsFreeSession.Cue.REPLY, cues.get(2));
    for (int i = 1; i <= 1 + HandsFreeSession.RETRIES; i++) { // Tried again, then given up.
      int tries = i;
      until(() -> f.spoken.size() == tries);
      f.fail.run();
    }
    assertTrue(cues.toString(), cues.contains(HandsFreeSession.Cue.FAILED));
  }

  @Test
  public void soundTooQuietToCountIsShownWithItsLevels() throws Exception {
    Fake f = new Fake();
    for (int i = 0; i < 400; i++) f.session.frame(frame(560)); // A loud room: background about 400.
    for (int i = 0; i < 50; i++) f.session.frame(frame(1270)); // A voice not 3× louder.
    for (int i = 0; i < 40; i++) f.session.frame(frame(560));
    String r = reasons(f);
    assertTrue(r, r.contains("Didn't count as speech: too quiet (level 9"));
    assertTrue(r, r.contains(" < 3.0× background 4"));
    assertEquals(HandsFreeSession.Floor.OPEN, f.session.floor());
  }

  @Test
  public void aTranscriptionThatFailsShowsWhy() throws Exception {
    Fake f = new Fake();
    f.quiet(1000);
    f.talk();
    until(() -> !f.session.error().isEmpty());
    assertTrue(reasons(f), reasons(f).startsWith("Couldn't write down 1."));
  }

  // ------------------------------------------------------------------ 3.2.9: replies reach you

  /** A household sound: n frames at the given amplitude. */
  static void clatter(HandsFreeSession session, int amplitude, int frames) {
    for (int i = 0; i < frames; i++) session.frame(frame(amplitude));
  }

  @Test
  public void householdBurstsInAQuietRoomNeverOpenATurnButYourVoiceDoes() {
    List<String> started = new ArrayList<>();
    List<byte[]> out = new ArrayList<>();
    HandsFree.Segmenter s =
        new HandsFree.Segmenter(
            HandsFree.DEFAULT_PAUSE_MS,
            () -> HandsFree.DEFAULT_TAKE_MS,
            HandsFree.DEFAULT_GATE,
            HandsFree.LEVEL,
            new HandsFree.Segmenter.Listener() {
              public void segment(byte[] pcm) {
                out.add(pcm);
              }

              public void started(double level, double background) {
                started.add(String.format(java.util.Locale.ROOT, "level %.0f, background %.0f", level, background));
              }
            });
    java.util.Random random = new java.util.Random(7);
    feed(s, 140, 3000); // A quiet room: background about 100.
    for (int i = 0; i < 40; i++) { // A minute and a half: a cup, a door, a drawer every few seconds.
      int amplitude = 1400 + random.nextInt(2000); // Levels 1000 to 2400: ten to twenty-four times the room.
      feed(s, amplitude, 60 + random.nextInt(5) * 20); // 60 to 140 ms.
      feed(s, 140, 1800 + random.nextInt(1500));
    }
    assertEquals("noise took the turn", List.of(), started);
    assertTrue(out.isEmpty());
    assertTrue("background " + s.background(), s.background() < 150);
    feed(s, 6000, 600); // You, close to the phone.
    assertEquals(1, started.size());
    feed(s, 6000, 120);
    feed(s, 140, 2000);
    assertEquals(1, out.size());
  }

  @Test
  public void aSoundThatNeverCountsAsSpeechDoesntHoldAReply() throws Exception {
    Fake f = new Fake();
    f.quiet(1000);
    clatter(f.session, 2100, 3); // A sound that never counts as speech.
    f.session.reply("r1", "Your table is booked.");
    for (int i = 0; i < 5 && f.spoken.isEmpty(); i++) {
      clatter(f.session, 50, 22);
      clatter(f.session, 2100, 3);
      f.session.tick();
      Thread.sleep(50);
    }
    assertEquals(List.of("Your table is booked."), f.spoken);
    assertFalse(reasons(f), reasons(f).contains("Reply waits"));
    assertEquals("the noise never took the turn", "", f.session.pending());
    assertEquals(0, f.transcriptions.get());
  }

  @Test
  public void waitingForTheVoiceIsShownAndCountsUp() throws Exception {
    Fake f = new Fake();
    java.util.concurrent.CountDownLatch fetched = new java.util.concurrent.CountDownLatch(1);
    f.prepare =
        text -> {
          try {
            fetched.await();
          } catch (InterruptedException ignored) {
            /* Go on. */
          }
          return text;
        };
    f.quiet(1000);
    f.session.reply("r1", "Your table is booked.");
    f.session.tick();
    assertFalse("not in the first second", reasons(f).contains("its voice"));
    f.now.addAndGet(1000);
    f.session.tick();
    assertTrue(reasons(f), reasons(f).startsWith("Reply waits: its voice is being fetched (1 s)"));
    f.now.addAndGet(2000);
    f.session.tick();
    String r = reasons(f);
    assertTrue(r, r.startsWith("Reply waits: its voice is being fetched (3 s)"));
    assertFalse("counted up in place", r.contains("(1 s)"));
    assertEquals(1, f.log.stream().filter(l -> l.contains("its voice is being fetched")).count());
    fetched.countDown();
    until(() -> f.spoken.size() == 1);
  }

  @Test
  public void wordsYouStartAsAReplyEndsAreKept() throws Exception {
    Fake f = playingReply("Wait, one more thing");
    for (int i = 0; i < 8; i++) f.session.frame(frame(8000)); // You, over its last words.
    f.done.run(); // It ends before that's enough to stop it.
    assertEquals(HandsFreeSession.State.LISTENING, f.session.state());
    for (int i = 0; i < 30; i++) f.session.frame(frame(8000)); // The microphone stayed on.
    f.quiet(1200);
    until(() -> f.session.pending().equals("Wait, one more thing"));
    assertEquals(HandsFreeSession.Floor.YOU, f.session.floor());
  }

  // ------------------------------------------------------------------ 3.2.10: voices

  @Test
  public void rawSamplesBecomeAWavWithTheirRate() throws Exception {
    assertArrayEquals(new int[] {44100, 1}, Voice.pcmFormat("audio/pcm;rate=44100;channels=1"));
    assertArrayEquals(new int[] {24000, 1}, Voice.pcmFormat("audio/pcm; rate=24000"));
    assertNull(Voice.pcmFormat("audio/mpeg"));
    assertNull(Voice.pcmFormat("audio/pcm"));
    assertNull(Voice.pcmFormat(null));
    byte[] h = Voice.wavHeader(24000, 1, 48000);
    java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(h).order(java.nio.ByteOrder.LITTLE_ENDIAN);
    assertEquals(44, h.length);
    assertEquals("RIFF", new String(h, 0, 4, java.nio.charset.StandardCharsets.US_ASCII));
    assertEquals(36 + 48000, b.getInt(4));
    assertEquals("WAVEfmt ", new String(h, 8, 8, java.nio.charset.StandardCharsets.US_ASCII));
    assertEquals(1, b.getShort(20)); // PCM
    assertEquals(1, b.getShort(22)); // mono
    assertEquals(24000, b.getInt(24));
    assertEquals(48000, b.getInt(28)); // bytes a second
    assertEquals(2, b.getShort(32));
    assertEquals(16, b.getShort(34));
    assertEquals("data", new String(h, 36, 4, java.nio.charset.StandardCharsets.US_ASCII));
    assertEquals(48000, b.getInt(40));
    // The same header as the app's own WAV files for 16 kHz mono.
    byte[] own = AudioFiles.wav(new byte[320]);
    assertArrayEquals(java.util.Arrays.copyOf(own, 44), Voice.wavHeader(AudioFiles.RATE, 1, 320));
  }

  @Test
  public void theNewVoicesAskForWhatTheySend() throws Exception {
    Voice.Choice gemini = Voice.choice("gemini-kore"), fish = Voice.choice("fish-drama"), mai = Voice.choice("mai-harper");
    JSONObject g = Voice.body(gemini, "Hi");
    assertEquals("google/gemini-3.8-flash-lite-tts", g.getString("model"));
    assertEquals("Kore", g.getString("voice"));
    assertEquals("pcm", g.getString("response_format"));
    assertEquals("pcm", Voice.body(Voice.choice("heygen-bram"), "Hi").getString("response_format"));
    JSONObject d = Voice.body(fish, "Hi");
    // Without a voice Fish picked another speaker for each reply: always one of its voice IDs.
    assertEquals("933563129e564b19a115bedd57b7406a", d.getString("voice"));
    assertEquals("mp3", d.getString("response_format"));
    for (Voice.Choice c : Voice.CHOICES) assertTrue("a fixed voice: " + c.id(), c.model().isEmpty() || !c.voice().isEmpty());
    assertEquals("fish-audio/drama-3 (933563129e564b19a115bedd57b7406a)", fish.tag());
    assertEquals("Android's voice", Voice.ANDROID.tag());
    assertEquals("en-US-Harper:MAI-Voice-2.1-Flash", Voice.body(mai, "Hi").getString("voice"));
    java.util.Set<String> ids = new java.util.HashSet<>();
    for (Voice.Choice c : Voice.CHOICES) assertTrue("twice: " + c.id(), ids.add(c.id()));
    assertTrue(ids.containsAll(List.of("kokoro", "eleven", "android"))); // Chosen before: still there.
  }

  @Test
  public void aVoiceThatFailsSaysWhy() throws Exception {
    assertEquals("HTTP 503: No provider available", Voice.httpError(503, "{\"error\":{\"message\":\"No provider available\",\"code\":503}}"));
    assertEquals("HTTP 502: Bad gateway", Voice.httpError(502, "Bad\n  gateway"));
    assertEquals("HTTP 500", Voice.httpError(500, ""));
    assertTrue(Voice.httpError(400, "x".repeat(500)).endsWith("…"));
    Fake f = new Fake();
    f.session.voiceFailed("Kokoro: no answer in 30.0 s", false);
    assertTrue(reasons(f), reasons(f).startsWith("Voice failed (Kokoro: no answer in 30.0 s): this phone has no other voice"));
    assertEquals("Kokoro: no answer in 30.0 s", f.session.voiceError());
    assertTrue(String.join("\n", f.log).contains("Voice failed (Kokoro: no answer in 30.0 s)"));
    f.now.addAndGet(HandsFreeSession.VOICE_ERROR_MS);
    assertEquals("shown a while, then gone", "", f.session.voiceError());
    f.session.voiceFailed("Kokoro: HTTP 503: No provider available", true);
    assertTrue(reasons(f), reasons(f).startsWith("Voice failed (Kokoro: HTTP 503: No provider available): Android's voice reads the reply"));
  }

  @Test
  public void liveTranscriptionWithoutItsKeySaysSoForAWhileOnTheCallBarAndAllCallOnScreen() throws Exception {
    Fake f = new Fake();
    assertEquals("", f.session.liveKeyMissing());
    assertFalse(HandsFreeService.liveOffShown(f.session));
    f.session.liveKeyMissing("AssemblyAI");
    String off = "Live transcription is off: no AssemblyAI key (Settings → Hands-free)";
    assertTrue(reasons(f), reasons(f).startsWith(off));
    assertTrue(String.join("\n", f.log), String.join("\n", f.log).contains("→ " + off));
    assertEquals(off, HandsFreeService.liveOffText(f.session));
    assertEquals("Live off · no AssemblyAI key", HandsFreeService.shortLabel(f.session));
    // A voice failure goes first.
    f.session.voiceFailed("Kokoro: HTTP 503: No provider available", true);
    assertEquals("Voice failed · Kokoro: HTTP 503", HandsFreeService.shortLabel(f.session));
    f.now.addAndGet(HandsFreeSession.VOICE_ERROR_MS);
    assertEquals("Live off · no AssemblyAI key", HandsFreeService.shortLabel(f.session));
    // A minute on the call bar; on the screen the whole call.
    f.now.addAndGet(HandsFreeSession.LIVE_OFF_MS - HandsFreeSession.VOICE_ERROR_MS);
    assertFalse(HandsFreeService.liveOffShown(f.session));
    assertEquals("Listening", HandsFreeService.shortLabel(f.session));
    assertEquals("AssemblyAI", f.session.liveKeyMissing());
  }

  @Test
  public void aMessageToTheTalkerAndTheChiefNamesTheTalkerFirst() {
    assertEquals(
        List.of("thr_talker", "thr_chief"),
        List.copyOf(HandsFreeService.bothTo("thr_chief", "thr_talker", "to the chief", "to the talker").keySet()));
    assertEquals("to the talker", HandsFreeService.bothTo("thr_chief", "thr_talker", "to the chief", "to the talker").get("thr_talker"));
    assertEquals(java.util.Map.of("thr_chief", "to the chief"), HandsFreeService.bothTo("thr_chief", "", "to the chief", "to the talker"));
  }

  @Test
  public void aHangingVoiceNeverHoldsUpTheNextReply() throws Exception {
    Fake f = new Fake();
    java.util.concurrent.CountDownLatch hang = new java.util.concurrent.CountDownLatch(1);
    f.prepare =
        text -> {
          if (text.startsWith("First")) {
            try {
              hang.await();
            } catch (InterruptedException ignored) {
              /* Go on. */
            }
          }
          return text;
        };
    f.quiet(1000);
    f.session.reply("r1", "First reply.");
    f.session.reply("r2", "Second reply.");
    until(() -> f.log.stream().anyMatch(l -> l.startsWith("voice ready for r2")));
    hang.countDown();
    until(() -> f.spoken.size() == 1);
    assertEquals("First reply.", f.spoken.get(0));
    f.done.run();
    f.now.addAndGet(HandsFreeSession.TAIL_MS);
    f.session.tick();
    until(() -> f.spoken.size() == 2);
  }

  @Test
  public void callAudioUsesAHeadsetElseTheSpeakerNeverTheEarpiece() {
    int earpiece = android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, speaker = android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        sco = android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO, wired = android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET;
    assertEquals(speaker, CallAudio.pick(List.of(earpiece, speaker)));
    assertEquals(sco, CallAudio.pick(List.of(earpiece, speaker, wired, sco)));
    assertEquals(wired, CallAudio.pick(List.of(speaker, wired)));
    assertEquals(-1, CallAudio.pick(List.of(earpiece)));
  }

  // ------------------------------------------------------------------ the log

  @Test
  public void theLogLosesNoLineFromManyThreadsAndKeepsTheLastThousand() throws Exception {
    java.io.File file = java.io.File.createTempFile("handsfree", ".log");
    try {
      StringBuilder old = new StringBuilder();
      for (int i = 0; i < 1000; i++) old.append("old ").append(i).append('\n');
      java.nio.file.Files.write(file.toPath(), old.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
      HandsFreeLog.append(file, HandsFreeLog.callStarted("14:05"));
      List<Thread> threads = new ArrayList<>();
      for (int t = 0; t < 8; t++) {
        int n = t;
        threads.add(new Thread(() -> {
          for (int i = 0; i < 100; i++) HandsFreeLog.append(file, "thread " + n + " event " + i);
        }));
      }
      for (Thread t : threads) t.start();
      HandsFreeLog.append(file, "call ended"); // While the others write.
      for (Thread t : threads) t.join();
      HandsFreeLog.append(file, "told the chief: [hands-free call ended]");
      List<String> lines = java.nio.file.Files.readAllLines(file.toPath());
      for (int t = 0; t < 8; t++) for (int i = 0; i < 100; i++) assertTrue("lost: thread " + t + " event " + i, lines.contains("thread " + t + " event " + i));
      assertTrue(lines.contains("call ended"));
      assertTrue(lines.contains("── call started 14:05 ──"));
      assertEquals("told the chief: [hands-free call ended]", lines.get(lines.size() - 1));
      assertTrue("old lines dropped: " + lines.size(), lines.size() <= HandsFreeLog.KEEP + 100);
      assertFalse("the oldest go first", lines.contains("old 0"));
      assertEquals(lines.size(), new java.util.HashSet<>(lines).size());
    } finally {
      file.delete();
    }
  }

  @Test
  public void copyingTakesWholeCallsNewestIncluded() {
    String log =
        "old line\n"
            + HandsFreeLog.callStarted("22:10") + "\nfirst a\n"
            + HandsFreeLog.callStarted("23:29") + "\nsecond a\nsecond b\n"
            + HandsFreeLog.callStarted("23:41") + "\nthird a\nthird b\n";
    assertEquals("── call started 23:41 ──\nthird a\nthird b\n", HandsFreeLog.lastCalls(log, 1));
    assertEquals(
        "── call started 23:29 ──\nsecond a\nsecond b\n── call started 23:41 ──\nthird a\nthird b\n",
        HandsFreeLog.lastCalls(log, 2));
    assertEquals(log.substring(log.indexOf("── call started 22:10")), HandsFreeLog.lastCalls(log, 3));
    assertEquals("fewer calls than asked: all of it", log, HandsFreeLog.lastCalls(log, 4));
    assertEquals("no call yet: all of it", "a\nb\n", HandsFreeLog.lastCalls("a\nb\n", 1));
    assertEquals("", HandsFreeLog.lastCalls("", 1));
  }

  @Test
  public void aMessageOnlyTheTalkerOrOnlyTheChiefGotCountsAsSentAndSaysWhoMissedIt() throws Exception {
    Fake f = new Fake("Book the hotel. Over.", "And the train. Over.");
    f.missedBy = "talker";
    f.talk();
    until(() -> f.session.sent() == 1);
    assertTrue(f.session.ours("r1"));
    assertEquals("", f.session.pending()); // Not kept: the chief has it.
    until(() -> reasons(f).contains("Sent ✓ to the chief. The talker didn't get it: thread not found"));
    f.missedBy = "chief";
    f.now.addAndGet(5000);
    f.talk();
    until(() -> f.session.sent() == 2);
    assertEquals("", f.session.pending()); // Not sent again: the talker would hear it twice.
    until(() -> reasons(f).contains("Sent to the talker only. The chief didn't get it: thread not found"));
    assertEquals(2, f.sent.size());
  }
}
