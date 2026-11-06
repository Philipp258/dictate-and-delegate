package app.driftdictation;

import android.accessibilityservice.AccessibilityService;
import android.content.*;
import android.media.AudioManager;
import android.os.*;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Dictate & Delegate's Accessibility service, used for two things only: holding a volume key starts or
 * stops a dictation (the chosen key for the first assistant; with a second assistant set up, the
 * other volume key for that one), and Insert puts text at the cursor of the field you're typing in. It asks for
 * no accessibility events, so it never sees what happens on screen; it looks up the focused field
 * only when you tap Insert. While it runs, it also takes the Copy button of the chief's ntfy
 * notifications (ntfy sends that as an implicit broadcast, which only a running receiver gets).
 */
public final class TalkAccessibility extends AccessibilityService {
  static volatile TalkAccessibility instance;

  /** Settings: which volume key starts (off, down, up) and how long to hold it. */
  static final String VOLUME_KEY = "volumeStart", HOLD_MS = "holdMs";

  static final String OFF = "off", DOWN = "down", UP = "up";
  static final int DEFAULT_HOLD_MS = 500;

  /** ntfy's broadcast action on the chief's paste message: copy that request's text. */
  static final String COPY_ACTION = "app.driftdictation.COPY_CHIEF_TEXT";

  private final Handler main = new Handler(Looper.getMainLooper());
  private SharedPreferences prefs;
  private boolean holding, fired;
  /** The key being held, and the assistant it starts a dictation for. */
  private int heldKey, heldAssistant;
  private final Runnable held =
      () -> {
        fired = true;
        holdFired();
      };
  private BroadcastReceiver copy;

  @Override
  protected void onServiceConnected() {
    super.onServiceConnected();
    instance = this;
    I18n.init(this);
    prefs = getSharedPreferences("settings", MODE_PRIVATE);
    copy = new ChiefText.CopyReceiver();
    registerReceiver(copy, new IntentFilter(COPY_ACTION), RECEIVER_EXPORTED);
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {
    /* None are requested. */
  }

  @Override
  public void onInterrupt() {}

  @Override
  public boolean onUnbind(Intent intent) {
    stop();
    return super.onUnbind(intent);
  }

  @Override
  public void onDestroy() {
    stop();
    super.onDestroy();
  }

  private void stop() {
    instance = null;
    main.removeCallbacksAndMessages(null);
    if (copy != null) {
      try {
        unregisterReceiver(copy);
      } catch (IllegalArgumentException ignored) {
        /* Already gone. */
      }
      copy = null;
    }
  }

  /** Whether Android has the service switched on for Dictate & Delegate (it may still be starting). */
  static boolean enabled(Context context) {
    String on =
        android.provider.Settings.Secure.getString(
            context.getContentResolver(),
            android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
    ComponentName me = new ComponentName(context, TalkAccessibility.class);
    if (on == null) return false;
    for (String s : on.split(":")) {
      ComponentName c = ComponentName.unflattenFromString(s);
      if (me.equals(c)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ volume keys

  /** The key code that starts a dictation, or 0 when the volume keys aren't used. */
  static int startKey(SharedPreferences prefs) {
    return switch (prefs.getString(VOLUME_KEY, OFF)) {
      case DOWN -> KeyEvent.KEYCODE_VOLUME_DOWN;
      case UP -> KeyEvent.KEYCODE_VOLUME_UP;
      default -> 0;
    };
  }

  /**
   * The other volume key, which starts a dictation for the second assistant: when a key is chosen
   * for the first, a second assistant has a chief, and it isn't switched off (Settings → Start).
   * 0 otherwise.
   */
  static int secondKey(SharedPreferences prefs) {
    return secondKey(startKey(prefs), secondOn(prefs));
  }

  /** A second assistant has a chief, and its key isn't switched off. */
  private static boolean secondOn(SharedPreferences prefs) {
    return prefs.getBoolean(Assistants.OTHER_KEY, true) && !prefs.getString(Assistants.key(1, BbBridge.CHIEF_ID), "").isEmpty();
  }

  /** The other volume key than first (0 when first is 0 or the second assistant's is off). */
  static int secondKey(int first, boolean secondOn) {
    if (first == 0 || !secondOn) return 0;
    return first == KeyEvent.KEYCODE_VOLUME_DOWN ? KeyEvent.KEYCODE_VOLUME_UP : KeyEvent.KEYCODE_VOLUME_DOWN;
  }

  /** The assistant a key starts a dictation for: 0, 1, or -1 when it isn't one of ours. */
  static int assistantFor(SharedPreferences prefs, int keyCode) {
    return assistantFor(keyCode, startKey(prefs), secondOn(prefs));
  }

  static int assistantFor(int keyCode, int first, boolean secondOn) {
    if (first != 0 && keyCode == first) return 0;
    int second = secondKey(first, secondOn);
    return second != 0 && keyCode == second ? 1 : -1;
  }

  static int holdMs(SharedPreferences prefs) {
    return Math.max(200, Math.min(2000, prefs.getInt(HOLD_MS, DEFAULT_HOLD_MS)));
  }

  /**
   * The chosen volume key is held back from Android until we know what it is: held long enough,
   * it starts or stops a dictation; a short press changes the volume as usual, re-sent here. With
   * the screen off or locked, or during a call, the key is left alone.
   */
  @Override
  protected boolean onKeyEvent(KeyEvent e) {
    int key = e.getKeyCode();
    int assistant = prefs == null ? -1 : assistantFor(prefs, key);
    if (holding ? key != heldKey : assistant < 0) return false;
    // During a hands-free call the volume keys are the volume, nothing else: a call doesn't start
    // dictations, and Android sends them to the call's media session (the replies' stream).
    if (HandsFreeService.instance != null && !holding) return false;
    if (e.getAction() == KeyEvent.ACTION_DOWN) {
      if (e.getRepeatCount() > 0) return holding;
      if (holding || !available()) return false;
      holding = true;
      fired = false;
      heldKey = key;
      heldAssistant = assistant;
      main.postDelayed(held, holdMs(prefs));
      return true;
    }
    if (e.getAction() != KeyEvent.ACTION_UP || !holding) return false;
    holding = false;
    main.removeCallbacks(held);
    if (!fired) {
      // A short press while recording stops; otherwise it's the volume, as if we weren't here.
      if (recording()) DictationService.send(this, DictationService.STOP);
      else
        getSystemService(AudioManager.class)
            .adjustSuggestedStreamVolume(
                key == KeyEvent.KEYCODE_VOLUME_UP ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER,
                AudioManager.USE_DEFAULT_STREAM_TYPE,
                AudioManager.FLAG_SHOW_UI);
    }
    return true;
  }

  /** Screen on and unlocked, and no call going on. */
  private boolean available() {
    if (!getSystemService(PowerManager.class).isInteractive()) return false;
    if (getSystemService(android.app.KeyguardManager.class).isKeyguardLocked()) return false;
    int mode = getSystemService(AudioManager.class).getMode();
    return mode != AudioManager.MODE_IN_CALL
        && mode != AudioManager.MODE_IN_COMMUNICATION
        && mode != AudioManager.MODE_RINGTONE;
  }

  private static boolean recording() {
    return DictationService.instance != null
        && DictationService.RECORDING.equals(DictationService.instance.state());
  }

  private void holdFired() {
    if (recording()) {
      DictationService.send(this, DictationService.STOP);
      return;
    }
    if (DictationService.busy()) return;
    // The same short-lived window as the tile: Android lets a visible app start the microphone.
    startActivity(
        new Intent(this, RecordActivity.class)
            .putExtra(RecordActivity.ASSISTANT, heldAssistant)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
  }

  // ------------------------------------------------------------------ insert

  /**
   * Where a text was put: the field, and the range it took there (start -1 when unknown).
   * clipboard: the text is on the clipboard now too (what was there before couldn't be put back).
   */
  record Inserted(AccessibilityNodeInfo field, String text, int start, boolean clipboard) {}

  /** The text field that has input focus in the app you're in, or null. */
  AccessibilityNodeInfo field() {
    // Without events Android never updates its node cache, so always ask the app afresh.
    clearCache();
    AccessibilityNodeInfo n = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    if (n == null || !n.refresh()) return null;
    if (n.isEditable()) return n;
    // Web content (Chrome, WebView) reports its host view as focused: the field is inside it.
    return focusedEditable(n);
  }

  /** The focused editable node below a view, breadth first, looking at a bounded number of nodes. */
  private static AccessibilityNodeInfo focusedEditable(AccessibilityNodeInfo root) {
    java.util.ArrayDeque<AccessibilityNodeInfo> queue = new java.util.ArrayDeque<>();
    queue.add(root);
    for (int seen = 0; !queue.isEmpty() && seen < 3000; seen++) {
      AccessibilityNodeInfo n = queue.poll();
      if (n.isFocused() && n.isEditable()) return n;
      for (int i = 0; i < n.getChildCount(); i++) {
        AccessibilityNodeInfo child = n.getChild(i);
        if (child != null) queue.add(child);
      }
    }
    return null;
  }

  /** A field's text, "" while it only shows its hint. */
  static String text(AccessibilityNodeInfo n) {
    CharSequence t = n.getText(), hint = n.getHintText(), label = n.getContentDescription();
    // The label only counts as a placeholder with the cursor at the start (an empty field's), so
    // real text that happens to equal it is never wiped.
    boolean atStart = n.getTextSelectionStart() <= 0;
    return own(t == null ? "" : t.toString(), n.isShowingHintText(), hint == null ? "" : hint.toString(), label == null || !atStart ? "" : label.toString());
  }

  /**
   * What of a field's text is really in it: "" while it shows its placeholder. Web fields (Chrome,
   * the bb app's editor) report an empty field's placeholder as its text without saying it's the
   * hint; the placeholder is also its hint or its label (aria-label). So a text that is one of
   * those (spaces, invisible characters and a trailing … aside) counts as empty; otherwise the
   * placeholder ends up in front of what's inserted ("Ask for a follow-up. @ to mention…I mean").
   */
  static String own(String text, boolean showingHint, String... placeholders) {
    if (showingHint) return "";
    String t = plain(text);
    if (t.isEmpty()) return text.replaceAll("[\u200b\u200c\u200d\ufeff]", "");
    for (String p : placeholders) if (t.equals(plain(p))) return "";
    return text;
  }

  private static String plain(String s) {
    return s.replaceAll("[\u200b\u200c\u200d\ufeff]", "").replaceAll("[\\s\u00a0]+", " ").replaceAll("[ .…]+$", "").trim();
  }

  /**
   * Puts the text at the cursor of the focused field, replacing a selection, through the field's
   * own paste: only our text goes in. The field is never written back whole from what
   * Accessibility reports as its text, which in web fields can be a placeholder or other text on
   * the page, and would end up in front of the dictation. The paste needs the clipboard; what was
   * on it before is put back when Android lets us read it. Only an app that refuses pastes gets
   * its text set, and only in a native field, whose reported text is its real text. Null when
   * there's no field or nothing could go in.
   */
  Inserted insert(Context context, String text) {
    AccessibilityNodeInfo n = field();
    if (n == null) return null;
    String before = text(n);
    Inserted pasted = paste(context, n, before, text);
    if (pasted != null || web(n)) return pasted;
    int s = n.getTextSelectionStart(), e = n.getTextSelectionEnd();
    if (s < 0 || e < 0 || s > before.length() || e > before.length()) s = e = before.length();
    if (s > e) {
      int t = s;
      s = e;
      e = t;
    }
    return setText(n, before, s, e, text);
  }

  /**
   * Replaces an inserted text with another (the refined version), if the field still contains it
   * unchanged: selects it, and pastes over it once the field confirms exactly that selection.
   * Null otherwise, and the caller inserts at the cursor instead.
   */
  Inserted replace(Context context, Inserted earlier, String text) {
    AccessibilityNodeInfo n = field();
    if (n == null || earlier == null || !n.equals(earlier.field())) return null;
    String now = text(n);
    int at = locate(now, earlier.text(), earlier.start());
    if (at < 0) return null;
    int end = at + earlier.text().length();
    if (!select(n, at, end, earlier.text())) return web(n) ? null : setText(n, now, at, end, text);
    Inserted pasted = paste(context, n, now, text);
    if (pasted != null || web(n)) return pasted;
    return setText(n, now, at, end, text);
  }

  /** Is the field web content (Chromium: Chrome, WebView, a web app)? */
  static boolean web(AccessibilityNodeInfo n) {
    Bundle extras = n.getExtras();
    return extras != null && extras.containsKey("AccessibilityNodeInfo.chromeRole");
  }

  /** Selects [s, e) and checks the field now has exactly that selected, holding the expected text. */
  private static boolean select(AccessibilityNodeInfo n, int s, int e, String expected) {
    Bundle range = new Bundle();
    range.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, s);
    range.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, e);
    if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, range)) return false;
    n.refresh();
    return selects(text(n), n.getTextSelectionStart(), n.getTextSelectionEnd(), s, e, expected);
  }

  /** The field's selection is [s, e) and covers the expected text (non-breaking spaces aside). */
  static boolean selects(String field, int selStart, int selEnd, int s, int e, String expected) {
    if (selStart != s || selEnd != e || e > field.length()) return false;
    return field.substring(s, e).replace('\u00a0', ' ').equals(expected.replace('\u00a0', ' '));
  }

  /**
   * The field's own paste at its cursor (replacing its selection). Once the app takes the paste
   * nothing else is tried, also when the change doesn't show within a second and a half (slow web
   * apps): a second attempt would put the text in twice. The clipboard is put back only once the
   * text is visibly in, so a late paste can't take the old clipboard instead. Null if the app
   * refused the paste.
   */
  private Inserted paste(Context context, AccessibilityNodeInfo n, String before, String text) {
    ClipData previous = restorable(context);
    DictationService.copy(context, text);
    if (!n.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
      restore(context, previous);
      return null;
    }
    String after = settle(n, before, 30);
    if (after.equals(before)) return new Inserted(n, text, -1, true);
    boolean restored = restore(context, previous);
    return new Inserted(n, text, locate(after, text, -1), !restored);
  }

  /**
   * What's on the clipboard now, if Android lets us read it (usually only the app in front and the
   * keyboard can) and it's plain text we can put back; null otherwise.
   */
  private static ClipData restorable(Context context) {
    try {
      ClipboardManager cm = context.getSystemService(ClipboardManager.class);
      ClipData clip = cm.getPrimaryClip();
      return restorable(clip) ? clip : null;
    } catch (RuntimeException ex) {
      return null;
    }
  }

  static boolean restorable(ClipData clip) {
    if (clip == null || clip.getItemCount() == 0) return false;
    for (int i = 0; i < clip.getItemCount(); i++) {
      ClipData.Item item = clip.getItemAt(i);
      if (item.getText() == null || item.getUri() != null || item.getIntent() != null) return false;
    }
    return true;
  }

  /** Puts a clipboard back; false when there was nothing to put back. */
  private static boolean restore(Context context, ClipData previous) {
    if (previous == null) return false;
    try {
      context.getSystemService(ClipboardManager.class).setPrimaryClip(previous);
      return true;
    } catch (RuntimeException ex) {
      return false;
    }
  }

  /** Where the inserted text is now: at its old place, or its only occurrence; -1 if gone. */
  static int locate(String field, String inserted, int start) {
    if (inserted.isEmpty()) return -1;
    // Web editors turn spaces at the edges into non-breaking ones.
    field = field.replace('\u00a0', ' ');
    inserted = inserted.replace('\u00a0', ' ');
    if (start >= 0 && field.startsWith(inserted, start)) return start;
    int first = field.indexOf(inserted);
    return first >= 0 && first == field.lastIndexOf(inserted) ? first : -1;
  }

  /** before[0, s) + text + before[e, …): what the field should hold afterwards. */
  static String spliced(String before, int s, int e, String text) {
    return before.substring(0, s) + text + before.substring(e);
  }

  /**
   * For native fields whose app refuses pastes: sets the field's text with ours spliced in, then
   * the cursor after it. No clipboard. Once the app takes it, nothing else is tried.
   */
  private static Inserted setText(AccessibilityNodeInfo n, String before, int s, int e, String text) {
    Bundle args = new Bundle();
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, spliced(before, s, e, text));
    if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return null;
    Bundle cursor = new Bundle();
    cursor.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, s + text.length());
    cursor.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, s + text.length());
    n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, cursor);
    String after = settle(n, before, 10);
    return new Inserted(n, text, after.equals(before) ? -1 : locate(after, text, s), false);
  }

  /** The field's text once it changed (apps paste asynchronously), at most tries × 50 ms. */
  private static String settle(AccessibilityNodeInfo n, String before, int tries) {
    String now = before;
    for (int i = 0; i < tries; i++) {
      n.refresh();
      now = text(n);
      if (!now.equals(before)) return now;
      SystemClock.sleep(50);
    }
    return now;
  }
}
