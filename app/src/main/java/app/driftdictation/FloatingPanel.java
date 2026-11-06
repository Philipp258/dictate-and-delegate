package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.*;
import android.widget.*;

/**
 * The floating panel over other apps, icon buttons named for accessibility (long press shows the
 * name). While recording: the timer with stop, Refine and Chief to choose ahead, 📞 to go on as a
 * call, ✕ to cancel, and 📎. Afterwards: ✕, Insert, Refine (then Insert refined), Chief (then Open
 * chat ↗), and Insert from chief when the chief sent text back. With two assistants set up, each
 * is one round button with its initial in its colour (P, W) instead of Chief and 📞: a tap sends to
 * it, holding it while recording starts a call with it; the one whose volume key started the
 * dictation comes first, so the row is as short as with one. While it's written down: ✕ stops
 * trying (the recording stays in the notes) and 🎙 records something new; when it couldn't be,
 * ↻ tries again. Ready, error and empty show the small icon instead. Its window never takes focus, so the cursor stays in the app you're in; drag it
 * anywhere.
 */
final class FloatingPanel extends FrameLayout {
  /** What the panel shows; DictationService builds it from its state and the session. */
  record Model(
      String state,
      long elapsed,
      int attached,
      String refine,
      String chief,
      /** The assistant chief's state is for. */
      int assistant,
      /** The assistants offered (whose chief can get requests), in order. */
      java.util.List<Integer> assistants,
      /** Each assistant's name. */
      String[] names,
      /** The assistant whose volume key started the dictation, -1 none: its buttons come first. */
      int keyAssistant,
      boolean reply,
      String message,
      int opacity) {}

  interface Actions {
    void close();

    void stop();

    void attach();

    /** An assistant's 📞 while recording: switch to a hands-free call with its chief, keeping what was said. */
    void call(int assistant);

    void insert();

    void refine();

    void chief(int assistant);

    void insertFromChief();

    void tapIcon();

    /** 🎙 while a recording is written down or wasn't: record something new. */
    void record();

    /** ↻ on a recording that wasn't written down: try again. */
    void retry();
  }

  interface Drag {
    void start();

    void move(float dx, float dy);

    void end();
  }

  private static final int INK = 0xf2182420, PILL = 0x2effffff, TEAL = 0xff28b89a;

  private final OverlayIcon icon;
  private final LinearLayout bar, extra;
  private final TextView attach, timer, close, insert, refine, fromChief, status, mic, retry;
  /** Each assistant's Chief and 📞. */
  private final TextView[] chiefs = new TextView[Assistants.COUNT], calls = new TextView[Assistants.COUNT];
  /** What holding an assistant's button does: the call's name, null when holding only shows its name. */
  private final String[] holdCall = new String[Assistants.COUNT];
  private final Row row;
  private final Actions actions;
  private final Drag drag;
  private final float density;
  private final int slop;
  private float downX, downY;
  private boolean dragging, small = true;
  /** Which order the buttons are in (recording or not, which assistant first): null before the first render. */
  private String order;

  FloatingPanel(Context context, Actions actions, Drag drag) {
    super(context);
    this.actions = actions;
    this.drag = drag;
    density = getResources().getDisplayMetrics().density;
    slop = dp(8);
    icon = new OverlayIcon(context);
    icon.setClickable(false);
    addView(icon, new LayoutParams(dp(48), dp(48)));
    bar = new LinearLayout(context);
    bar.setOrientation(LinearLayout.VERTICAL);
    bar.setPadding(dp(6), dp(6), dp(6), dp(6));
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(INK);
    bg.setCornerRadius(dp(24));
    bar.setBackground(bg);
    row = new Row(context, dp(6));
    bar.addView(row, new LinearLayout.LayoutParams(-2, -2)); // Its own width: it sets the panel's.
    timer = pill(row, "", v -> actions.stop());
    name(timer, tr("Stop recording"));
    timer.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
    attach = pill(row, "📎", v -> actions.attach());
    name(attach, tr("Add context to this dictation"));
    for (int a = 0; a < Assistants.COUNT; a++) {
      int assistant = a;
      calls[a] = pill(row, "📞", v -> actions.call(assistant));
      name(calls[a], tr("Hands-free call with your chief"));
    }
    close = pill(row, "✕", v -> actions.close());
    mic = pill(row, "🎙", v -> actions.record());
    name(mic, tr("Record something new"));
    retry = pill(row, "↻", v -> actions.retry());
    name(retry, tr("Try again"));
    insert = pill(row, "📥", v -> actions.insert());
    refine = pill(row, "", v -> actions.refine());
    for (int a = 0; a < Assistants.COUNT; a++) {
      int assistant = a;
      chiefs[a] = pill(row, "", v -> actions.chief(assistant));
      // With two assistants, holding one while recording calls it (there's no 📞 of its own).
      chiefs[a].setOnLongClickListener(
          v -> {
            if (holdCall[assistant] == null) return false; // Shows its name.
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            actions.call(assistant);
            return true;
          });
      chiefs[a].setAccessibilityDelegate(
          new View.AccessibilityDelegate() {
            @Override
            public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
              super.onInitializeAccessibilityNodeInfo(host, info);
              if (holdCall[assistant] != null)
                info.addAction(
                    new android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(
                        android.view.accessibility.AccessibilityNodeInfo.ACTION_LONG_CLICK, holdCall[assistant]));
            }
          });
    }
    extra = new LinearLayout(context);
    extra.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams el = new LinearLayout.LayoutParams(-2, -2);
    el.topMargin = dp(6);
    bar.addView(extra, el);
    fromChief = pill(extra, "🧑‍💼 📥", v -> actions.insertFromChief());
    name(fromChief, tr("Insert from chief"));
    status = new TextView(context);
    status.setTextColor(0xccffffff);
    status.setTextSize(12);
    status.setMaxLines(2);
    status.setEllipsize(TextUtils.TruncateAt.END);
    status.setPadding(dp(8), dp(4), dp(8), dp(2));
    status.setMaxWidth(dp(320));
    bar.addView(status);
    addView(bar, new LayoutParams(-2, -2));
    bar.setVisibility(GONE);
  }

  private int dp(float n) {
    return Math.round(n * density);
  }

  private TextView pill(ViewGroup row, String text, View.OnClickListener click) {
    TextView t = new TextView(getContext());
    t.setText(text);
    t.setTextSize(14);
    t.setTextColor(0xffffffff);
    t.setTypeface(Ui.MEDIUM);
    t.setGravity(Gravity.CENTER);
    t.setSingleLine(true);
    t.setMinHeight(dp(40));
    t.setMinWidth(dp(40));
    t.setPadding(dp(12), 0, dp(12), 0);
    t.setOnClickListener(click);
    if (row instanceof Row) row.addView(t, new ViewGroup.LayoutParams(-2, dp(40)));
    else {
      LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(-2, dp(40));
      if (row.getChildCount() > 0) l.leftMargin = dp(6);
      row.addView(t, l);
    }
    style(t, PILL, 0);
    return t;
  }

  /** The button's name for TalkBack, also shown on a long press. */
  private static void name(TextView t, String name) {
    t.setContentDescription(name);
    t.setTooltipText(name);
  }

  private void style(TextView t, int fill, int stroke) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(fill);
    d.setCornerRadius(dp(20));
    if (stroke != 0) d.setStroke(dp(2), stroke);
    t.setBackground(d);
  }

  /** Whether the small icon is shown (and taps on it count). */
  boolean small() {
    return small;
  }

  /** Whether every shown button has room for its whole label (for the device tests). */
  boolean fits() {
    java.util.List<TextView> all = new java.util.ArrayList<>(java.util.List.of(attach, timer, close, insert, refine, fromChief, mic, retry));
    all.addAll(java.util.List.of(chiefs));
    all.addAll(java.util.List.of(calls));
    for (TextView t : all) {
      if (t.getVisibility() != VISIBLE || t.getLayout() == null) continue;
      float need = t.getPaint().measureText(t.getText().toString()) + t.getPaddingLeft() + t.getPaddingRight();
      if (t.getWidth() + 1 < need) return false;
      int[] at = new int[2];
      t.getLocationOnScreen(at);
      if (at[0] < 0 || at[0] + t.getWidth() > getResources().getDisplayMetrics().widthPixels) return false;
    }
    return true;
  }

  /**
   * The buttons in a row that wraps whole buttons to the next line when they don't fit, such as
   * Insert refined and Open chat ↗ in a longer language.
   */
  private static final class Row extends ViewGroup {
    private final int gap;

    Row(Context context, int gap) {
      super(context);
      this.gap = gap;
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
      int max = MeasureSpec.getMode(widthSpec) == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE : MeasureSpec.getSize(widthSpec);
      int x = 0, y = 0, line = 0, width = 0;
      for (int i = 0; i < getChildCount(); i++) {
        View c = getChildAt(i);
        if (c.getVisibility() == GONE) continue;
        c.measure(MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(c.getLayoutParams().height, MeasureSpec.EXACTLY));
        int w = c.getMeasuredWidth();
        if (x > 0 && x + gap + w > max) {
          y += line + gap;
          x = 0;
          line = 0;
        }
        x += (x > 0 ? gap : 0) + w;
        line = Math.max(line, c.getMeasuredHeight());
        width = Math.max(width, x);
      }
      setMeasuredDimension(resolveSize(width, widthSpec), resolveSize(y + line, heightSpec));
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
      int max = r - l, x = 0, y = 0, line = 0;
      for (int i = 0; i < getChildCount(); i++) {
        View c = getChildAt(i);
        if (c.getVisibility() == GONE) continue;
        int w = c.getMeasuredWidth(), h = c.getMeasuredHeight();
        if (x > 0 && x + gap + w > max) {
          y += line + gap;
          x = 0;
          line = 0;
        }
        if (x > 0) x += gap;
        c.layout(x, y, x + w, y + h);
        x += w;
        line = Math.max(line, h);
      }
    }
  }

  void render(Model m) {
    boolean recording = DictationService.RECORDING.equals(m.state());
    boolean working = DictationService.STOPPING.equals(m.state()) || DictationService.UPLOADING.equals(m.state());
    boolean ready = DictationService.done(m.state());
    boolean uploading = DictationService.UPLOADING.equals(m.state());
    boolean unfinished = DictationService.UNFINISHED.equals(m.state());
    small = !recording && !working && !ready && !unfinished;
    icon.setVisibility(small ? VISIBLE : GONE);
    bar.setVisibility(small ? GONE : VISIBLE);
    if (small) {
      icon.update(m.state(), m.opacity());
      setAlpha(1f);
      return;
    }
    setAlpha(1f);
    // While recording: ■ ✨ 🧑‍💼 📞 📎 ✕ (with two assistants ■ ✨ P W 📎 ✕); afterwards: 📥 ✨ 🧑‍💼 ✕
    // (📥 ✨ P W ✕). The ✕ is always last, on the outer edge where close and cancel usually are.
    java.util.List<Integer> first = new java.util.ArrayList<>();
    if (m.keyAssistant() >= 0) first.add(m.keyAssistant());
    for (int a = 0; a < Assistants.COUNT; a++) if (!first.contains(a)) first.add(a);
    String next = recording + ":" + first;
    if (!next.equals(order)) {
      order = next;
      row.removeAllViews();
      java.util.List<TextView> views = new java.util.ArrayList<>();
      if (recording) {
        views.addAll(java.util.List.of(timer, refine));
        for (int a : first) views.addAll(java.util.List.of(chiefs[a], calls[a]));
        views.addAll(java.util.List.of(attach, insert, retry, mic, close));
      } else {
        views.addAll(java.util.List.of(retry, insert, refine));
        for (int a : first) views.add(chiefs[a]);
        views.addAll(java.util.List.of(mic, timer, attach));
        for (int a : first) views.add(calls[a]);
        views.add(close);
      }
      for (TextView t : views) row.addView(t, new ViewGroup.LayoutParams(-2, dp(40)));
    }
    attach.setVisibility(recording ? VISIBLE : GONE);
    attach.setText(m.attached() > 0 ? "📎 " + m.attached() : "📎");
    timer.setVisibility(recording ? VISIBLE : GONE);
    timer.setText("● " + AudioFiles.elapsed(m.elapsed()) + "  ■");
    style(timer, 0xffe5484d, 0);
    // Only while the recording is saved (a moment) there's nothing to tap; while it's written
    // down ✕ stops trying, and you can record something new.
    close.setVisibility(working && !uploading ? GONE : VISIBLE);
    name(
        close,
        recording
            ? tr("Cancel: nothing is transcribed or sent")
            : uploading ? tr("Stop trying: the recording stays in your notes to retry") : tr("Close"));
    mic.setVisibility(uploading || unfinished ? VISIBLE : GONE);
    retry.setVisibility(unfinished ? VISIBLE : GONE);
    style(retry, TEAL, 0);
    insert.setVisibility(recording || unfinished ? GONE : VISIBLE);
    insert.setText(working ? "…" : "📥");
    name(insert, working ? tr("Transcribing…") : tr("Insert"));
    insert.setEnabled(ready);
    insert.setAlpha(ready ? 1f : 0.6f);
    style(insert, ready ? TEAL : PILL, 0);
    refine.setText(
        switch (m.refine()) {
          case DictationService.QUEUED -> "✨ ✓";
          case DictationService.RUNNING -> "✨ …";
          case DictationService.DONE -> "✨ 📥";
          case DictationService.FAILED -> "✨ ↻";
          default -> "✨";
        });
    name(
        refine,
        switch (m.refine()) {
          case DictationService.QUEUED -> tr("✨ Refine ✓");
          case DictationService.RUNNING -> tr("✨ Refining…");
          case DictationService.DONE -> tr("Insert refined");
          case DictationService.FAILED -> tr("✨ Refine again");
          default -> tr("✨ Refine");
        });
    style(
        refine,
        m.refine().equals(DictationService.DONE) ? TEAL : PILL,
        m.refine().equals(DictationService.QUEUED) || m.refine().equals(DictationService.RUNNING) ? TEAL : 0);
    refine.setVisibility(unfinished ? GONE : VISIBLE);
    boolean several = m.assistants().size() > 1;
    String[] initials = Assistants.initials(m.names());
    // Once the dictation is on its way (or kept to try again) it belongs to its assistant: the
    // other's Chief goes.
    boolean bound = !m.chief().equals(DictationService.IDLE) && !m.chief().equals(DictationService.QUEUED);
    for (int a = 0; a < Assistants.COUNT; a++) {
      boolean offered = m.assistants().contains(a);
      chiefs[a].setVisibility(offered && !unfinished && (!bound || a == m.assistant()) ? VISIBLE : GONE);
      // With two, the call is holding the assistant's button: no 📞 of its own.
      calls[a].setVisibility(offered && recording && !several ? VISIBLE : GONE);
      holdCall[a] = several && offered && recording ? tr("Hands-free call with %1$s", m.names()[a]) : null;
      String state = a == m.assistant() ? m.chief() : DictationService.IDLE;
      chiefs[a].setText(
          (several ? initials[a] : "🧑‍💼")
              + switch (state) {
                case DictationService.QUEUED -> " ✓";
                case DictationService.RUNNING -> " …";
                case DictationService.DONE -> " ↗";
                case DictationService.FAILED -> " ↻";
                default -> "";
              });
      name(
          chiefs[a],
          several
              ? switch (state) {
                case DictationService.QUEUED -> tr("Goes to %1$s ✓", m.names()[a]);
                case DictationService.RUNNING -> tr("Sending to %1$s…", m.names()[a]);
                case DictationService.DONE -> tr("Open the chat with %1$s ↗", m.names()[a]);
                case DictationService.FAILED -> tr("Send to %1$s again", m.names()[a]);
                default -> tr("Send to %1$s", m.names()[a]);
              }
              : switch (state) {
                case DictationService.QUEUED -> tr("🧑‍💼 Chief ✓");
                case DictationService.RUNNING -> tr("🧑‍💼 Sending…");
                case DictationService.DONE -> tr("Open chat ↗");
                case DictationService.FAILED -> tr("🧑‍💼 Send again");
                default -> tr("🧑‍💼 Chief");
              });
      boolean busy = state.equals(DictationService.QUEUED) || state.equals(DictationService.RUNNING);
      // With two, each its initial in its colour: half see-through, solid with dark ink once it's
      // chosen or on its way, so it's plain which one it goes to; alone, as always.
      chiefs[a].setTypeface(Ui.MEDIUM, several ? Typeface.BOLD : Typeface.NORMAL);
      chiefs[a].setTextSize(several ? 16 : 14);
      chiefs[a].setTextColor(several && busy ? INK | 0xff000000 : 0xffffffff);
      if (several) style(chiefs[a], busy ? Assistants.bright(a) : tint(Assistants.bright(a)), Assistants.bright(a));
      else style(chiefs[a], PILL, busy ? TEAL : 0);
      calls[a].setText("📞");
      name(calls[a], tr("Hands-free call with your chief"));
    }
    extra.setVisibility(m.reply() ? VISIBLE : GONE);
    style(fromChief, TEAL, 0);
    status.setText(m.message());
    status.setVisibility(m.message().isEmpty() ? GONE : VISIBLE);
  }

  /** A colour, half see-through over the panel's dark background. */
  private static int tint(int color) {
    return (color & 0x00ffffff) | 0x66000000;
  }

  // Dragging: a move past the touch slop anywhere on the panel moves its window; taps still reach
  // the buttons.

  @Override
  public boolean onInterceptTouchEvent(MotionEvent e) {
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_DOWN -> {
        downX = e.getRawX();
        downY = e.getRawY();
        dragging = false;
        drag.start();
        return false;
      }
      case MotionEvent.ACTION_MOVE -> {
        if (!dragging && Math.hypot(e.getRawX() - downX, e.getRawY() - downY) > slop) dragging = true;
        return dragging;
      }
      default -> {
        return dragging;
      }
    }
  }

  @Override
  public boolean onTouchEvent(MotionEvent e) {
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_DOWN -> {
        downX = e.getRawX();
        downY = e.getRawY();
        dragging = false;
        drag.start();
      }
      case MotionEvent.ACTION_MOVE -> {
        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
        if (!dragging && Math.hypot(dx, dy) > slop) dragging = true;
        if (dragging) drag.move(dx, dy);
      }
      case MotionEvent.ACTION_UP -> {
        if (dragging) drag.end();
        else if (small) performClick();
        dragging = false;
      }
      case MotionEvent.ACTION_CANCEL -> {
        if (dragging) drag.end();
        dragging = false;
      }
      default -> {}
    }
    return true;
  }

  @Override
  public boolean performClick() {
    super.performClick();
    if (small) actions.tapIcon();
    return true;
  }
}
