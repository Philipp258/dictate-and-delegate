package app.driftdictation;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * Three small bars that move with the microphone's level, in the call's state colour: full colour
 * when your voice counts as speech, faint when there's a sound that doesn't count, low dots when
 * it's quiet. It shows that the microphone hears something also without live text (Philipp, 6
 * November 2026: "I would like to see whether it transcribes at all").
 */
final class LevelMeter extends View {
  private static final float[] WEIGHT = {0.75f, 1f, 0.6f};
  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final RectF bar = new RectF();
  private final float density;
  private int color = 0xffffffff;
  private double level;
  private HandsFreeSession.Hearing hearing = HandsFreeSession.Hearing.QUIET;

  LevelMeter(Context context) {
    super(context);
    density = getResources().getDisplayMetrics().density;
    setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); // The label next to it says it in words.
  }

  /** Shows this level (0 to 1) as heard, in this colour; redraws only when it looks different. */
  void show(double level, HandsFreeSession.Hearing hearing, int color) {
    double l = hearing == HandsFreeSession.Hearing.QUIET ? 0 : Math.max(0, Math.min(1, level));
    if (Math.abs(l - this.level) < 0.02 && hearing == this.hearing && color == this.color) return;
    this.level = l;
    this.hearing = hearing;
    this.color = color;
    invalidate();
  }

  @Override
  protected void onDraw(Canvas canvas) {
    float w = getWidth(), h = getHeight(), gap = 2 * density, width = (w - 2 * gap) / 3, low = Math.min(width, h);
    paint.setColor(color);
    paint.setAlpha(hearing == HandsFreeSession.Hearing.VOICE ? 255 : hearing == HandsFreeSession.Hearing.SOUND ? 140 : 90);
    for (int i = 0; i < 3; i++) {
      float height = (float) Math.max(low, h * Math.min(1, level * WEIGHT[i] * 1.4));
      float x = i * (width + gap), top = (h - height) / 2;
      bar.set(x, top, x + width, top + height);
      canvas.drawRoundRect(bar, width / 2, width / 2, paint);
    }
  }
}
