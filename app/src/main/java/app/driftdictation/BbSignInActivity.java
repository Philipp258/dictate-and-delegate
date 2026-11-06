package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.LinearLayout;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Where the browser comes back after signing in to bb Connect: talkrouter://oauth/callback, opened
 * by the redirect page (BbOAuth.REDIRECT). Swaps
 * the code for tokens (BbOAuth.complete), saved for the assistant the sign-in was started for,
 * then returns to Settings → bb (or the setup page) on that assistant with the outcome.
 */
public final class BbSignInActivity extends Activity {
  /** The assistant this sign-in is for. */
  private volatile int assistant;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    I18n.init(this);
    Ui ui = new Ui(this);
    LinearLayout root = ui.vertical();
    root.setGravity(Gravity.CENTER);
    root.setPadding(ui.dp(28), ui.dp(28), ui.dp(28), ui.dp(28));
    root.setBackgroundColor(Ui.BG);
    root.addView(ui.title(tr("Signing in to bb…"), 24));
    setContentView(root);
    Uri data = getIntent() == null ? null : getIntent().getData();
    Map<String, String> query = new HashMap<>();
    if (data != null && data.isHierarchical())
      for (String name : data.getQueryParameterNames()) query.put(name, data.getQueryParameter(name));
    Handler main = new Handler(Looper.getMainLooper());
    // Whose sign-in it is, so Settings → bb opens on that assistant (also after a failure).
    assistant = Math.max(0, BbOAuth.pendingAssistant(this));
    Executors.newSingleThreadExecutor()
        .execute(
            () -> {
              String message;
              boolean ok = false;
              try {
                BbOAuth.SignedIn in = BbOAuth.complete(this, query);
                assistant = in.assistant();
                int same = Assistants.sameBb(this, in.assistant(), in.handle(), null);
                if (same >= 0) {
                  BbOAuth.signOut(this, in.assistant());
                  throw new java.io.IOException(tr("%1$s already uses this bb. Each assistant needs its own bb, or their replies would mix.", Assistants.name(this, same)));
                }
                new BbBridge(this, in.assistant()).useConnect(in.handle());
                ChiefSkills.sync(this, in.assistant(), true);
                message = tr("Signed in to %1$s.getbb.app", in.handle());
                ok = true;
              } catch (Exception ex) {
                message =
                    ex.getClass() == java.io.IOException.class && ex.getMessage() != null
                        ? ex.getMessage()
                        : tr("Sign-in failed: %1$s", String.valueOf(ex.getMessage()));
              }
              String result = message;
              boolean success = ok;
              main.post(
                  () -> {
                    MainActivity.handoffOk = success;
                    MainActivity.handoffMessage = result;
                    startActivity(
                        new Intent(this, MainActivity.class)
                            .addFlags(
                                Intent.FLAG_ACTIVITY_NEW_TASK
                                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                                    | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            .putExtra("open", "bb")
                            .putExtra("assistant", assistant));
                    finish();
                  });
            });
  }
}
