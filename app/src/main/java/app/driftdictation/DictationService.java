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
 * panel offers Insert, Refine and Chief. Jev decides what starts by itself: Refine when the
 * dictation asks for a text or names a template, the chief only when it was explicitly addressed.
 * Refine and Chief can be chosen while recording; they run once the transcript is ready.
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
      EMPTY = "empty";

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
    /** Jev answered or isn't asked; until then queued choices wait (a template may come). */
    volatile boolean decided, hint, redo, chiefReady;
    volatile TalkAccessibility.Inserted inserted;
    volatile String insertedKind = "";
    /** Refine was started by Jev, not tapped: it yields to the chief. */
    volatile boolean autoRefine;
    /** Counts Refine runs; a run whose number is no longer current is ignored when it ends. */
    volatile int refineRun;
  }

  static volatile DictationService instance;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final ExecutorService actions = Executors.newFixedThreadPool(3);
  private final ExecutorService inserter = Executors.newSingleThreadExecutor();
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

  private boolean isBusy() {
    return RECORDING.equals(state) || STOPPING.equals(state) || UPLOADING.equals(state);
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
    if (audio(this).exists()) {
      state = ERROR;
      detail = tr("Saved recording found. Open Dictate & Delegate to retry or discard.");
      main.postDelayed(finishFeedback, 3500);
    }
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
      } else if (RECORD.equals(action)) startRecording();
      else if (STOP.equals(action)) stopRecording(true);
      else if (CANCEL.equals(action)) cancelRecording();
      else if (COMPARE.equals(action) && !isBusy()) {
        if (audio(this).exists())
          throw new IOException(tr("Finish or discard the pending recording first."));
        String id = intent.getStringExtra("recordingId"), model = intent.getStringExtra("model");
        if (model == null || model.isBlank()) throw new IOException(tr("Choose a model first."));
        requireKey(this);
        File saved = new AudioArchive(this).get(id);
        if (saved == null)
          throw new IOException(tr("Audio has expired or was deleted. Text is still saved."));
        java.nio.file.Files.copy(saved.toPath(), audio(this).toPath());
        String session = intent.getStringExtra("sessionId");
        prefs
            .edit()
            .putString("recordingId", id)
            .putString("sessionModel", model)
            .putString(
                "sessionId",
                session == null || session.isBlank()
                    ? java.util.UUID.randomUUID().toString()
                    : session)
            .putLong("sessionCreated", System.currentTimeMillis())
            .commit();
        newSession();
        upload();
      } else if (RETRY.equals(action) && !isBusy()) {
        newSession();
        upload();
      } else if (DISCARD.equals(action) && !isBusy()) {
        clearPending();
        transition(READY, tr("Tap the bubble to record"));
      } else if (HIDE.equals(action)) {
        prefs.edit().putString("bubbleMode", "never").apply();
        update();
        if (!isBusy()) finishIdle();
      } else if (CONFIGURE.equals(action)) {
        update();
        if (!isBusy() && !"always".equals(mode()) && !done(state)) finishIdle();
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
    stopListening();
    session = new Session();
    session.chiefReady = BbBridge.ready(this);
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
        if (done(state) || EMPTY.equals(state)) {
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
    if (working > 0) {
      closing = true; // Refine or the chief are still running; their results are saved.
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
                else closePanel();
              }

              public void stop() {
                if (RECORDING.equals(state)) stopRecording(true);
              }

              public void call() {
                callChief();
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

              public void chief() {
                tapChief();
              }

              public void insertFromChief() {
                if (!session.reply.isEmpty()) insertText("chief", session.reply);
              }

              public void tapIcon() {
                if (isBusy()) return;
                if (audio(DictationService.this).exists() || ERROR.equals(state)) {
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
    bubble.render(
        new FloatingPanel.Model(
            state,
            RECORDING.equals(state) ? SystemClock.elapsedRealtime() - started : 0,
            RECORDING.equals(state) ? new Attachments(this).pending().size() : 0,
            s.refine,
            s.chief,
            s.chiefReady || !s.chief.equals(IDLE),
            s.hint,
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
        s.autoRefine = false;
        startQueued();
      }
    }
    renderBubble();
    touch();
  }

  /** Chief: chosen ahead while recording, sent once the transcript is ready; then opens the chat. */
  private void tapChief() {
    Session s = session;
    switch (s.chief) {
      case QUEUED -> s.chief = IDLE;
      case RUNNING -> {}
      case DONE -> {
        if (s.chiefLink.isEmpty()) say(tr("Set the bb web address for links in Settings → bb."));
        else
          try {
            startActivity(
                BbBridge.view(s.chiefLink));
          } catch (ActivityNotFoundException ex) {
            say(tr("No browser available"));
          }
      }
      default -> {
        if (!BbBridge.ready(this)) {
          say(tr("Set up your chief of staff in Dictate & Delegate → Settings → bb."));
          return;
        }
        s.chief = QUEUED;
        dropAutoRefine(s);
        startQueued();
      }
    }
    renderBubble();
    touch();
  }

  /** The chief gets it as said: a Refine that Jev started (not one you tapped) is dropped. */
  private void dropAutoRefine(Session s) {
    if (!s.autoRefine) return;
    if (s.refine.equals(QUEUED) || s.refine.equals(RUNNING)) {
      s.refine = IDLE;
      s.refineRun++;
    }
    s.autoRefine = false;
  }

  /** Runs what's queued, once the transcript is there and Jev has answered (or isn't asked). */
  private void startQueued() {
    Session s = session;
    if (!done(state) || !s.decided || s.noteId.isEmpty()) return;
    if (s.refine.equals(QUEUED)) {
      s.refine = RUNNING;
      String template = s.template;
      int run = ++s.refineRun;
      work(() -> refined(s, run, refineNote(this, s.noteId, new Profile(prefs), template)));
    }
    if (s.chief.equals(QUEUED)) {
      s.chief = RUNNING;
      work(() -> sent(s, sendNote(this, s.noteId)));
    }
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

  /** Jev, right after the transcript: what starts by itself, the template, the chief hint. */
  private void decide() {
    Session s = session;
    Profile profile = new Profile(prefs);
    boolean chiefReady = BbBridge.ready(this);
    java.util.List<String> templates = new Templates(this).names();
    String said = s.transcript;
    // The chief is only asked about when its name comes up.
    boolean named = chiefReady && Jev.mentions(said, profile.chiefName());
    if (s.redo || (!profile.autoRefine() && !named && templates.isEmpty())) {
      s.decided = true;
      startQueued();
      return;
    }
    String id = s.noteId;
    work(
        () -> {
          Jev.Answers a = null;
          String failed = null;
          long asked = SystemClock.elapsedRealtime();
          try {
            a = Jev.ask(this, said, templates, profile.autoRefine(), named ? profile.chiefName() : "");
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
          Jev.Decision d =
              Jev.decide(answers, profile.autoRefine(), profile.autoChief(), chiefReady, named);
          main.post(
              () -> {
                if (session != s) return;
                s.decided = true;
                s.template = d.template();
                s.hint = d.hint();
                if (d.chief() && s.chief.equals(IDLE)) s.chief = QUEUED;
                // What goes to the chief goes as said: Jev's Refine only when it doesn't.
                if (d.refine() && s.refine.equals(IDLE) && s.chief.equals(IDLE)) {
                  s.refine = QUEUED;
                  s.autoRefine = true;
                }
                startQueued();
                renderBubble();
              });
        });
  }

  /** Refine finished (failure: why, else null). */
  private void refined(Session s, int run, String failed) {
    if (run != s.refineRun && failed == null) {
      // Dropped for the chief: the note shows what was said; the refined text stays a version.
      try {
        update(this, s.noteId, e -> e.json.put("version", "original").put("text", e.json.optString("original", e.text())));
      } catch (Exception ignored) {
        /* The note just opens on the refined version. */
      }
    }
    String text = failed == null ? text(this, s.noteId) : "";
    main.post(
        () -> {
          prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
          if (run != s.refineRun) return; // Dropped: the dictation went to the chief meanwhile.
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
                    : tr("Not sent to your chief of staff: %1$s", failed == null ? "" : failed);
          } else {
            s.chief = DONE;
            s.chiefLink = e.json.optString("chiefLink");
            s.request = e.json.optString("chiefRequest");
            s.message = tr("Sent to your chief of staff");
            if (bubble == null && session == s) Toast.makeText(this, tr("Sent to chief of staff"), Toast.LENGTH_LONG).show();
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
    BbBridge bb = new BbBridge(this);
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
      return sendNoteOnce(context, id);
    } finally {
      synchronized (SENDING) {
        SENDING.remove(id);
        SENDING.notifyAll();
      }
    }
  }

  private static String sendNoteOnce(Context context, String id) {
    HistoryEntry entry = load(context, id);
    if (entry == null) return tr("This note was deleted.");
    // Sent meanwhile (by the outbox, or a Retry before this one): nothing to do.
    if (entry.json.has("chiefThread") && !entry.json.has("chiefFailed")) return null;
    String said = entry.json.optString("original", entry.text());
    BbBridge bb = new BbBridge(context);
    // The same request ID on every try: the chief's reply finds the note, and a try that may
    // have arrived isn't sent twice.
    boolean again = entry.json.has("chiefFailed") && !entry.json.optString("chiefRequest").isEmpty();
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
            e.json.put("route", "chief").put("chiefRequest", request);
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
    if (failed != null) Outbox.failure(context, key, "chief", "Note to you, request " + request, failed);
    else if (again) {
      Outbox.resolved(context, key);
      Outbox.worked(context);
    } else if (Outbox.failuresWaiting(context) > 0) Outbox.worked(context); // A failure is kept for each queued note.
    return failed;
  }

  /** The note went to the chief of staff. */
  static boolean sentToChief(HistoryEntry entry) {
    return entry.json.has("chiefThread") && !entry.json.has("chiefFailed");
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

  private void startRecording() throws Exception {
    if (isBusy()) return;
    if (audio(this).exists()) {
      transition(ERROR, tr("A saved recording needs retry or discard first."));
      return;
    }
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
      throw new IOException(tr("Allow microphone access in Dictate & Delegate first."));
    requireKey(this);
    foreground(true);
    newSession();
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
          main.post(
              () -> {
                if (!alive) return;
                if (wake.isHeld()) wake.release();
                foreground(false);
                if (failure != null || !transcribe) {
                  transition(
                      ERROR,
                      failure == null
                          ? tr("Recording interrupted. Saved audio can be retried.")
                          : friendly(failure));
                } else upload();
              });
        });
  }

  /**
   * 📞 while recording: the recording so far becomes the start of a hands-free call. The audio
   * goes to hands-free mode (through RecordActivity, which may start the microphone service), this
   * dictation ends without a note, and listening goes on there.
   */
  private void callChief() {
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

  private void upload() {
    File pcm = audio(this);
    if (pcm.length() < 2) {
      try {
        clearPending();
        transition(EMPTY, tr("No audio captured. Ready to try again."));
      } catch (IOException ex) {
        transition(ERROR, friendly(ex));
      }
      return;
    }
    transition(UPLOADING, tr("Transcribing… You can keep using other apps."));
    wake.acquire(30 * 60 * 1000L);
    String existingId = prefs.getString("sessionId", "");
    final String sessionId =
        existingId.isEmpty() ? java.util.UUID.randomUUID().toString() : existingId;
    prefs
        .edit()
        .putString("sessionId", sessionId)
        .putString("recordingId", prefs.getString("recordingId", sessionId))
        .commit();
    worker.execute(
        () -> {
          long uploadStarted = SystemClock.elapsedRealtime();
          try (HistoryStore history = new HistoryStore(this)) {
            String model = prefs.getString("sessionModel", new Profile(prefs).fixedModel());
            HistoryEntry entry = history.get(sessionId);
            if (entry == null) {
              entry =
                  HistoryEntry.create(
                      sessionId, model, pcm.length() / (double) AudioFiles.BYTES_PER_SECOND);
              entry.json.put("recordingId", prefs.getString("recordingId", sessionId));
              entry.json.put(
                  "created", prefs.getLong("sessionCreated", System.currentTimeMillis()));
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
              history.save(entry);
              vault.remove("progress");
            }
            OpenRouter openRouter = new OpenRouter(this);
            Profile profile = new Profile(prefs);
            // No language: the speech models detect it, also when you switch mid-note.
            java.util.List<String> words = profile.hintWords();
            while (entry.offset() < (pcm.length() & ~1L)) {
              if (Thread.currentThread().isInterrupted() || !alive) return;
              AudioFiles.Chunk chunk = AudioFiles.readChunk(pcm, entry.offset());
              entry.beginRequest();
              history.save(entry); // A lost response leaves an explicit unknown charge.
              long asked = SystemClock.elapsedRealtime();
              OpenRouter.Result result;
              try {
                result = openRouter.transcribe(chunk.wav(), model, words);
              } catch (Exception failed) {
                entry.step(
                    "speech", model, SystemClock.elapsedRealtime() - asked, null, friendly(failed));
                history.save(entry);
                throw failed;
              }
              entry.accept(result, chunk.nextOffset());
              entry.step(
                  "speech", model, SystemClock.elapsedRealtime() - asked, result.cost(), null);
              history.save(entry); // Text, cost, and resume offset commit together, including after
              // interruption.
              if (Thread.currentThread().isInterrupted() || !alive) return;
            }
            boolean empty = entry.text().isBlank();
            if (!empty && !entry.json.has("raw")) {
              // "raw" stays what the speech model wrote; "original" and "processed" are the two
              // versions you can switch between and edit.
              entry.json.put("raw", entry.text()).put("original", entry.text());
              // What was attached while recording belongs to this note (not to a redo of another).
              if (entry.recordingId().equals(entry.id())) {
                Attachments attachments = new Attachments(this);
                attachments.claimPending(entry.recordingId());
                int attached = attachments.of(entry.recordingId()).size();
                if (attached > 0) entry.json.put("attached", attached);
              }
            }
            entry.json.put("status", empty ? "no speech" : "complete");
            entry.json.put(
                "processingMs",
                entry.json.optLong("processingMs") + SystemClock.elapsedRealtime() - uploadStarted);
            synchronized (NOTES) {
              history.save(entry);
            }
            Outbox.resolved(this, "recording:" + sessionId);
            boolean redo = !entry.recordingId().equals(entry.id());
            if (!empty && redo) history.prefer(entry);
            new AudioArchive(this).retain(entry.recordingId(), pcm);
            if (empty) {
              main.post(
                  () -> {
                    if (!alive) return;
                    try {
                      clearPending();
                      transition(EMPTY, tr("No speech recognized. Ready to record again."));
                    } catch (IOException ex) {
                      transition(ERROR, friendly(ex));
                    } finally {
                      if (wake.isHeld()) wake.release();
                    }
                  });
              return;
            }
            prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
            vault.put("transcript", entry.text());
            String transcript = entry.text();
            main.post(
                () -> {
                  if (!alive) return;
                  try {
                    // The transcript comes first, on the panel to insert; never on the clipboard by itself.
                    clearPending();
                    session.noteId = sessionId;
                    session.transcript = transcript;
                    session.redo = redo;
                    transition(COPIED, tr("Your text is ready to insert"));
                    decide();
                  } catch (Exception ex) {
                    transition(ERROR, tr("Transcript saved in history. Open Dictate & Delegate to copy it."));
                  } finally {
                    if (wake.isHeld()) wake.release();
                  }
                });
          } catch (Exception ex) {
            try (HistoryStore history = new HistoryStore(this)) {
              HistoryEntry entry = history.get(sessionId);
              if (entry != null
                  && !entry.json.optString("status").equals("complete")
                  && !entry.json.optString("status").equals("no speech")) {
                entry.json.put("status", "needs attention");
                history.save(entry);
              }
            } catch (Exception ignored) {
              /* Keep the original error and recoverable audio. */
            }
            prefs.edit().putLong("historyRevision", System.nanoTime()).apply();
            // For the next failure report: the recording is kept for Retry.
            Outbox.failure(this, "recording:" + sessionId, "recording", "Recording (writing it down)", friendly(ex));
            main.post(
                () -> {
                  if (!alive) return;
                  if (wake.isHeld()) wake.release();
                  transition(ERROR, friendly(ex));
                });
          }
        });
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
