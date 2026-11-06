package app.driftdictation;

import static org.junit.Assert.*;

import android.content.*;
import android.graphics.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import org.junit.*;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ControlsTest {
  Context context;
  UiDevice device;

  @Before
  public void setup() throws Exception {
    context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    device.executeShellCommand("pm grant app.driftdictation android.permission.RECORD_AUDIO");
    device.executeShellCommand("cmd locale set-app-locales app.driftdictation --locales en-US");
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    context
        .getSharedPreferences("settings", 0)
        .edit()
        .putString("bubbleMode", "recording")
        .putString("model", "openai/whisper-1")
        .putBoolean("onboarded", true)
        .commit();
    TestServer.useKey(context);
    TestServer.reset();
    TestServer.transcripts("Quick Settings works.", "Quick Settings works.", "Quick Settings works.");
    device.executeShellCommand("cmd statusbar add-tile app.driftdictation/.DictationTile");
    device.pressHome();
  }

  void state(String value) throws Exception {
    long end = SystemClock.elapsedRealtime() + 12000;
    while (SystemClock.elapsedRealtime() < end) {
      if (value.equals(context.getSharedPreferences("settings", 0).getString("state", ""))
          && (!value.equals("recording") || DictationService.busy())) return;
      Thread.sleep(100);
    }
    fail(
        "Expected "
            + value
            + ": "
            + context.getSharedPreferences("settings", 0).getString("detail", ""));
  }

  void tile() throws Exception {
    device.openQuickSettings();
    Thread.sleep(700);
    device.executeShellCommand("cmd statusbar click-tile app.driftdictation/.DictationTile");
  }

  void send(String action) {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(() -> DictationService.send(context, action));
  }

  @After
  public void cleanup() throws Exception {
    if (DictationService.busy()) {
      send(DictationService.STOP);
      state("copied");
    }
    send(DictationService.HIDE);
    Thread.sleep(350);
    TestServer.reset();
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    device.pressHome();
  }

  @Test
  public void tileRecordsAcrossAppsWithoutAnyOverlayPermission() throws Exception {
    context.getSharedPreferences("settings", 0).edit().putString("bubbleMode", "never").commit();
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW deny");
    tile();
    state("recording");
    assertFalse(DictationService.bubbleVisible());
    device.executeShellCommand("am start -a android.settings.SETTINGS");
    Thread.sleep(1500);
    assertTrue(DictationService.busy());
    tile();
    state("copied");
    assertEquals("Quick Settings works.", new Vault(context).get("transcript"));
    assertFalse(DictationService.audio(context).exists());
  }

  @Test
  public void smallRecordingIconCanBeHiddenWithoutStoppingCapture() throws Exception {
    assertFalse(DictationService.bubbleVisible());
    tile();
    state("recording");
    var stop = device.wait(Until.findObject(By.desc("Stop recording")), 5000);
    assertNotNull(stop);
    send(DictationService.HIDE);
    Thread.sleep(500);
    assertFalse(DictationService.bubbleVisible());
    assertTrue(DictationService.busy());
    tile();
    state("copied");
  }

  @Test
  public void userCanAddTileFromAppAndTapItInQuickSettings() throws Exception {
    device.executeShellCommand("cmd statusbar remove-tile app.driftdictation/.DictationTile");
    Thread.sleep(700);
    context.getSharedPreferences("settings", 0).edit().putBoolean("tileAdded", false).commit();
    context.startActivity(
        new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    UiObject2 addTile = device.wait(Until.findObject(By.text("Add tile")), 5000);
    assertNotNull("Home offers to add the tile", addTile);
    addTile.click();
    var add =
        device.wait(
            Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)^(add|add tile)$"))),
            5000);
    if (add == null)
      device.dumpWindowHierarchy(new java.io.File(context.getFilesDir(), "tile-prompt.xml"));
    assertNotNull("Android should offer its Add tile confirmation", add);
    add.click();
    Thread.sleep(700);
    device.pressHome();
    device.openQuickSettings();
    UiObject2 tile = null;
    for (int page = 0; page < 4; page++) {
      tile = device.wait(Until.findObject(By.pkg("com.android.systemui").text("Dictate & Delegate")), 1000);
      if (tile != null) break;
      device.swipe(
          device.getDisplayWidth() * 8 / 10,
          device.getDisplayHeight() / 2,
          device.getDisplayWidth() * 2 / 10,
          device.getDisplayHeight() / 2,
          20);
    }
    assertNotNull("The added tile should be visible in Quick Settings", tile);
    tile.click();
    state("recording");
    Thread.sleep(1500);
    tile();
    state("copied");
    assertTrue(context.getSharedPreferences("settings", 0).getBoolean("tileAdded", false));
  }

  @Test
  public void iconHasTransparentMarginsAndNoPill() {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> {
              float d = context.getResources().getDisplayMetrics().density;
              int size = Math.round(48 * d);
              OverlayIcon icon = new OverlayIcon(context);
              icon.layout(0, 0, size, size);
              Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
              icon.draw(new Canvas(bitmap));
              int count = 0;
              for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                  if (Color.alpha(bitmap.getPixel(x, y)) > 0) {
                    count++;
                    assertTrue(x >= 11 * d && x <= 37 * d && y >= 11 * d && y <= 37 * d);
                  }
              assertTrue(count > 0);
              assertEquals(0, Color.alpha(bitmap.getPixel(0, 0)));
              bitmap.recycle();
            });
  }
}
