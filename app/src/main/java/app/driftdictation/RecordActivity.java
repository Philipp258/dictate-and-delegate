package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.*;

/** Brief user-visible launch bridge for microphone access, shared by the tile and overlay. */
public final class RecordActivity extends Activity {
  /**
   * Extra: the assistant (Assistants) a dictation is for, by the volume key that started it (-1:
   * none, from the tile or the bubble); for a call, the assistant it's with.
   */
  static final String ASSISTANT = "assistant";

  /** Extra: start hands-free mode instead, with this PCM file as the start of the first turn. */
  static final String HANDS_FREE_SEED = "handsFreeSeed";

  private boolean sent;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    I18n.init(this);
    OverlayIcon icon = new OverlayIcon(this);
    icon.update(DictationService.READY, 65);
    setContentView(icon);
    int size = Math.round(48 * getResources().getDisplayMetrics().density);
    getWindow().setLayout(size, size);
  }

  @Override
  public void onWindowFocusChanged(boolean focused) {
    super.onWindowFocusChanged(focused);
    if (!focused || sent) return;
    sent = true;
    if (getIntent().hasExtra(HANDS_FREE_SEED)) {
      // From the dictation panel's 📞: hands-free mode, starting with what was said so far.
      String seed = getIntent().getStringExtra(HANDS_FREE_SEED);
      Intent i = new Intent(this, HandsFreeService.class).setAction(HandsFreeService.START);
      if (seed != null && !seed.isEmpty()) i.putExtra(HandsFreeService.SEED, seed);
      i.putExtra(HandsFreeService.AT_X, getIntent().getIntExtra(HandsFreeService.AT_X, -1))
          .putExtra(HandsFreeService.AT_Y, getIntent().getIntExtra(HandsFreeService.AT_Y, -1))
          .putExtra(ASSISTANT, getIntent().getIntExtra(ASSISTANT, 0));
      try {
        startForegroundService(i);
      } catch (RuntimeException ex) {
        openApp();
        return;
      }
      finishAndRemoveTask();
      return;
    }
    String current = getSharedPreferences("settings", 0).getString("state", "");
    boolean stop = DictationService.instance != null && DictationService.RECORDING.equals(current);
    if (!stop) {
      if (DictationService.busy()) {
        finishAndRemoveTask();
        return;
      }
      try {
        // A recording kept from before doesn't stop a new one: it waits in the notes to retry.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
          openApp();
          return;
        }
      } catch (Exception ex) {
        openApp();
        return;
      }
      // Without a key there is no point in recording: say so before the user starts speaking.
      if (!OpenRouter.hasKey(this)) {
        openApp("key", tr("Add your OpenRouter key in Dictate & Delegate's Settings first."));
        return;
      }
    }
    Intent intent =
        new Intent(this, DictationService.class)
            .setAction(stop ? DictationService.STOP : DictationService.RECORD)
            .putExtra(ASSISTANT, getIntent().getIntExtra(ASSISTANT, -1));
    intent.putExtra(
        "started",
        new ResultReceiver(new Handler(getMainLooper())) {
          @Override
          protected void onReceiveResult(int code, Bundle result) {
            if (DictationService.ERROR.equals(
                getSharedPreferences("settings", 0).getString("state", ""))) openApp();
            else finishAndRemoveTask();
          }
        });
    try {
      startForegroundService(intent);
    } catch (RuntimeException ex) {
      openApp();
    }
  }

  private void openApp() {
    openApp(null, null);
  }

  /** Opens Dictate & Delegate, on a given page with a message when there is one (e.g. the key is missing). */
  private void openApp(String page, String message) {
    Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    if (page != null) {
      MainActivity.handoffMessage = message;
      intent
          // Reach a Dictate & Delegate that is already open, too (onNewIntent).
          .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
          .putExtra("open", page);
    }
    startActivity(intent);
    finishAndRemoveTask();
  }
}
