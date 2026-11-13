package app.driftdictation;

import static app.driftdictation.I18n.tr;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One hands-free call, without Android: microphone frames go in, messages to the chief and replies
 * to read aloud come out. It's strictly turn-based, with an open floor: when nobody holds the turn,
 * whoever starts first gets it.
 *
 * <ul>
 *   <li>You take the floor by speaking (the segmenter's three layers decide what counts). You hold
 *       it while you talk, while your words are written down, and while you have unsent text,
 *       until the message goes (Jev says you're clearly done, or Send now) or your turn comes to
 *       nothing. Two minutes of silence end the call, sending nothing.
 *   <li>A chief message arriving on an open floor is read aloud, as call audio the phone's echo
 *       cancellation removes from the microphone; your speech over it stops it (BARGE_MS), and the
 *       microphone is off a moment after it.
 *   <li>No queue: once your next message goes, every reply not played yet is dropped, also one
 *       arriving later for a message before it. Until then a reply waits while it's your turn,
 *       and a reply you talk over pauses: if your turn comes to nothing (noise, no words, or Jev
 *       says you're not done and you stay quiet) it plays, from the sentence it stopped in. Only
 *       replies to your newest message play. Your next message (or the call's end) tells the chief
 *       how far you heard and what didn't play, so it says again what still matters (Philipp's
 *       design, 2 November 2026: "no queuing, just always canceled"; at 22:46 the same day:
 *       noise only pauses a reply, it's dropped once your message goes).
 *   <li>Every decision it makes is a reason on screen ({@link #reasons}), in plain words, and in
 *       the log; a few moments get a quiet sound ({@link Cue}).
 * </ul>
 *
 * HandsFreeService wires it to the microphone, bb, ntfy and the voice.
 */
final class HandsFreeSession {
  enum State {
    LISTENING,
    READING,
    ENDED
  }

  /**
   * What the screen shows, and nothing else: you can talk, your message is on its way, the chief
   * has it, or a reply is read.
   */
  enum Phase {
    LISTENING,
    SENDING,
    WORKING,
    READING
  }

  /** Who holds the turn. */
  enum Floor {
    OPEN,
    YOU,
    CHIEF
  }

  /** What's happening right now, in more detail than Phase: the live line on screen. */
  enum Live {
    LISTENING,
    HEARING,
    WRITING,
    WAITING_SEND,
    SENDING,
    SENT,
    WAITING_CHIEF,
    REPLY_WAITING,
    REPLY_COMING,
    PLAYING,
    MUTED,
    ENDED
  }

  /** The moments that get a quiet sound. */
  enum Cue {
    HEARD,
    SENT,
    REPLY,
    FAILED
  }

  /** A decision and its reason, as shown on screen; times counts the same one in a row. */
  record Reason(long at, String text, int times) {}

  /**
   * What the microphone hears right now, for the meter on screen: quiet, a sound that doesn't count
   * as your speech (too quiet against the background, or too short so far), or your voice.
   */
  enum Hearing {
    QUIET,
    SOUND,
    VOICE
  }

  /**
   * The last words heard, for the call bar: your unsent words (counted), or what live
   * transcription hears while none of it counts as your speech (not counted: noise, the radio, or
   * your voice too quiet against the background).
   */
  record Heard(String words, boolean counted) {}

  /**
   * With live transcription, this much of your speech (as the segmenter counts it) with no words
   * coming back says so on screen: it isn't working, or what counts as speech is noise (Philipp,
   * 6 November 2026, in the car: "if I talk for 10 minutes and nothing is picked up, that is quite
   * frustrating").
   */
  static final long NO_WORDS_MS = 5000;

  /** The live line says it hears you while your voice stopped less than this long ago. */
  static final long HEARING_MS = 700;

  /** How fast the meter falls back after a loud frame (each 20 ms frame: half in about 130 ms). */
  static final double METER_FALL = 0.9;

  /**
   * With live transcription, speech without words in the live text holds your turn this long at
   * most (the live text's delay for the first words): noise or a cough doesn't hold a reply.
   */
  static final long WORDLESS_MS = 3000;

  /** How long the screen says Sent ✓ after a message went. */
  static final long SENT_SHOWN_MS = 3000;

  /** While a sound plays (and a moment after) the microphone can't start your speech with it. */
  static final int CUE_MS = 300;

  /** How many reasons the screen keeps. */
  static final int REASONS = 8;

  /** A message counts as being worked on until the chief's second reply, or this long. */
  static final long WORKING_MS = 10 * 60_000;

  /** After a reply is read the microphone stays off this long, so its last word isn't caught. */
  static final long TAIL_MS = 800;

  /**
   * A reply's audio has to start this soon after the floor
   * is taken, and end this long after its own length, or the reading is given up and listening
   * resumes. The audio is fetched before, while the floor is still open.
   */
  static final long START_MS = 6000, OVERRUN_MS = 3000;

  /**
   * Past its length a reply keeps playing as long as the voice says audio is coming out; only one
   * that stalls, or plays this long in all, is given up.
   */
  static final long READING_CAP_MS = 10 * 60_000;

  /**
   * Talking while a reply plays (barge-in): replies are call audio, so the phone's echo
   * cancellation takes them out of the microphone, and the microphone's frames go to the
   * segmenter as when listening. This much of your speech (by its level and gate rules, without
   * the short-burst rule: a clatter isn't you) stops the reply at once; what you say goes on as
   * your turn, and the rest of the reply waits (from the sentence it stopped in): dropped once
   * your message goes (which then says how far you heard), played if your turn comes to nothing.
   */
  static final int BARGE_MS = 300;

  /** Once you hold the floor, a stretch this short still counts ("Over." on its own). */
  static final int SHORT_MS = 200;

  interface Transcriber {
    /** The text of a WAV file; throws when the speech model fails. */
    String transcribe(byte[] wav) throws Exception;
  }

  /**
   * Is your turn done? Asked at each longer pause with everything you said in it so far (Jev).
   * Throws when it can't tell (failed, too slow).
   */
  interface Judge {
    Verdict judge(String said) throws Exception;
  }

  /**
   * Live transcription (StreamingSpeech): the microphone's audio streams to a speech model while
   * you talk and its text comes back as you speak, so a send phrase sends at once and nothing waits
   * for writing down. Without it (or once it fails) your turn's audio is written down at the pauses.
   */
  interface LiveText {
    /** A 20 ms frame of what the microphone hears (silence while a reply plays). */
    void audio(byte[] frame);

    /** You're speaking: it's to be open (it closes itself after a while without speech). */
    void speech();

    /** The turn's text so far: final, then what's still live. */
    String text();

    /**
     * The turn's text once the model has finished what's live (asked to, at once), waited for at
     * most waitMs; the next turn starts after it. Throws once it failed.
     */
    String take(long waitMs) throws Exception;

    /** The turn so far is dropped (it came to nothing); the next starts now. */
    void discard();

    boolean working();

    /** Why it stopped working, in a few words. */
    String failure();

    void close();
  }

  /** The longest a turn's final text from live transcription is waited for (it took 0.1 to 0.4 s). */
  static final long TAKE_MS = 1500;

  /**
   * A send or end phrase is an ending, not a hesitation ("should we end the call … tomorrow"), once
   * you've been quiet this long after it with the live text still ending in it; hanging up waits
   * longer (and asks Jev), it's the worse mistake. Without that quiet within PHRASE_WAIT_MS the
   * phrase is left to your next pause.
   */
  static final long SEND_QUIET_MS = 300, END_QUIET_MS = 700, PHRASE_WAIT_MS = 3000;

  /**
   * A turn of this many seconds of speech with fewer words a second than this in the live text
   * looks stalled (ElevenLabs once stuck on "Mm." for 30 s): it's written down from its audio.
   */
  static final double STALL_SECONDS = 4, STALL_WORDS_PER_SECOND = 0.3;

  /** The floor open this long with no speech: words the live text has (noise, a TV) are dropped. */
  static final long STRAY_MS = 3000;

  /**
   * Jev's answer: where you are (over, question, request, end, unfinished, more), how sure it is
   * that the turn is done and that you want to end the call, and what asking cost (null unknown).
   */
  record Verdict(String choice, double send, double end, java.math.BigDecimal cost) {}

  /**
   * At these probabilities a turn is sent, or the call ended: Jev is clearly sure. A pause only
   * asks (a send word asks too, but needs much less: PHRASE_HOLD_BELOW); when Jev can't answer
   * nothing is sent (the send word decides only without Jev, or said twice).
   */
  static final double SEND_AT = 0.7, END_AT = 0.8;

  /**
   * A turn ending with the send word goes unless Jev is clearly sure you're mid-sentence (done
   * below this): saying it is a clear wish to send. Said twice or more in a row ("Over. Over.") it
   * goes without asking Jev. Philipp's calls, 6 November 2026: Jev gave "…the advantages of those
   * options. Over." 0.68 and "…Well, over." 0.37, and saying it again made it less sure (0.66,
   * 0.50), so it took the Send button. The one it was right to hold that morning, "…switch between
   * them. End the over." (he went on: "End the robot. Overlay."), got 0.26.
   */
  static final double PHRASE_HOLD_BELOW = 0.3;

  /** Whether a turn's text ends with the send word said twice or more in a row. */
  boolean repeatedSend(String text) {
    return HandsFree.endings(text, sendWords) >= 2;
  }

  interface Sender {
    /** A new request ID, for a message about to go: it counts as ours from then on. */
    default String newRequest() {
      return ChiefText.requestId();
    }

    /** Sends a message to the chief (and the talker, with one) with this request ID. */
    void send(String said, String request) throws Exception;
  }

  /**
   * A message that reached one of the chief and the talker but not the other: it counts as sent
   * (sending it again would repeat it to the one that got it), and the reason says who missed it.
   */
  static final class PartlySent extends Exception {
    final String request;
    final boolean chiefMissed;

    PartlySent(String request, boolean chiefMissed, String why) {
      super(why);
      this.request = request;
      this.chiefMissed = chiefMissed;
    }
  }

  interface Speaker {
    /**
     * Gets a reply ready to play, such as fetching its audio (on a background thread; may be slow).
     * Never throws: what it returns may simply play with a fallback voice.
     */
    Object prepare(String request, String text);

    /** Plays a prepared reply, telling the playback when audio started and when it ended. */
    void play(String request, String text, Object prepared, Playback playback);

    /** Is audio of the reply still coming out (for the watchdog)? */
    default boolean playing() {
      return false;
    }


    /** How many characters of the reply's text have been played (heard) so far. */
    default int heardChars() {
      return 0;
    }

    /** A prepared reply that won't be played (the call ended): whatever it still fetches stops. */
    default void drop(Object prepared) {}

    void stop();
  }

  interface Playback {
    /** Audio is coming out; it will take about this long. */
    void started(long durationMs);

    /** It's over: played to the end, or failed or stopped (played false). */
    void ended(boolean played);
  }

  /** A chief message waiting to be read: being prepared until ready. */
  private static final class Held {
    final String request, text;
    volatile Object prepared;
    volatile boolean ready;
    /** Why it waited was shown (once per reason): told, and the last reason shown. */
    boolean told;
    String toldWhy;
    /** The seconds its voice has been fetched for, as last shown (0: not shown). */
    long voiceShown;
    /** Tries to play it that failed before (its voice fetched afresh each time). */
    int failures;
    /** When it arrived and when its voice was ready, for the timings in the log. */
    final long arrived;
    volatile long readyAt;
    /** Not to be played (an outdated reply, or the call ended): its voice, when it comes, is let go. */
    volatile boolean dropped;
    /** The number of the message it answers (0: none; see answers()). */
    int answers;
    /**
     * The rest of a reply you talked over: what your message says if it's dropped ("[heard up
     * to: …] [not played from there: …]"); null for a reply not played at all.
     */
    String note;

    Held(String request, String text, long arrived) {
      this.request = request;
      this.text = text;
      this.arrived = arrived;
    }
  }

  interface Listener {
    /** Something changed: floor, state, your text so far. */
    void changed();
  }

  final List<String> sendWords, endWords;
  /** This long without speech or a reply playing ends the call, sending nothing. */
  final int silenceEndMs;
  private final Transcriber transcriber;
  private final Sender sender;
  private final Speaker speaker;
  private final Listener listener;
  private final HandsFree.Segmenter segmenter;
  /**
   * Three queues, so nothing waits on what it doesn't need: work writes down what you say (in
   * order) and checks barge-ins; outbox delivers your messages to bb (in order), so writing down
   * your next words never waits for bb and a message never waits for transcription of words
   * that came after it; voices fetches the chief's audio, each reply's at once.
   */
  private final ExecutorService work = Executors.newSingleThreadExecutor(),
      outbox = Executors.newSingleThreadExecutor(),
      voices = Executors.newCachedThreadPool(), // In parallel: a hanging voice never holds up the next reply's.
      speech = Executors.newCachedThreadPool();
  /** Live transcription, if it's on (set before the call starts). */
  volatile LiveText live;
  /** This turn is written down from its audio: its live text looked stalled. */
  private volatile boolean batchTurn;
  /** A send phrase heard in the live text is being acted on (and when it was heard, for the log). */
  private volatile boolean keyword;
  private volatile long keywordAt;
  /**
   * A phrase came while one was being checked ("Over. Over." while Jev was still asked about the
   * first): once that check ends without a send, the live text as it is then is checked again.
   */
  private volatile boolean phraseAgain;
  /** The stretch of speech going on when a send phrase sent the turn: its audio was in that message. */
  private volatile boolean dropStretch;
  /** When you started speaking in this turn, and whether its first live words were logged. */
  private volatile long turnSpeechAt;
  /** When the stretch of speech going on started (each one). */
  private volatile long stretchAt;
  /** When you last spoke, a reply last played or a message last went: the long silence counts from it. */
  private volatile long activeAt;
  /**
   * You started talking since your latest message was handed over (a new turn): every reply not
   * played yet is dropped, and one arriving now is too. Cleared when your next message goes.
   */
  private volatile boolean newTurn;
  private volatile boolean firstWordsLogged;
  private static final byte[] SILENCE = new byte[640];
  /** The microphone's level for the meter: the loudest recent frame, falling back fast. */
  private volatile double meterLevel;
  /**
   * Your voice since live transcription's words last changed, in ms: the microphone's thread adds
   * to it, words and the turn's end reset it.
   */
  private final java.util.concurrent.atomic.AtomicLong speechSinceWords = new java.util.concurrent.atomic.AtomicLong();
  /** The live text when it last brought words: a repeat of it isn't new words. */
  private volatile String wordsSeen = "";
  /** The send or end word a running phrase check is about (for the live line). */
  private volatile String phraseWord = "";

  /**
   * Your turn: nothing is written down while you talk. Its audio is collected part by part (a
   * part ends at a longer pause, so in silence); at each such pause only the parts that are new
   * since the last check are written down, and the judge (Jev) is asked about the whole turn so
   * far: whether you're done. Null judge: the send and end words.
   */
  volatile Judge judge;
  /** The audio of this turn's parts, in order (under its lock), and what changes it counts. */
  private final List<byte[]> turnAudio = new ArrayList<>();
  private int turnVersion;
  /**
   * What each part said, once written down (under turnAudio's lock; by identity): a later check
   * only writes down the parts that are new. Parts written down together have their text on the
   * last of them ("" on the others).
   */
  private final java.util.Map<byte[], String> written = new java.util.IdentityHashMap<>();
  /**
   * The whole turn written down in one pass, started at a check alongside the new part (under
   * turnAudio's lock): what's sent. A part written down on its own misses the words around it, and
   * got words at its edges wrong (on real recordings, sometimes changing the meaning); the parts'
   * text is only for the screen and for Jev.
   */
  private Whole whole;

  /** A pass over a turn's parts in one, running in the background. */
  private static final class Whole {
    final List<byte[]> parts;
    final long started;
    volatile long done;
    java.util.concurrent.Future<String> text;

    Whole(List<byte[]> parts, long started) {
      this.parts = parts;
      this.started = started;
    }
  }
  /** Words of your turn said over a reply (written down then): they come before its audio. */
  private volatile String turnPrefix = "";
  /** Writing down took this long: shown as slow. */
  static final long SLOW_WRITING_MS = 4000;

  /** Writing down a turn is given up after this long and tried once more. */
  static volatile long writeTimeoutMs = 6000;

  /** What a running check is doing: "writing" (the speech model) or "asking" (Jev); "" none. */
  private volatile String checkStep = "";
  /** A check (writing down, then Jev) started (for the live line's seconds), 0 when none runs. */
  private volatile long writingSince;
  /** Messages handed to the outbox and not delivered yet. */
  private final AtomicInteger outgoing = new AtomicInteger();
  /** Chief messages waiting to be read: once their voice is ready, the one playing ends, or your message went. */
  private final ArrayDeque<Held> held = new ArrayDeque<>();
  /**
   * A note for your next message; claimedBy is the number of the message on its way with it (0:
   * none): removed once that one is delivered, free again if it couldn't be sent.
   */
  private static final class Note {
    final String text;
    int claimedBy;

    Note(String text) {
      this.text = text;
    }
  }

  /** Notes about replies you didn't hear (their reading failed, or you talked over them). */
  private final List<Note> unheard = new ArrayList<>();
  /** Replies dropped unplayed (their texts: you started a new turn), not yet noted in a delivered message. */
  private final List<Note> outdated = new ArrayList<>();
  /**
   * Messages handed to the outbox so far (each one's number), the numbers on their way, the
   * latest delivered, and each sent request's number. A reply to an older message than the
   * latest handed over is dropped.
   */
  private int handedOff, latestSent;
  /** When the latest message was handed over. */
  private volatile long handedAt = Long.MIN_VALUE / 2;
  private final java.util.TreeSet<Integer> onTheWay = new java.util.TreeSet<>();
  private final java.util.Map<String, Integer> requestNumber = new java.util.HashMap<>();
  /** The latest decisions with their reasons, oldest first (under its own lock). */
  private final ArrayDeque<Reason> reasons = new ArrayDeque<>();
  /** What the call's end tells the chief: replies still waiting, or cut off by the end (see endNote()). */
  private volatile String endNote = "";
  private final List<String> requests = new ArrayList<>();
  /** Request → {replies so far, sent at}: for "Chief is working". */
  private final java.util.Map<String, long[]> working = new java.util.HashMap<>();
  /** Checks of your turn (writing down, Jev) queued or running. */
  private final AtomicInteger transcribing = new AtomicInteger();
  private volatile State state = State.LISTENING;
  private volatile String pending = "", status = "", error = "", reply = "";
  private volatile boolean sendAfterFlush, takenByYou;
  /**
   * Send was pressed and your message hasn't gone yet (what you said may still be written down):
   * the screen says Sending… at once, and pressing again does nothing.
   */
  private volatile boolean sendPressed;
  /** When your last message went: a press right after it belongs to it, not to what follows. */
  private volatile long sentAt = Long.MIN_VALUE / 2;
  /** A press this soon after a message went is taken as a repeated press for that message. */
  static final long REPRESS_MS = 1500;
  private volatile long mutedUntil, deliveredAt = Long.MIN_VALUE / 2;
  /** Until when a sound of ours may be in the microphone's frames. */
  private volatile long cueUntil;
  /** A sound was heard while the microphone was paused after a reply (said once per reply). */
  private volatile boolean tailHeard;
  private int sinceCheck;
  private volatile java.util.function.Consumer<String> events = e -> {};
  /** Plays a sound, true if it did; HandsFreeService's are quiet and short, and may be off. */
  volatile java.util.function.Predicate<Cue> cues = c -> false;
  private int reading, sent;
  private Held current;
  private boolean playing;
  private long readingDeadline, readingSince;
  private final int pauseFrames;
  private final double gate;
  /** The time; tests set their own. */
  java.util.function.LongSupplier clock = System::currentTimeMillis;

  HandsFreeSession(
      int pauseMs,
      int silenceEndMs,
      List<String> sendWords,
      List<String> endWords,
      Transcriber transcriber,
      Sender sender,
      Speaker speaker,
      Listener listener) {
    this(pauseMs, silenceEndMs, HandsFree.DEFAULT_TAKE_MS, HandsFree.DEFAULT_GATE, HandsFree.LEVEL, sendWords, endWords, transcriber, sender, speaker, listener);
  }

  HandsFreeSession(
      int pauseMs,
      int silenceEndMs,
      int takeMs,
      double gate,
      HandsFree.Detector detector,
      List<String> sendWords,
      List<String> endWords,
      Transcriber transcriber,
      Sender sender,
      Speaker speaker,
      Listener listener) {
    this.silenceEndMs = silenceEndMs;
    this.pauseFrames = Math.max(1, pauseMs / HandsFree.Segmenter.FRAME_MS);
    this.gate = gate;
    this.sendWords = sendWords;
    this.endWords = endWords;
    this.transcriber = transcriber;
    this.sender = sender;
    this.speaker = speaker;
    this.listener = listener;
    segmenter =
        new HandsFree.Segmenter(
            pauseMs,
            // Taking the floor needs takeMs of speech; once it's yours, short stretches count too.
            // Over a reply, BARGE_MS of your speech stops it.
            () -> state == State.READING ? BARGE_MS : floorIsYours() ? SHORT_MS : takeMs,
            gate,
            detector,
            new HandsFree.Segmenter.Listener() {
              public void segment(byte[] pcm) {
                if (dropStretch) { // Its words were taken from live transcription (sent, or in the turn's words).
                  dropStretch = false;
                  log(String.format(java.util.Locale.ROOT, "the rest of the stretch with the phrase (%.1f s) was taken from live transcription already", pcm.length / (double) AudioFiles.BYTES_PER_SECOND));
                  // What you said after the phrase in the same breath ("Over. Build it.") is in the
                  // live text only: it's your turn's, and this is a pause like any other.
                  if (streaming()) check("rest");
                  return;
                }
                addPart(pcm);
                // A longer pause: is the turn done? With Send pressed: it goes, no question.
                check(sendAfterFlush ? "button" : "pause");
              }

              public void started(double level, double background) {
                boolean taking = !takenByYou;
                takenByYou = true;
                heldBack = false; // You talk again: your words hold the turn again.
                stretchAt = clock.getAsLong();
                activeAt = stretchAt;
                // A new turn: over a reply (you interrupted it), or without live transcription.
                // With it, your first words start it (liveText): a TV or a cough doesn't.
                if (state == State.READING || !streaming()) startTurn("you started talking");
                if (taking) {
                  log(String.format(java.util.Locale.ROOT, "floor: you (level %.0f, background %.0f)", level, background));
                  cue(Cue.HEARD);
                  turnSpeechAt = clock.getAsLong();
                  firstWordsLogged = false;
                }
                listener.changed();
              }

              public void noise(int speechMs, double level, double background) {
                dropStretch = false; // That stretch didn't count: the next one is yours again.
                log(String.format(java.util.Locale.ROOT, "noise ignored (%d ms, level %.0f, background %.0f)", speechMs, level, background));
                // Clicks are left out of the reasons; anything you might have meant is in. Not over a
                // reply: what's left of its echo would fill the list.
                if (speechMs >= 100 && state != State.READING)
                  reason("Didn't count as speech: too short (%1$d ms, %2$d ms needed)", speechMs, floorIsYours() ? SHORT_MS : takeMs);
                // Send now during a sound too short to count: what was said before still goes.
                if (sendAfterFlush) check("button");
              }

              public void tooQuiet(int ms, double level, double background) {
                log(String.format(java.util.Locale.ROOT, "too quiet to count (%d ms, level %.0f, background %.0f, gate ×%.1f)", ms, level, background, gate));
                if (state != State.READING) reason("Didn't count as speech: too quiet (level %1$.0f < %2$.1f× background %3$.0f)", level, gate, background);
              }
            });
  }

  State state() {
    return state;
  }

  /** What you said since the last message. */
  String pending() {
    return pending;
  }

  /** The reply being read aloud, "" when none is. */
  String reply() {
    return reply;
  }

  /** The last thing that happened. */
  String status() {
    return status;
  }

  /** The last error (a part not written down, a message not sent), "" when the last try worked. */
  String error() {
    return error;
  }

  int sent() {
    return sent;
  }

  boolean speaking() {
    return segmenter.speaking();
  }

  /** A reply's audio is coming out. */
  synchronized boolean audioPlaying() {
    return state == State.READING && playing;
  }

  /** Chief messages waiting to be read. */
  synchronized int held() {
    return held.size();
  }

  /** What's happening right now, for the live line on screen, the call bar and the notification. */
  Live live() {
    if (state == State.ENDED) return Live.ENDED;
    long now = clock.getAsLong();
    boolean voiceReady;
    synchronized (this) {
      if (state == State.READING) return !playing ? Live.REPLY_COMING : Live.PLAYING;
      voiceReady = held.isEmpty() || held.peekFirst().ready;
    }
    if (now < mutedUntil) return Live.MUTED;
    // A send word or your pause being checked: shown even while the stretch it ended in goes on.
    String step = checkStep();
    if (step.equals("pause") || step.equals("asking")) return Live.WRITING;
    // Your voice now; a stretch goes on through the pause that ends it, which isn't hearing you.
    if (voiceNow()) return Live.HEARING;
    if (transcribing.get() > 0) return Live.WRITING;
    if (sendPressed || outgoing.get() > 0) return Live.SENDING;
    if (held() > 0) return voiceReady ? Live.REPLY_WAITING : Live.REPLY_COMING;
    if (hasTurn() || !pending.isEmpty()) return Live.WAITING_SEND;
    if (segmenter.speaking()) return Live.HEARING;
    if (now - deliveredAt < SENT_SHOWN_MS) return Live.SENT;
    synchronized (this) {
      for (long[] w : working.values()) if (w[0] < 2 && now - w[1] < WORKING_MS) return Live.WAITING_CHIEF;
    }
    return Live.LISTENING;
  }

  /** What the microphone hears right now (the meter's colour). */
  Hearing hearing() {
    if (voiceNow()) return Hearing.VOICE;
    // The same "clearly there" as the segmenter's too-quiet report: above its minimum and half
    // again the background.
    return meterLevel > Math.max(600, segmenter.background() * 1.5) ? Hearing.SOUND : Hearing.QUIET;
  }

  /**
   * Your voice is heard now: speech, and not the pause that ends it (a stretch lasts through that
   * pause, 5 s by default).
   */
  private boolean voiceNow() {
    return segmenter.speaking() && segmenter.silentMs() < HEARING_MS;
  }

  /** The meter's height, 0 to 1: the microphone's recent level on a log scale (100 to 10,000). */
  double meter() {
    double l = meterLevel;
    return l <= 100 ? 0 : Math.min(1, (Math.log10(l) - 2) / 2);
  }

  /** The last few words heard (see Heard), or null when there are none. */
  Heard heard() {
    String p = pending;
    if (!p.isEmpty()) return new Heard(lastWords(p, HEARD_WORDS), true);
    LiveText l = live;
    if (l == null || !l.working() || state != State.LISTENING || batchTurn) return null;
    String t = l.text();
    return t.isEmpty() ? null : new Heard(lastWords(t, HEARD_WORDS), false);
  }

  /** How many of the last words the call bar shows. */
  static final int HEARD_WORDS = 8;

  /** Does live transcription bring your words as you speak (this turn)? Else they come at your pause. */
  boolean liveWords() {
    return streaming();
  }

  /**
   * Why your words may not be coming through, in a few words, or "": live transcription failed or
   * has no key (the whole call), or it brought no words for NO_WORDS_MS of your speech.
   */
  String trouble() {
    LiveText l = live;
    if (l != null && !l.working()) return tr("Live transcription failed: %1$s", l.failure());
    if (!liveOff.isEmpty()) return tr("Live transcription is off: no %1$s key (Settings → Hands-free)", liveOff);
    long ms = speechSinceWords.get();
    if (streaming() && ms >= NO_WORDS_MS) return tr("No words for %1$d s of sound: live transcription may not be working", ms / 1000);
    return "";
  }

  /**
   * As trouble(), short, for the call bar; "" when there's none. A missing key isn't here: the
   * call bar says that in the call's first minute (liveOffRecent).
   */
  String troubleShort() {
    LiveText l = live;
    if (l != null && !l.working()) return tr("No live text · words at pauses");
    if (!liveOff.isEmpty()) return tr("Live off · no %1$s key", liveOff); // The whole call, not only its start.
    long ms = speechSinceWords.get();
    if (streaming() && ms >= NO_WORDS_MS) return tr("No words for %1$d s", ms / 1000);
    return "";
  }

  /** The send or end word a running check heard and waits for a pause after; "" otherwise. */
  String phraseWaiting() {
    return "pause".equals(checkStep()) ? phraseWord : "";
  }

  /** The text's last n words, "…" before them when there were more. */
  static String lastWords(String text, int n) {
    String[] w = text.trim().split("\\s+");
    return (w.length > n ? "…" : "") + String.join(" ", java.util.Arrays.copyOfRange(w, Math.max(0, w.length - n), w.length));
  }

  /** The latest decisions with their reasons, newest first. */
  List<Reason> reasons() {
    synchronized (reasons) {
      List<Reason> out = new ArrayList<>(reasons);
      java.util.Collections.reverse(out);
      return out;
    }
  }

  /**
   * A decision, with its reason in plain words: on screen (translated), and in the log (in
   * English). The same one again in a row counts up instead of filling the list.
   */
  void reason(String english, Object... args) {
    log("→ " + (args.length == 0 ? english : String.format(java.util.Locale.ROOT, english, args)));
    show(english, false, args);
  }

  /**
   * A reason that counts up while it lasts ("… (3 s)"): it takes the place of the last one when
   * that's the same reason, and is logged only the first time.
   */
  private void ongoing(String english, Object... args) {
    boolean first;
    synchronized (reasons) {
      first = !english.equals(lastReason);
    }
    if (first) log("→ " + String.format(java.util.Locale.ROOT, english, args));
    show(english, true, args);
  }

  /** The English of the last reason shown (under reasons' lock). */
  private String lastReason = "";

  private void show(String english, boolean inPlace, Object... args) {
    String text = tr(english, args);
    long now = clock.getAsLong();
    synchronized (reasons) {
      Reason last = reasons.peekLast();
      if (last != null && inPlace && english.equals(lastReason)) {
        reasons.removeLast();
        reasons.addLast(new Reason(now, text, 1));
      } else if (last != null && last.text().equals(text)) {
        reasons.removeLast();
        reasons.addLast(new Reason(now, text, last.times() + 1));
      } else reasons.addLast(new Reason(now, text, 1));
      lastReason = english;
      while (reasons.size() > REASONS) reasons.removeFirst();
    }
    listener.changed();
  }

  /**
   * A quiet sound; for CUE_MS the microphone's frames can't start your speech or a barge-in. Not
   * for HEARD: it plays while you're talking, and your speech goes on through it.
   */
  private void cue(Cue c) {
    try {
      if (cues.test(c) && c != Cue.HEARD) cueUntil = clock.getAsLong() + CUE_MS;
    } catch (RuntimeException ignored) {
      /* A sound is a help, not a must. */
    }
  }

  /** May a sound of ours be in the frame coming in now? */
  private boolean inCue() {
    return clock.getAsLong() < cueUntil;
  }

  /**
   * What the call's end tells the chief, after the end signal: the replies that never played
   * (still waiting), or the one cut off by the end. "" when every reply was heard.
   */
  String endNote() {
    StringBuilder note = new StringBuilder(endNote);
    List<String> notNoted = new ArrayList<>();
    synchronized (this) {
      endNoted = true; // A reply after this can't be noted any more.
      // Notes no message took (a reply you talked over or that was outdated), once the messages
      // on their way are settled (a failed one frees its notes).
      for (Note n : unheard) if (n.claimedBy == 0) note.append("\n\n").append(n.text);
      for (Note n : outdated) if (n.claimedBy == 0) notNoted.add(n.text);
    }
    if (!notNoted.isEmpty()) note.append("\n\n").append(missed(notNoted));
    synchronized (this) {
      note.append(unsentEnd);
    }
    return note.toString();
  }

  /** The call's end built its note (endNote); a message still in bb failing after this sends its words itself. */
  private volatile boolean endNoted, settled;
  private final java.util.concurrent.atomic.AtomicBoolean leftoverRunning = new java.util.concurrent.atomic.AtomicBoolean();

  /** Tries of sendLeftover, LEFTOVER_RETRY_MS apart. */
  static final int LEFTOVER_TRIES = 3;
  static volatile long leftoverRetryMs = 2000;

  /**
   * After the call's end, once the messages on their way are settled: words a message that
   * failed left behind are sent now (with the notes it carried), so they aren't stranded. Tried
   * LEFTOVER_TRIES times, not past until (the clock's time). True when nothing is left.
   */
  boolean sendLeftover(long until) {
    if (state != State.ENDED) return true;
    settled = true;
    while (true) {
      if (!leftoverRunning.compareAndSet(false, true)) return false; // Another thread is at it.
      boolean sent;
      try {
        sent = leftoverOnce(until);
      } finally {
        leftoverRunning.set(false);
      }
      if (!sent) return false;
      // Words a message that failed meanwhile left (it saw this running): they go too.
      synchronized (turnAudio) {
        if (turnPrefix.trim().isEmpty()) return true;
      }
    }
  }

  /**
   * Words left at the end, tried LEFTOVER_TRIES times. Given up, they go in the end line; if only
   * the talker got them, in the chief's end line. False when given up.
   */
  private boolean leftoverOnce(long until) {
    for (int tries = 0; ; tries++) {
      String text;
      synchronized (turnAudio) {
        text = turnPrefix.trim();
        turnPrefix = "";
      }
      if (text.isEmpty()) return true;
      log("words a message couldn't take before the end: sending them now" + (tries > 0 ? " (try " + (tries + 1) + ")" : ""));
      outgoing.incrementAndGet();
      Handoff h = handOff(true);
      Delivery d = deliver(text + h.notes(), text, "end of the call", h, clock.getAsLong());
      if (d == Delivery.CHIEF_MISSED) {
        // It counts as sent (the talker has them): the chief gets them with its end line.
        synchronized (this) {
          chiefOnlyEnd.append("\n\n").append(notSent(text));
        }
        log("the chief missed your last words: they go with its end of the call");
        return true;
      }
      if (d == Delivery.SENT) return true;
      // Not sent: deliver put them back in your turn, for the next try.
      if (tries + 1 >= LEFTOVER_TRIES || clock.getAsLong() + leftoverRetryMs > until) {
        String left;
        synchronized (turnAudio) {
          left = turnPrefix.trim();
          turnPrefix = "";
        }
        synchronized (this) {
          if (!left.isEmpty()) unsentEnd.append("\n\n").append(notSent(left));
        }
        log("words left at the call's end couldn't be sent: they go with the end of the call");
        return false;
      }
      try {
        Thread.sleep(leftoverRetryMs);
      } catch (InterruptedException ex) {
        return false;
      }
    }
  }

  /** Words that never reached a thread, for the end line. */
  static String notSent(String words) {
    return "[my last words, not sent before the end: \"" + words.trim() + "\"]";
  }

  /** Last words for both threads' end line (sending failed), and for the chief's only (the talker got them). */
  private final StringBuilder unsentEnd = new StringBuilder(), chiefOnlyEnd = new StringBuilder();

  /** The chief's end line: endNote() and the last words only the talker got. */
  String endNoteForChief() {
    String both = endNote();
    synchronized (this) {
      return both + chiefOnlyEnd;
    }
  }


  /** Chief messages that couldn't be read, not yet noted in a message. */
  synchronized int unheard() {
    return unheard.size();
  }

  /** Is your turn going on: speaking, being written down, unsent text, or going out? */
  private boolean floorIsYours() {
    return takenByYou || segmenter.speaking() || transcribing.get() > 0 || hasTurn() || outgoing.get() > 0;
  }

  Floor floor() {
    if (state == State.READING) return Floor.CHIEF;
    return floorIsYours() ? Floor.YOU : Floor.OPEN;
  }

  Phase phase() {
    if (state == State.READING) return Phase.READING;
    if (outgoing.get() > 0 || sendPressed) return Phase.SENDING;
    if (floorIsYours()) return Phase.LISTENING;
    long now = clock.getAsLong();
    synchronized (this) {
      for (long[] w : working.values()) if (w[0] < 2 && now - w[1] < WORKING_MS) return Phase.WORKING;
    }
    return Phase.LISTENING;
  }

  /** Each thing that happens, for the hands-free log (what went wrong in a turn). */
  void onEvent(java.util.function.Consumer<String> listener) {
    events = listener;
  }

  private void log(String event) {
    events.accept(event);
  }

  /** The request sent last in this call; "" before the first. */
  synchronized String lastRequest() {
    return requests.isEmpty() ? "" : requests.get(requests.size() - 1);
  }

  /** Is this one of the requests sent in this call? */
  synchronized boolean ours(String request) {
    return requests.contains(request);
  }

  /**
   * One 20 ms frame from the microphone (on the recording thread). While a reply plays it's
   * checked for you talking over it (barge-in); for TAIL_MS after a reply ended frames are dropped,
   * so its last word doesn't start your turn.
   */
  void frame(byte[] frame) {
    boolean cue = inCue();
    meterLevel = Math.max(HandsFree.Segmenter.level(frame, frame.length), meterLevel * METER_FALL);
    LiveText l = live;
    if (l != null && l.working() && state != State.ENDED) {
      // Live transcription hears everything you say (not only what the segmenter keeps); a reply
      // and its tail are silence to it (its echo isn't you): if you talk over it, what you said
      // over it goes first.
      boolean quiet = state == State.READING || clock.getAsLong() < mutedUntil;
      l.audio(quiet ? SILENCE : frame);
      if (segmenter.speaking()) l.speech();
    }
    if (state == State.READING) {
      bargeFrame(frame, cue);
      return;
    }
    if (state != State.LISTENING) return;
    long now = clock.getAsLong();
    if (now < mutedUntil) {
      if (!tailHeard && HandsFree.Segmenter.level(frame, frame.length) > Math.max(600, segmenter.background() * gate)) {
        tailHeard = true;
        reason("A sound right after the reply was ignored (mic paused)");
      }
      return;
    }
    // A sound of ours just played: it can't start a stretch of speech (one going on goes on).
    if (cue && !segmenter.candidate()) return;
    segmenter.frame(frame);
    // Only frames loud as your voice count (not the gaps between words or the pause after them):
    // the warning rather comes late than when you're simply pausing.
    if (segmenter.speaking() && segmenter.silentMs() == 0 && streaming()) noWords(HandsFree.Segmenter.FRAME_MS);
    // A waiting reply plays once your turn is over: checked a few times a second.
    if (++sinceCheck >= 10) {
      sinceCheck = 0;
      noteTurn();
      if (held() > 0) readNext();
    }
  }

  /**
   * Your speech went on ms more without live transcription bringing words: past NO_WORDS_MS it's
   * on screen (and once in the log and the reasons, with the levels, as it may be noise counted as
   * speech) until words come.
   */
  private void noWords(long ms) {
    long was = speechSinceWords.getAndAdd(ms), now = was + ms;
    if (was < NO_WORDS_MS && now >= NO_WORDS_MS) {
      LiveText l = live;
      log(String.format(java.util.Locale.ROOT, "live transcription: no words for %d s of speech (background %.0f; it %s)", now / 1000, segmenter.background(),
          l == null ? "isn't there" : l.working() ? "says it's working" : "failed"));
      reason("No words came for %1$d s of sound: live transcription may not be working, or it's noise", now / 1000);
      cue(Cue.FAILED); // Heard too: the screen may not be in sight (driving).
    } else if (now >= NO_WORDS_MS && now / 1000 != was / 1000) listener.changed(); // The seconds on screen.
  }

  /**
   * Barge-in: the microphone's frames while a reply plays go to the segmenter (the reply's echo
   * cancelled by the phone); once it hears BARGE_MS of your speech the reply stops.
   */
  private void bargeFrame(byte[] frame, boolean cue) {
    int token;
    synchronized (this) {
      if (state != State.READING) return; // Also before its audio starts: you may talk first.
      token = reading;
    }
    if (cue && !segmenter.candidate()) return; // A sound of ours, not you.
    segmenter.frame(frame);
    if (segmenter.speaking()) bargeIn(token);
  }

  /**
   * You talk over the reply: it stops at once and the rest of it is dropped (you've said something
   * new; it no longer fits). Your next message tells the chief how far you heard; your speech goes
   * on as your turn.
   */
  private void bargeIn(int token) {
    int at = speaker.heardChars();
    Held was;
    synchronized (this) {
      if (token != reading || state != State.READING || current == null) return;
      was = current;
    }
    String text = was.text;
    int speech = segmenter.voicedMs();
    long since = clock.getAsLong();
    String note = heardUpTo(text, at), rest = resumeFrom(text, at);
    // What you said over it, from the start of that stretch (it took a moment to count as you).
    byte[] said = segmenter.stretchAudio();
    if (!endReading(token, null, false)) return;
    speaker.stop();
    LiveText l = live;
    if (l != null && l.working())
      for (int i = 0; i + 640 <= said.length; i += 640) l.audio(java.util.Arrays.copyOfRange(said, i, i + 640));
    // The rest waits, first in line: played if your turn comes to nothing, dropped once your
    // message goes (which then says how far you heard).
    Held r = rest.isEmpty() ? null : new Held(was.request, rest, clock.getAsLong());
    boolean waits = false;
    if (r != null)
      synchronized (this) {
        r.answers = was.answers;
        r.note = note;
        if (state != State.ENDED && !outdated(r)) {
          held.addFirst(r);
          waits = true;
        } else unheard.add(new Note(note));
      }
    if (waits) prepare(r);
    log(String.format(java.util.Locale.ROOT, "barge-in: speech %d ms → paused (in %d ms, at character %d of %d)%s", speech, clock.getAsLong() - since, at, text.length(),
        waits ? "; it plays on from \"" + firstWords(rest, MISSED_WORDS) + "\" if your turn comes to nothing, dropped once your message goes" : ""));
    if (waits) reason("Reply paused: you're talking. It's dropped once your message goes");
    else reason("Reply stopped: you talked over it");
  }

  /**
   * Where a reply you talked over at heardChars plays on from: the start of the sentence it
   * stopped in ("" when it was heard to its end).
   */
  static String resumeFrom(String reply, int heardChars) {
    int at = Math.max(0, Math.min(heardChars, reply.length()));
    if (at >= reply.length()) return "";
    int start = 0;
    for (int i = at - 1; i > 0; i--)
      if (Character.isWhitespace(reply.charAt(i)) && ".!?…\n".indexOf(reply.charAt(i - 1)) >= 0) {
        start = i;
        break;
      } else if (reply.charAt(i) == '\n') {
        start = i;
        break;
      }
    return reply.substring(start).trim();
  }

  /** The note for a reply you interrupted: its last words you heard (or that you heard none). */
  static String heardUpTo(String reply, int heardChars) {
    String part = reply.substring(0, Math.max(0, Math.min(heardChars, reply.length()))).trim();
    // A word cut in the middle wasn't heard.
    if (heardChars < reply.length() && heardChars > 0 && Character.isLetterOrDigit(reply.charAt(heardChars))
        && Character.isLetterOrDigit(reply.charAt(heardChars - 1)))
      part = part.replaceAll("\\S+$", "").trim();
    String[] w = part.isEmpty() ? new String[0] : part.split("\\s+");
    if (w.length < 2) return missed(reply);
    StringBuilder last = new StringBuilder();
    for (int i = Math.max(0, w.length - 8); i < w.length; i++) last.append(last.length() == 0 ? "" : " ").append(w[i]);
    String heard = "[heard up to: \"" + (w.length > 8 ? "…" : "") + last + "\"]";
    // What wasn't played, from where it was cut: its first words.
    String rest = reply.substring(Math.min(reply.length(), reply.indexOf(part) + part.length())).trim();
    return rest.isEmpty() ? heard : heard + " [not played from there: \"" + firstWords(rest, MISSED_WORDS) + "\"]";
  }

  /** How long the call bar and screen say the voice model failed. */
  static final long VOICE_ERROR_MS = 20_000;

  private volatile String voiceError = "";
  private volatile long voiceErrorAt;

  /**
   * The voice model failed to deliver a reply's audio (why: its HTTP status and what it said, or
   * how long it didn't answer): on screen, on the call bar a while, and in the log. With Android's
   * voice the reply is read in it; without, playing it fails and it's tried once more.
   */
  void voiceFailed(String why, boolean android) {
    voiceError = why;
    voiceErrorAt = clock.getAsLong();
    if (android) reason("Voice failed (%1$s): Android's voice reads the reply", why);
    else reason("Voice failed (%1$s): this phone has no other voice", why);
  }

  /** Why the voice model failed, while it's shown; "" otherwise. */
  String voiceError() {
    return clock.getAsLong() - voiceErrorAt < VOICE_ERROR_MS ? voiceError : "";
  }

  /** How long the call bar says live transcription is off for a missing key. */
  static final long LIVE_OFF_MS = 60_000;

  private volatile String liveOff = "";
  private volatile long liveOffAt;

  /**
   * Live transcription is on, but its provider (AssemblyAI, ElevenLabs) has no key: your words
   * are written down from their audio at each pause, and a send word doesn't send at once. Said
   * at the call's start: in the reasons, on the screen for the whole call, on the call bar a while.
   */
  void liveKeyMissing(String provider) {
    liveOff = provider;
    liveOffAt = clock.getAsLong();
    reason("Live transcription is off: no %1$s key (Settings → Hands-free)", provider);
    cue(Cue.FAILED); // Heard too: no preview and no instant send word all call.
  }

  /** The provider whose key live transcription is missing this call, "" when it isn't. */
  String liveKeyMissing() {
    return liveOff;
  }

  /** Is the call bar still to say so? */
  boolean liveOffRecent() {
    return !liveOff.isEmpty() && clock.getAsLong() - liveOffAt < LIVE_OFF_MS;
  }

  /** Once a second: a long silence ends the call, a held reply may start, a hung voice is let go. */
  void tick() {
    if (state == State.ENDED) return;
    int token;
    boolean late;
    long now = clock.getAsLong();
    if (activeAt == 0) activeAt = now; // The call's first tick: the silence counts from here.
    liveCheck(now);
    synchronized (this) {
      token = reading;
      late = state == State.READING && now > readingDeadline;
      // Longer than it said, but audio still coming out: let it finish.
      if (late && playing && now - readingSince < READING_CAP_MS && speaker.playing()) {
        readingDeadline = now + OVERRUN_MS;
        late = false;
      }
    }
    if (late) {
      boolean started;
      synchronized (this) {
        started = playing;
      }
      log(started ? "the reply played too long: listening again" : "the reply's audio didn't start: listening again");
      speaker.stop();
      finishReading(token, false, started ? tr("it played far too long") : tr("its audio didn't start"));
      return;
    }
    if (state == State.LISTENING && !segmenter.candidate() && transcribing.get() == 0 && outgoing.get() == 0 && !sendPressed
        && held() == 0 && now - activeAt >= silenceEndMs) {
      // Nobody talked and nothing played for so long: the call is over. Nothing is sent, also no
      // words of yours Jev didn't call done (Philipp's design, 2 November 2026).
      log(String.format(java.util.Locale.ROOT, "%d s of silence: ending the call, sending nothing%s", silenceEndMs / 1000,
          hasTurn() || !pending.isEmpty() ? " (your unsent words \"" + tail(pending) + "\" are let go)" : ""));
      reason("Call ended after %1$d s of silence; nothing was sent", silenceEndMs / 1000);
      end(false);
      return;
    }
    // Words live transcription heard while nobody had the floor (noise, a TV, someone else) don't
    // start your next turn.
    LiveText l = live;
    if (l != null && l.working() && state == State.LISTENING && floor() == Floor.OPEN && !segmenter.candidate()
        && segmenter.quietMs() >= STRAY_MS && !l.text().isEmpty()) {
      log("live text heard words while nobody had the floor: dropped (\"" + tail(l.text()) + "\")");
      l.discard();
    }
    readNext();
  }

  private void execute(Runnable r, Runnable rejected) {
    try {
      work.execute(r);
    } catch (java.util.concurrent.RejectedExecutionException ex) {
      if (rejected != null) rejected.run(); // Ended.
    }
  }

  /** Is live transcription on and working, for this turn? */
  private boolean streaming() {
    LiveText l = live;
    return l != null && l.working() && !batchTurn;
  }

  /**
   * The live text changed (on the transcription's thread): shown as your words, and a send or end
   * phrase at its end acts at once (checked on the work queue: the model's final text decides).
   */
  void liveText(String text) {
    if (!text.isEmpty() && !text.equals(wordsSeen)) words(text);
    String ending = text.isEmpty() ? null : HandsFree.endsWith(text, endWords) != null ? "end" : HandsFree.endsWith(text, sendWords) != null ? "send" : null;
    if (state != State.LISTENING || !streaming() || text.isEmpty() || !floorIsYours()) {
      if (ending != null)
        phraseSkipped(ending, text,
            state == State.READING ? "a reply is playing" : state != State.LISTENING ? "the call ended"
                : !streaming() ? (batchTurn ? "this turn is written down from its audio" : "live transcription isn't working")
                : "nobody had the floor (no speech heard)");
      return;
    }
    LiveText now = live;
    if (now != null && !text.equals(now.text())) { // Overtaken (its turn was just taken).
      if (ending != null) phraseSkipped(ending, text, "the live text moved on (its turn was just taken)");
      return;
    }
    String prefix = turnPrefix;
    pending = (prefix + " " + text).trim();
    activeAt = clock.getAsLong();
    // Words you said after your message went ("Over. And also…" in one breath): a new turn. Only
    // with sound heard since (late words of the message just taken aren't you talking again).
    if (clock.getAsLong() - segmenter.silentMs() > handedAt) startTurn("you went on talking");
    if (!firstWordsLogged && turnSpeechAt > 0) {
      firstWordsLogged = true;
      log(String.format(java.util.Locale.ROOT, "live text: first words %d ms after you started speaking", clock.getAsLong() - turnSpeechAt));
    }
    listener.changed();
    String phrase = ending;
    if (phrase == null) return;
    if (phrase.equals("send") && heldPhrase.equals(HandsFree.normalize(pending))) {
      phraseSkipped(phrase, text, "Jev said you weren't done with these words");
      return;
    }
    if (keyword) {
      phraseAgain = true;
      phraseSkipped(phrase, text, "a phrase is being checked already; checked again after it");
      return;
    }
    keyword = true;
    keywordAt = clock.getAsLong();
    phraseWord = matched(text, phrase.equals("end") ? endWords : sendWords);
    log("live text ends with the " + phrase + " phrase: \"" + tail(text) + "\"");
    check(phrase.equals("end") ? "end phrase" : "send phrase");
  }

  /** Live transcription brought words: it works (a warning that it brought none goes, and is logged). */
  private void words(String text) {
    wordsSeen = text;
    long was = speechSinceWords.getAndSet(0);
    if (was >= NO_WORDS_MS) {
      log(String.format(java.util.Locale.ROOT, "live transcription: words again, after %d s of speech without", was / 1000));
      listener.changed();
    }
  }

  /** When the first tick came; whether live transcription's state was logged (LIVE_CHECK_MS in). */
  private long firstTick;
  private boolean liveChecked;

  static final long LIVE_CHECK_MS = 10_000;

  /** Once, LIVE_CHECK_MS into the call: is live transcription running, so a log says why "over" didn't act. */
  private void liveCheck(long now) {
    if (liveChecked) return;
    if (firstTick == 0) firstTick = now;
    if (now - firstTick < LIVE_CHECK_MS) return;
    liveChecked = true;
    LiveText l = live;
    log("live transcription " + (LIVE_CHECK_MS / 1000) + " s into the call: "
        + (l == null ? "not used (off, or no key)" : !l.working() ? "failed (" + l.failure() + "): send words act at your pauses only" : "working"));
  }

  /** Which of the words the text ends with ("" none), as set. */
  static String matched(String text, List<String> words) {
    for (String w : words) if (HandsFree.endsWith(text, List.of(w)) != null) return w.trim();
    return "";
  }

  /** The phrase skip logged last, so the live text's repeats don't fill the log. */
  private String lastSkip = "";

  /**
   * Logs why a send or end phrase at the end of the live text didn't act: every one says why. Not
   * acting because your voice didn't count is on screen too: in the car "over" seemed ignored.
   */
  private void phraseSkipped(String phrase, String text, String why) {
    String line = "live text ends with the " + phrase + " phrase, not acted on: " + why + " (\"" + tail(text) + "\")";
    synchronized (this) {
      if (line.equals(lastSkip)) return;
      lastSkip = line;
    }
    log(line);
    if (why.startsWith("nobody had the floor"))
      reason("Heard %1$s, but your voice didn't count as speech (too quiet against the background?): not sent", quote(matched(text, phrase.equals("end") ? endWords : sendWords)));
  }

  private static String quote(String word) {
    return "\"" + word + "\"";
  }

  /** The last few words, for the log. */
  private static String tail(String text) {
    String[] w = text.trim().split("\\s+");
    return (w.length > 6 ? "…" : "") + String.join(" ", java.util.Arrays.copyOfRange(w, Math.max(0, w.length - 6), w.length));
  }

  /**
   * What was said before hands-free started (the dictation it was switched to from): written down
   * as the start of your first turn, which it holds the floor for.
   */
  void seed(byte[] pcm) {
    if (pcm.length == 0) return;
    log(String.format(java.util.Locale.ROOT, "started from a dictation (%.1f s)", pcm.length / (double) AudioFiles.BYTES_PER_SECOND));
    takenByYou = true;
    addPart(pcm);
    check("seed"); // Shown; you go on talking, so not judged yet.
  }

  /**
   * Send now (the panel's, the screen's, the notification's or the headset's button). It shows at
   * once (Sending…), since your message may wait for what you said last to be written down; a
   * second press meanwhile, or right after it went, does nothing (it would send the next words
   * you start on their own). Every press is logged, also the ones that do nothing.
   */
  void sendNow() {
    if (state == State.ENDED) return;
    activeAt = clock.getAsLong();
    if (sendPressed) {
      log("send pressed again: already sending");
      reason("Send ignored: already sending");
      return;
    }
    long since = clock.getAsLong() - sentAt;
    if (since < REPRESS_MS) {
      log("send pressed right after your message went: taken as the same press");
      reason("Send ignored: just sent (%1$.1f s ago)", since / 1000.0);
      return;
    }
    // Sounds that didn't count as speech just before: Send means they were meant, so they're
    // written down and sent.
    byte[] noise = state == State.LISTENING && !hasTurn() && transcribing.get() == 0 && !segmenter.candidate() ? segmenter.takeNoise() : null;
    if (noise != null) {
      sendPressed = true;
      takenByYou = true;
      log(String.format(java.util.Locale.ROOT, "send pressed: writing down the last %.1f s of sounds that didn't count as speech", noise.length / (double) AudioFiles.BYTES_PER_SECOND));
      reason("Send: writing down what didn't count as speech, then it goes");
      addPart(noise);
      check("button");
      return;
    }
    if (!hasTurn() && transcribing.get() == 0 && !talking()) {
      if (state == State.READING) {
        log("send pressed while a reply is read: nothing of yours to send (talk over the reply to interrupt it)");
        reason("Send ignored: a reply is playing and you have nothing unsent");
      } else {
        log("send pressed: nothing said yet");
        reason("Send ignored: nothing heard yet");
      }
      return;
    }
    sendPressed = true;
    listener.changed();
    if (talking()) {
      log("send pressed: ending what you're saying");
      reason("Send: ending what you're saying, then it goes");
      sendAfterFlush = true;
      segmenter.flush(true); // Written down even if it didn't count as speech yet.
    } else {
      // Your unsent words go also while a reply plays: sending doesn't stop it. Written down
      // first (after a check that's running), never judged: Send always sends.
      log("send pressed: writing down your turn, then it goes" + (state == State.READING ? " (a reply plays on)" : ""));
      reason("Send: writing down your turn, then it goes");
      check("button");
    }
  }

  /**
   * You started talking (a stretch counted as speech, or live words came after your message went):
   * a new turn. Replies waiting wait on while it's your turn; they're dropped once your message
   * goes (handOff), and play if your turn comes to nothing (noise, no words). Once per turn; a
   * reply playing pauses by itself (barge-in).
   */
  private void startTurn(String why) {
    int waiting;
    synchronized (this) {
      if (newTurn || state == State.ENDED) return;
      newTurn = true;
      waiting = held.size();
    }
    log("new turn (" + why + ")" + (waiting == 0 ? "" : ": " + waiting + " reply(ies) wait, dropped once your message goes"));
  }

  /** Not done yet, but you're quiet: Jev said so at your pause; your next speech ends it. */
  private volatile boolean heldBack;

  /** Ends the call. What you said but didn't send yet is sent first. */
  void end() {
    end(true);
  }

  /** Ends the call; sendWords false (a long silence): what you said but didn't send isn't sent. */
  void end(boolean sendWords) {
    if (state == State.ENDED) return;
    // What you're saying right now is part of your last words.
    if (state == State.LISTENING && sendWords) segmenter.flush(true);
    int at = state == State.READING ? speaker.heardChars() : 0;
    StringBuilder note = new StringBuilder();
    int waiting;
    List<Held> dropped;
    synchronized (this) {
      if (state == State.ENDED) return; // Ended once only (End and an end phrase at once).
      // The chief hears once, with the call's end, which replies never reached you.
      if (state == State.READING && current != null) note.append("\n\n").append(heardUpTo(current.text, at));
      // Replies still waiting: noted with your last words if they go, else with the end (endNote).
      for (Held h : held) {
        if (h.note != null) unheard.add(new Note(h.note));
        else outdated.add(new Note(h.text));
        h.dropped = true; // A voice still being fetched is let go when it comes.
      }
      dropped = new ArrayList<>(held);
      waiting = held.size();
      // Notes no message takes are added by endNote(), once the messages on their way settled.
      held.clear();
      state = State.ENDED;
    }
    for (Held h : dropped) speaker.drop(h.prepared); // Not played: not fetched on.
    endNote = note.toString();
    if (waiting > 0) log("ended with " + waiting + " reply(ies) still waiting: the chief is told");
    if (sendWords) sendUnsent();
    else
      synchronized (turnAudio) { // Let go: nothing goes after a silent end.
        turnAudio.clear();
        written.clear();
        turnPrefix = "";
        turnVersion++;
      }
    log("ended");
    speaker.stop();
    status = "ended";
    work.shutdown();
    LiveText l = live;
    if (l != null)
      try {
        outbox.execute(l::close); // After your last words are taken from it.
      } catch (java.util.concurrent.RejectedExecutionException ended) {
        l.close();
      }
    outbox.shutdown(); // Messages on their way still go.
    voices.shutdownNow();
    speech.shutdown();
    listener.changed();
  }

  /**
   * A spoken message from the chief: its audio is fetched right away, while the floor stays open;
   * once ready it's read on an open floor, else held.
   */
  void reply(String request, String text) {
    reply(request, text, 0);
  }

  /** As above; published is when ntfy got it (unix ms, 0 if unknown), for the log's timings. */
  void reply(String request, String text, long published) {
    reply(request, text, published, false);
  }

  /**
   * As above; untagged: the talker's update without a request ID. Its request is then the latest
   * one handed over (lastRequest), also while that message is on its way: it answers that one.
   */
  void reply(String request, String text, long published, boolean untagged) {
    if (state == State.ENDED) {
      replyAfterEnd(request, text);
      return;
    }
    Held h = new Held(request, text, clock.getAsLong());
    long since;
    boolean old;
    synchronized (this) {
      if (state == State.ENDED) { // Ended meanwhile: end() took what was waiting.
        replyAfterEnd(request, text);
        return;
      }
      long[] w = working.get(request);
      if (w != null) w[0]++;
      since = w == null ? -1 : clock.getAsLong() - w[1];
      Integer n = requestNumber.get(request);
      h.answers = n == null ? 0 : n;
      old = outdated(h);
      if (old) outdated.add(new Note(text));
      else held.addLast(h);
    }
    if (old) {
      log("chief message " + request + " dropped unplayed (" + text.length() + " characters): "
          + "it answers an older message than your latest"
          + "; your next message says it didn't play");
      reason("A reply wasn't played: you've said more since. Your next message tells the chief");
      listener.changed();
      return;
    }
    // ntfy's time is in whole seconds (and the server's clock): about how long delivery took.
    long ntfy = published <= 0 ? -1 : Math.max(0, System.currentTimeMillis() - published);
    log("chief message " + request + (untagged ? " (untagged)" : "") + " (" + text.length() + " characters" + (since < 0 ? "" : ", " + since + " ms after your message went")
        + (ntfy < 0 ? "" : ", ntfy delivered it ~" + ntfy / 1000 + " s after it was posted") + ")");
    prepare(h);
    readNext(); // Says why it waits, if it does.
    listener.changed();
  }

  /**
   * Is this reply for a turn before your newest: it answers an older message than the latest
   * handed over (also one still on its way; a reply without a request of ours counts as older
   * once a message went)? Such a reply is never played. One answering the message on its way
   * waits until it's delivered, then plays; one arriving while you talk waits for your turn.
   */
  private synchronized boolean outdated(Held h) {
    return h.answers < handedOff;
  }

  /**
   * A reply after the call's end isn't played: noted with the end, while its note is still to be
   * built; else only logged.
   */
  private void replyAfterEnd(String request, String text) {
    boolean noted;
    synchronized (this) {
      noted = !endNoted;
      if (noted) unheard.add(new Note(missed(text)));
    }
    log("chief message " + request + " after the call's end (" + text.length() + " characters): "
        + (noted ? "noted with the end" : "not played, and the end was already sent"));
  }

  /** Fetches a reply's audio (on the voices queue); once ready it plays when it may. */
  private void prepare(Held h) {
    try {
      voices.execute(
          () -> {
            long start = clock.getAsLong();
            try {
              h.prepared = speaker.prepare(h.request, h.text);
              if (h.dropped) {
                speaker.drop(h.prepared); // Dropped while its voice was fetched.
                return;
              }
              log("voice ready for " + h.request + " in " + (clock.getAsLong() - start) + " ms");
            } catch (RuntimeException ex) {
              log("voice not ready for " + h.request + ": " + ex.getMessage());
            }
            h.readyAt = clock.getAsLong();
            h.ready = true;
            readNext();
          });
    } catch (java.util.concurrent.RejectedExecutionException ended) {
      /* The call ended. */
    }
  }

  /**
   * The next waiting reply plays once its audio is ready and nobody has the turn (silence): never
   * during your turn (yourTurn), however long it lasts. Why it waits is shown once per reason, and
   * when it plays after waiting; while its voice is fetched the seconds count up on screen.
   */
  private void readNext() {
    noteTurn();
    Held next;
    int token;
    String waits, plays = null;
    long now = clock.getAsLong(), fetching = 0;
    synchronized (this) {
      if (state != State.LISTENING || held.isEmpty()) return;
      Held first = held.peekFirst();
      waits = holds(first, now);
      if ("voice".equals(waits)) {
        // Shown from a second on (a voice is usually ready by then), and counted up each second.
        fetching = (now - first.arrived) / 1000;
        if (fetching < 1 || fetching == first.voiceShown) return;
        first.voiceShown = fetching;
      } else if (waits != null) {
        if (waits.equals(first.toldWhy)) return;
        first.told = true;
        first.toldWhy = waits;
      } else if (first.told) {
        plays = "silence";
      }
    }
    if (waits != null) {
      switch (waits) {
        case "voice" -> {
          ongoing("Reply waits: its voice is being fetched (%1$d s)", fetching);
          return;
        }
        case "speaking" -> reason("Reply waits: you're talking");
        case "writing down" -> reason("Reply waits: checking whether you're done");
        case "sending" -> reason("Reply waits: your message is being sent");
        default -> reason("Reply waits: your turn (unsent words)");
      }
      readNext(); // It may play right away after all (it was told, so this doesn't repeat).
      return;
    }
    if (plays != null) reason("Reply plays: your message went");
    // A sound that hasn't counted as speech yet ends as noise (if it was you, talking on over the
    // reply interrupts it). Speech going on (a reply past its cap) ends as a part of your turn,
    // so the reset below doesn't lose it.
    segmenter.flush(segmenter.speaking());
    synchronized (this) {
      if (state != State.LISTENING || held.isEmpty() || holds(held.peekFirst(), clock.getAsLong()) != null) return;
      next = held.removeFirst();
      state = State.READING;
      reply = next.text;
      current = next;
      playing = false;
      // The microphone stays on: what it hears over the reply goes to the segmenter, afresh.
      segmenter.reset();
      dropStretch = false; // Whatever stretch was going on is gone.
      segmenter.bursts = false;
      token = ++reading;
      readingSince = clock.getAsLong();
      readingDeadline = readingSince + START_MS;
    }
    status = "reading";
    log("floor: chief, reading " + next.request);
    noteTurn();
    cue(Cue.REPLY);
    listener.changed();
    try {
      speaker.play(
          next.request,
          next.text,
          next.prepared,
          new Playback() {
            public void started(long durationMs) {
              synchronized (HandsFreeSession.this) {
                if (token != reading || state != State.READING) return;
                playing = true;
                readingDeadline = clock.getAsLong() + durationMs + OVERRUN_MS;
              }
              long now = clock.getAsLong();
              log(String.format(java.util.Locale.ROOT, "audio started (%.1f s) after %d ms", durationMs / 1000.0, now - readingSince));
              // Where the time went between the reply arriving and you hearing it.
              log(String.format(
                  java.util.Locale.ROOT,
                  "timing %s: voice %d ms, then waiting %d ms, then starting %d ms (%.1f s from arrival)",
                  next.request, next.readyAt - next.arrived, readingSince - next.readyAt, now - readingSince, (now - next.arrived) / 1000.0));
            }

            public void ended(boolean played) {
              finishReading(token, played, tr("the voice stopped"));
            }
          });
    } catch (RuntimeException ex) {
      log("the voice failed: " + ex.getMessage());
      finishReading(token, false, tr("the voice failed (%1$s)", ex.getMessage()));
    }
  }

  /**
   * Why the first waiting reply can't play now: it's your turn (yourTurn's why) or "voice" (its
   * audio isn't ready); null when it can.
   */
  private String holds(Held first, long now) {
    String yours = yourTurn(now);
    if (yours != null) return yours;
    return first.ready ? null : "voice";
  }

  /**
   * Is it your turn, and why: "unsent words", "speaking", "writing down" (a check of your turn)
   * or "sending" (Send pressed, or a message on its way); null when it isn't. Unsent words come
   * from live transcription while it works for this turn: words in the live text since your last
   * message (or kept from before), so loudness alone doesn't give you the turn; speech without
   * words yet holds it WORDLESS_MS at most. Without it (off, no key, failed) they come from your
   * unsent audio parts (and their words written down), and speech holds the turn while it goes on.
   * A sound that hasn't counted as speech (a cough, noise) never does. Unsent words Jev called
   * not done at your pause don't hold it while you stay quiet (heldBack): a reply plays.
   */
  String yourTurn(long now) {
    if (streaming()) {
      boolean words = !pending.isEmpty() || !turnPrefix.isEmpty();
      if (!words && segmenter.speaking() && now - stretchAt < WORDLESS_MS) return "speaking";
      if (transcribing.get() > 0) return "writing down";
      if (words && !heldBack) return "unsent words";
    } else {
      if (segmenter.speaking()) return "speaking";
      if (transcribing.get() > 0) return "writing down";
      if ((hasTurn() || !pending.isEmpty()) && !heldBack) return "unsent words";
    }
    if (outgoing.get() > 0 || sendPressed) return "sending";
    return null;
  }

  /** Whose turn it was when last logged: "yours (why)", "ours (a reply plays)" or "silence". */
  private String turnLogged = "silence";

  /**
   * Logs each change of turn, so the log shows why a reply waited: "turn: yours (unsent words)",
   * "turn: ours (a reply plays)", "turn: silence (sent)".
   */
  private void noteTurn() {
    if (state == State.ENDED) return;
    String why = state == State.READING ? null : yourTurn(clock.getAsLong());
    String now = state == State.READING ? "ours (a reply plays)" : why != null ? "yours (" + why + ")" : "silence";
    String was;
    synchronized (this) {
      if (turnLogged.equals(now)) return;
      was = turnLogged;
      turnLogged = now;
    }
    if (!now.equals("silence")) log("turn: " + now);
    else
      log("turn: silence (" + switch (was) {
            case "ours (a reply plays)" -> "the reply ended";
            case "yours (sending)" -> "sent";
            case "yours (writing down)" -> "nothing to send";
            case "yours (speaking)" -> "no words";
            default -> "your words were let go";
          } + ")");
  }

  /**
   * Reading number token ended (finished or given up): the floor is open again. A reply that didn't
   * play is noted in your next message as not heard.
   */
  private void finishReading(int token, boolean played, String why) {
    boolean heard, started;
    Held failed;
    synchronized (this) {
      if (token != reading || state != State.READING) return;
      started = playing;
      heard = played && playing;
      failed = heard ? null : current;
    }
    String note = null;
    Held again = null;
    if (heard) log("reply played to the end");
    else if (failed != null && started) {
      // Part of it was heard: not played again from its start; your next message says how far.
      int at = speaker.heardChars();
      note = heardUpTo(failed.text, at);
      log("reply stopped part-way (" + why + ", at character " + at + " of " + failed.text.length() + "): not played again; your next message says " + note);
      cue(Cue.FAILED);
      reason("Reply stopped part-way (%1$s): your next message tells the chief how far you heard", why);
    } else if (failed != null && failed.failures < RETRIES) {
      // Never given up at once: its voice is fetched again (the voice model, else Android's).
      again = new Held(failed.request, failed.text, clock.getAsLong());
      again.failures = failed.failures + 1;
      again.told = true;
      log("reply not played (" + why + "): trying again (" + again.failures + " of " + RETRIES + ")");
      reason("Reply couldn't be played (%1$s): trying again", why);
    } else {
      note = failed == null ? null : missed(failed.text);
      log("reply not heard: noted in your next message");
      cue(Cue.FAILED);
      reason("Reply couldn't be played: %1$s. Your next message tells the chief", why);
    }
    if (!endReading(token, note, true)) return;
    if (again != null) {
      synchronized (this) {
        held.addFirst(again);
      }
      prepare(again);
    }
    readNext();
  }

  /** A reply that couldn't be played is tried once more before your message notes it. */
  static final int RETRIES = 1;

  /**
   * Ends reading number token: note (if any) goes with your next message; tail mutes the
   * microphone a moment and forgets what it heard during the reply. Not when you talked over it:
   * then your speech goes on, as your turn. False if it had ended.
   */
  private boolean endReading(int token, String note, boolean tail) {
    synchronized (this) {
      if (token != reading || state != State.READING) return false;
      if (note != null) unheard.add(new Note(note));
      // You started talking over its last words: they're kept, the microphone stays on.
      if (tail && segmenter.candidate()) tail = false;
      current = null;
      activeAt = clock.getAsLong();
      mutedUntil = tail ? clock.getAsLong() + TAIL_MS : 0;
      tailHeard = false;
      if (tail) {
        segmenter.reset();
        dropStretch = false;
      }
      segmenter.bursts = true;
      reply = "";
      state = State.LISTENING;
    }
    status = "listening";
    log("floor: " + (tail ? "open" : "you"));
    noteTurn();
    if (tail) reason("Mic paused %1$.1f s after the reply (echo)", TAIL_MS / 1000.0);
    listener.changed();
    return true;
  }

  /**
   * The call ended with words of yours not sent yet: they go now (written down first, if they
   * weren't), on the outbox, so before the chief hears the call ended.
   */
  private void sendUnsent() {
    List<byte[]> audio;
    String prefix;
    synchronized (turnAudio) {
      if (turnAudio.isEmpty() && turnPrefix.isEmpty()) return;
      audio = new ArrayList<>(turnAudio);
      prefix = turnPrefix;
      turnAudio.clear();
      turnPrefix = "";
      turnVersion++;
    }
    log("ended with words not sent yet (" + audio.size() + " part(s)): they're sent before the call's end");
    outgoing.incrementAndGet();
    long queued = clock.getAsLong();
    Runnable last =
        () -> {
          String text = null;
          if (streaming())
            try {
              text = (prefix + " " + live.take(TAKE_MS)).trim();
            } catch (Exception ex) {
              liveFailed(ex.getMessage());
            }
          boolean missing = false;
          if (text == null) {
            Whole all = startWhole(audio);
            String parts;
            try {
              Written w = writeTurn(audio, "end");
              parts = (prefix + " " + w.text()).trim();
              if (w.parts() > 0) log(String.format(java.util.Locale.ROOT, "your last words: %d new part(s), %.1f s, written down in %d ms", w.parts(), w.seconds(), w.ms()));
            } catch (Exception ex) {
              // What was written down before still goes (and all of it, if the whole pass works).
              missing = true;
              parts = (prefix + " " + partsText(audio)).trim();
              log("some of your last words couldn't be written down (" + ex.getMessage() + "): what was goes");
            }
            text = toSend(parts, all, prefix);
          }
          if (text.isEmpty()) {
            log(missing ? "your last words couldn't be written down: not sent" : "your last words had no words in them: nothing sent");
            outgoing.decrementAndGet();
            return;
          }
          Handoff h = handOff(true);
          deliver(text + h.notes(), text, "end of the call", h, queued);
        };
    try {
      outbox.execute(last);
    } catch (java.util.concurrent.RejectedExecutionException ended) {
      new Thread(last, "last-words").start();
    }
  }

  /** Is there a turn of yours not sent yet (audio or words)? */
  private boolean hasTurn() {
    synchronized (turnAudio) {
      return !turnAudio.isEmpty() || !turnPrefix.isEmpty();
    }
  }

  /** A part of your turn: its audio, written down at the next check. */
  private void addPart(byte[] pcm) {
    synchronized (turnAudio) {
      turnAudio.add(pcm);
      turnVersion++;
    }
    takenByYou = true;
  }

  /**
   * Checks your turn, on the work queue: why is "pause" (a longer pause: written down, then Jev
   * asked whether you're done), "button" or "silence" (written down and sent, no question) or
   * "seed" (written down to show it).
   */
  private void check(String why) {
    transcribing.incrementAndGet();
    execute(() -> checkNow(why), () -> transcribing.decrementAndGet());
  }

  /** What a running check is doing: "writing", "asking" or "". */
  String checkStep() {
    return transcribing.get() == 0 ? "" : checkStep;
  }

  /**
   * Writes down audio with the speech model, at most writeTimeoutMs a try, twice: a request that
   * hangs is given up (and logged) rather than waited for.
   */
  private String writeDown(byte[] pcm, String why) throws Exception {
    byte[] wav = AudioFiles.wav(pcm);
    Exception last = null;
    for (int attempt = 1; attempt <= 2; attempt++) {
      java.util.concurrent.Future<String> f;
      try {
        f = speech.submit(() -> transcriber.transcribe(wav));
      } catch (java.util.concurrent.RejectedExecutionException ended) {
        return transcriber.transcribe(wav).trim(); // The call ended: your last words, here.
      }
      try {
        return f.get(writeTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).trim();
      } catch (java.util.concurrent.TimeoutException slow) {
        f.cancel(true);
        log(String.format(java.util.Locale.ROOT, "writing down (%s) took over %.0f s: %s", why, writeTimeoutMs / 1000.0, attempt == 1 ? "trying once more" : "given up"));
        if (attempt == 1) reason("Writing down took over %1$.0f s: trying once more", writeTimeoutMs / 1000.0);
        last = new java.io.IOException(tr("the speech model took over %1$.0f s", writeTimeoutMs / 1000.0));
      } catch (java.util.concurrent.ExecutionException ex) {
        throw ex.getCause() instanceof Exception e ? e : ex;
      }
    }
    throw last;
  }

  /**
   * Starts writing down these parts in one pass, in the background (or finds the pass already
   * started for them); null for a single part: its own pass is the whole.
   */
  private Whole startWhole(List<byte[]> audio) {
    if (audio.size() < 2) return null;
    Whole w;
    synchronized (turnAudio) {
      w = whole;
      if (w != null && w.parts.size() == audio.size()) {
        boolean same = true;
        for (int i = 0; i < audio.size() && same; i++) same = w.parts.get(i) == audio.get(i);
        if (same) return w;
      }
      w = new Whole(new ArrayList<>(audio), clock.getAsLong());
      whole = w;
    }
    Whole pass = w;
    java.util.concurrent.FutureTask<String> task =
        new java.util.concurrent.FutureTask<>(
            () -> {
              try {
                return writeDown(joined(pass.parts), "whole turn");
              } finally {
                pass.done = clock.getAsLong();
              }
            });
    pass.text = task;
    try {
      speech.execute(task);
    } catch (java.util.concurrent.RejectedExecutionException ended) {
      task.run(); // The call ended: your last words, here.
    }
    return pass;
  }

  /**
   * The text that goes: the whole turn's pass (prefix before it), waited for; without one (a
   * single part), or if it failed, the parts' text. The log says what it took and how many words
   * it changed.
   */
  private String toSend(String partsText, Whole w, String prefix) {
    if (w == null) return partsText;
    long start = clock.getAsLong();
    try {
      String all = (prefix + " " + w.text.get()).trim();
      log(String.format(java.util.Locale.ROOT, "whole turn (%d parts) written down in %d ms (waited %d ms for it); it changed %d of %d words of the parts' text",
          w.parts.size(), w.done - w.started, clock.getAsLong() - start, wordsChanged(partsText, all), HandsFree.normalize(partsText).split(" ").length));
      return all.isEmpty() ? partsText : all;
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
      return partsText;
    } catch (java.util.concurrent.ExecutionException ex) {
      Throwable why = ex.getCause() == null ? ex : ex.getCause();
      log("the whole turn couldn't be written down (" + why.getMessage() + "): the parts' text goes");
      return partsText;
    }
  }

  /** How many words differ between two texts (words added, dropped or changed), case and punctuation ignored. */
  static int wordsChanged(String a, String b) {
    String na = HandsFree.normalize(a), nb = HandsFree.normalize(b);
    String[] x = na.isEmpty() ? new String[0] : na.split(" "), y = nb.isEmpty() ? new String[0] : nb.split(" ");
    int[] d = new int[y.length + 1];
    for (int j = 0; j <= y.length; j++) d[j] = j;
    for (int i = 1; i <= x.length; i++) {
      int diagonal = d[0];
      d[0] = i;
      for (int j = 1; j <= y.length; j++) {
        int was = d[j];
        d[j] = Math.min(Math.min(d[j] + 1, d[j - 1] + 1), diagonal + (x[i - 1].equals(y[j - 1]) ? 0 : 1));
        diagonal = was;
      }
    }
    return d[y.length];
  }

  /** A turn's text, and what writing it down took: the parts that were new, their seconds, and how long. */
  record Written(String text, int parts, double seconds, long ms) {}

  /**
   * The text of a turn's parts: those written down before as they were, the new ones written down
   * now, together in one pass (usually there's one: the part that just ended). Each part ends in
   * a pause, so no word is cut between two.
   */
  private Written writeTurn(List<byte[]> audio, String why) throws Exception {
    List<byte[]> fresh = new ArrayList<>();
    synchronized (turnAudio) {
      for (byte[] p : audio) if (!written.containsKey(p)) fresh.add(p);
    }
    long ms = 0;
    int bytes = 0;
    if (!fresh.isEmpty()) {
      long start = clock.getAsLong();
      String t = writeDown(joined(fresh), why);
      ms = clock.getAsLong() - start;
      for (byte[] p : fresh) bytes += p.length;
      synchronized (turnAudio) {
        for (byte[] p : fresh) written.put(p, "");
        written.put(fresh.get(fresh.size() - 1), t);
      }
    }
    return new Written(partsText(audio), fresh.size(), bytes / (double) AudioFiles.BYTES_PER_SECOND, ms);
  }

  /** What these parts said, those written down so far, joined. */
  private String partsText(List<byte[]> audio) {
    StringBuilder text = new StringBuilder();
    synchronized (turnAudio) {
      for (byte[] p : audio) {
        String t = written.getOrDefault(p, "");
        if (!t.isEmpty()) text.append(text.length() == 0 ? "" : " ").append(t);
      }
    }
    return text.toString();
  }

  private void checkNow(String why) {
    boolean button = why.equals("button") || why.equals("rest") && sendAfterFlush;
    try {
      if (state == State.ENDED) return;
      if (why.endsWith(" phrase")) {
        phrase(why.equals("end phrase"));
        return;
      }
      if (why.equals("rest")) {
        takeRest();
        why = sendAfterFlush ? "button" : "pause"; // Send pressed during the stretch: it goes.
      }
      List<byte[]> audio;
      String prefix;
      int version;
      synchronized (turnAudio) {
        audio = new ArrayList<>(turnAudio);
        prefix = turnPrefix;
        version = turnVersion;
      }
      if (audio.isEmpty() && prefix.isEmpty()) {
        if (button) {
          sendAfterFlush = false;
          sendPressed = false;
          if (clock.getAsLong() - sentAt < 10_000) {
            log("send: your message had already gone");
            reason("Send: your message had already gone");
          } else reason("Nothing to send: no words were written down");
          listener.changed();
        }
        return;
      }
      long start = clock.getAsLong();
      writingSince = start;
      listener.changed();
      String text = prefix;
      int bytes = 0;
      for (byte[] p : audio) bytes += p.length;
      double seconds = bytes / (double) AudioFiles.BYTES_PER_SECOND;
      Written w = new Written("", 0, 0, 0);
      LiveText l = live;
      boolean streamed = streaming() && !why.equals("seed");
      if (streamed && why.equals("pause") && seconds >= STALL_SECONDS) {
        int words = HandsFree.normalize(l.text()).isEmpty() ? 0 : HandsFree.normalize(l.text()).split(" ").length;
        if (words < seconds * STALL_WORDS_PER_SECOND) {
          batchTurn = true;
          streamed = false;
          log(String.format(java.util.Locale.ROOT, "live text looks stuck (%d words for %.1f s of speech): this turn is written down from its audio", words, seconds));
          reason("Live transcription looks stuck (%1$d words for %2$.0f s): your words are written down instead", words, seconds);
          cue(Cue.FAILED);
        }
      }
      String liveText = null;
      boolean offLive = false;
      int liveWas = 0; // How much live text there was before writing down (offLive).
      if (streamed) {
        try {
          checkStep = "writing";
          liveText = why.equals("pause") ? l.text() : l.take(TAKE_MS);
          text = (prefix + " " + liveText).trim();
        } catch (Exception ex) {
          liveFailed(ex.getMessage());
          streamed = false;
        }
        if (streamed && liveText.isEmpty() && !audio.isEmpty()) {
          // Audio but no live words (yet): written down from the audio rather than dropped.
          log(String.format(java.util.Locale.ROOT, "no live text for %.1f s of your speech: written down from its audio", seconds));
          // Not silent: no preview this turn, and a send word in it waits for the pause.
          reason("Live transcription brought no words for %1$.1f s of your speech: written down from its audio", seconds);
          if (speechSinceWords.get() < NO_WORDS_MS) cue(Cue.FAILED); // Else it sounded already (noWords).
          streamed = false;
          offLive = why.equals("pause");
          liveWas = l.text().length();
          text = prefix;
        }
      }
      // What would be sent is written down whole meanwhile (not for the screen alone). Not for
      // parts live transcription missed at a pause: their words become the turn's (below).
      Whole all = why.equals("seed") || streamed || offLive ? null : startWhole(audio);
      if (!audio.isEmpty() && !streamed) {
        try {
          checkStep = "writing";
          w = writeTurn(audio, why);
          text = (prefix + " " + w.text()).trim();
        } catch (Exception ex) {
          status = "transcription failed: " + ex.getMessage();
          error = "Couldn't write down what you said: " + ex.getMessage();
          log(String.format(java.util.Locale.ROOT, "check (%s): %.1f s, transcription failed after %d ms: %s", why, seconds, clock.getAsLong() - start, ex.getMessage()));
          cue(Cue.FAILED);
          reason("Couldn't write down %1$.1f s of what you said: %2$s", seconds, ex.getMessage());
          // Kept: the next pause or Send tries again with it.
          sendAfterFlush = false;
          sendPressed = false;
          listener.changed();
          return;
        }
      }
      long took = clock.getAsLong() - start;
      if (state == State.ENDED) return; // The call's end sends it (end()).
      error = "";
      pending = text;
      listener.changed();
      log(String.format(java.util.Locale.ROOT, "check (%s): %d part(s), %.1f s; %s: \"%s\"", why, audio.size(), seconds,
          streamed ? (why.equals("pause") ? "live text" : "final live text in " + took + " ms")
              : w.parts() == 0 ? "written down already" : String.format(java.util.Locale.ROOT, "%d new (%.1f s) written down in %d ms", w.parts(), w.seconds(), w.ms()), text));
      if (took >= SLOW_WRITING_MS) reason("Writing down took %1$.1f s (the speech model was slow)", took / 1000.0);
      if (why.equals("seed")) {
        if (streaming())
          // Live transcription didn't hear it: its text starts the turn.
          synchronized (turnAudio) {
            turnAudio.removeAll(audio);
            written.keySet().retainAll(turnAudio);
            turnPrefix = text;
            turnVersion++;
          }
        return;
      }
      if (text.isEmpty() && all != null) text = toSend(text, all, prefix); // The parts had no words; the whole pass may.
      if (text.isEmpty()) {
        if (stale(version) && !button) return;
        reason("The speech model heard no words: your turn ends");
        giveUpTurn("nothing was said");
        return;
      }
      if (!why.equals("pause")) {
        if (!streamed) forgetLive();
        send(streamed ? text : toSend(text, all, prefix), why, audio.size(), prefix);
        return;
      }
      if (offLive && streaming()) {
        // Live transcription missed these parts (it connected late, or its words for them never
        // came): it only has what you say next, so their words start the turn, as words, before
        // it. Otherwise a send word after this pause would send the live text alone and drop them
        // (Philipp's call, 27 October 2026: "So it seems to be stuck right" and then "Over."
        // sent nothing).
        boolean wentOn = stale(version);
        synchronized (turnAudio) {
          turnAudio.removeAll(audio); // By identity: arrays don't override equals.
          written.keySet().retainAll(turnAudio);
          turnPrefix = (turnPrefix + " " + w.text()).trim();
          turnVersion++;
          prefix = turnPrefix;
          version = turnVersion;
        }
        // Its words that came late while they were written down would be there twice: dropped
        // (with what's still in flight of them). Not when nothing came: a drop then guesses the
        // next stretch, and would swallow what you say next. Not when you went on: what it has
        // now may be your new words.
        if (!wentOn && l.text().length() > liveWas) forgetLive();
        log("these words start your turn: live transcription didn't hear them" + (wentOn ? " (you went on: what it hears next follows them)" : ""));
        if (wentOn) { // The check queued for what you said since decides, about all of it.
          log("you went on talking: checked again at your next pause");
          return;
        }
        audio = List.of();
        streamed = true;
      }
      if (stale(version)) {
        log("you went on talking: checked again at your next pause");
        return;
      }
      boolean viaLive = streamed;
      String before = prefix;
      decide(
          text,
          audio.size(),
          before,
          version,
          t -> {
            if (viaLive) return finalLive(t, before);
            forgetLive();
            return toSend(t, all, before);
          });
    } finally {
      boolean again = false;
      if (why.endsWith(" phrase")) {
        keyword = false;
        again = phraseAgain;
        phraseAgain = false;
      }
      writingSince = 0;
      checkStep = "";
      transcribing.decrementAndGet();
      listener.changed();
      readNext();
      // A phrase said again while this one was checked: the live text now decides (a text Jev
      // just held back isn't asked again; one this check sent was taken, so it's empty).
      LiveText l = live;
      if (again && l != null) {
        String t = l.text();
        if (!t.isEmpty()) liveText(t);
      }
    }
  }

  /**
   * The live text ended with a send (or end) phrase. Jev is asked at once whether you're done (or
   * saying goodbye), while the short quiet after the phrase is waited for, so it adds little to
   * the wait; then the model is asked for its final text, and if that still ends with the phrase
   * the turn goes (or the call ends) without waiting for a pause. A phrase mid-sentence ("until
   * the period is over", "game over and …") sends nothing when you go on after it, or when Jev is
   * sure you're mid-sentence (PHRASE_HOLD_BELOW).
   */
  private void phrase(boolean end) {
    LiveText l = live;
    if (!streaming() || state != State.LISTENING) {
      log("the " + (end ? "end" : "send") + " phrase isn't checked: "
          + (state == State.READING ? "a reply started playing" : state != State.LISTENING ? "the call ended"
              : batchTurn ? "this turn is written down from its audio" : "live transcription stopped working")
          + "; your next pause decides");
      return;
    }
    // Asked at once: its answer comes while the quiet after the phrase is waited for. The send
    // word said twice or more in a row isn't asked about (null): it goes.
    String said = (turnPrefix + " " + l.text()).trim();
    Asked asked = !end && repeatedSend(said) ? null : ask(said);
    try {
      phrase(end, l, asked);
    } finally {
      if (asked != null) asked.cancel(); // You went on, or the call ended: its answer is no longer wanted.
    }
  }

  private void phrase(boolean end, LiveText l, Asked asked) {
    List<String> words = end ? endWords : sendWords;
    long need = end ? END_QUIET_MS : SEND_QUIET_MS, waited = System.nanoTime(), until = waited + PHRASE_WAIT_MS * 1_000_000;
    checkStep = "pause";
    listener.changed();
    while (segmenter.silentMs() < need) {
      if (state != State.LISTENING) return;
      if (HandsFree.endsWith(l.text(), words) == null) {
        log("you went on after the phrase: not an ending, the turn goes on");
        return;
      }
      if (System.nanoTime() > until) {
        // The live text still ends with it, but sound went on: noise counted as speech (the car)
        // looks like this, and so does talking on before its words came. Said on screen, with the
        // levels in the log.
        log(String.format(java.util.Locale.ROOT, "no pause after the phrase in %d ms (sound went on: level %.0f, background %.0f, gate ×%.1f): it's left to your next pause",
            PHRASE_WAIT_MS, meterLevel, segmenter.background(), gate));
        if (!end) reason("Heard %1$s, but sound went on after it (noise?): not sent. Pause a moment, or press Send", quote(phraseWord));
        return;
      }
      try {
        Thread.sleep(10);
      } catch (InterruptedException ex) {
        return;
      }
    }
    if (HandsFree.endsWith(l.text(), words) == null) {
      log("you went on after the phrase: not an ending, the turn goes on");
      return;
    }
    long quiet = (System.nanoTime() - waited) / 1_000_000;
    checkStep = "asking";
    listener.changed();
    Verdict v = asked == null ? null : asked.verdict();
    if (v != null) logVerdict(end ? "on the end phrase" : "on the send phrase", asked.ms(), v);
    if (state != State.LISTENING) return;
    if (asked == null) log("the send word said again and again: sent without asking Jev");
    else if (end) {
      // Hanging up by mistake is the worst: only when Jev confirms it's a goodbye. Without that
      // (no Jev, it failed, or not a goodbye) the turn goes on as it is, and your pause decides.
      String why =
          v == null ? "Jev couldn't confirm the goodbye (" + asked.failed() + ")"
              : v.end() >= END_AT ? null : String.format(java.util.Locale.ROOT, "Jev: not a goodbye (end the call %.2f)", v.end());
      if (why != null) {
        log(why + ": not ended, the turn goes on");
        return;
      }
    } else if (v != null && v.send() < PHRASE_HOLD_BELOW) {
      // "Over" as a word of the sentence ("until the period is over"), Jev clearly sure: the turn
      // goes on, and the same text doesn't ask again (the live text repeats it until you say more).
      // Say it again to send anyway.
      heldPhrase = HandsFree.normalize(asked.said);
      log(String.format(java.util.Locale.ROOT, "send phrase: Jev is sure you're mid-sentence (done %.2f): not sent, the turn goes on", v.send()));
      notDone(v);
      listener.changed();
      return;
    } else if (v == null && judge != null) {
      // The send word only asks: without Jev's clear "done" nothing goes. Your pause asks again.
      log("Jev couldn't tell whether you're done (" + asked.failed() + "): not sent, your pause asks again");
      reason("Couldn't ask whether you're done (%1$s): not sent; say %2$s again or press Send", asked.failed(), "\"" + sendWords.get(0) + "\"");
      listener.changed();
      return;
    } else if (v == null) log("no Jev: the send word decides");
    else if (v.send() < SEND_AT)
      log(String.format(java.util.Locale.ROOT, "send phrase: Jev isn't sure you're done (done %.2f), but you said the send word: sent", v.send()));
    long start = clock.getAsLong();
    writingSince = start;
    checkStep = "writing";
    listener.changed();
    String text;
    try {
      text = l.take(TAKE_MS);
    } catch (Exception ex) {
      liveFailed(ex.getMessage());
      return;
    }
    long took = clock.getAsLong() - start;
    String cut = HandsFree.endsWith(text, end ? endWords : sendWords);
    List<byte[]> audio;
    String prefix;
    synchronized (turnAudio) {
      audio = new ArrayList<>(turnAudio);
      prefix = turnPrefix;
    }
    String notEnding = cut == null ? String.format(java.util.Locale.ROOT, "the final text in %d ms doesn't end with the phrase (\"%s\")", took, tail(text)) : null;
    if (notEnding != null) {
      // Not an ending after all: the turn goes on. What was taken stays in it, as words: its
      // audio no longer needs writing down.
      synchronized (turnAudio) {
        turnAudio.subList(0, Math.min(audio.size(), turnAudio.size())).clear();
        written.keySet().retainAll(turnAudio);
        turnPrefix = (turnPrefix + " " + text).trim();
        turnVersion++;
      }
      dropStretch = segmenter.candidate(); // The stretch going on holds them too.
      log(notEnding + ": not " + (end ? "ended" : "sent") + ", the turn goes on");
      if (!end) reason("Heard %1$s, but the final words went on after it: not sent", quote(phraseWord));
      return;
    }
    // Its audio went with this message: the stretch going on now is part of it.
    dropStretch = segmenter.candidate();
    String rest = (prefix + " " + cut).trim();
    pending = rest;
    log(String.format(java.util.Locale.ROOT, "%s phrase: quiet %d ms after it, final text in %d ms (%d ms after the phrase was heard): \"%s\"", end ? "end" : "send", quiet, took, clock.getAsLong() - keywordAt, text));
    if (end) {
      log("end of the call");
      reason("Ending the call: you said goodbye");
      if (!rest.isEmpty()) send(rest, "end phrase", audio.size(), prefix);
      end();
      return;
    }
    if (rest.isEmpty()) {
      // The live text was just taken: nothing of it to drop (dropping would lose what you say next).
      if (clock.getAsLong() - sentAt < 10_000) {
        log("the send word came after your message went: nothing more to send");
        reason("Send word heard: your message had already gone");
        endTurn(false);
      } else {
        reason("Only the send word was heard: nothing to send");
        giveUpTurn("only the send word", false);
      }
      return;
    }
    reason("Sent: you said %1$s", "\"" + sendWords.get(0) + "\"");
    send(rest, "send phrase", audio.size(), prefix);
  }

  /** The longest Jev's answer on a phrase is waited for (Jev gives up after 3 s itself). */
  static volatile long phraseJudgeMs = 3500;

  /**
   * A send phrase Jev said wasn't the end, as the turn's text (normalized): the live text keeps
   * ending with it until you say more, and that doesn't ask again. "" none.
   */
  private volatile String heldPhrase = "";

  /** A question to Jev on its way (on the speech pool): its answer, or why there is none. */
  private final class Asked {
    final String said;
    private final java.util.concurrent.Future<Verdict> answer;
    private final long started = clock.getAsLong();
    private volatile long answered;
    private String failed = "no judge";

    Asked(String said) {
      this.said = said;
      java.util.concurrent.Future<Verdict> f = null;
      Judge j = judge;
      if (j != null)
        try {
          f = speech.submit(() -> {
            try {
              return j.judge(said);
            } finally {
              answered = clock.getAsLong();
            }
          });
        } catch (java.util.concurrent.RejectedExecutionException ended) {
          failed = "the call ended";
        }
      answer = f;
    }

    /** Waits for the answer (at most phraseJudgeMs); null when there's none (see failed()). */
    Verdict verdict() {
      if (answer == null) return null;
      try {
        return answer.get(phraseJudgeMs, java.util.concurrent.TimeUnit.MILLISECONDS);
      } catch (java.util.concurrent.TimeoutException slow) {
        failed = "no answer in " + phraseJudgeMs + " ms";
      } catch (java.util.concurrent.ExecutionException ex) {
        failed = String.valueOf((ex.getCause() == null ? ex : ex.getCause()).getMessage());
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        failed = "interrupted";
      } catch (java.util.concurrent.CancellationException ex) {
        failed = "cancelled";
      }
      return null;
    }

    String failed() {
      return failed;
    }

    long ms() {
      return (answered == 0 ? clock.getAsLong() : answered) - started;
    }

    void cancel() {
      if (answer != null) answer.cancel(true);
    }
  }

  private Asked ask(String said) {
    return new Asked(said);
  }

  /** Logs Jev's answer: what it chose, how sure it is, what it cost. */
  private void logVerdict(String on, long ms, Verdict v) {
    log(String.format(
        java.util.Locale.ROOT,
        "Jev%s in %d ms%s: %s (done %.2f, end the call %.2f)",
        on.isEmpty() ? "" : " " + on,
        ms,
        v.cost() == null ? "" : ", $" + v.cost().stripTrailingZeros().toPlainString(),
        v.choice(),
        v.send(),
        v.end()));
  }

  /** Says why your turn wasn't sent, from Jev's answer. */
  private void notDone(Verdict v) {
    int pct = (int) Math.round(100 * v.send());
    switch (v.choice()) {
      case "unfinished" -> reason("Not sent: you seem mid-sentence (%1$d%% done)", pct);
      case "more" -> reason("Not sent: you seem to have more to say (%1$d%% done)", pct);
      default -> reason("Not sent: not clearly done yet (%1$d%%)", pct);
    }
  }

  /**
   * The stretch with a send phrase went on after it and has ended: what live transcription heard
   * of it since then is your turn's (its audio went with the message, so the live text is all
   * there is of it). Taken into the turn as words; a pause check follows.
   */
  private void takeRest() {
    LiveText l = live;
    if (!streaming() || state != State.LISTENING || l.text().isEmpty()) return;
    String text;
    try {
      text = l.take(TAKE_MS);
    } catch (Exception ex) {
      liveFailed(ex.getMessage());
      return;
    }
    if (text.isEmpty()) return;
    synchronized (turnAudio) {
      turnPrefix = (turnPrefix + " " + text).trim();
      turnVersion++;
    }
    takenByYou = true;
    log("words after the phrase, in the same stretch: they're your turn's (\"" + tail(text) + "\")");
  }

  /** The live text's final version for sending (prefix before it), or what was checked if that fails. */
  private String finalLive(String checked, String prefix) {
    LiveText l = live;
    long start = clock.getAsLong();
    try {
      String t = (prefix + " " + l.take(TAKE_MS)).trim();
      log(String.format(java.util.Locale.ROOT, "final live text in %d ms", clock.getAsLong() - start));
      return t.isEmpty() ? checked : t;
    } catch (Exception ex) {
      liveFailed(ex.getMessage());
      return checked;
    }
  }

  /** A turn sent from its audio: what live transcription has of it is dropped. */
  private void forgetLive() {
    LiveText l = live;
    if (l != null && l.working()) l.discard();
  }

  private volatile boolean liveFailedSaid;

  /** Live transcription stopped working: said once, and from now on your words are written down. */
  void liveFailed(String why) {
    if (liveFailedSaid) return;
    liveFailedSaid = true;
    log("live transcription failed (" + why + "): your words are written down from their audio from now on");
    // On the work queue (it's heard on the connection's thread): before the next check of your turn.
    Runnable say =
        () -> {
          cue(Cue.FAILED);
          reason("Live transcription failed (%1$s): your words are written down instead", why);
        };
    execute(say, say);
  }

  /** Did the turn change (a new part) or are you talking again, since the check began? */
  private boolean stale(int version) {
    synchronized (turnAudio) {
      if (turnVersion != version) return true;
    }
    return talking();
  }

  /**
   * A sound you may be making is going on. Not while a reply plays: what the segmenter has then
   * hasn't stopped it, so it isn't you (yet).
   */
  private boolean talking() {
    return state != State.READING && segmenter.candidate();
  }

  /** The parts' audio in one, 0.3 s of silence between them. */
  private static byte[] joined(List<byte[]> parts) {
    java.io.ByteArrayOutputStream all = new java.io.ByteArrayOutputStream();
    byte[] gap = new byte[AudioFiles.BYTES_PER_SECOND * 3 / 10 & ~1];
    for (byte[] p : parts) {
      if (all.size() > 0) all.write(gap, 0, gap.length);
      all.write(p, 0, p.length);
    }
    return all.toByteArray();
  }

  /**
   * At a longer pause: asks the judge whether your turn is done, and acts: sends it, ends the
   * call, or listens on. Without a judge, or when it fails, the send and end words decide.
   */
  private void decide(String text, int parts, String prefix, int version, java.util.function.UnaryOperator<String> finalText) {
    Verdict v = null;
    long start = clock.getAsLong();
    String failed = null;
    checkStep = "asking";
    listener.changed();
    // The send word said twice or more in a row at the end: it goes, Jev isn't asked.
    boolean repeated = repeatedSend(text);
    if (judge != null && !repeated) {
      try {
        v = judge.judge(text);
      } catch (Exception ex) {
        failed = String.valueOf(ex.getMessage());
      }
    }
    long ms = clock.getAsLong() - start;
    if (repeated) log("the send word said again and again: sent without asking Jev");
    if (v != null) logVerdict("", ms, v);
    else if (failed != null) log("Jev failed after " + ms + " ms (" + failed + "): not sent, nothing ended");
    if (state == State.ENDED) return; // The call's end sent it.
    if (stale(version)) {
      log("you went on talking: checked again at your next pause");
      return;
    }
    String ended = HandsFree.endsWith(text, endWords), over = HandsFree.endsWith(text, sendWords);
    // Only Jev's clear answer sends or ends; the words decide only without Jev at all. Ending with
    // the send word, the turn goes unless Jev is sure you're mid-sentence; said twice, it goes.
    boolean noJev = judge == null;
    boolean end = v != null ? v.end() >= END_AT : noJev && ended != null;
    boolean done = repeated || (v != null ? v.send() >= (over != null ? PHRASE_HOLD_BELOW : SEND_AT) : noJev && over != null && !HandsFree.normalize(text).equals(heldPhrase));
    if (failed != null) reason("Couldn't ask whether you're done (%1$s): not sent; say %2$s or press Send", failed, sendWords.isEmpty() ? "Send" : "\"" + sendWords.get(0) + "\"");
    if (end) {
      log("end of the call");
      reason("Ending the call: you said goodbye");
      String sent = finalText.apply(text), cut = HandsFree.endsWith(sent, endWords);
      String rest = cut != null ? cut : ended != null && sent.equals(text) ? ended : sent;
      if (!rest.isEmpty()) send(rest, "end phrase", parts, prefix);
      end();
      return;
    }
    int pct = v == null ? 0 : (int) Math.round(100 * v.send());
    if (done) {
      // What goes is the whole pass's text: it decides what's left once the send word is off.
      String sent = finalText.apply(text), cut = HandsFree.endsWith(sent, sendWords);
      String rest = sent.equals(text) ? (over != null ? over : text) : cut != null ? cut : sent;
      if (stale(version)) { // You went on while it was written down whole: checked at your next pause.
        if (streaming())
          synchronized (turnAudio) { // Taken from live transcription: it starts the rest of the turn.
            turnAudio.subList(0, Math.min(parts, turnAudio.size())).clear();
            written.keySet().retainAll(turnAudio);
            turnPrefix = sent;
            turnVersion++;
          }
        log("you went on talking: checked again at your next pause");
        return;
      }
      // The live text was taken (or dropped) for the final text already: nothing more to drop.
      if (rest.isEmpty() && clock.getAsLong() - sentAt < 10_000) { // "Over" just after Send.
        log("the send word came after your message went: nothing more to send");
        reason("Send word heard: your message had already gone");
        endTurn(false);
        return;
      }
      if (rest.isEmpty()) { // Only "over".
        reason("Only the send word was heard: nothing to send");
        giveUpTurn("only the send word", false);
        return;
      }
      if (v == null || over != null && v.send() < SEND_AT) reason("Sent: you said %1$s", "\"" + sendWords.get(0) + "\"");
      else
        switch (v.choice()) {
          case "question" -> reason("Sent: you asked your question (%1$d%%)", pct);
          case "request" -> reason("Sent: you finished what you were saying (%1$d%%)", pct);
          default -> reason("Sent: you said you're done (%1$d%%)", pct);
        }
      send(rest, "jev", parts, prefix);
      return;
    }
    if (v == null) {
      if (failed == null) reason("Not sent: no %1$s yet", sendWords.isEmpty() ? "send word" : "\"" + sendWords.get(0) + "\"");
    } else notDone(v);
    // Jev says you're not done (or couldn't tell), and you're quiet: a reply waiting plays
    // meanwhile; your words wait for your next message. Without Jev a pause is only a pause.
    if (judge != null && !segmenter.speaking()) {
      heldBack = true;
      int waiting;
      synchronized (this) {
        waiting = held.size();
      }
      if (waiting > 0) log("not sent and you're quiet: the waiting reply plays; your words go with your next message");
    }
    listener.changed();
  }

  /** How long the current check (writing down, Jev) has been running, 0 when none is. */
  long writingMs() {
    long since = writingSince;
    return since == 0 || transcribing.get() == 0 ? 0 : Math.max(0, clock.getAsLong() - since);
  }

  /** Your turn is over without a message, quietly (nothing was lost). */
  private void endTurn() {
    endTurn(true);
  }

  /**
   * As above; forget drops what live transcription has of the turn. Not when its text was just
   * taken: a drop then would catch what you say next ("Over. Build it.").
   */
  private void endTurn(boolean forget) {
    pending = "";
    speechSinceWords.set(0); // The sound without words was this turn's.
    takenByYou = false;
    heldBack = false;
    batchTurn = false;
    heldPhrase = "";
    if (forget) forgetLive();
    sendAfterFlush = false;
    sendPressed = false;
    synchronized (turnAudio) {
      turnAudio.clear();
      written.clear();
      whole = null;
      turnPrefix = "";
      turnVersion++;
    }
    listener.changed();
  }

  /** Your turn came to nothing: the floor opens, and a waiting chief message is read. */
  private void giveUpTurn(String why) {
    giveUpTurn(why, true);
  }

  private void giveUpTurn(String why, boolean forget) {
    log("your turn ended without a message (" + why + ")");
    endTurn(forget);
  }

  /**
   * Your message goes, with a note for each reply that couldn't be played. Replies waiting
   * meanwhile stay waiting: they play at your next pause.
   */
  private void send(String text, String why, int parts, String prefix) {
    sendAfterFlush = false;
    sendPressed = false;
    batchTurn = false;
    if (state == State.ENDED) { // Ended while this was written down: the call's end sent these words.
      log("the call ended meanwhile: its end sends your words, not this check");
      return;
    }
    if (text.trim().isEmpty()) {
      reason("Nothing to send: no words were written down");
      giveUpTurn("empty");
      return;
    }
    // The turn is over: the parts written down go; what you said since starts your next turn.
    // Taken under the handover's lock: the call's end can't send them a second time.
    boolean[] more = new boolean[1];
    Handoff h =
        handOff(
            false,
            () -> {
              synchronized (turnAudio) {
                turnAudio.subList(0, Math.min(parts, turnAudio.size())).clear();
                written.keySet().retainAll(turnAudio); // ArrayList's contains: by identity for arrays.
                if (turnPrefix.equals(prefix)) turnPrefix = "";
                turnVersion++;
                more[0] = !turnAudio.isEmpty() || !turnPrefix.isEmpty();
              }
              if (more[0]) newTurn = true; // You went on talking: that's your next turn already.
            });
    if (h == null) {
      log("the call ended meanwhile: its end sends your words, not this check");
      return;
    }
    letGo();
    pending = "";
    speechSinceWords.set(0);
    takenByYou = more[0];
    heldPhrase = "";
    heldBack = false;
    outgoing.incrementAndGet();
    sentAt = clock.getAsLong();
    listener.changed();
    long queued = clock.getAsLong();
    Runnable delivery = () -> deliver(text.trim() + h.notes(), text, why, h, queued);
    try {
      outbox.execute(delivery);
    } catch (java.util.concurrent.RejectedExecutionException ended) {
      delivery.run(); // The call ended with this message (an end phrase): it still goes.
    }
  }

  /**
   * Delivers a message to the chief (on the outbox): in order, without holding up what you say
   * next. The log says how long it waited for earlier messages and how long bb took.
   */
  /** A message handed over: its number, its request ID and the notes it carries ("" none). */
  record Handoff(int number, String request, String notes) {}

  /**
   * Hands a message over (under the lock end() takes): numbers it, registers its request ID (a
   * reply to it is ours from now on, also before bb is done), and claims the notes no message on
   * its way carries yet. Null once the call ended, unless last (your last words, after the end).
   */
  private synchronized Handoff handOff(boolean last) {
    return handOff(last, () -> {});
  }

  /** As above; consume takes the message's words from your turn, at once with the handover. */
  private synchronized Handoff handOff(boolean last, Runnable consume) {
    if (state == State.ENDED && !last) return null;
    newTurn = false; // Your turn went; consume says if you went on meanwhile.
    handedAt = clock.getAsLong();
    consume.run();
    int number = ++handedOff;
    onTheWay.add(number);
    String request = sender.newRequest();
    requests.add(request);
    requestNumber.put(request, number);
    // Replies still waiting answer an earlier message: dropped now, and this message says so.
    for (java.util.Iterator<Held> it = held.iterator(); it.hasNext(); ) {
      Held w = it.next();
      if (w.answers >= number) continue;
      it.remove();
      w.dropped = true;
      letGo.add(w);
      if (w.note != null) unheard.add(new Note(w.note));
      else outdated.add(new Note(w.text));
    }
    StringBuilder notes = new StringBuilder();
    for (Note n : unheard)
      if (n.claimedBy == 0) {
        n.claimedBy = number;
        notes.append("\n\n").append(n.text);
      }
    List<String> missedNow = new ArrayList<>();
    for (Note n : outdated)
      if (n.claimedBy == 0) {
        n.claimedBy = number;
        missedNow.add(n.text);
      }
    if (!missedNow.isEmpty()) notes.append("\n\n").append(missed(missedNow));
    return new Handoff(number, request, notes.toString());
  }

  /** Replies handOff dropped, their voices to let go (outside its lock). */
  private final List<Held> letGo = new ArrayList<>();

  /** Lets go of the replies the last handover dropped, and says so. */
  private void letGo() {
    List<Held> dropped;
    synchronized (this) {
      dropped = new ArrayList<>(letGo);
      letGo.clear();
    }
    if (dropped.isEmpty()) return;
    for (Held w : dropped) {
      speaker.drop(w.prepared); // Let go when it comes, if it's still fetched.
      log("chief message " + w.request + " dropped unplayed (" + w.text.length() + " characters): your new message went; it says it didn't play");
    }
    if (dropped.size() == 1) reason("A reply wasn't played: your new message went. It tells the chief");
    else reason("%1$d replies weren't played: your new message went. It tells the chief", dropped.size());
    listener.changed();
  }

  /** The notes message number carries are free again: for the next message or the call's end. */
  private synchronized void unclaim(int number) {
    for (Note n : unheard) if (n.claimedBy == number) n.claimedBy = 0;
    for (Note n : outdated) if (n.claimedBy == number) n.claimedBy = 0;
  }

  /** How a message went: to bb (both), to the talker only (the chief missed it), or not at all. */
  enum Delivery {
    SENT,
    CHIEF_MISSED,
    FAILED
  }

  private Delivery deliver(String said, String text, String why, Handoff h, long queued) {
    long start = clock.getAsLong();
    int number = h.number();
    String request = h.request();
    try {
      PartlySent partly = null;
      try {
        sender.send(said, request);
      } catch (PartlySent p) {
        partly = p;
      }
      long done = clock.getAsLong();
      List<Held> old = new ArrayList<>();
      boolean chiefMissed = partly != null && partly.chiefMissed;
      synchronized (this) {
        working.put(request, new long[] {0, done});
        // Its notes reached the chief: done. The chief missed it: they go again.
        if (chiefMissed) unclaim(number);
        else {
          unheard.removeIf(n -> n.claimedBy == number);
          outdated.removeIf(n -> n.claimedBy == number);
        }
        onTheWay.remove(number);
        latestSent = Math.max(latestSent, number);
        activeAt = done;
        // Replies waiting that are for an earlier turn (answering an older message, or you're
        // talking again): never played; your next message, or the call's end, says so.
        for (java.util.Iterator<Held> it = held.iterator(); it.hasNext(); ) {
            Held w = it.next();
            if (!outdated(w)) continue;
            it.remove();
            w.dropped = true;
            old.add(w);
            if (w.note != null) unheard.add(new Note(w.note));
            else outdated.add(new Note(w.text));
          }
      }
      for (Held w : old) {
        speaker.drop(w.prepared); // Its voice no longer fetched on (let go when it comes).
        log("chief message " + w.request + " dropped unplayed (" + w.text.length() + " characters): it was waiting when your newer message " + request + " went; your next message says it didn't play");
      }
      if (old.size() == 1) reason("A reply wasn't played: you've said more since. Your next message tells the chief");
      else if (old.size() > 1) reason("%1$d replies weren't played: you've said more since. Your next message tells the chief", old.size());
      sent++;
      sentAt = done;
      deliveredAt = done;
      status = "sent (" + why + ")";
      error = "";
      log(String.format(java.util.Locale.ROOT, "sent %s (%s, %d characters; bb took %d ms, waited %d ms%s)", request, why, said.length(), done - start, start - queued,
          why.equals("send phrase") || why.equals("end phrase") ? "; " + (done - keywordAt) + " ms after the phrase was heard" : ""));
      cue(partly != null && partly.chiefMissed ? Cue.FAILED : Cue.SENT);
      if (partly != null) {
        if (partly.chiefMissed) reason("Sent to the talker only. The chief didn't get it: %1$s", partly.getMessage());
        else reason("Sent ✓ to the chief. The talker didn't get it: %1$s", partly.getMessage());
      } else switch (why) {
        case "jev", "send phrase" -> reason("Sent ✓");
        case "end phrase", "end of the call" -> reason("Sent ✓ before the call ended");
        default -> reason("Sent ✓ by the Send button");
      }
      return chiefMissed ? Delivery.CHIEF_MISSED : Delivery.SENT;
    } catch (Exception ex) {
      // Its notes go with the next message (or the call's end). Its request stays ours: nobody
      // got it, so no reply to it comes.
      synchronized (this) {
        onTheWay.remove(number);
        unclaim(number);
      }
      // Kept, before whatever you said since, so the next check or Send tries again.
      synchronized (turnAudio) {
        turnPrefix = (text + " " + turnPrefix).trim();
        turnVersion++;
      }
      pending = pending.isEmpty() ? text : text + " " + pending;
      takenByYou = true;
      status = "not sent: " + ex.getMessage();
      error = "Not sent: " + ex.getMessage();
      log(String.format(java.util.Locale.ROOT, "not sent (%s) after %d ms: %s", why, clock.getAsLong() - start, ex.getMessage()));
      cue(Cue.FAILED);
      reason("Not sent: %1$s. Your words are kept; send again", ex.getMessage());
      // After the call's end settled (a message still in bb then failed): its words go now.
      if (state == State.ENDED && settled && !leftoverRunning.get()) {
        log("a message failed after the call's end: its words are sent now");
        new Thread(() -> sendLeftover(clock.getAsLong() + 20_000), "leftover").start();
      }
      return Delivery.FAILED;
    } finally {
      outgoing.decrementAndGet();
      listener.changed();
      readNext();
    }
  }

  /** Waits (at most ms) until every message of the call is delivered: before telling the chief it ended. */
  boolean awaitDelivered(long ms) {
    try {
      return outbox.awaitTermination(ms, java.util.concurrent.TimeUnit.MILLISECONDS);
    } catch (InterruptedException ex) {
      return false;
    }
  }

  /** The note about replies that didn't play: one note per reply, each as missed(reply). */
  static String missed(List<String> replies) {
    StringBuilder all = new StringBuilder();
    for (String r : replies) all.append(all.length() == 0 ? "" : "\n").append(missed(r));
    return all.toString();
  }

  /**
   * The note in your message about a chief message you didn't hear at all (dropped when you
   * talked, or its voice failed): its first words, so the chief knows which.
   */
  static String missed(String reply) {
    return "[not played: \"" + firstWords(reply, MISSED_WORDS) + "\"]";
  }

  /** How many of a reply's first words a note quotes. */
  static final int MISSED_WORDS = 12;

  private static String firstWords(String text, int n) {
    String[] words = text.trim().split("\\s+");
    StringBuilder first = new StringBuilder();
    for (int i = 0; i < Math.min(n, words.length); i++) first.append(i == 0 ? "" : " ").append(words[i]);
    return first + (words.length > n ? "…" : "");
  }
}
