package app.driftdictation;

import android.content.SharedPreferences;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Hands-free mode: talking with the chief of staff without touching the phone. The phone listens
 * (voice activity, no model), transcribes each stretch of speech once when you pause, and sends the
 * message only when Jev says you're clearly done, asked when you say a send word ("over") or pause
 * a few seconds; an end word ends the mode, and so does a long silence (sending nothing). The chief's spoken replies are read aloud as call audio; talking over one stops it. These are the
 * settings and the pure parts: keyword matching and the voice activity segmenter.
 */
final class HandsFree {
  private HandsFree() {}

  /** Marks a message from hands-free mode for the chief (the dictate-and-delegate skill). */
  static final String TAG = "[hands-free]";

  /** What the chief hears when a call starts and ends: whether spoken messages are heard. */
  static final String CALL_STARTED = "[hands-free call started]", CALL_ENDED = "[hands-free call ended]";

  /** The chief's call start: it names the talker, if there is one, so the chief sends it its results. */
  /** The call start as the talker gets it: marked, so its skill is used. */
  static final String TALKER_CALL_STARTED = CALL_STARTED + " [you are the talker]";

  static String callStarted(String talker) {
    return talker.isEmpty() ? CALL_STARTED : CALL_STARTED + " [talker: " + talker + "]";
  }

  /** Prefs keys. */
  static final String SEND_WORDS = "hfSendWords",
      END_WORDS = "hfEndWords",
      PAUSE_MS = "hfEndOfTurnPauseMs",
      SILENCE_END_MS = "hfSilenceEndMs",
      VOICE = "hfVoice";

  /**
   * One English word or phrase per action by default; each setting may hold several,
   * comma-separated. "over" is also ordinary speech ("until the period is over"), so a send word
   * only sends once Jev says you're done (HandsFreeSession.phrase): a phrase nobody says in a
   * sentence ("over and out") took as long to say as asking Jev.
   */
  static final String DEFAULT_SEND = "over", DEFAULT_END = "end the call";
  /**
   * A pause this long ends a part of your turn: then the whole turn so far is written down and
   * Jev asked whether you're done; only a clear yes sends it (a new key: the old setting's 1.8 s
   * sent while Philipp was still thinking). A call with this long of silence, nobody talking and
   * no reply playing, ends without sending anything.
   */
  static final int DEFAULT_PAUSE_MS = 5000, DEFAULT_SILENCE_END_MS = 120_000;

  static List<String> words(SharedPreferences prefs, String key, String fallback) {
    return list(prefs.getString(key, fallback));
  }

  static String endSetting(SharedPreferences prefs) {
    return prefs.getString(END_WORDS, DEFAULT_END);
  }

  static int pauseMs(SharedPreferences prefs) {
    return Math.max(500, Math.min(15_000, prefs.getInt(PAUSE_MS, DEFAULT_PAUSE_MS)));
  }

  /** Prefs: quiet sounds for the key moments (on by default), and how long a voice model may take. */
  static final String SOUNDS = "hfSounds", VOICE_WAIT_MS = "hfVoiceWaitMs";

  /**
   * Prefs: live transcription (on by default; it needs the provider's key) and its model
   * (StreamingSpeech's choices), and the call audio kept open for the whole call (on by default).
   */
  static final String LIVE = "hfLive", LIVE_MODEL = "hfLiveModel", OPEN_AUDIO = "hfOpenAudio";

  /**
   * A voice model slower than this to send a reply's audio is given up for Android's voice:
   * Kokoro sometimes took 13 s. ElevenLabs answers in about half a second.
   */
  /** With a second request after 1 s (Voice), Android's voice is a rare last resort. */
  static final int DEFAULT_VOICE_WAIT_MS = 3000;

  static int voiceWaitMs(SharedPreferences prefs) {
    return Math.max(500, Math.min(60_000, prefs.getInt(VOICE_WAIT_MS, DEFAULT_VOICE_WAIT_MS)));
  }

  static int silenceEndMs(SharedPreferences prefs) {
    return Math.max(30_000, Math.min(3_600_000, prefs.getInt(SILENCE_END_MS, DEFAULT_SILENCE_END_MS)));
  }

  /** "over, send ,  senden" → [over, send, senden]: comma- or line-separated, blanks dropped. */
  static List<String> list(String setting) {
    List<String> out = new ArrayList<>();
    for (String w : (setting == null ? "" : setting).split("[,\\n]"))
      if (!normalize(w).isEmpty()) out.add(w.trim());
    return out;
  }

  // ------------------------------------------------------------------ keywords (unit-tested)

  /** Lower case, accents and punctuation gone, single spaces: "Das war's!" → "das wars". */
  static String normalize(String s) {
    String n = Normalizer.normalize(s == null ? "" : s, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
    n = n.toLowerCase(Locale.ROOT).replaceAll("['’`]", "").replaceAll("[^\\p{L}\\p{N}]+", " ");
    return n.trim();
  }

  /**
   * If the text ends with one of the words (a phrase of one or more words, as a whole word, case,
   * punctuation and accents ignored), the text without it; otherwise null. "Book the table. Over."
   * with [over] → "Book the table."
   */
  static String endsWith(String text, List<String> words) {
    String t = text == null ? "" : text;
    String norm = normalize(t);
    for (String w : words) {
      String nw = normalize(w);
      if (nw.isEmpty()) continue;
      if (norm.equals(nw) || norm.endsWith(" " + nw)) return cut(t, nw.split(" ").length);
    }
    return null;
  }

  /**
   * How many times in a row the text ends with one of the words: "…those options. Over. Over." with
   * [over] → 2, "…is over." → 1, none → 0. (The text sent keeps all but the last: "the period is
   * over. Over." keeps its sentence.)
   */
  static int endings(String text, List<String> words) {
    int n = 0;
    for (String t = endsWith(text, words); t != null; t = t.isEmpty() ? null : endsWith(t, words)) n++;
    return n;
  }

  /** The text without its last n words, and without the punctuation left before them. */
  private static String cut(String text, int n) {
    String t = text.replaceAll("[^\\p{L}\\p{N}]+$", "");
    for (int i = 0; i < n; i++) {
      t = t.replaceAll("[\\p{L}\\p{N}'’`]+$", "");
      if (i < n - 1) t = t.replaceAll("[^\\p{L}\\p{N}]+$", "");
    }
    return t.replaceAll("[\\s,;:–—-]+$", "").trim();
  }

  // ------------------------------------------------------------------ voice activity (unit-tested)

  /** Prefs: how much louder than the background your voice has to be, and how long you speak to take the floor. */
  static final String GATE = "hfGate", TAKE_MS = "hfTakeMs";

  static final double DEFAULT_GATE = 3.0;
  /**
   * Voice needed to take the turn, counted within the last TAKE_WINDOW_MS, so natural speech with
   * its little gaps counts ("Hi, can you hear me"); 1 s without gaps was too much for it.
   */
  static final int DEFAULT_TAKE_MS = 400;

  static double gate(SharedPreferences prefs) {
    return Math.max(1.5, Math.min(20, prefs.getFloat(GATE, (float) DEFAULT_GATE)));
  }

  static int takeMs(SharedPreferences prefs) {
    return Math.max(200, Math.min(5000, prefs.getInt(TAKE_MS, DEFAULT_TAKE_MS)));
  }

  /** Layer 1: is this frame speech at all? Today by its level; a model (Silero) can take its place. */
  interface Detector {
    boolean speech(byte[] frame, double level, double background);
  }

  /** The level-based detector: clearly above the background, and above a fixed minimum. */
  static final Detector LEVEL = (frame, level, background) -> level > Math.max(600, background * 2);

  /**
   * Splits a stream of 20 ms frames into stretches of your speech, in three layers: a frame counts
   * if the detector calls it speech (1) and it's at least gate times louder than the measured
   * background (2), so your voice close to the phone counts and distant voices or music mostly
   * don't. A stretch only counts once it holds minSpeechMs of such frames within the last
   * WINDOW_MS, or a burst of BURST_FRAMES at least BURST times louder than the background and
   * above BURST_MIN (3);
   * shorter ones are noise. It ends after pauseMs without speech, and keeps a little audio before
   * and after it. Silence in between never goes to the speech model.
   */
  static final class Segmenter {
    // Synchronized: the microphone feeds it while Send, the ticker and a barge-in use it too.
    static final int FRAME_MS = 20, PAD_MS = 300, WINDOW_MS = 1500, BURST_FRAMES = 5;
    static final double BURST = 10;
    /**
     * A burst also has to be at least this loud: with the background down at 50 (a quiet room,
     * 3.2.8 lets it fall fast), 10× is only 500, and a clatter or a door took the turn with it.
     * A short word close to the phone is far louder.
     */
    static final double BURST_MIN = 2500;
    /** The background is learned fast over the first quiet frames (the default is a guess), then slowly. */
    static final int LEARN_FRAMES = 50;

    /** How fast the background follows quieter frames down (half way in about 0.3 s). */
    static final double FALL = 0.05;

    interface Listener {
      /** A stretch of speech ended: its 16 kHz 16-bit mono PCM. */
      void segment(byte[] pcm);

      /** It just became speech (minSpeechMs reached): level and background, for the log. */
      default void started(double level, double background) {}

      /** It ended too short: noise, dropped. */
      default void noise(int speechMs, double level, double background) {}

      /**
       * Something like a voice went on for a while but never was gate times louder than the
       * background, so it didn't count (only reported, for the reasons on screen).
       */
      default void tooQuiet(int ms, double level, double background) {}
    }

    private final int pauseFrames, padFrames = PAD_MS / FRAME_MS;
    private final java.util.function.IntSupplier minSpeechMs;
    private final double gate;
    private final Detector detector;
    private final Listener listener;
    private final java.util.ArrayDeque<byte[]> before = new java.util.ArrayDeque<>();
    private java.io.ByteArrayOutputStream current;
    private int silentFrames, speechFrames, streak;
    private boolean confirmed;
    private double background = 300, peak;
    private long quietMs;
    // A stretch of sound that's too quiet to count (for the reasons only; it changes nothing).
    private int nearFrames, nearGap;
    private double nearPeak;
    /** Frame numbers of the recent loud frames (within the window), and frames seen in all. */
    private final java.util.ArrayDeque<Long> voiced = new java.util.ArrayDeque<>();
    private long frameNo;
    private int quietFrames;
    /** The audio of sounds that didn't count, since the last stretch that did: Send writes it down. */
    private java.io.ByteArrayOutputStream noiseAudio;
    private long noiseAt;

    Segmenter(int pauseMs, Listener listener) {
      this(pauseMs, () -> 200, DEFAULT_GATE, LEVEL, listener);
    }

    Segmenter(int pauseMs, java.util.function.IntSupplier minSpeechMs, double gate, Detector detector, Listener listener) {
      this.pauseFrames = Math.max(1, pauseMs / FRAME_MS);
      this.minSpeechMs = minSpeechMs;
      this.gate = gate;
      this.detector = detector;
      this.listener = listener;
    }

    /** Milliseconds since the last confirmed speech (or since the start). */
    synchronized long quietMs() {
      return quietMs;
    }

    /** Speech is going on (it reached minSpeechMs and hasn't ended yet). */
    synchronized boolean speaking() {
      return current != null && confirmed;
    }

    /** Something loud started but isn't confirmed speech yet. */
    synchronized boolean candidate() {
      return current != null;
    }

    synchronized double background() {
      return background;
    }

    /** The short-burst rule applies (not over a reply: a clatter mustn't stop it). */
    volatile boolean bursts = true;

    /**
     * Milliseconds since the last frame that counted as voice: within a stretch its silence so
     * far, else the quiet since the last one.
     */
    synchronized long silentMs() {
      return current == null ? quietMs : (long) silentFrames * FRAME_MS;
    }

    /** The audio of the stretch going on, from its start (with the little before it); empty if none. */
    synchronized byte[] stretchAudio() {
      return current == null ? new byte[0] : current.toByteArray();
    }

    /** Milliseconds of voice within the window: how much it took to count. */
    synchronized int voicedMs() {
      return voiced.size() * FRAME_MS;
    }

    /** Root mean square of a frame of 16-bit little-endian samples. */
    static double level(byte[] frame, int length) {
      double sum = 0;
      int n = length / 2;
      for (int i = 0; i + 1 < length; i += 2) {
        int s = (short) ((frame[i] & 0xff) | (frame[i + 1] << 8));
        sum += (double) s * s;
      }
      return n == 0 ? 0 : Math.sqrt(sum / n);
    }

    /** Feeds one 20 ms frame (640 bytes at 16 kHz). */
    synchronized void frame(byte[] frame) {
      double level = level(frame, frame.length);
      boolean loud = detector.speech(frame, level, background) && level >= background * gate;
      if (!loud) { // Follows the quiet frames only.
        // Fast at first, and fast down always: the noise at the start of a call (or any loud
        // spell) passes, and the background mustn't stay up with it. Slowly up.
        double a = quietFrames++ < LEARN_FRAMES ? 0.1 : level < background ? FALL : 0.005;
        background = background * (1 - a) + level * a;
      }
      frameNo++;
      if (loud) voiced.addLast(frameNo);
      long window = Math.max(WINDOW_MS, minSpeechMs.getAsInt() * 3 / 2) / FRAME_MS;
      while (!voiced.isEmpty() && voiced.peekFirst() <= frameNo - window) voiced.removeFirst();
      // Two loud frames in a row start a candidate, so a click doesn't.
      streak = loud ? streak + 1 : 0;
      nearly(loud, level);
      if (current == null) {
        before.addLast(frame.clone());
        while (before.size() > padFrames) before.removeFirst();
        quietMs += FRAME_MS;
        if (streak >= 2) {
          current = new java.io.ByteArrayOutputStream();
          for (byte[] b : before) current.write(b, 0, b.length);
          before.clear();
          speechFrames = streak;
          silentFrames = 0;
          confirmed = false;
          peak = level;
          confirm(level);
        }
        return;
      }
      current.write(frame, 0, frame.length);
      if (loud) {
        speechFrames++;
        silentFrames = 0;
        peak = Math.max(peak, level);
        confirm(level);
      } else {
        silentFrames++;
        if (confirmed) quietMs += FRAME_MS;
      }
      // Both end after the pause: a candidate's little gaps (between words) don't end it.
      if (silentFrames >= pauseFrames) finish();
    }

    /**
     * Notes sound that's clearly there (half again the background, above the detector's minimum)
     * but not loud enough to count: once it's gone for half a second after at least 0.3 s of it,
     * the listener hears it was too quiet. Thresholds stay as they are; this only reports.
     */
    private void nearly(boolean loud, double level) {
      boolean near = !loud && current == null && level > Math.max(600, background * 1.5);
      if (near) {
        nearFrames++;
        nearGap = 0;
        nearPeak = Math.max(nearPeak, level);
        return;
      }
      if (nearFrames == 0) return;
      if (loud || current != null) { // It became speech after all.
        nearFrames = 0;
        nearPeak = 0;
        return;
      }
      if (++nearGap < 500 / FRAME_MS) return;
      if (nearFrames * FRAME_MS >= 300) listener.tooQuiet(nearFrames * FRAME_MS, nearPeak, background);
      nearFrames = 0;
      nearGap = 0;
      nearPeak = 0;
    }

    double gate() {
      return gate;
    }

    /** Enough voice within the window, or a clearly loud burst. */
    private void confirm(double level) {
      if (confirmed) return;
      boolean enough = voiced.size() * FRAME_MS >= minSpeechMs.getAsInt();
      boolean burst = bursts && speechFrames >= BURST_FRAMES && peak >= Math.max(BURST_MIN, background * BURST);
      if (!enough && !burst) return;
      confirmed = true;
      quietMs = 0;
      listener.started(peak, background);
    }

    /** Ends the current stretch now (the mode ends). */
    void flush() {
      flush(false);
    }

    /**
     * Ends the current stretch now; with force (Send pressed) a stretch that didn't count yet is
     * written down anyway, unless it's only a click.
     */
    synchronized void flush(boolean force) {
      if (current == null) return;
      if (force && speechFrames >= 2) confirmed = true;
      finish();
    }

    /**
     * The sounds that didn't count as speech in the last ten seconds (since the last stretch that
     * did), or null: Send pressed with nothing written down writes them down. Taken once.
     */
    synchronized byte[] takeNoise() {
      java.io.ByteArrayOutputStream n = noiseAudio;
      noiseAudio = null;
      if (n == null || frameNo - noiseAt > 10_000 / FRAME_MS) return null;
      return n.toByteArray();
    }

    /** Forgets everything in progress (a reply was read meanwhile). */
    synchronized void reset() {
      current = null;
      before.clear();
      silentFrames = 0;
      speechFrames = 0;
      streak = 0;
      confirmed = false;
      quietMs = 0;
      nearFrames = nearGap = 0;
      nearPeak = 0;
      voiced.clear();
      noiseAudio = null;
    }

    private void finish() {
      byte[] all = current.toByteArray();
      int frameBytes = AudioFiles.RATE * 2 * FRAME_MS / 1000;
      // Keep only padFrames of the trailing silence.
      int keep = Math.max(0, all.length - Math.max(0, silentFrames - padFrames) * frameBytes);
      boolean real = confirmed;
      int ms = speechFrames * FRAME_MS;
      current = null;
      silentFrames = 0;
      speechFrames = 0;
      confirmed = false;
      voiced.clear();
      if (real) {
        noiseAudio = null;
        listener.segment(java.util.Arrays.copyOf(all, keep));
      } else {
        if (noiseAudio == null || frameNo - noiseAt > 10_000 / FRAME_MS) noiseAudio = new java.io.ByteArrayOutputStream();
        if (noiseAudio.size() < 15 * AudioFiles.BYTES_PER_SECOND) noiseAudio.write(all, 0, keep);
        noiseAt = frameNo;
        listener.noise(ms, peak, background);
      }
    }
  }
}
