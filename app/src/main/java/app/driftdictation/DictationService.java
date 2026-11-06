package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/**
 * Recording, transcription and the floating panel. The transcript always comes first; then the
 * panel offers Insert, Refine and, for each assistant set up, Chief. Nothing starts by itself and
 * nothing is routed by what was said: the user taps where it goes (the volume key that started
 * the dictation only puts its assistant first). Jev only says which template a tapped Refine uses,
 * when the dictation names one. Refine and Chief can be chosen while recording; they run once the
 * transcript is ready.
 */
public final class DictationService extends Service {
  static final String ENABLE = "enable",
      RECORD = "record",
      STOP = "stop",
      RETRY = "retry",
      HIDE = "hide",
      DISCARD = "discard",
      CANCEL = "cancel",
      CONFIGURE = "configure",
      COMPARE = "compare";
  static final String READY = "ready",
      RECORDING = "recording",
      STOPPING = "stopping",
      UPLOADING = "uploading",
      COPIED = "copied",
      ERROR = "error",
      EMPTY = "empty",
      /** The panel's recording wasn't written down: kept in the notes, ↻ tries again. */
      UNFINISHED = "unfinished";

  /** Extra of RECORD: the assistant the volume key that started it is for (RecordActivity.ASSISTANT). */
  static final String ASSISTANT = RecordActivity.ASSISTANT;

  /** Where Refine and Chief are for this dictation. */
  static final String IDLE = "idle", QUEUED = "queued", RUNNING = "running", DONE = "done", FAILED = "failed";

  /** The panel hides after this long without a tap; longer while something is under way. */
  static final long PANEL_IDLE_MS = 60_000, PANEL_WAIT_MS = 5 * 60_000;

  /** Notes change from several threads (upload, Refine, the chief, the app); one at a time. */
  static final Object NOTES = new Object();

  /** One dictation as the panel sees it. Changed on the main thread only. */
  static final class Session {
    volatile String noteId = "", transcript = "", refined = "", reply = "";
    volatile String refine = IDLE, chief = IDLE, template = "", chiefLink = "", request = "";
    volatile String message = "";
    /** Jev answered or isn't asked; until then a queued Refine waits (a template may come). */
    volatile boolean decided, redo;
    /** The assistants whose chief can get requests, when the dictation started. */
    volatile java.util.List<Integer> assistants = java.util.List.of();
    /** The assistant Chief is for (chief's state is that one's); the one the key chose, -1 none. */
    volatile int assistant, keyAssistant = -1;
    volatile TalkAccessibility.Inserted inserted;
    volatile String insertedKind = "";
    /** Counts Refine runs; a run whose number is no longer current is ignored when it ends. */
    volatile int refineRun;
    /** The transcript is there: queued choices can run (also once it's no longer the panel's). */
    volatile boolean ready;
  }

  static volatile DictationService instance;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final ExecutorService actions = Executors.newFixedThreadPool(3);
  private final ExecutorService inserter = Executors.newSingleThreadExecutor();
  /** Recordings being written down, each on its own thread: none waits for another. */
  private final ExecutorService transcribers = Executors.newCachedThreadPool();
  /** Jobs done whose result the main thread hasn't taken yet: the service waits for them too. */
  private final java.util.concurrent.atomic.AtomicInteger reporting = new java.util.concurrent.atomic.AtomicInteger();
  private String state = READY, detail = tr("Tap the bubble to record");
  private volatile boolean alive;
  private long started;
  private PcmRecorder recorder;
  private PowerManager.WakeLock wake;
  private FloatingPanel bubble;
  private WindowManager windows;
  private WindowManager.LayoutParams layout;
  private Vault vault;
  private SharedPreferences prefs;
  private Session session = new Session();
  private ChiefText.Listener listener;
  /** Refine, Jev and the chief running in the background; the service waits for them. */
  private int working;
  private boolean closing;
  private int lastWidth;

  static File audio(Context context) {
    return new File(context.getNoBackupFilesDir(), "pending.pcm");
  }

  static boolean busy() {
    return instance != null && instance.isBusy();
  }

  /** The current dictation's session, for tests and the app; null without a running service. */
  static Session session() {
    DictationService s = instance;
    return s == null ? null : s.session;
  }

  String state() {
    return state;
  }

  /**
   * The microphone is in use (recording, or saving what was recorded). Writing a recording down
   * isn't busy: it runs in the background, and a new recording can start meanwhile.
   */
  private boolean isBusy() {
    return RECORDING.equals(state) || STOPPING.equals(state);
  }

  static void send(Context c, String action) {
    Intent intent = new Intent(c, DictationService.class).setAction(action);
    if (instance == null) c.startForegroundService(intent);
    else c.startService(intent);
  }

  @Override
  public void onCreate() {
    super.onCreate();
    alive = true;
    instance = this;
    I18n.init(this);
    vault = new Vault(this);
    prefs = getSharedPreferences("settings", MODE_PRIVATE);
    QuietNotifications.initialize(this);
    // Left from before: a recording the app stopped during (or an older version kept after a
    // failure) and ones whose writing down was cut off become notes to retry; none blocks.
    adoptLeftover();
    markOrphans(this);
    windows = getSystemService(WindowManager.class);
    wake =
        getSystemService(PowerManager.class)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Dictate & Delegate:dictation");
    wake.setReferenceCounted(false);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    try {
      foreground(RECORDING.equals(state) || STOPPING.equals(state));
      String action = intent == null ? ENABLE : intent.getAction();
      if (ENABLE.equals(action)) {
        prefs.edit().putString("bubbleMode", "always").apply();
        update();
      } else if (RECORD.equals(action)) startRecording(intent.getIntExtra(ASSISTANT, -1));
      else if (STOP.equals(action)) stopRecording(true);
      else if (CANCEL.equals(action)) cancelRecording();
      else if (COMPARE.equals(action)) {
        String id = intent.getStringExtra("recordingId"), model = intent.getStringExtra("model");
        if (model == null || model.isBlank()) throw new IOException(tr("Choose a model first."));
        requireKey(this);
        File saved = new AudioArchive(this).get(id);
        if (saved == null)
          throw new IOException(tr("Audio has expired or was deleted. Text is still saved."));
        String session = intent.getStringExtra("sessionId");
        if (session == null || session.isBlank()) session = java.util.UUID.randomUUID().toString();
        recordings(this).mkdirs();
        java.nio.file.Files.copy(saved.toPath(), recording(this, session).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        synchronized (NOTES) {
          try (HistoryStore history = new HistoryStore(this)) {
            HistoryEntry entry = HistoryEntry.create(session, model, saved.length() / (double) AudioFiles.BYTES_PER_SECOND);
            entry.json.put("recordingId", id);
            history.save(entry);
          }
        }
        retryNote(session);
      } else if (RETRY.equals(action)) {
        adoptLeftover();
        String id = intent.getStringExtra("noteId");
        java.util.List<String> ids = id == null || id.isEmpty() ? unfinished(this) : java.util.List.of(id);
        requireKey(this);
        for (String i : ids) retryNote(i);
      } else if (DISCARD.equals(action)) {
        String id = intent.getStringExtra("noteId");
        boolean all = id == null || id.isEmpty();
        if (all && !isBusy()) clearPending(); // also a recording left from before
        for (String i : all ? unfinished(this) : java.util.List.of(id)) discard(this, i);
        if (UNFINISHED.equals(state) && (id == null || id.isEmpty() || id.equals(session.noteId))) closePanel();
      } else if (HIDE.equals(action)) {
        prefs.edit().putString("bubbleMode", "never").apply();
        update();
        if (!isBusy()) finishIdle();
      } else if (CONFIGURE.equals(action)) {
        update();
        if (!isBusy() && !"always".equals(mode()) && !done(state) && !UPLOADING.equals(state) && !UNFINISHED.equals(state))
          finishIdle();
      }
    } catch (Exception ex) {
      transition(ERROR, friendly(ex));
    } finally {
      ResultReceiver callback =
          intent == null ? null : intent.getParcelableExtra("started", ResultReceiver.class);
      if (callback != null) callback.send(0, Bundle.EMPTY);
    }
    return START_NOT_STICKY; // Never silently restart capture after force-stop, crash or reboot.
  }

  private void foreground(boolean microphone) {
    startForeground(
        1,
        notification(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            | (microphone ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0));
  }

  private Notification notification() {
    // Android requires a foreground-service notification object even without posting permission.
    return new Notification.Builder(this, QuietNotifications.CHANNEL)
        .setSmallIcon(app.driftdictation.R.drawable.ic_mic)
        .setContentTitle(tr("Dictate & Delegate is running"))
        .setContentText(tr("Use the bubble or open Dictate & Delegate to control dictation."))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .build();
  }

  /** A new dictation: the panel forgets the last one. */
  private void newSession() {
    newSession(-1);
  }

  /** The same, for a dictation the volume key of an assistant started (-1: none). */
  private void newSession(int keyAssistant) {
    stopListening();
    session = new Session();
    session.assistants = Assistants.ready(this);
    session.keyAssistant = session.assistants.contains(keyAssistant) ? keyAssistant : -1;
    session.assistant = session.keyAssistant >= 0 ? session.keyAssistant : session.assistants.isEmpty() ? 0 : session.assistants.get(0);
    closing = false;
  }

  /** Without the panel, a toast says where the user is what the panel would show. */
  private void transition(String next, String message) {
    transition(next, message, false);
  }

  private void transition(String next, String message, boolean alsoToast) {
    main.removeCallbacks(finishFeedback);
    state = next;
    detail = message;
    update();
    if ((bubble == null || alsoToast)
        && (done(next) || ERROR.equals(next) || EMPTY.equals(next)))
      Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    if (done(next)) touch();
    else if (UNFINISHED.equals(next)) main.postDelayed(finishFeedback, PANEL_IDLE_MS);
    else if (ERROR.equals(next) || EMPTY.equals(next)) main.postDelayed(finishFeedback, 3500);
    else if (READY.equals(next) && !"always".equals(mode())) finishIdle();
  }

  private void update() {
    if (!alive) return;
    prefs.edit().putString("state", state).putString("detail", detail).apply();
    syncBubble();
    DictationTile.refresh(this);
  }

  /** The transcript is ready: the panel offers Insert, Refine and Chief. */
  static boolean done(String state) {
    return COPIED.equals(state);
  }

  private String mode() {
    return prefs.getString("bubbleMode", "recording");
  }

  private final Runnable finishFeedback =
      () -> {
        if (ERROR.equals(state)) {
          finishIdle();
          return;
        }
        if (done(state) || EMPTY.equals(state) || UNFINISHED.equals(state)) {
          if ("always".equals(mode())) transition(READY, tr("Tap the microphone to record"));
          else finishIdle();
        }
      };

  /**
   * The panel stays while it's used: it hides after a minute without a tap, or five while Refine
   * runs or the chief's text is awaited. Without the panel, the service ends soon after.
   */
  private void touch() {
    main.removeCallbacks(finishFeedback);
    if (!done(state)) return;
    boolean waiting =
        session.refine.equals(RUNNING)
            || session.chief.equals(RUNNING)
            || (session.chief.equals(DONE) && session.reply.isEmpty() && listener != null);
    main.postDelayed(finishFeedback, bubble == null ? 6000 : waiting ? PANEL_WAIT_MS : PANEL_IDLE_MS);
  }

  private void finishIdle() {
    if (isBusy()) return;
    removeBubble();
    if (working > 0 || !JOBS.isEmpty() || reporting.get() > 0) {
      closing = true; // Refine, the chief or a transcription are still running; their results are saved.
      return;
    }
    stopListening();
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  private void removeBubble() {
    if (bubble != null) {
      windows.removeView(bubble);
      bubble = null;
    }
  }

  /**
   * A file picker is open (the 📎's Attach a file). Pickers such as Android's photo picker ignore
   * every tap while another app's window lies over the screen (tapjacking protection), so the
   * floating panels are taken off until it closes.
   */
  static volatile boolean picking;

  static void picking(boolean open) {
    picking = open;
    DictationService s = instance;
    if (s != null) s.main.post(s::syncBubble);
    HandsFreeService.panelHidden(open);
  }

  private void syncBubble() {
    boolean visible =
        !closing
            && !picking
            && ("always".equals(mode()) || ("recording".equals(mode()) && !READY.equals(state)));
    if (visible && Settings.canDrawOverlays(this)) showBubble();
    else removeBubble();
    renderBubble();
  }

  private final Runnable ticker =
      new Runnable() {
        public void run() {
          if (!alive || !RECORDING.equals(state)) return;
          renderBubble();
          main.postDelayed(this, 1000);
        }
      };

  private void showBubble() {
    if (bubble != null || !Settings.canDrawOverlays(this)) return;
    int[] from = new int[2];
    bubble =
        new FloatingPanel(
            this,
            new FloatingPanel.Actions() {
              public void close() {
                if (RECORDING.equals(state)) cancelRecording();
                else if (UPLOADING.equals(state)) stopTrying(session);
                else closePanel();
              }

              public void record() {
                if (isBusy()) return;
                startActivity(
                    new Intent(DictationService.this, RecordActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
              }

              public void retry() {
                if (!UNFINISHED.equals(state)) return;
                try {
                  requireKey(DictationService.this);
                  retryNote(session.noteId);
                } catch (Exception ex) {
                  say(friendly(ex));
                }
              }

              public void stop() {
                if (RECORDING.equals(state)) stopRecording(true);
              }

              public void call(int assistant) {
                callChief(assistant);
              }

              public void attach() {
                // The 📎: add context while recording goes on.
                startActivity(
                    new Intent(DictationService.this, AttachActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
              }

              public void insert() {
                if (done(state)) insertText("transcript", session.transcript);
              }

              public void refine() {
                tapRefine();
              }

              public void chief(int assistant) {
                tapChief(assistant);
              }

              public void insertFromChief() {
                if (!session.reply.isEmpty()) insertText("chief", session.reply);
              }

              public void tapIcon() {
                if (isBusy()) return;
                if (ERROR.equals(state)) {
                  finishIdle();
                  startActivity(
                      new Intent(DictationService.this, MainActivity.class)
                          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } else
                  startActivity(
                      new Intent(DictationService.this, RecordActivity.class)
                          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
              }
            },
            new FloatingPanel.Drag() {
              public void start() {
                from[0] = layout.x;
                from[1] = layout.y;
                touch();
              }

              public void move(float dx, float dy) {
                if (bubble == null) return;
                layout.x = from[0] + (int) dx;
                layout.y = from[1] + (int) dy;
                clampPosition();
                windows.updateViewLayout(bubble, layout);
              }

              public void end() {
                prefs.edit().putInt("bubbleX", layout.x).putInt("bubbleY", layout.y).apply();
              }
            });
    layout =
        new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // Never focusable: the cursor stays in the app you're in, so Insert lands there.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
    layout.gravity = Gravity.TOP | Gravity.LEFT;
    lastWidth = 0;
    layout.x = prefs.getInt("bubbleX", 16);
    layout.y = prefs.getInt("bubbleY", 220);
    clampPosition();
    windows.addView(bubble, layout);
    renderBubble();
  }

  private int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  private void clampPosition() {
    android.graphics.Rect bounds = windows.getCurrentWindowMetrics().getBounds();
    int width = layout.width > 0 ? layout.width : dp(48);
    layout.x = Math.max(0, Math.min(layout.x, bounds.width() - width));
    layout.y = Math.max(dp(32), Math.min(layout.y, bounds.height() - dp(80)));
  }

  @Override
  public void onConfigurationChanged(android.content.res.Configuration config) {
    super.onConfigurationChanged(config);
    I18n.init(this); // The language may have changed while the service runs.
    if (bubble != null) {
      clampPosition();
      windows.updateViewLayout(bubble, layout);
      renderBubble();
    }
  }

  private void renderBubble() {
    if (bubble == null) return;
    Session s = session;
    java.util.List<Integer> assistants = new java.util.ArrayList<>(s.assistants);
    if (!s.chief.equals(IDLE) && !assistants.contains(s.assistant)) assistants.add(s.assistant);
    String[] names = new String[Assistants.COUNT];
    for (int a = 0; a < names.length; a++) names[a] = Assistants.name(prefs, a);
    bubble.render(
        new FloatingPanel.Model(
            state,
            RECORDING.equals(state) ? SystemClock.elapsedRealtime() - started : 0,
            RECORDING.equals(state) ? new Attachments(this).pending().size() : 0,
            s.refine,
            s.chief,
            s.assistant,
            assistants,
            names,
            s.keyAssistant,
            !s.reply.isEmpty(),
            s.message,
            prefs.getInt("bubbleOpacity", 65)));
    // The panel grows and shrinks with its buttons. Android would squeeze a wrap-content overlay
    // to dialog width, so the window gets the width its buttons need, and stays on screen.
    int screen = windows.getCurrentWindowMetrics().getBounds().width();
    bubble.measure(
        View.MeasureSpec.makeMeasureSpec(screen - dp(16), View.MeasureSpec.AT_MOST),
        View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
    int width = bubble.getMeasuredWidth(), x = layout.x;
    layout.width = width;
    clampPosition();
    if (width != lastWidth || x != layout.x) {
      lastWidth = width;
      windows.updateViewLayout(bubble, layout);
    }
  }

  static boolean bubbleVisible() {
    return instance != null && instance.bubble != null;
  }

  /** Where the floating panel is (x, y), or null without one (for the device tests). */
  static int[] panelPosition() {
    DictationService s = instance;
    return s == null || s.bubble == null ? null : new int[] {s.layout.x, s.layout.y};
  }

  /** Whether the panel shows every button whole and on screen (for the device tests). */
  static boolean panelFits() {
    DictationService s = instance;
    return s != null && s.bubble != null && s.bubble.fits();
  }

  private void closePanel() {
    if ("always".equals(mode())) {
      newSession();
      transition(READY, tr("Tap the microphone to record"));
    } else finishIdle();
  }

  private void say(String message) {
    session.message = message;
    renderBubble();
    touch();
  }

  // ------------------------------------------------------------------ the panel's choices

  /** Refine: chosen ahead while recording, started once the transcript is ready, then inserted. */
  private void tapRefine() {
    Session s = session;
    switch (s.refine) {
      case QUEUED -> s.refine = IDLE;
      case RUNNING -> {}
      case DONE -> insertText("refined", s.refined);
      default -> {
        s.refine = QUEUED;
        startQueued(s);
      }
    }
    renderBubble();
    touch();
  }

  /**
   * An assistant's Chief: chosen ahead while recording, sent once the transcript is ready; then
   * opens the chat. A dictation goes to one assistant: tapping the other's while it's only chosen
   * moves it there; once it's on its way the other's button is gone.
   */
  private void tapChief(int assistant) {
    Session s = session;
    boolean same = s.assistant == assistant;
    switch (s.chief) {
      case QUEUED -> {
        if (same) s.chief = IDLE;
        else if (BbBridge.ready(this, assistant)) s.assistant = assistant;
        else say(tr("Set up your chief of staff in Dictate & Delegate → Settings → bb."));
      }
      case RUNNING -> {}
      case DONE -> {
        if (!same) {}
        else if (s.chiefLink.isEmpty()) say(tr("Set the bb web address for links in Settings → bb."));
        else
          try {
            startActivity(
                BbBridge.view(s.chiefLink));
          } catch (ActivityNotFoundException ex) {
            say(tr("No browser available"));
          }
      }
      default -> {
        if (s.chief.equals(FAILED) && !same) return; // Kept for its own assistant, which sends it again by itself.
        if (!BbBridge.ready(this, assistant)) {
          say(tr("Set up your chief of staff in Dictate & Delegate → Settings → bb."));
          return;
        }
        s.assistant = assistant;
        s.chief = QUEUED;
        startQueued(s);
      }
    }
    renderBubble();
    touch();
  }

  /**
   * Runs what's queued, once the transcript is there (Refine also waits for Jev's template, if it's
   * asked); also for a dictation the panel has moved on from (a recording written down after the
   * next began).
   */
  private void startQueued(Session s) {
    if (!s.ready || s.noteId.isEmpty()) return;
    if (s.refine.equals(QUEUED) && s.decided) {
      s.refine = RUNNING;
      String template = s.template;
      int run = ++s.refineRun;
      work(() -> refined(s, run, refineNote(this, s.noteId, new Profile(prefs), template)));
    }
    if (s.chief.equals(QUEUED)) {
      s.chief = RUNNING;
      int assistant = s.assistant;
      work(() -> sent(s, sendNote(this, s.noteId, assistant)));
    }
    if (session != s) return;
    renderBubble();
    touch();
  }

  private void work(Runnable task) {
    working++;
    actions.execute(
        () -> {
          try {
            task.run();
          } finally {
            main.post(
                () -> {
                  working--;
                  if (working == 0 && closing) finishIdle();
                });
          }
        });
  }

  /**
   * Jev, right after the transcript, only with saved templates: the template the dictation names,
   * for a tapped Refine. Nothing starts by itself.
   */
  private void decide(Session s) {
    java.util.List<String> templates = new Templates(this).names();
    String said = s.transcript;
    if (s.redo || templates.isEmpty()) {
      s.decided = true;
      startQueued(s);
      return;
    }
    String id = s.noteId;
    work(
        () -> {
          Jev.Answers a = null;
          String failed = null;
          long asked = SystemClock.elapsedRealtime();
          try {
            a = Jev.ask(this, said, templates);
          } catch (Exception ex) {
            failed = friendly(ex);
          }
          Jev.Answers answers = a;
          String why = failed;
          long ms = SystemClock.elapsedRealtime() - asked;
          try {
            update(
                this,
                id,
                e -> {
                  JSONObject step = e.step("jev", Jev.MODEL, ms, answers == null ? null : answers.cost(), why);
                  if (answers != null) {
                    step.put("answer", Jev.detail(answers));
                    e.charge(answers.cost());
                    e.addCost("jevCost", answers.cost());
                  }
                });
          } catch (Exception ignored) {
            /* The note keeps the transcript; Activity just lacks this step. */
          }
          String template = answers == null ? "" : answers.template();
          main.post(
              () -> {
                s.decided = true;
                s.template = template;
                startQueued(s);
                if (session == s) renderBubble();
              });
        });
  }

  /** Refine finished (failure: why, else null). */
  private void refined(Session s, int run, String failed) {
    String text = failed == null ? text(this, s.noteId) : "";
    main.post(
        () -> {
          prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
          if (run != s.refineRun) return; // An older run.
          if (failed != null) {
            s.refine = FAILED;
            s.message = tr("Couldn't refine: %1$s", failed);
          } else {
            s.refine = DONE;
            s.refined = text;
            try {
              vault.put("transcript", text);
            } catch (Exception ignored) {
              /* Only the last-transcript shortcut. */
            }
            // Never on the clipboard by itself: Insert refined, or Copy on the note.
            s.message = bubble == null ? "" : tr("Refined");
            if (bubble == null && session == s)
              Toast.makeText(this, tr("Refined. The text is in Dictate & Delegate."), Toast.LENGTH_LONG).show();
          }
          if (session == s) {
            renderBubble();
            touch();
          }
        });
  }

  /** The chief got it (failure: why, else null): the button opens the chat; its text may follow. */
  private void sent(Session s, String failed) {
    HistoryEntry e = load(this, s.noteId);
    main.post(
        () -> {
          prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
          if (failed != null || e == null) {
            s.chief = FAILED;
            s.message =
                e != null && e.json.optBoolean("chiefQueued")
                    ? tr("Not sent yet: %1$s It's kept and goes by itself once bb can be reached.", failed == null ? "" : failed)
                    : s.assistants.size() > 1
                        ? tr("Not sent to %1$s: %2$s", Assistants.name(prefs, s.assistant), failed == null ? "" : failed)
                        : tr("Not sent to your chief of staff: %1$s", failed == null ? "" : failed);
          } else {
            s.chief = DONE;
            s.chiefLink = e.json.optString("chiefLink");
            s.request = e.json.optString("chiefRequest");
            s.message = s.assistants.size() > 1 ? tr("Sent to %1$s", Assistants.name(prefs, s.assistant)) : tr("Sent to your chief of staff");
            if (bubble == null && session == s) Toast.makeText(this, s.message, Toast.LENGTH_LONG).show();
            if (session == s && bubble != null) listen(s, e.json.optLong("chiefSent"));
          }
          if (session == s) {
            renderBubble();
            touch();
          }
        });
  }

  /** While the panel is open: the chief's text for this request, from the ntfy topic. */
  private void listen(Session s, long sentAt) {
    stopListening();
    BbBridge bb = new BbBridge(this, s.assistant);
    String topic;
    try {
      topic = bb.ntfyTopic();
    } catch (Exception ex) {
      return;
    }
    listener =
        new ChiefText.Listener(
            bb.ntfyServer(),
            topic,
            s.request,
            Math.max(0, sentAt / 1000 - 5),
            text -> {
              keepReply(this, s.request, text);
              main.post(
                  () -> {
                    if (session != s) return;
                    s.reply = text;
                    s.message = tr("Your chief of staff sent text to insert");
                    listener = null;
                    prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
                    renderBubble();
                    touch();
                  });
            });
    listener.start();
  }

  private void stopListening() {
    if (listener != null) {
      listener.finish();
      listener = null;
    }
  }

  /**
   * Insert: at the cursor of the field in the app you're in, through the Accessibility service.
   * The refined text replaces the transcript it follows if the field still holds that unchanged.
   * Without the service, or when the app refuses, the text is copied instead.
   */
  private void insertText(String kind, String text) {
    if (text.isEmpty()) return;
    Session s = session;
    TalkAccessibility.Inserted earlier = "transcript".equals(s.insertedKind) ? s.inserted : null;
    touch();
    inserter.execute(
        () -> {
          TalkAccessibility a = TalkAccessibility.instance;
          TalkAccessibility.Inserted r = null;
          boolean replaced = false;
          try {
            if (a != null && kind.equals("refined") && earlier != null) {
              r = a.replace(this, earlier, text);
              replaced = r != null;
            }
            if (a != null && r == null) r = a.insert(this, text);
          } catch (RuntimeException ex) {
            r = null; // The app went away mid-way: copy instead.
          }
          TalkAccessibility.Inserted done = r;
          boolean swapped = replaced;
          main.post(
              () -> {
                if (done == null) {
                  // Insert couldn't: the clipboard instead, and the panel says so.
                  copy(this, text);
                  s.message =
                      a == null
                          ? tr("Copied instead, paste with a long press. Insert needs the Accessibility permission (Settings → Start).")
                          : tr("Copied instead, paste with a long press");
                } else {
                  s.inserted = done;
                  s.insertedKind = kind;
                  s.message =
                      (swapped ? tr("Replaced with the refined text") : tr("Inserted"))
                          + (done.clipboard() ? " · " + tr("this app only takes pastes, so it's on the clipboard too") : "");
                }
                if (session == s) {
                  renderBubble();
                  touch();
                }
              });
        });
  }

  // ------------------------------------------------------------------ notes

  interface Change {
    void apply(HistoryEntry e) throws Exception;
  }

  /** Loads a note, changes it and saves it, one change at a time. */
  static void update(Context context, String id, Change change) throws Exception {
    synchronized (NOTES) {
      try (HistoryStore h = new HistoryStore(context)) {
        HistoryEntry e = h.get(id);
        if (e == null) throw new IOException(tr("This note was deleted."));
        change.apply(e);
        h.save(e);
      }
    }
  }

  /** The same for the note that sent a request to the chief (found by its request ID). */
  static void updateByRequest(Context context, String request, Change change) throws Exception {
    synchronized (NOTES) {
      try (HistoryStore h = new HistoryStore(context)) {
        for (HistoryEntry e : h.list(200, 0))
          if (request.equals(e.json.optString("chiefRequest"))) {
            change.apply(e);
            h.save(e);
            context.getSharedPreferences("settings", MODE_PRIVATE).edit().putLong("historyRevision", System.nanoTime()).apply();
            return;
          }
      }
    }
    throw new IOException("No note for request " + request);
  }

  static HistoryEntry load(Context context, String id) {
    synchronized (NOTES) {
      try (HistoryStore h = new HistoryStore(context)) {
        return h.get(id);
      } catch (Exception ex) {
        return null;
      }
    }
  }

  private static String text(Context context, String id) {
    HistoryEntry e = load(context, id);
    return e == null ? "" : e.text();
  }

  /**
   * Every call to OpenRouter starts here: recording, redo and processing again. Without a key
   * nothing is recorded that couldn't be transcribed.
   */
  static void requireKey(Context context) throws IOException {
    if (!OpenRouter.hasKey(context))
      throw new IOException(tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
  }

  /**
   * Refine: what was said, with the template named and the attachments, through the text model.
   * The note gets the refined version (what was said stays); on failure it records why. Returns
   * null, or why it failed.
   */
  static String refineNote(Context context, String id, Profile profile, String template) {
    HistoryEntry entry = load(context, id);
    if (entry == null) return tr("This note was deleted.");
    String said = entry.json.optString("original", entry.text());
    long asked = SystemClock.elapsedRealtime();
    TextModel.Refined r = null;
    String failed = null;
    try {
      r =
          TextModel.process(
              context,
              said,
              new Attachments(context).parts(entry.recordingId()),
              profile.refinePrompt(),
              new Templates(context).prompt(template),
              profile.context());
    } catch (Exception ex) {
      failed = friendly(ex);
    }
    TextModel.Refined result = r;
    String why = failed;
    long ms = SystemClock.elapsedRealtime() - asked;
    try {
      update(
          context,
          id,
          e -> {
            if (result == null) {
              e.json.put("processingFailed", why);
              e.step("refine", TextModel.model(context), ms, null, why);
              return;
            }
            if (result.anthropic()) {
              // Anthropic credits: kept apart, never in the note's or the month's cost.
              e.addCost("anthropicCost", result.cost());
              e.step("refine", result.model(), ms, result.cost(), null)
                  .put("provider", "anthropic")
                  .put("approx", true);
            } else {
              e.charge(result.cost());
              e.addCost("textCost", result.cost());
              JSONObject step = e.step("refine", result.model(), ms, result.cost(), null).put("provider", "openrouter");
              if (result.fallback() != null) step.put("fallback", result.fallback());
            }
            if (result.keyProblem()) e.json.put("anthropicWarning", result.fallback());
            else e.json.remove("anthropicWarning");
            e.json
                .put("processed", result.text())
                .put("text", result.text())
                .put("version", "processed")
                .put("textModel", result.model())
                .remove("processingFailed");
            if (template == null || template.isEmpty()) e.json.remove("template");
            else e.json.put("template", template);
          });
    } catch (Exception ex) {
      return friendly(ex);
    }
    return why;
  }

  /** What the activity log calls the chief-of-staff step's target. */
  static final String CHIEF_STEP = "bb", CHIEF_TARGET = "chief of staff";

  /** Notes being sent right now: a second send of one (Retry while the outbox tries) waits its turn. */
  private static final java.util.Set<String> SENDING = new java.util.HashSet<>();

  /**
   * Hands what was said, with pasted text as context and a request ID, to the chief-of-staff
   * thread in bb. On failure the note records why and stays queued in the Outbox, which sends it
   * again by itself (with the same request ID, so it never arrives twice). Returns null, or why
   * it failed.
   */
  static String sendNote(Context context, String id) {
    return sendNote(context, id, -1);
  }

  /**
   * The same, to an assistant (-1: the one the note is for already). A note that failed stays
   * with the assistant it was meant for: its tries go there, never to another.
   */
  static String sendNote(Context context, String id, int assistant) {
    synchronized (SENDING) {
      while (SENDING.contains(id))
        try {
          SENDING.wait();
        } catch (InterruptedException ex) {
          Thread.currentThread().interrupt();
          return tr("bb couldn't be reached. Try again.");
        }
      SENDING.add(id);
    }
    try {
      return sendNoteOnce(context, id, assistant);
    } finally {
      synchronized (SENDING) {
        SENDING.remove(id);
        SENDING.notifyAll();
      }
    }
  }

  private static String sendNoteOnce(Context context, String id, int to) {
    HistoryEntry entry = load(context, id);
    if (entry == null) return tr("This note was deleted.");
    // Sent meanwhile (by the outbox, or a Retry before this one): nothing to do.
    if (entry.json.has("chiefThread") && !entry.json.has("chiefFailed")) return null;
    String said = entry.json.optString("original", entry.text());
    // The same request ID on every try: the chief's reply finds the note, and a try that may
    // have arrived isn't sent twice.
    boolean again = entry.json.has("chiefFailed") && !entry.json.optString("chiefRequest").isEmpty();
    int assistant = again || to < 0 ? Assistants.of(entry.json) : Assistants.clamp(to);
    BbBridge bb = new BbBridge(context, assistant);
    String chief = bb.chiefId(), request = again ? entry.json.optString("chiefRequest") : ChiefText.requestId();
    long asked = SystemClock.elapsedRealtime();
    String why = null;
    BbBridge.Sent sent = null;
    try {
      if (chief.isEmpty() || !bb.connected())
        throw new IOException(tr("No chief of staff is set up. Set one up in Settings → bb."));
      Attachments attachments = new Attachments(context);
      sent =
          bb.sendRequest(
              chief, said, attachments.texts(entry.recordingId()), attachments.binaries(entry.recordingId()), request, again);
    } catch (Exception ex) {
      why =
          ex.getClass() == IOException.class && ex.getMessage() != null
              ? ex.getMessage()
              : tr("bb couldn't be reached. Try again.");
    }
    String failed = why;
    BbBridge.Sent files = sent;
    long ms = SystemClock.elapsedRealtime() - asked;
    try {
      update(
          context,
          id,
          e -> {
            JSONObject step = e.step(CHIEF_STEP, CHIEF_TARGET, ms, null, failed);
            // Activity: how many files went along, and how ("upload", or "base64" as a fallback).
            if (files != null && files.files() > 0) step.put("files", files.files()).put("filesHow", files.how());
            if (files != null && files.refused() > 0) step.put("uploadRefused", files.refused());
            if (files != null && !files.failed().isEmpty()) step.put("filesFailed", String.join("; ", files.failed()));
            e.json.put("route", "chief").put("chiefRequest", request).put("assistant", assistant);
            if (failed != null) {
              Outbox.failed(e.json, failed, e.json.optInt("chiefTries") + 1, System.currentTimeMillis());
              return;
            }
            Outbox.sent(e.json);
            e.json
                .put("chiefThread", chief)
                .put("chiefLink", bb.threadLink(chief))
                .put("chiefSent", System.currentTimeMillis());
          });
    } catch (Exception ex) {
      return failed == null ? friendly(ex) : failed;
    }
    String key = "chief:" + request;
    if (failed != null) Outbox.failure(context, key, "chief", "Note to you, request " + request, failed, assistant);
    else if (again) {
      Outbox.resolved(context, key);
      Outbox.worked(context, assistant);
    } else if (Outbox.failuresWaiting(context) > 0) Outbox.worked(context, assistant); // A failure is kept for each queued note.
    return failed;
  }

  /** The note went to the chief of staff. */
  static boolean sentToChief(HistoryEntry entry) {
    return entry.json.has("chiefThread") && !entry.json.has("chiefFailed");
  }

  /** The assistant the note that sent this request went to; -1 when there's no such note. */
  static int assistantOf(Context context, String request) {
    synchronized (NOTES) {
      try (HistoryStore h = new HistoryStore(context)) {
        for (HistoryEntry e : h.list(200, 0))
          if (request.equals(e.json.optString("chiefRequest"))) return Assistants.of(e.json);
      } catch (Exception ignored) {
        /* Then every assistant's topic is looked at. */
      }
    }
    return -1;
  }

  /** Keeps the chief's text back with the note that asked for it (found by its request ID). */
  static void keepReply(Context context, String request, String text) {
    synchronized (NOTES) {
      try (HistoryStore h = new HistoryStore(context)) {
        for (HistoryEntry e : h.list(200, 0))
          if (request.equals(e.json.optString("chiefRequest"))) {
            e.json.put("chiefReply", text).put("chiefReplyAt", System.currentTimeMillis());
            h.save(e);
            context
                .getSharedPreferences("settings", MODE_PRIVATE)
                .edit()
                .putLong("historyRevision", System.nanoTime())
                .apply();
            return;
          }
      } catch (Exception ignored) {
        /* The text was still shown or copied. */
      }
    }
  }

  // ------------------------------------------------------------------ recording

  /** keyAssistant: the assistant whose volume key started it (-1: the tile, the bubble). */
  private void startRecording(int keyAssistant) throws Exception {
    if (isBusy()) return;
    adoptLeftover(); // never blocks: an old recording becomes a note to retry
    if (audio(this).exists()) throw new IOException(tr("Could not delete saved audio. Try again after restarting Dictate & Delegate."));
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
      throw new IOException(tr("Allow microphone access in Dictate & Delegate first."));
    requireKey(this);
    foreground(true);
    newSession(keyAssistant);
    vault.remove("progress");
    prefs.edit().remove("recordingId").commit();
    prefs.edit().putString("sessionModel", new Profile(prefs).fixedModel()).commit();
    prefs
        .edit()
        .putString("sessionId", java.util.UUID.randomUUID().toString())
        .putLong("sessionCreated", System.currentTimeMillis())
        .commit();
    recorder = new PcmRecorder();
    try {
      recorder.start(
          audio(this),
          () ->
              main.post(
                  () -> {
                    if (RECORDING.equals(state)) stopRecording(false);
                  }));
    } catch (Exception ex) {
      recorder = null;
      foreground(false);
      throw ex;
    }
    // User controls the lifetime. No timeout or voice-activity/silence detector ends recording.
    wake.acquire();
    started = SystemClock.elapsedRealtime();
    transition(RECORDING, tr("Recording until you tap Stop. Switch apps freely."));
    main.post(ticker);
  }

  private void stopRecording(boolean transcribe) {
    if (!RECORDING.equals(state)) return;
    transition(STOPPING, tr("Saving recording…"));
    main.removeCallbacks(ticker);
    PcmRecorder current = recorder;
    recorder = null;
    worker.execute(
        () -> {
          Exception failure = current.stop();
          // The recording becomes a note of its own at once, so the next one can start.
          String id = "";
          Exception kept = null;
          try {
            boolean go = failure == null && transcribe;
            if (audio(this).length() >= 2) id = go ? handOver("pending", session) : handOver("needs attention");
          } catch (Exception ex) {
            kept = ex;
          }
          String note = id;
          Exception handOverFailed = kept;
          main.post(
              () -> {
                if (!alive) {
                  if (!note.isEmpty()) JOBS.remove(note); // never started: it stays to retry
                  return;
                }
                if (wake.isHeld()) wake.release();
                foreground(false);
                if (handOverFailed != null) {
                  transition(ERROR, friendly(handOverFailed));
                  return;
                }
                if (note.isEmpty()) {
                  try {
                    clearPending();
                    transition(EMPTY, tr("No audio captured. Ready to try again."));
                  } catch (IOException ex) {
                    transition(ERROR, friendly(ex));
                  }
                  return;
                }
                session.noteId = note;
                if (failure != null || !transcribe) {
                  String why = failure == null ? tr("Recording interrupted.") : friendly(failure);
                  session.message = tr("%1$s It's kept in your notes; ↻ writes it down.", why);
                  transition(UNFINISHED, why);
                } else startJob(JOBS.get(note), true);
              });
        });
  }

  /**
   * An assistant's 📞 while recording: the recording so far becomes the start of a hands-free call
   * with that assistant's chief. The audio goes to hands-free mode (through RecordActivity, which
   * may start the microphone service), this dictation ends without a note, and listening goes on
   * there.
   */
  private void callChief(int assistant) {
    if (!RECORDING.equals(state)) return;
    transition(STOPPING, tr("Starting the call…"));
    main.removeCallbacks(ticker);
    // The call panel takes the dictation panel's place.
    int atX = bubble != null ? layout.x : -1, atY = bubble != null ? layout.y : -1;
    PcmRecorder current = recorder;
    recorder = null;
    worker.execute(
        () -> {
          current.stop();
          File seed = new File(getCacheDir(), "handsfree-seed.pcm");
          try {
            java.nio.file.Files.copy(audio(this).toPath(), seed.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
          } catch (IOException ex) {
            seed.delete();
          }
          main.post(
              () -> {
                if (!alive) return;
                if (wake.isHeld()) wake.release();
                foreground(false);
                new Attachments(this).clearPending();
                try {
                  clearPending();
                } catch (IOException ignored) {
                  /* The seed copy is what matters now. */
                }
                startActivity(
                    new Intent(this, RecordActivity.class)
                        .putExtra(RecordActivity.HANDS_FREE_SEED, seed.exists() ? seed.getPath() : "")
                        .putExtra(HandsFreeService.AT_X, atX)
                        .putExtra(HandsFreeService.AT_Y, atY)
                        .putExtra(RecordActivity.ASSISTANT, assistant)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
                transition(READY, tr("Tap the bubble to record"));
              });
        });
  }

  /** ✕ while recording: the audio is thrown away, nothing is transcribed or sent, so it costs nothing. */
  private void cancelRecording() {
    if (!RECORDING.equals(state)) return;
    transition(STOPPING, tr("Cancelling…"));
    main.removeCallbacks(ticker);
    PcmRecorder current = recorder;
    recorder = null;
    worker.execute(
        () -> {
          current.stop();
          main.post(
              () -> {
                if (!alive) return;
                if (wake.isHeld()) wake.release();
                foreground(false);
                new Attachments(this).clearPending();
                try {
                  clearPending();
                } catch (IOException ex) {
                  transition(ERROR, friendly(ex));
                  return;
                }
                Toast.makeText(this, tr("Cancelled. Nothing was transcribed or sent."), Toast.LENGTH_SHORT).show();
                transition(READY, tr("Tap the bubble to record"));
              });
        });
  }

  // ------------------------------------------------------------------ writing it down

  /**
   * A recording being written down, on its own thread (transcribers), so a new recording never
   * waits for one that is trying again. Its control stops it (Stop trying), also mid-upload.
   */
  static final class Job {
    final String id, recordingId;
    final OpenRouter.Control control = new OpenRouter.Control(OpenRouter.RETRY_BUDGET_MS);
    /** The dictation it belongs to; the panel shows it while that is the panel's. */
    final Session session;
    /** Discard while it ran: the audio goes once it stopped. */
    volatile boolean discard;
    /** Stop trying was tapped: an answer that still comes is kept, but nothing more is started. */
    volatile boolean stopped;
    /** Its thread runs (a job only registered isn't yet). */
    volatile boolean started;

    Job(String id, String recordingId, Session session) {
      this.id = id;
      this.recordingId = recordingId;
      this.session = session;
    }
  }

  /** The recordings being written down now, by note ID. */
  static final java.util.Map<String, Job> JOBS = new ConcurrentHashMap<>();

  /**
   * Where a recording's audio waits until it's written down (then it moves to AudioArchive, whose
   * folder is "recordings" and is pruned: never the same).
   */
  static File recordings(Context context) {
    return new File(context.getNoBackupFilesDir(), "unsent");
  }

  static File recording(Context context, String id) {
    return new File(recordings(context), id + ".pcm");
  }

  /** The note (or a redo of it) is being written down right now. */
  static boolean transcribing(String noteId) {
    for (Job j : JOBS.values()) if (j.id.equals(noteId) || j.recordingId.equals(noteId)) return true;
    return false;
  }

  /** The recordings kept to retry: audio waiting, nothing writing it down. Newest first. */
  static java.util.List<String> unfinished(Context context) {
    File[] files = recordings(context).listFiles();
    java.util.List<File> kept = new java.util.ArrayList<>();
    if (files != null)
      for (File f : files)
        if (f.getName().endsWith(".pcm") && !JOBS.containsKey(f.getName().substring(0, f.getName().length() - 4))) kept.add(f);
    kept.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
    java.util.List<String> ids = new java.util.ArrayList<>();
    for (File f : kept) ids.add(f.getName().substring(0, f.getName().length() - 4));
    return ids;
  }

  /**
   * The recording in pending.pcm becomes a note with its own audio file, with status: pending.pcm
   * is free for the next recording at once. What was attached while recording belongs to it.
   */
  private String handOver(String status) throws Exception {
    return handOver(status, null);
  }

  /** The same; with a session, its job is registered before the file moves (nothing else takes it). */
  private String handOver(String status, Session s) throws Exception {
    File pcm = audio(this);
    String id = prefs.getString("sessionId", "");
    if (id.isEmpty()) id = java.util.UUID.randomUUID().toString();
    String recordingId = prefs.getString("recordingId", "");
    if (recordingId.isEmpty()) recordingId = id;
    if (s != null) JOBS.put(id, new Job(id, recordingId, s));
    try {
      return handOver(status, id, recordingId);
    } catch (Exception ex) {
      if (s != null) JOBS.remove(id);
      throw ex;
    }
  }

  private String handOver(String status, String id, String recordingId) throws Exception {
    File pcm = audio(this);
    String model = prefs.getString("sessionModel", new Profile(prefs).fixedModel());
    if (model.isEmpty()) model = new Profile(prefs).fixedModel();
    File to = recording(this, id);
    recordings(this).mkdirs();
    java.nio.file.Files.move(pcm.toPath(), to.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    synchronized (NOTES) {
      try (HistoryStore history = new HistoryStore(this)) {
        HistoryEntry entry = history.get(id);
        if (entry == null) {
          entry = HistoryEntry.create(id, model, to.length() / (double) AudioFiles.BYTES_PER_SECOND);
          entry.json.put("recordingId", recordingId);
          entry.json.put("created", prefs.getLong("sessionCreated", System.currentTimeMillis()));
          // Carry forward a version 1.0 checkpoint, whose billing metadata was not recorded.
          String legacy = vault.get("progress");
          if (!legacy.isEmpty()) {
            JSONObject old = new JSONObject(legacy);
            entry
                .json
                .put("offset", old.optLong("offset"))
                .put("text", old.optString("text"))
                .put("unpriced", old.optLong("offset") > 0 ? 1 : 0);
          }
        }
        entry.json.put("status", status);
        if (recordingId.equals(id)) {
          Attachments attachments = new Attachments(this);
          attachments.claimPending(id);
          int attached = attachments.of(id).size();
          if (attached > 0) entry.json.put("attached", attached);
        }
        history.save(entry);
      }
    }
    vault.remove("progress");
    prefs
        .edit()
        .remove("sessionModel")
        .remove("sessionId")
        .remove("sessionCreated")
        .remove("recordingId")
        .putLong("historyRevision", System.nanoTime())
        .commit();
    return id;
  }

  /** A recording left in pending.pcm while nothing records becomes a note to retry. */
  private void adoptLeftover() {
    if (recorder != null || isBusy()) return;
    File pcm = audio(this);
    if (!pcm.exists()) return;
    try {
      if (pcm.length() < 2) clearPending();
      else handOver("needs attention");
    } catch (Exception ignored) {
      /* It stays where it is; the next start tries again. */
    }
  }

  /** Notes whose writing down was cut off (the app stopped) say so, and can be retried. */
  static void markOrphans(Context context) {
    java.util.List<String> ids = unfinished(context);
    if (ids.isEmpty()) return;
    synchronized (NOTES) {
      try (HistoryStore history = new HistoryStore(context)) {
        for (String id : ids) {
          HistoryEntry e = history.get(id);
          if (e != null && e.json.optString("status").equals("pending")) {
            e.json.put("status", "needs attention");
            history.save(e);
          }
        }
      } catch (Exception ignored) {
        /* They still show as unfinished. */
      }
    }
  }

  /** Retry: writes a kept recording down again, on the panel unless you're recording. */
  private void retryNote(String id) throws IOException {
    if (JOBS.containsKey(id)) return;
    if (!recording(this, id).exists()) throw new IOException(tr("The audio of this recording is gone. Its text so far is in your notes."));
    HistoryEntry e = load(this, id);
    if (e == null) throw new IOException(tr("This note was deleted."));
    Session s;
    boolean show = !isBusy();
    if (show && UNFINISHED.equals(state) && id.equals(session.noteId)) s = session; // ↻: choices made stay
    else if (show) {
      newSession();
      s = session;
      s.noteId = id;
    } else {
      s = new Session();
      s.noteId = id;
    }
    Job job = new Job(id, e.recordingId(), s);
    if (JOBS.putIfAbsent(id, job) != null) return;
    startJob(job, show);
  }

  /**
   * Stop trying: the panel is free at once and the recording stays in the notes, to retry. If it
   * went out whole already, its answer is still taken when it comes (the model may be charging).
   */
  private void stopTrying(Session s) {
    Job j = JOBS.get(s.noteId);
    if (j != null) {
      j.stopped = true;
      j.control.cancel();
    }
    Toast.makeText(this, tr("Stopped. The recording is kept in your notes; retry it there."), Toast.LENGTH_LONG).show();
    newSession();
    transition(READY, tr("Tap the bubble to record"));
  }

  /** Throws a kept recording's audio away (once it stopped, if it's being written down). */
  static void discard(Context context, String id) {
    Job j = JOBS.get(id);
    if (j != null) {
      j.discard = true;
      j.control.kill();
      return;
    }
    recording(context, id).delete();
    synchronized (NOTES) {
      try (HistoryStore history = new HistoryStore(context)) {
        HistoryEntry e = history.get(id);
        if (e != null && !e.json.optString("status").equals("complete") && !e.json.optString("status").equals("no speech")) {
          e.json.put("status", "audio discarded");
          history.save(e);
        }
      } catch (Exception ignored) {
        /* The audio is gone; the note may still say unfinished. */
      }
    }
    context.getSharedPreferences("settings", MODE_PRIVATE).edit().putLong("historyRevision", System.nanoTime()).apply();
  }

  /** What the panel says while it tries again. */
  static String retryLine(int attempt, long waitMs, String why) {
    long seconds = (waitMs + 999) / 1000;
    return seconds <= 0
        ? tr("Transcribing… %1$s, trying again now (try %2$d).", why, attempt + 1)
        : tr("Transcribing… %1$s, trying again in %2$d s (try %3$d).", why, seconds, attempt + 1);
  }

  /** Starts a job registered in JOBS; show: the panel shows it. */
  private void startJob(Job job, boolean show) {
    if (job == null) {
      // Never registered (the service went away meanwhile): kept in the notes to retry.
      session.message = tr("Not written down: %1$s It's kept in your notes; ↻ tries again.", tr("Recording interrupted."));
      transition(UNFINISHED, tr("Recording interrupted."));
      return;
    }
    job.started = true;
    String id = job.id;
    Session s = job.session;
    job.control.onRetry(
        (attempt, waitMs, why) ->
            main.post(
                () -> {
                  if (session != s || !UPLOADING.equals(state)) return;
                  s.message = retryLine(attempt, waitMs, why);
                  renderBubble();
                }));
    if (show) {
      s.message = "";
      transition(UPLOADING, tr("Transcribing… You can keep using other apps, or record something new."));
    }
    prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
    try {
      transcribers.execute(() -> transcribe(job));
    } catch (RejectedExecutionException ex) {
      JOBS.remove(id); // The service is going away; the note stays to retry.
    }
  }

  /** Writes one recording down, chunk by chunk, resuming where an earlier try stopped. */
  private void transcribe(Job job) {
    String id = job.id;
    File pcm = recording(this, id);
    PowerManager.WakeLock lock =
        getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Dictate & Delegate:transcribe");
    lock.setReferenceCounted(false);
    lock.acquire(15 * 60_000L);
    long uploadStarted = SystemClock.elapsedRealtime();
    String failed = null, transcript = "";
    boolean cancelled = false, empty = false, redo = false;
    try (HistoryStore history = new HistoryStore(this)) {
      HistoryEntry entry;
      synchronized (NOTES) {
        entry = history.get(id);
      }
      if (entry == null) throw new IOException(tr("This note was deleted."));
      if (job.control.cancelled()) throw new OpenRouter.Cancelled(null);
      if (!pcm.exists()) throw new IOException(tr("The audio of this recording is gone. Its text so far is in your notes."));
      if (entry.json.optString("status").equals("needs attention")) entry.json.put("status", "pending");
      entry.json.remove("transcribeFailed");
      String model = entry.model();
      OpenRouter openRouter = new OpenRouter(this);
      // No language: the speech models detect it, also when you switch mid-note.
      java.util.List<String> words = new Profile(prefs).hintWords();
      while (entry.offset() < (pcm.length() & ~1L)) {
        if (job.control.cancelled() || !alive) throw new OpenRouter.Cancelled(null);
        AudioFiles.Chunk chunk = AudioFiles.readChunk(pcm, entry.offset());
        entry.beginRequest();
        save(history, entry); // A lost response leaves an explicit unknown charge.
        long asked = SystemClock.elapsedRealtime();
        OpenRouter.Result result;
        try {
          result = openRouter.transcribe(chunk.wav(), model, words, job.control);
        } catch (Exception failure) {
          entry.step("speech", model, SystemClock.elapsedRealtime() - asked, null, friendly(failure));
          save(history, entry);
          throw failure;
        }
        entry.accept(result, chunk.nextOffset());
        entry.step("speech", model, SystemClock.elapsedRealtime() - asked, result.cost(), null);
        save(history, entry); // Text, cost, and resume offset commit together.
      }
      empty = entry.text().isBlank();
      if (!empty && !entry.json.has("raw")) {
        // "raw" stays what the speech model wrote; "original" and "processed" are the two
        // versions you can switch between and edit.
        entry.json.put("raw", entry.text()).put("original", entry.text());
      }
      entry.json.put("status", empty ? "no speech" : "complete");
      entry.json.put("processingMs", entry.json.optLong("processingMs") + SystemClock.elapsedRealtime() - uploadStarted);
      save(history, entry);
      Outbox.resolved(this, "recording:" + id);
      redo = !entry.recordingId().equals(entry.id());
      synchronized (NOTES) {
        // Deleted right after the last save: nothing of it is kept.
        if (history.get(id) == null) throw new IOException(tr("This note was deleted."));
        if (!empty && redo) history.prefer(entry);
        new AudioArchive(this).retain(entry.recordingId(), pcm);
      }
      pcm.delete();
      transcript = entry.text();
      if (!empty) vault.put("transcript", transcript);
    } catch (Exception ex) {
      cancelled = ex instanceof OpenRouter.Cancelled || job.control.cancelled() || job.discard;
      failed = friendly(ex);
      synchronized (NOTES) {
        try (HistoryStore history = new HistoryStore(this)) {
          HistoryEntry entry = history.get(id);
          if (entry != null
              && !entry.json.optString("status").equals("complete")
              && !entry.json.optString("status").equals("no speech")) {
            entry.json.put("status", "needs attention").put("transcribeFailed", failed);
            history.save(entry);
          }
        } catch (Exception ignored) {
          /* Keep the original error and recoverable audio. */
        }
      }
      // For the next failure report: the recording is kept for Retry. Stop trying is yours.
      if (!cancelled)
        Outbox.failure(this, "recording:" + id, "recording", "Recording (writing it down)", failed);
    } finally {
      reporting.incrementAndGet(); // the service stays until finished() took the result
      JOBS.remove(id);
      if (job.discard) discard(this, id);
      if (lock.isHeld()) lock.release();
      prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
      String why = failed, text = transcript;
      boolean stopped = cancelled, nothing = empty, again = redo;
      main.post(() -> finished(job, why, stopped, nothing, text, again));
    }
  }

  /** Saves the job's copy of its note, unless the note was deleted meanwhile (then it stops). */
  private static void save(HistoryStore history, HistoryEntry entry) throws Exception {
    synchronized (NOTES) {
      if (history.get(entry.id()) == null) throw new IOException(tr("This note was deleted."));
      history.save(entry);
    }
  }

  /** A recording is written down (or not): on the panel if it's still the panel's, else a toast. */
  private void finished(Job job, String failed, boolean cancelled, boolean empty, String transcript, boolean redo) {
    reporting.decrementAndGet();
    if (!alive) return;
    Session s = job.session;
    boolean shown = session == s && UPLOADING.equals(state);
    if (failed == null && !empty) {
      s.noteId = job.id;
      s.transcript = transcript;
      s.redo = redo;
      s.ready = true;
      if (shown) {
        s.message = "";
        // The transcript comes first, on the panel to insert; never on the clipboard by itself.
        transition(COPIED, tr("Your text is ready to insert"));
      } else Toast.makeText(this, tr("An earlier recording is written down. It's in your notes."), Toast.LENGTH_LONG).show();
      // After Stop trying the text is kept (it was paid for), but nothing starts by itself.
      if (!job.stopped) decide(s);
    } else if (failed == null) {
      if (shown) transition(EMPTY, tr("No speech recognized. Ready to record again."));
    } else if (cancelled || job.discard) {
      if (shown) {
        if (!job.discard) Toast.makeText(this, failed, Toast.LENGTH_LONG).show();
        closePanel();
      }
    } else if (shown) {
      s.message = tr("Not written down: %1$s It's kept in your notes; ↻ tries again.", failed);
      transition(UNFINISHED, failed);
    } else
      Toast.makeText(this, tr("An earlier recording wasn't written down: %1$s It's kept in your notes to retry.", failed), Toast.LENGTH_LONG).show();
    if (closing && working == 0 && JOBS.isEmpty()) finishIdle();
  }

  static void copy(Context context, String text) {
    ClipData clip = ClipData.newPlainText("Dictate & Delegate transcript", text);
    PersistableBundle extras = new PersistableBundle();
    extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
    clip.getDescription().setExtras(extras);
    context.getSystemService(ClipboardManager.class).setPrimaryClip(clip);
  }

  private void clearPending() throws IOException {
    if (audio(this).exists() && !audio(this).delete())
      throw new IOException(tr("Could not delete saved audio. Try again after restarting Dictate & Delegate."));
    try (HistoryStore history = new HistoryStore(this)) {
      HistoryEntry entry = history.get(prefs.getString("sessionId", ""));
      if (entry != null
          && !entry.json.optString("status").equals("complete")
          && !entry.json.optString("status").equals("no speech")) {
        entry.json.put("status", "audio discarded");
        history.save(entry);
      }
    } catch (Exception ex) {
      throw new IOException(tr("Could not update history."), ex);
    }
    vault.remove("progress");
    prefs
        .edit()
        .remove("sessionModel")
        .remove("sessionId")
        .remove("sessionCreated")
        .remove("recordingId")
        .putLong("historyRevision", System.nanoTime())
        .commit();
  }

  static String friendly(Exception ex) {
    // Dictate & Delegate's own errors are plain IOExceptions with a translated message. Subclasses come from
    // the network stack (connection reset, TLS, timeouts) and carry raw English, if anything.
    if (ex.getClass() == IOException.class && ex.getMessage() != null) return ex.getMessage();
    if (ex instanceof OpenRouter.Cancelled) return ex.getMessage();
    if (ex instanceof java.io.FileNotFoundException
        || ex instanceof java.nio.file.FileSystemException
        || ex instanceof java.io.EOFException
        || (ex.getMessage() != null && ex.getMessage().contains("ENOSPC")))
      return tr("Dictate & Delegate couldn't read or write its files. Check available storage, then retry.");
    if (ex instanceof IOException)
      return tr("The connection to OpenRouter was lost. Check your internet connection, then retry.");
    return tr(
            "Could not complete this action. Check microphone permission, available storage and"
                + " your saved key, then retry.");
  }

  @Override
  public void onDestroy() {
    alive = false;
    main.removeCallbacksAndMessages(null);
    if (recorder != null) recorder.stop();
    stopListening();
    worker.shutdownNow();
    // What's being written down stops and stays in the notes, to retry.
    for (Job j : JOBS.values()) {
      j.control.kill();
      if (!j.started) JOBS.remove(j.id); // registered, never run: kept in the notes to retry
    }
    transcribers.shutdownNow();
    actions.shutdownNow();
    inserter.shutdownNow();
    if (wake.isHeld()) wake.release();
    if (bubble != null) {
      windows.removeView(bubble);
      bubble = null;
    }
    instance = null;
    DictationTile.refresh(this);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
