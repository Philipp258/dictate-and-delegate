package app.driftdictation;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaPlayer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/**
 * Reads the chief's replies aloud in hands-free mode: a speech model through OpenRouter
 * (POST /audio/speech, MP3 or raw PCM, with the user's OpenRouter key), or Android's own voice
 * offline and as the fallback when OpenRouter fails. A reply plays while its audio still comes in
 * (VoiceStream: MP3 decoded as it arrives), from its first fifth of a second. Replies play as call
 * audio, so the phone's echo cancellation takes them out of the microphone.
 */
final class Voice {
  /**
   * A choice in Settings → Models & providers → Text-to-speech: the OpenRouter model and voice
   * ("" when the model needs none), or Android's; format is what's asked for, "mp3" or "pcm" (for
   * the models that only send raw samples).
   */
  record Choice(String id, String name, String note, String model, String voice, String pricePerCharacter, String format) {
    Choice(String id, String name, String note, String model, String voice, String pricePerCharacter) {
      this(id, name, note, model, voice, pricePerCharacter, "mp3");
    }

    String label() {
      return name + " · " + note;
    }

    /** For the log: "fish-audio/drama-3 (933563…)", the model and the voice it was asked for. */
    String tag() {
      return model.isEmpty() ? "Android's voice" : voice.isEmpty() ? model : model + " (" + voice + ")";
    }

    /** OpenRouter's list price, for when the real cost can't be looked up. */
    java.math.BigDecimal perCharacter() {
      return new java.math.BigDecimal(pricePerCharacter);
    }
  }

  static final String MAI = "microsoft/mai-voice-2.1-flash", VOXTRAL = "mistralai/voxtral-mini-tts-3-0",
      HEYGEN = "heygen/heygen-voice-1-turbo", GEMINI = "google/gemini-3.8-flash-lite-tts", FISH = "fish-audio/drama-3";

  static final Choice KOKORO = new Choice("kokoro", "Kokoro", "cheapest", "hexgrad/kokoro-82m", "af_heart", "0.00000062"),
      ELEVEN = new Choice("eleven", "ElevenLabs Flash v2.5", "best voice", "elevenlabs/eleven-flash-v2.5", "george", "0.00004"),
      ANDROID = new Choice("android", "Android's voice", "offline, free", "", "", "0");

  /**
   * Prices are OpenRouter's per character; Gemini's is per token (audio out at $6 a million), about
   * $10 a million characters. Each voice answered once in about 0.5 to 2 s (October 2026).
   */
  static final Choice[] CHOICES = {
    KOKORO,
    // Fish takes a voice's reference ID (fish.audio); without one each reply had another speaker.
    new Choice("fish-drama", "Fish Audio Drama 3 · Sarah", "fast, cheap", FISH, "933563129e564b19a115bedd57b7406a", "0.000002"),
    new Choice("fish-friendly", "Fish Audio Drama 3 · Friendly", "fast, cheap", FISH, "b545c585f631496c914815291da4e893", "0.000002"),
    new Choice("fish-adrian", "Fish Audio Drama 3 · Adrian", "fast, cheap", FISH, "bf322df2096a46f18c579d0baa36f41d", "0.000002"),
    new Choice("fish-ethan", "Fish Audio Drama 3 · Ethan", "fast, cheap", FISH, "536d3a5e000945adb7038665781a4aca", "0.000002"),
    new Choice("gemini-kore", "Gemini Flash Lite TTS · Kore", "cheap", GEMINI, "Kore", "0.00001", "pcm"),
    new Choice("gemini-puck", "Gemini Flash Lite TTS · Puck", "cheap", GEMINI, "Puck", "0.00001", "pcm"),
    new Choice("gemini-charon", "Gemini Flash Lite TTS · Charon", "cheap", GEMINI, "Charon", "0.00001", "pcm"),
    new Choice("gemini-aoede", "Gemini Flash Lite TTS · Aoede", "cheap", GEMINI, "Aoede", "0.00001", "pcm"),
    new Choice("heygen-bram", "HeyGen Voice 1 Turbo · Bram", "cheap", HEYGEN, "bram", "0.000004", "pcm"),
    new Choice("heygen-nadine", "HeyGen Voice 1 Turbo · Nadine", "cheap", HEYGEN, "nadine", "0.000004", "pcm"),
    new Choice("heygen-lucian", "HeyGen Voice 1 Turbo · Lucian", "cheap", HEYGEN, "lucian", "0.000004", "pcm"),
    new Choice("heygen-tabitha", "HeyGen Voice 1 Turbo · Tabitha", "cheap", HEYGEN, "tabitha", "0.000004", "pcm"),
    new Choice("voxtral-paul", "Voxtral Mini TTS · Paul", "fast", VOXTRAL, "en_paul_neutral", "0.000013"),
    new Choice("voxtral-paul-cheerful", "Voxtral Mini TTS · Paul, cheerful", "fast", VOXTRAL, "en_paul_cheerful", "0.000013"),
    new Choice("voxtral-jane", "Voxtral Mini TTS · Jane (British)", "fast", VOXTRAL, "gb_jane_neutral", "0.000013"),
    new Choice("voxtral-oliver", "Voxtral Mini TTS · Oliver (British)", "fast", VOXTRAL, "gb_oliver_neutral", "0.000013"),
    new Choice("mai-harper", "MAI-Voice 2.1 Flash · Harper", "fastest", MAI, "en-US-Harper:MAI-Voice-2.1-Flash", "0.000015"),
    new Choice("mai-iris", "MAI-Voice 2.1 Flash · Iris", "fastest", MAI, "en-US-Iris:MAI-Voice-2.1-Flash", "0.000015"),
    new Choice("mai-jasper", "MAI-Voice 2.1 Flash · Jasper", "fastest", MAI, "en-US-Jasper:MAI-Voice-2.1-Flash", "0.000015"),
    new Choice("mai-ethan", "MAI-Voice 2.1 Flash · Ethan", "fastest", MAI, "en-US-Ethan:MAI-Voice-2.1-Flash", "0.000015"),
    ELEVEN,
    ANDROID
  };

  /** The hands-free voice until another is chosen: the cheapest. */
  static final Choice DEFAULT = KOKORO;

  static Choice choice(String id) {
    for (Choice c : CHOICES) if (c.id().equals(id)) return c;
    return DEFAULT;
  }

  /** How a reading goes: audio started (and how long it will take), then it ended. */
  interface Playback {
    void started(long durationMs);

    /** Ended: played to the end, or failed or stopped (played false). */
    void ended(boolean played);
  }

  /**
   * A reply ready to play: its audio coming in (stream), or a whole file in a format that can't be
   * played as it comes (audio); neither: Android's voice reads the text. Also OpenRouter's
   * generation ID, and how it went: when the first byte came and when enough audio to start
   * playing (ms after asking, -1 when it didn't), why Android's voice reads it ("" when it
   * doesn't), and which request delivered it ("", or that a second was sent and which won).
   */
  record Prepared(File audio, VoiceStream stream, String generation, long firstByteMs, long playableMs, String fallback, String how) {
    Prepared(File audio, String generation) {
      this(audio, null, generation, -1, -1, "", "");
    }

    /** The voice model's audio is there to play. */
    boolean ready() {
      return audio != null || stream != null;
    }
  }

  /** A voice model's request failed: why, in a few words (HTTP status and what it said). */
  static final class Failed extends IOException {
    Failed(String why) {
      super(why);
    }
  }

  /**
   * A voice request that hasn't delivered after this long gets a second one in parallel; the first
   * to deliver plays, the other is dropped. OpenRouter picks the provider itself (routing is ignored
   * for speech), and its slow answers are single stalls, so a second request cuts them off.
   */
  static final long SECOND_REQUEST_MS = 1000;

  /**
   * One request for a reply's audio, running in its own thread: into its stream as it comes, or
   * (a format that can't be played as it comes) into a file, which the task returns.
   */
  private final class Attempt {
    final long[] first = {-1};
    final String[] generation = {""};
    final HttpURLConnection[] open = {null};
    final VoiceStream stream = new VoiceStream();
    final java.util.concurrent.FutureTask<File> task;

    Attempt(Choice choice, String text, long asked) {
      task =
          new java.util.concurrent.FutureTask<>(
              () -> {
                try {
                  return NetLog.request(
                      "TTS " + choice.model(), "POST", OpenRouter.base() + "/audio/speech",
                      net -> fetch(choice, text, generation, first, open, asked, stream, net));
                } catch (Exception ex) {
                  stream.fail(ex instanceof Failed ? ex.getMessage() : String.valueOf(ex.getMessage()), android.os.SystemClock.elapsedRealtime() - asked);
                  throw ex;
                }
              });
      stream.cancel = this::drop;
      new Thread(task, "voice-fetch").start();
    }

    /** It can start playing: enough audio is in, or the whole file. */
    boolean ready() {
      if (stream.failed() != null) return false;
      if (stream.playable()) return true;
      if (!task.isDone() || task.isCancelled()) return false;
      try {
        return task.get() != null;
      } catch (Exception ex) {
        return false;
      }
    }

    /** Given up: not downloaded on. */
    void drop() {
      HttpURLConnection c = open[0];
      if (c != null && !task.isDone()) c.disconnect();
      task.cancel(true);
    }
  }

  private final Context context;
  private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
  private MediaPlayer player;
  /** A streamed reply playing: its track and its audio (null when none plays). */
  private AudioTrack track;
  private VoiceStream streamed;
  /**
   * How fast the replies are read, in characters a second: what the last whole reply took (the
   * voices measured 15 to 20), and until one came in a rate below any of them, so [heard up to]
   * never quotes words not heard yet.
   */
  static final double SLOWEST_CHARS_PER_SECOND = 10;

  private volatile double charsPerSecond = SLOWEST_CHARS_PER_SECOND;
  /** The stream being played or about to be (cancelled when the reading stops). */
  private volatile VoiceStream playingStream;
  /** How far a streamed reply got when it ended early (-1: it didn't): heardChars says it after. */
  private volatile int heardAtEnd = -1;
  private volatile TextToSpeech tts;
  private Playback current;
  /** The reply being read; for Android's voice, how far it got. */
  private volatile String text = "";
  private volatile int ttsAt;
  private int replies;
  /**
   * Android's voice: one engine for the whole call, started at once (it takes a moment to be
   * ready); what's spoken before then waits for it. Its callbacks only act on the utterance being
   * read now (utterance), so a stopped or earlier one can never end the next reply.
   */
  private boolean ttsReady, ttsFailed;
  private final java.util.List<Runnable> whenReady = new java.util.ArrayList<>();
  private volatile String utterance = "";
  private int utterances;
  /** Hears once how Android's voice started: "" ready, else why not (some phones have none). */
  volatile java.util.function.Consumer<String> androidStatus = s -> {};
  /** Android's voice couldn't start on this phone (no engine, or it failed). */
  volatile boolean androidUnavailable;

  /** Ends the current reading once, on the main thread. */
  private void finished(boolean played) {
    Playback p;
    synchronized (this) {
      p = current;
      current = null;
    }
    if (p != null)
      main.post(
          () -> {
            focus(false);
            p.ended(played);
          });
  }

  Voice(Context context) {
    this.context = context.getApplicationContext();
    main.post(this::startAndroid);
  }

  /** Starts Android's voice (on the main thread): English, on the replies' audio route. */
  private void startAndroid() {
    if (tts != null) return;
    tts =
        new TextToSpeech(
            context,
            status ->
                main.post(
                    () -> {
                      TextToSpeech t = tts;
                      if (t == null) return; // Shut down meanwhile.
                      if (status == TextToSpeech.SUCCESS) {
                        // The replies are English (whatever the phone's language is).
                        int lang = t.setLanguage(Locale.US);
                        if (lang < TextToSpeech.LANG_AVAILABLE) t.setLanguage(Locale.getDefault());
                        t.setAudioAttributes(attributes());
                        t.setOnUtteranceProgressListener(listener);
                        ttsReady = true;
                        androidUnavailable = false;
                        androidStatus.accept(
                            "ready: " + t.getDefaultEngine() + (lang < TextToSpeech.LANG_AVAILABLE ? ", no English voice (" + Locale.getDefault() + " instead)" : ", English"));
                      } else {
                        ttsFailed = true;
                        androidUnavailable = true;
                        String engine = t.getDefaultEngine();
                        androidStatus.accept("not available (" + (engine == null || engine.isEmpty() ? "no text-to-speech engine on this phone" : engine + " failed to start") + ")");
                      }
                      java.util.List<Runnable> waiting = new java.util.ArrayList<>(whenReady);
                      whenReady.clear();
                      for (Runnable r : waiting) r.run();
                    }));
  }

  /** Android's voice telling how the utterance being read now goes; others are ignored. */
  private final UtteranceProgressListener listener =
      new UtteranceProgressListener() {
        public void onStart(String id) {
          if (!id.equals(utterance) || !id.startsWith("reply")) return;
          Playback p;
          synchronized (Voice.this) {
            p = current;
          }
          String t = text;
          if (p != null) main.post(() -> p.started(t.length() * 1000L / 15));
        }

        public void onRangeStart(String id, int start, int end, int frame) {
          if (id.equals(utterance)) ttsAt = start; // Words as they're spoken: how far you heard.
        }

        public void onDone(String id) {
          if (id.equals(utterance)) finished(true);
        }

        public void onError(String id) {
          onError(id, -1);
        }

        public void onError(String id, int code) {
          if (!id.equals(utterance)) return;
          androidFailed("couldn't speak (error " + code + ")");
          finished(false);
        }

        public void onStop(String id, boolean interrupted) {
          if (id.equals(utterance)) finished(false);
        }
      };

  /** Android's voice failed on this phone: from now on the voice model is waited for instead. */
  private void androidFailed(String why) {
    if (!androidUnavailable) androidStatus.accept(why + ": the voice model is waited for from now on");
    androidUnavailable = true;
  }

  /** Runs r once Android's voice is ready or failed to start (on the main thread). */
  private void whenAndroidReady(Runnable r) {
    if (ttsReady) {
      r.run();
      return;
    }
    whenReady.add(r);
    if (ttsFailed && tts != null) { // It failed to start before: once more.
      tts.shutdown();
      tts = null;
      ttsFailed = false;
    }
    startAndroid();
  }

  /** The request for OpenRouter's speech endpoint. */
  static JSONObject body(Choice c, String text) throws Exception {
    JSONObject b = new JSONObject().put("model", c.model()).put("input", text).put("response_format", c.format());
    if (!c.voice().isEmpty()) b.put("voice", c.voice());
    return b;
  }

  /** "audio/pcm;rate=44100;channels=1" → {44100, 1}; null if it isn't PCM with a rate. */
  static int[] pcmFormat(String contentType) {
    if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("audio/pcm")) return null;
    int rate = 0, channels = 1;
    for (String part : contentType.split(";")) {
      String[] kv = part.trim().split("=", 2);
      if (kv.length < 2) continue;
      try {
        if (kv[0].trim().equalsIgnoreCase("rate")) rate = Integer.parseInt(kv[1].trim());
        else if (kv[0].trim().equalsIgnoreCase("channels")) channels = Integer.parseInt(kv[1].trim());
      } catch (NumberFormatException ignored) {
        return null;
      }
    }
    return rate <= 0 || channels <= 0 ? null : new int[] {rate, channels};
  }

  /** The 44-byte header that makes 16-bit little-endian PCM a WAV file of that many bytes. */
  static byte[] wavHeader(int rate, int channels, long pcmBytes) {
    java.nio.ByteBuffer h = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
    h.put(new byte[] {'R', 'I', 'F', 'F'})
        .putInt((int) (36 + pcmBytes))
        .put(new byte[] {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '})
        .putInt(16)
        .putShort((short) 1)
        .putShort((short) channels)
        .putInt(rate)
        .putInt(rate * channels * 2)
        .putShort((short) (channels * 2))
        .putShort((short) 16)
        .put(new byte[] {'d', 'a', 't', 'a'})
        .putInt((int) pcmBytes);
    return h.array();
  }

  /**
   * Why a request failed, in a few words: "HTTP 503: <what it said>", its JSON error message if
   * it sent one, cut to a line.
   */
  static String httpError(int status, String body) {
    String said = body == null ? "" : body.trim();
    try {
      JSONObject j = new JSONObject(said);
      JSONObject e = j.optJSONObject("error");
      String m = e != null ? e.optString("message") : j.optString("message");
      if (!m.isEmpty()) said = m;
    } catch (Exception notJson) {
      /* As it came. */
    }
    said = said.replaceAll("\\s+", " ");
    if (said.length() > 160) said = said.substring(0, 160) + "…";
    return "HTTP " + status + (said.isEmpty() ? "" : ": " + said);
  }

  /**
   * Gets a reply ready: fetches its audio from OpenRouter (network: not on the main thread). Never
   * throws: without audio (Android's voice chosen, or OpenRouter failed) Android's voice reads it.
   */
  Prepared prepare(Choice choice, String text) {
    return prepare(choice, text, 0);
  }

  /**
   * As above, but when there isn't enough audio to start playing within waitMs (0: no limit) the
   * request is given up and Android's voice reads the reply, so a slow voice model never keeps you
   * waiting. The audio goes on coming in while it plays.
   */
  Prepared prepare(Choice choice, String text, long waitMs) {
    if (choice.model().isEmpty()) return new Prepared(null, "");
    long asked = android.os.SystemClock.elapsedRealtime();
    long deadline = waitMs > 0 ? asked + waitMs : Long.MAX_VALUE;
    Attempt a = new Attempt(choice, text, asked), b = null;
    int sent = 1;
    Throwable failed = null;
    try {
      while (true) {
        long now = android.os.SystemClock.elapsedRealtime();
        Attempt ready = a != null && a.ready() ? a : b != null && b.ready() ? b : null;
        if (ready != null) {
          Attempt other = ready == a ? b : a;
          if (other != null) other.drop();
          String how = b == null ? "" : ready == b ? "second request won (sent after " + SECOND_REQUEST_MS + " ms)" : "first request won (a second was sent after " + SECOND_REQUEST_MS + " ms)";
          File file = ready.task.isDone() ? ready.task.get() : null;
          if (file == null) learn(ready.stream, text);
          return new Prepared(file, file == null ? ready.stream : null, ready.generation[0], ready.first[0], now - asked, "", how);
        }
        Attempt done = a != null && a.task.isDone() ? a : b != null && b.task.isDone() ? b : null;
        if (done != null) {
          try {
            done.task.get();
            throw new java.util.concurrent.ExecutionException(new Failed("it sent no audio"));
          } catch (java.util.concurrent.CancellationException ex) {
            failed = ex;
            if (done == a) a = null;
            else b = null;
            if (a == null && b == null) break;
          } catch (java.util.concurrent.ExecutionException ex) {
            failed = ex.getCause() == null ? ex : ex.getCause();
            // One request failed: the other may still deliver; if there's none yet, send one.
            if (done == a) a = null;
            else b = null;
            if (a == null && b == null) {
              if (now < deadline && sent < 3) {
                a = new Attempt(choice, text, asked);
                sent++;
              } else break;
            }
          }
        } else if (b == null && a != null && sent < 3 && now - asked >= SECOND_REQUEST_MS && now < deadline) {
          b = new Attempt(choice, text, asked);
          sent++;
        } else if (now >= deadline) {
          if (a != null) a.drop();
          if (b != null) b.drop();
          boolean answered = a != null && a.first[0] >= 0 || b != null && b.first[0] >= 0;
          return new Prepared(null, null, "", a == null ? -1 : a.first[0], -1,
              String.format(Locale.ROOT, answered ? "%1$s: its audio didn't start coming in %2$.1f s" : "%1$s: no answer in %2$.1f s", choice.name(), waitMs / 1000.0),
              b == null ? "" : "two requests");
        }
        Thread.sleep(25);
      }
    } catch (java.util.concurrent.ExecutionException ex) {
      failed = ex.getCause(); // Can't be: a ready attempt's file was there.
    } catch (InterruptedException ex) {
      // The call ended: not downloaded on.
      if (a != null) a.drop();
      if (b != null) b.drop();
      Thread.currentThread().interrupt();
      failed = ex;
    }
    android.util.Log.w("Voice", "OpenRouter's voice failed, Android's reads instead", failed);
    return new Prepared(null, null, "", -1, -1, choice.name() + ": " + (failed instanceof Failed ? failed.getMessage() : String.valueOf(failed == null ? "failed" : failed.getMessage())), "");
  }

  /**
   * Opens the connection to OpenRouter before the first reply (in the background), so that reply
   * doesn't wait for it; later ones reuse it (keep-alive).
   */
  void warm() {
    new Thread(
            () -> {
              try {
                NetLog.request(
                    "TTS warm-up",
                    "GET",
                    OpenRouter.base() + "/key",
                    net -> {
                      HttpURLConnection c = (HttpURLConnection) new URL(OpenRouter.base() + "/key").openConnection();
                      c.setConnectTimeout(10_000);
                      c.setReadTimeout(10_000);
                      c.setRequestProperty("Authorization", "Bearer " + new Vault(context).get(OpenRouter.KEY));
                      net.status(c.getResponseCode());
                      try (InputStream in = c.getResponseCode() >= 300 ? c.getErrorStream() : c.getInputStream()) {
                        if (in != null) net.received(in.readAllBytes().length); // Read to the end: the connection stays open for reuse.
                      }
                      return null;
                    });
              } catch (Exception ignored) {
                /* Only a head start. */
              }
            },
            "voice-warm")
        .start();
  }

  /** Plays a prepared reply; the playback hears when audio starts and when it ends. */
  void play(Prepared prepared, String text, Playback playback) {
    synchronized (this) {
      current = playback;
    }
    this.text = text;
    ttsAt = 0;
    heardAtEnd = -1;
    playingStream = prepared.stream();
    focus(true);
    CallTrack call = callTrack;
    if (call != null && prepared.stream() != null) { // The call's audio is open: no warm-up.
      call.play(prepared.stream(), text, playback);
      return;
    }
    new Thread(
            () -> {
              AudioTrack warm = warmUp();
              synchronized (this) {
                if (current != playback) { // Stopped meanwhile.
                  if (warm != null) warm.release();
                  if (prepared.stream() != null) prepared.stream().cancel.run();
                  return;
                }
              }
              // The silence keeps the route awake until the reply has started.
              main.postDelayed(
                  () -> {
                    if (warm != null) warm.release();
                  },
                  1500);
              if (prepared.stream() != null) playStream(prepared.stream(), text, playback);
              else if (prepared.audio() == null) speakAndroid(text, playback);
              else
                main.post(
                    () -> {
                      synchronized (this) {
                        if (current != playback) return; // Stopped meanwhile.
                      }
                      try {
                        play(prepared.audio(), playback);
                      } catch (Exception ex) {
                        release();
                        prepared.audio().delete();
                        speakAndroid(text, playback); // The audio doesn't play: Android's voice instead.
                      }
                    });
            },
            "voice-warm-up")
        .start();
  }

  /** Silence played first, so the route is awake for the first word. */
  static final int WARM_MS = 500;

  /**
   * The replies' audio: call audio, so the phone's echo cancellation removes it from the
   * microphone (it only takes out what plays on the communication path) and you can talk over a
   * reply. Also the hands-free media session's, so the volume keys change its volume (the call
   * volume). The sounds play on it too.
   */
  static AudioAttributes attributes() {
    return new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();
  }

  /**
   * Half a second of silence on the voice's route. Right after the microphone, and over Bluetooth
   * especially, the route wakes up with the first sound and swallows it: this way that's silence,
   * not the reply's first words. Returns the track to release once the reply plays (or null).
   */
  private AudioTrack warmUp() {
    try {
      int rate = 24_000, bytes = rate * 2 * 2; // Two seconds of room; half a second is played first.
      AudioTrack t =
          new AudioTrack.Builder()
              .setAudioAttributes(attributes())
              .setAudioFormat(
                  new AudioFormat.Builder()
                      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                      .setSampleRate(rate)
                      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                      .build())
              .setTransferMode(AudioTrack.MODE_STATIC)
              .setBufferSizeInBytes(bytes)
              .build();
      t.write(new byte[bytes], 0, bytes);
      t.play();
      Thread.sleep(WARM_MS);
      return t;
    } catch (Exception ex) {
      return null; // No warm-up: the reply plays anyway.
    }
  }

  private AudioFocusRequest focusRequest;

  /** While a reply plays, other sound (music, navigation) gets quieter. */
  private void focus(boolean on) {
    AudioManager audio = context.getSystemService(AudioManager.class);
    if (on && focusRequest == null) {
      focusRequest =
          new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
              .setAudioAttributes(attributes())
              .build();
      audio.requestAudioFocus(focusRequest);
    } else if (!on && focusRequest != null) {
      audio.abandonAudioFocusRequest(focusRequest);
      focusRequest = null;
    }
  }

  /** Learns how fast the voice reads once a reply's audio is all in. */
  private void learn(VoiceStream s, String text) {
    s.whenDone(
        done -> {
          if (done.failed() == null && done.audioMs() > 2000) charsPerSecond = text.length() * 1000.0 / done.audioMs();
        });
  }

  /** How long a streamed reply will take: its length once all of it is in, else a guess. */
  private long estimatedMs(VoiceStream s, String text) {
    return s.complete() ? s.audioMs() : Math.max(s.audioMs(), (long) (text.length() * 1000 / charsPerSecond));
  }

  /** A stream that stops coming for this long while it plays is given up. */
  static final long STALL_MS = 5000;

  /**
   * Plays a reply while its audio comes in (on its own thread), on a call-audio track: written as
   * it comes, so it starts with the first fifth of a second. A stream that stops coming (STALL_MS)
   * or fails plays what came, then ends unplayed.
   */
  private void playStream(VoiceStream s, String text, Playback playback) {
    int rate = s.rate(), channels = s.channels(), frameBytes = 2 * channels;
    AudioTrack t;
    try {
      AudioFormat format =
          new AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(rate)
              .setChannelMask(channels == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO)
              .build();
      t =
          new AudioTrack.Builder()
              .setAudioAttributes(attributes())
              .setAudioFormat(format)
              .setTransferMode(AudioTrack.MODE_STREAM)
              .setBufferSizeInBytes(Math.max(AudioTrack.getMinBufferSize(rate, format.getChannelMask(), AudioFormat.ENCODING_PCM_16BIT), rate * frameBytes / 2))
              .build();
      // It starts with what's written first, not once its half second of room is full.
      try {
        t.setStartThresholdInFrames(Math.min(t.getBufferSizeInFrames(), rate / 20));
      } catch (Exception ignored) {
        /* As it is. */
      }
    } catch (Exception ex) {
      android.util.Log.w("Voice", "no track for the reply", ex);
      s.cancel.run();
      speakAndroid(text, playback); // It doesn't play: Android's voice instead.
      return;
    }
    synchronized (this) {
      if (current != playback) { // Stopped meanwhile.
        t.release();
        s.cancel.run();
        return;
      }
      track = t;
      streamed = s;
    }
    byte[] buffer = new byte[rate * frameBytes / 10];
    int at = 0;
    boolean started = false, played = false;
    long stalled = -1;
    // Its first sound: told when the track's head passes its first frame (or, should that not be
    // said, when the position shows it).
    java.util.concurrent.atomic.AtomicBoolean sounded = new java.util.concurrent.atomic.AtomicBoolean();
    Runnable out =
        () -> {
          if (!sounded.compareAndSet(false, true) || !stillPlaying(playback)) return;
          long ms = estimatedMs(s, text);
          main.post(() -> playback.started(ms));
        };
    t.setPlaybackPositionUpdateListener(
        new AudioTrack.OnPlaybackPositionUpdateListener() {
          public void onMarkerReached(AudioTrack track) {
            out.run();
          }

          public void onPeriodicNotification(AudioTrack track) {}
        },
        main);
    t.setNotificationMarkerPosition(1);
    try {
      while (stillPlaying(playback)) {
        int n = s.read(at, buffer, 100);
        if (n < 0) {
          played = s.failed() == null;
          break;
        }
        if (started && t.getPlaybackHeadPosition() > 0) out.run();
        long now = android.os.SystemClock.elapsedRealtime();
        if (n == 0) {
          if (stalled < 0) stalled = now;
          else if (now - stalled >= STALL_MS) {
            android.util.Log.w("Voice", "the reply's audio stopped coming");
            s.cancel.run();
            s.fail("its audio stopped coming for " + STALL_MS / 1000 + " s", -1);
            break;
          }
          continue;
        }
        stalled = -1;
        if (t.write(buffer, 0, n, AudioTrack.WRITE_BLOCKING) < 0) break;
        at += n;
        if (!started) {
          t.play();
          started = true;
        }
      }
      if (started) out.run(); // Shorter than a write: out by now.
      // What was written plays to its end (stop lets the last of it out; the track's head reaches
      // it), unless it's stopped.
      if (started && stillPlaying(playback)) t.stop();
      long frames = at / frameBytes, last = -1, since = android.os.SystemClock.elapsedRealtime();
      while (started && stillPlaying(playback)) {
        long head = t.getPlaybackHeadPosition() & 0xffffffffL;
        if (head >= frames) break;
        long now = android.os.SystemClock.elapsedRealtime();
        if (head != last) {
          last = head;
          since = now;
        } else if (now - since > 1000) break; // The track stopped moving.
        Thread.sleep(20);
      }
    } catch (InterruptedException ex) {
      played = false;
    } catch (Exception ex) {
      android.util.Log.w("Voice", "the reply's track failed", ex);
      played = false;
    }
    if (!played && started) heardAtEnd = heardChars(); // Ended early: how far it got stays known.
    synchronized (this) {
      if (track == t) {
        track = null;
        streamed = null;
      }
    }
    try {
      t.stop();
    } catch (IllegalStateException ignored) {
      /* Stopped already. */
    }
    t.release();
    if (stillPlaying(playback)) finished(played);
  }

  /**
   * The call's audio kept open (Settings → Hands-free, on by default): one call-audio track for the
   * whole call, playing silence while nothing else plays, so a reply's first words go straight out
   * instead of waiting for a new track and the half second of warm-up silence (about 650 ms). Its
   * replies are written into it as they come; rates differ between voices, so the track's rate is
   * set to each reply's (the silence doesn't mind).
   */
  private final class CallTrack {
    /** The idle rate, and the silence and reply chunks: short, so a stop is heard at once. */
    static final int RATE = 24_000, CHUNK_MS = 20;
    /** At most this much silence waits in the track before a reply. */
    static final int QUEUED_MS = 60;

    private final AudioTrack t;
    private volatile boolean open = true;
    /** The reply playing, and a stop asked for (done on the writer's thread). */
    private volatile Reply reply;
    private volatile boolean drop;
    private int rate = RATE;
    /** Frames written so far (in the track's frames, whatever its rate). */
    private long written;

    private final class Reply {
      final VoiceStream stream;
      final String text;
      final Playback playback;
      int at;
      byte[] chunk;
      long start = -1, end = -1, stalled = -1;
      boolean sounded, allIn;

      Reply(VoiceStream stream, String text, Playback playback) {
        this.stream = stream;
        this.text = text;
        this.playback = playback;
      }
    }

    CallTrack() {
      AudioFormat format =
          new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build();
      t =
          new AudioTrack.Builder()
              .setAudioAttributes(attributes())
              .setAudioFormat(format)
              .setTransferMode(AudioTrack.MODE_STREAM)
              .setBufferSizeInBytes(Math.max(AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), RATE * 2 * 60 / 1000))
              .build();
      t.play();
      new Thread(this::run, "voice-call-track").start();
    }

    void play(VoiceStream s, String text, Playback playback) {
      reply = new Reply(s, text, playback);
    }

    /** Silent at once (its thread empties it and goes on with silence). */
    void stopReply() {
      if (reply == null) return;
      reply = null;
      drop = true;
      try {
        t.pause();
        t.flush();
      } catch (IllegalStateException ignored) {
        /* Closed meanwhile. */
      }
    }

    boolean playing() {
      return reply != null;
    }

    /** How far the reply playing has got, in ms of it (-1: none plays). */
    long playedMs() {
      Reply r = reply;
      if (r == null || r.start < 0) return r == null ? -1 : 0;
      long head = t.getPlaybackHeadPosition() & 0xffffffffL;
      return Math.max(0, head - r.start) * 1000 / Math.max(1, r.stream.rate());
    }

    VoiceStream stream() {
      Reply r = reply;
      return r == null ? null : r.stream;
    }

    void close() {
      open = false;
      reply = null;
    }

    private void write(byte[] b, int n) {
      int w = t.write(b, 0, n, AudioTrack.WRITE_BLOCKING);
      if (w < 0) throw new IllegalStateException("the track refused audio (" + w + ")"); // Its reply ends unplayed.
      written += w / 2;
    }

    private void run() {
      byte[] buffer = new byte[192_000 * 2 * CHUNK_MS / 1000]; // Silence, at any rate a reply has.
      try {
        while (open) {
          if (drop) { // A reply stopped: what's left of it is gone; silence goes on from here.
            drop = false;
            t.pause();
            t.flush();
            t.play();
            written = t.getPlaybackHeadPosition() & 0xffffffffL;
          }
          Reply r = reply;
          if (r != null && !r.allIn) {
            int channels = Math.max(1, r.stream.channels());
            if (r.chunk == null) r.chunk = new byte[r.stream.rate() * 2 * channels * CHUNK_MS / 1000];
            byte[] chunk = r.chunk;
            int n = r.stream.read(r.at, chunk, 0);
            if (n < 0) {
              r.allIn = true;
              r.end = written;
            } else if (n > 0) {
              if (r.start < 0) {
                if (rate != r.stream.rate()) {
                  t.setPlaybackRate(r.stream.rate());
                  rate = r.stream.rate();
                }
                r.start = written;
              }
              r.at += n;
              r.stalled = -1;
              if (channels == 2) { // Both sides into one.
                for (int i = 0, o = 0; i + 3 < n; i += 4, o += 2) {
                  int left = (short) ((chunk[i] & 0xff) | (chunk[i + 1] << 8)), right = (short) ((chunk[i + 2] & 0xff) | (chunk[i + 3] << 8));
                  int m = (left + right) / 2;
                  chunk[o] = (byte) m;
                  chunk[o + 1] = (byte) (m >> 8);
                }
                n /= 2;
              }
              if (reply == r) write(chunk, n);
              progress(r);
              continue;
            } else if (r.start >= 0) {
              long now = android.os.SystemClock.elapsedRealtime();
              if (r.stalled < 0) r.stalled = now;
              else if (now - r.stalled >= STALL_MS) {
                r.stream.cancel.run();
                r.stream.fail("its audio stopped coming for " + STALL_MS / 1000 + " s", -1);
                r.allIn = true;
                r.end = written;
              }
            }
          }
          if (r != null) progress(r);
          // Only a little silence waits in the track (whatever its buffer holds): a reply written
          // next comes out after at most that much.
          long head = t.getPlaybackHeadPosition() & 0xffffffffL;
          if (written - head > (long) rate * QUEUED_MS / 1000) {
            Thread.sleep(5);
            continue;
          }
          java.util.Arrays.fill(buffer, 0, rate * 2 * CHUNK_MS / 1000, (byte) 0);
          write(buffer, rate * 2 * CHUNK_MS / 1000);
        }
      } catch (Exception ex) {
        android.util.Log.w("Voice", "the call's track failed", ex);
        Reply r = reply;
        if (r != null && stillPlaying(r.playback)) finished(false);
        callTrack = null; // Replies get their own track from now on.
      } finally {
        try {
          t.stop();
        } catch (IllegalStateException ignored) {
          /* Stopped. */
        }
        t.release();
      }
    }

    /** Its first sound out: started; all of it out: ended. */
    private void progress(Reply r) {
      long head = t.getPlaybackHeadPosition() & 0xffffffffL;
      if (!r.sounded && r.start >= 0 && head > r.start) {
        r.sounded = true;
        if (stillPlaying(r.playback)) {
          long ms = estimatedMs(r.stream, r.text);
          main.post(() -> r.playback.started(ms));
        }
      }
      if (r.allIn && head >= r.end && reply == r) {
        if (r.stream.failed() != null) heardAtEnd = heardChars(); // Ended early: how far it got stays known.
        reply = null;
        if (!r.sounded && stillPlaying(r.playback)) main.post(() -> r.playback.started(0));
        if (stillPlaying(r.playback)) finished(r.stream.failed() == null);
      }
    }
  }

  private volatile CallTrack callTrack;

  /** Opens the call's audio for the whole call (Settings → Hands-free); replies then start at once. */
  void openCall() {
    if (callTrack != null) return;
    try {
      callTrack = new CallTrack();
    } catch (Exception ex) {
      android.util.Log.w("Voice", "no call track", ex);
    }
  }

  /** Is the call's audio kept open? */
  boolean callOpen() {
    return callTrack != null;
  }

  /** Is this playback still the one going on (not stopped)? */
  private synchronized boolean stillPlaying(Playback playback) {
    return current == playback;
  }

  /**
   * How many characters of the reply have been heard: by the playback position (a third of a
   * second less, for the sound still on its way to the ear), or Android's voice's word. While a
   * streamed reply still comes in, its length isn't known yet: see VoiceStream.heardChars.
   */
  int heardChars() {
    MediaPlayer p;
    AudioTrack t;
    VoiceStream s;
    synchronized (this) {
      p = player;
      t = track;
      s = streamed;
    }
    try {
      CallTrack call = callTrack;
      VoiceStream inCall = call == null ? null : call.stream();
      if (inCall != null) return VoiceStream.heardChars(text.length(), call.playedMs(), inCall.audioMs(), inCall.complete(), charsPerSecond);
      if (t != null && s != null) {
        long played = (t.getPlaybackHeadPosition() & 0xffffffffL) * 1000 / Math.max(1, s.rate());
        return VoiceStream.heardChars(text.length(), played, s.audioMs(), s.complete(), charsPerSecond);
      }
      if (p != null) {
        int duration = p.getDuration();
        if (duration <= 0) return 0;
        long at = Math.max(0, p.getCurrentPosition() - 300L);
        return (int) Math.min(text.length(), text.length() * at / duration);
      }
    } catch (IllegalStateException ignored) {
      return 0;
    }
    if (heardAtEnd >= 0) return heardAtEnd;
    return Math.min(text.length(), ttsAt);
  }

  /** A prepared reply that won't be played (the call ended): its audio isn't fetched on. */
  static void drop(Object prepared) {
    if (prepared instanceof Prepared p && p.stream() != null) p.stream().cancel.run();
  }

  /** Is reply audio still coming out (the session's watchdog asks)? */
  boolean playing() {
    MediaPlayer p;
    CallTrack call = callTrack;
    if (call != null && call.playing()) return true;
    synchronized (this) {
      if (track != null) return true; // A streamed reply plays until its thread ends it.
      p = player;
    }
    try {
      if (p != null) return p.isPlaying();
    } catch (IllegalStateException ignored) {
      return false;
    }
    TextToSpeech t = tts;
    return t != null && t.isSpeaking();
  }

  /** What OpenRouter charged for a generation (GET /generation), or null if it can't say yet. */
  static java.math.BigDecimal cost(Context context, String generation) {
    Generation g = generation(context, generation);
    return g == null ? null : g.cost();
  }

  /** What OpenRouter says about a generation: its cost and which provider served it. */
  record Generation(java.math.BigDecimal cost, String provider, long latencyMs) {}

  /** The generation's details (GET /generation), or null if OpenRouter can't say yet. */
  static Generation generation(Context context, String generation) {
    if (generation == null || generation.isEmpty()) return null;
    for (int attempt = 0; attempt < 4; attempt++) {
      try {
        Thread.sleep(1500L * (attempt + 1)); // It shows up a moment after the call.
        String key = new Vault(context).get(OpenRouter.KEY);
        String url = OpenRouter.base() + "/generation?id=" + java.net.URLEncoder.encode(generation, "UTF-8");
        Generation g =
            NetLog.request(
                "OpenRouter cost lookup",
                "GET",
                url,
                attempt,
                net -> {
                  HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                  try {
                    c.setConnectTimeout(10_000);
                    c.setReadTimeout(15_000);
                    c.setRequestProperty("Authorization", "Bearer " + key);
                    net.status(c.getResponseCode());
                    if (c.getResponseCode() >= 300) return null;
                    try (InputStream in = c.getInputStream()) {
                      byte[] got = in.readAllBytes();
                      net.received(got.length);
                      JSONObject d = new JSONObject(new String(got, StandardCharsets.UTF_8)).optJSONObject("data");
                      if (d != null && d.has("total_cost"))
                        return new Generation(new java.math.BigDecimal(d.get("total_cost").toString()), d.optString("provider_name"), d.optLong("latency", -1));
                      return null;
                    }
                  } finally {
                    c.disconnect();
                  }
                });
        if (g != null) return g;
      } catch (Exception ignored) {
        /* Try again. */
      }
    }
    return null;
  }

  /**
   * Fetches a reply's audio; first[0] gets when its first byte came (ms after asked). MP3 and raw
   * PCM go into the stream as they come (null returned once all of it is in); anything else into a
   * file, returned. The connection isn't closed after a whole answer, so the next reply reuses it
   * (keep-alive).
   */
  private File fetch(Choice choice, String text, String[] generation, long[] first, HttpURLConnection[] open, long asked, VoiceStream stream, NetLog.Call net) throws Exception {
    String key = new Vault(context).get(OpenRouter.KEY);
    HttpURLConnection c = (HttpURLConnection) new URL(OpenRouter.base() + "/audio/speech").openConnection();
    open[0] = c;
    boolean whole = false;
    try {
      byte[] payload = body(choice, text).toString().getBytes(StandardCharsets.UTF_8);
      c.setConnectTimeout(10_000);
      c.setReadTimeout(30_000);
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Authorization", "Bearer " + key);
      c.setRequestProperty("Content-Type", "application/json");
      c.setRequestProperty("X-Title", "Dictate & Delegate");
      c.setFixedLengthStreamingMode(payload.length);
      net.sent(payload.length);
      try (OutputStream out = c.getOutputStream()) {
        out.write(payload);
      }
      int status;
      try {
        status = c.getResponseCode();
      } catch (java.net.SocketTimeoutException ex) {
        net.fail(ex);
        throw new Failed("no answer in " + (android.os.SystemClock.elapsedRealtime() - asked) / 1000 + " s");
      }
      net.status(status);
      if (status >= 300) {
        String said = "";
        try (InputStream err = c.getErrorStream()) {
          if (err != null) said = new String(err.readNBytes(4096), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
          /* The status says enough. */
        }
        throw new Failed(httpError(status, said));
      }
      first[0] = android.os.SystemClock.elapsedRealtime() - asked;
      net.note("first byte " + first[0] + " ms");
      String id = c.getHeaderField("X-Generation-Id");
      generation[0] = id == null ? "" : id;
      // Raw samples (some models send nothing else), at the rate they came at, or MP3: played as
      // they come.
      int[] pcm = pcmFormat(c.getContentType());
      if (pcm != null || isMp3(c.getContentType())) {
        receive(c, pcm, stream, asked, net);
        whole = true;
        return null;
      }
      // Each reply its own file: several may be ready while one plays.
      File f;
      synchronized (this) {
        f = new File(context.getCacheDir(), "reply-" + (++replies % 8) + (pcm == null ? ".mp3" : ".wav"));
      }
      try (InputStream in = c.getInputStream(); java.io.RandomAccessFile out = new java.io.RandomAccessFile(f, "rw")) {
        out.setLength(0);
        if (pcm != null) out.write(wavHeader(pcm[0], pcm[1], 0));
        byte[] buffer = new byte[16 * 1024];
        long got = 0;
        for (int n; (n = in.read(buffer)) > 0; ) {
          out.write(buffer, 0, n);
          net.received(got += n);
        }
        if (pcm != null) { // The sizes, now that they're known.
          out.seek(0);
          out.write(wavHeader(pcm[0], pcm[1], out.length() - 44));
        }
      } catch (java.net.SocketTimeoutException ex) {
        net.fail(ex);
        throw new Failed("its audio stopped coming after " + (android.os.SystemClock.elapsedRealtime() - asked) / 1000 + " s");
      }
      if (f.length() <= (pcm == null ? 0 : 44)) throw new Failed("it sent no audio");
      whole = true;
      return f;
    } finally {
      if (!whole) c.disconnect();
    }
  }

  /** Is it MP3 ("audio/mpeg", "audio/mp3")? */
  static boolean isMp3(String contentType) {
    String t = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
    return t.startsWith("audio/mpeg") || t.startsWith("audio/mp3");
  }

  /** Reads the audio into the stream as it comes: PCM as it is (pcm: its rate and channels), MP3 decoded. */
  private static void receive(HttpURLConnection c, int[] pcm, VoiceStream stream, long asked, NetLog.Call net) throws Exception {
    long got = 0;
    try (InputStream in = c.getInputStream()) {
      byte[] buffer = new byte[16 * 1024];
      if (pcm != null) {
        stream.format(pcm[0], pcm[1]);
        for (int n; (n = in.read(buffer)) >= 0; ) {
          stream.add(buffer, 0, n);
          net.received(got += n);
        }
      } else
        try (Mp3Decoder d = new Mp3Decoder(stream)) {
          for (int n; (n = in.read(buffer)) >= 0; ) {
            d.add(buffer, 0, n);
            net.received(got += n);
          }
          d.finish();
        }
    } catch (java.net.SocketTimeoutException ex) {
      net.fail(ex);
      throw new Failed("its audio stopped coming after " + (android.os.SystemClock.elapsedRealtime() - asked) / 1000 + " s");
    }
    if (stream.bytes() == 0) throw new Failed("it sent no audio");
    stream.end(android.os.SystemClock.elapsedRealtime() - asked);
  }

  /**
   * Decodes MP3 frames as they come, with Android's MP3 decoder, into the stream: 16-bit PCM at
   * the MP3's rate.
   */
  private static final class Mp3Decoder implements AutoCloseable {
    private final VoiceStream out;
    private final VoiceStream.Mp3Frames frames = new VoiceStream.Mp3Frames();
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private MediaCodec codec;
    private long frame;

    Mp3Decoder(VoiceStream out) {
      this.out = out;
    }

    void add(byte[] b, int off, int n) throws IOException {
      frames.add(b, off, n);
      for (byte[] f; (f = frames.next(false)) != null; ) decode(f);
      drain(0);
    }

    /** No more bytes come: the last frames are decoded to the end. */
    void finish() throws IOException {
      for (byte[] f; (f = frames.next(true)) != null; ) decode(f);
      if (codec == null) return;
      int i;
      while ((i = codec.dequeueInputBuffer(10_000)) < 0) drain(0);
      codec.queueInputBuffer(i, 0, 0, time(), MediaCodec.BUFFER_FLAG_END_OF_STREAM);
      long until = android.os.SystemClock.elapsedRealtime() + 2000;
      while (!drain(10_000) && android.os.SystemClock.elapsedRealtime() < until) {}
    }

    private long time() {
      return frame * frames.samples * 1_000_000L / Math.max(1, frames.rate);
    }

    private void decode(byte[] f) throws IOException {
      if (codec == null) {
        codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_MPEG);
        codec.configure(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_MPEG, frames.rate, frames.channels), null, null, 0);
        codec.start();
        out.format(frames.rate, frames.channels);
      }
      int i;
      while ((i = codec.dequeueInputBuffer(10_000)) < 0) drain(0);
      java.nio.ByteBuffer in = codec.getInputBuffer(i);
      in.clear();
      in.put(f);
      codec.queueInputBuffer(i, 0, f.length, time(), 0);
      frame++;
    }

    /** Takes what the decoder has ready into the stream; true at its end. */
    private boolean drain(long waitUs) {
      if (codec == null) return false; // No whole frame yet.
      while (true) {
        int o = codec.dequeueOutputBuffer(info, waitUs);
        if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          MediaFormat f = codec.getOutputFormat();
          // Its rate and channels, as long as nothing's in yet (an MP3's don't change).
          if (out.bytes() == 0) out.format(f.getInteger(MediaFormat.KEY_SAMPLE_RATE), f.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
          continue;
        }
        if (o < 0) return false;
        java.nio.ByteBuffer b = codec.getOutputBuffer(o);
        if (b != null && info.size > 0) {
          byte[] pcm = new byte[info.size];
          b.position(info.offset);
          b.get(pcm);
          out.add(pcm, 0, pcm.length);
        }
        codec.releaseOutputBuffer(o, false);
        if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return true;
      }
    }

    @Override
    public void close() {
      if (codec == null) return;
      try {
        codec.stop();
      } catch (IllegalStateException ignored) {
        /* Failed before. */
      }
      codec.release();
    }
  }

  /** On the main thread. */
  private void play(File mp3, Playback playback) throws IOException {
    MediaPlayer p = new MediaPlayer();
    p.setAudioAttributes(attributes());
    p.setDataSource(mp3.getPath());
    p.setOnCompletionListener(
        mp -> {
          release();
          mp3.delete();
          finished(true);
        });
    p.setOnErrorListener(
        (mp, what, extra) -> {
          release();
          mp3.delete();
          finished(false);
          return true;
        });
    p.prepare();
    synchronized (this) {
      player = p;
    }
    p.start();
    playback.started(Math.max(0, p.getDuration()));
  }

  /** Android's voice; about 15 characters a second for how long it takes. */
  private void speakAndroid(String text, Playback playback) {
    main.post(
        () ->
            whenAndroidReady(
                () -> {
                  synchronized (this) {
                    if (current != playback) return; // Stopped meanwhile.
                  }
                  TextToSpeech t = tts;
                  if (!ttsReady || t == null) {
                    android.util.Log.w("Voice", "Android's voice isn't available");
                    finished(false);
                    return;
                  }
                  String id = "reply-" + (++utterances);
                  utterance = id;
                  if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
                    androidFailed("refused to speak");
                    finished(false);
                  }
                }));
  }

  /** Stops reading at once; the playback still hears it ended. */
  void stop() {
    MediaPlayer p;
    AudioTrack streaming;
    VoiceStream s;
    synchronized (this) {
      p = player;
      streaming = track;
      s = streamed;
    }
    CallTrack call = callTrack;
    VoiceStream inCall = call == null ? null : call.stream();
    if (inCall != null) {
      call.stopReply();
      inCall.cancel.run();
    }
    if (streaming != null) {
      // Silent at once; its thread lets it go.
      try {
        streaming.pause();
        streaming.flush();
      } catch (IllegalStateException ignored) {
        /* Released meanwhile. */
      }
    }
    // The rest of its audio isn't fetched on (also while it was still warming up).
    VoiceStream fetching = playingStream;
    if (fetching != null) fetching.cancel.run();
    if (s != null) s.cancel.run();
    if (p != null) {
      try {
        p.stop();
      } catch (IllegalStateException ignored) {
        /* Not started yet or already done. */
      }
      release();
    }
    utterance = ""; // Whatever the engine says about it now no longer counts.
    TextToSpeech t = tts;
    if (t != null) t.stop();
    finished(false);
  }

  private synchronized void release() {
    if (player != null) {
      player.release();
      player = null;
    }
  }

  void shutdown() {
    stop();
    CallTrack call = callTrack;
    callTrack = null;
    if (call != null) call.close();
    main.post(
        () -> {
          if (tts != null) tts.shutdown();
          tts = null;
          ttsReady = false;
        });
  }
}
