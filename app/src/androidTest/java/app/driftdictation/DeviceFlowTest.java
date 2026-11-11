package app.driftdictation;

import static org.junit.Assert.*;

import android.content.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.*;
import org.junit.*;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DeviceFlowTest {
  Context context;
  UiDevice device;
  Vault vault;

  private void shell(String command) throws IOException {
    device.executeShellCommand(command);
  }

  private void waitFor(String state) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 20000;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (state.equals(context.getSharedPreferences("settings", 0).getString("state", ""))) return;
      Thread.sleep(100);
    }
    fail(
        "Expected "
            + state
            + "; got "
            + context.getSharedPreferences("settings", 0).getString("state", "")
            + ": "
            + context.getSharedPreferences("settings", 0).getString("detail", ""));
  }

  private void launch() throws Exception {
    context.startActivity(
        new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    device.wait(Until.hasObject(By.pkg(context.getPackageName()).depth(0)), 5000);
    Thread.sleep(400);
  }

  private void send(String action) {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(() -> DictationService.send(context, action));
  }

  /** Retry of one note (3.8.0: Retry is always for one note; there's no retry of all). */
  private void retry(String id) {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> context.startForegroundService(new Intent(context, DictationService.class).setAction(DictationService.RETRY).putExtra("noteId", id)));
  }

  /** Waits until the note's status is this (a retry from outside the panel runs in the background). */
  private HistoryEntry noteStatus(String id, String status) throws Exception {
    for (int i = 0; i < 150; i++) {
      try (HistoryStore h = new HistoryStore(context)) {
        HistoryEntry e = h.get(id);
        if (e != null && e.json.optString("status").equals(status) && !DictationService.transcribing(id)) return e;
      }
      Thread.sleep(100);
    }
    fail("Note " + id + " didn't reach " + status);
    return null;
  }

  @Before
  public void setup() throws Exception {
    context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    vault = new Vault(context);
    shell("pm grant app.driftdictation android.permission.RECORD_AUDIO");
    shell("cmd locale set-app-locales app.driftdictation --locales en-US");
    shell("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    shell("input keyevent KEYCODE_WAKEUP");
    shell("wm dismiss-keyguard");
    launch();
    send(DictationService.DISCARD);
    Thread.sleep(300);
    TestServer.reset();
    vault.remove("transcript");
    context
        .getSharedPreferences("settings", 0)
        .edit()
        .putString("model", "openai/whisper-1")
        .putString("bubbleMode", "recording")
        .commit();
    TestServer.useKey(context);
  }

  @After
  public void cleanup() throws Exception {
    if (DictationService.busy()) {
      send(DictationService.STOP);
      Thread.sleep(500);
    }
    send(DictationService.HIDE);
    Thread.sleep(300);
    TestServer.reset();
  }

  @Test
  public void bubbleRecordsAcrossAppsAndSilenceThenCopies() throws Exception {
    TestServer.transcripts(
        "Implement the parser and add a regression test.",
        "Implement the parser and add a regression test.");
    // Whatever is on the clipboard stays there: Dictate & Delegate never copies by itself.
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () ->
                context
                    .getSystemService(ClipboardManager.class)
                    .setPrimaryClip(ClipData.newPlainText("mine", "something I still need")));
    send(DictationService.ENABLE);
    waitFor("ready");
    device.pressHome();
    UiObject2 bubble = device.wait(Until.findObject(By.desc("Start recording")), 5000);
    assertNotNull(bubble);
    bubble.click();
    waitFor("recording");
    shell("am start -a android.settings.SETTINGS");
    Thread.sleep(65000);
    assertEquals("recording", context.getSharedPreferences("settings", 0).getString("state", ""));
    assertTrue(DictationService.audio(context).length() > AudioFiles.BYTES_PER_SECOND * 60L);
    // Security-sensitive Android Settings intentionally hides overlays. Return to a normal app.
    shell("am start -n app.driftdictation.test/app.driftdictation.TestPadActivity");
    UiObject2 stop = device.wait(Until.findObject(By.desc("Stop recording")), 5000);
    assertNotNull(stop);
    stop.click();
    waitFor("copied");
    // The floating panel offers Insert; nothing is copied.
    assertNotNull(device.wait(Until.findObject(By.desc("Insert")), 2000));
    assertFalse(device.hasObject(By.text("Fix")));
    assertFalse(DictationService.audio(context).exists());
    launch();
    String[] clip = {null};
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> {
              ClipData c = context.getSystemService(ClipboardManager.class).getPrimaryClip();
              clip[0] = c == null ? null : c.getItemAt(0).getText().toString();
            });
    assertEquals("something I still need", clip[0]);
    String said = "Implement the parser and add a regression test.";
    assertEquals(said, vault.get("transcript"));
    try (HistoryStore h = new HistoryStore(context)) {
      HistoryEntry entry = h.list(1, 0).get(0);
      assertEquals(said, entry.text());
      assertEquals(0, TestServer.SPEECH.compareTo(entry.cost()));
    }
    // The microphone must also start on a second use after a completed transcription.
    device.pressHome();
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1500);
    send(DictationService.STOP);
    waitFor("copied");
    assertFalse(
        context.getSystemService(android.app.NotificationManager.class).areNotificationsEnabled());
    device.openNotification();
    device.waitForIdle();
    assertFalse(device.hasObject(By.text("Dictate & Delegate is running")));
    assertFalse(device.hasObject(By.text("Ready to insert")));
    device.pressBack();
  }

  @Test
  public void failedUploadRetainsAudioAndRetrySucceeds() throws Exception {
    TestServer.transcripts((String) null, "Recovered prompt.");
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1600);
    send(DictationService.STOP);
    waitFor("unfinished");
    // Kept as a note of its own: the next recording isn't held up by it.
    assertFalse(DictationService.audio(context).exists());
    String id = DictationService.unfinished(context).get(0);
    assertTrue(DictationService.recording(context, id).length() > 0);
    assertTrue(vault.get("transcript").isEmpty());
    retry(id); // the panel shows this very recording: it stays there
    waitFor("copied");
    assertEquals("Recovered prompt.", vault.get("transcript"));
    assertFalse(DictationService.recording(context, id).exists());
  }

  @Test
  public void aRetryFromTheNotesNeverTakesThePanel() throws Exception {
    // 3.7.2: Retry on Home retried every kept recording, each took the panel in turn, and the
    // assistant button then sent the oldest. Now a retry from outside runs in the background.
    TestServer.transcripts((String) null, "The second recording.", "The first, retried.");
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1600);
    send(DictationService.STOP);
    waitFor("unfinished");
    String old = DictationService.unfinished(context).get(0);
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1600);
    send(DictationService.STOP);
    waitFor("copied");
    String current = DictationService.session().noteId;
    assertNotEquals(old, current);
    retry(old);
    noteStatus(old, "complete");
    assertEquals(current, DictationService.session().noteId);
    assertEquals("copied", context.getSharedPreferences("settings", 0).getString("state", ""));
  }

  @Test
  public void keystoreRoundTripDoesNotStorePlaintext() throws Exception {
    vault.put("testSecret", "secret-for-storage-test");
    assertEquals("secret-for-storage-test", new Vault(context).get("testSecret"));
    String stored = context.getSharedPreferences("vault", 0).getString("testSecret", "");
    assertFalse(stored.contains("secret-for-storage-test"));
    assertTrue(stored.contains(":"));
  }

  @Test
  public void interruptedServiceRetainsRecoverableAudio() throws Exception {
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1600);
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(() -> context.stopService(new Intent(context, DictationService.class)));
    Thread.sleep(500);
    assertNull(DictationService.instance);
    assertTrue(DictationService.audio(context).length() > 0);
    send(DictationService.ENABLE);
    Thread.sleep(500);
    // Taken into the notes to retry; it doesn't block anything.
    assertFalse(DictationService.audio(context).exists());
    assertEquals(1, DictationService.unfinished(context).size());
    String id = DictationService.unfinished(context).get(0);
    TestServer.transcripts("Recovered after interruption.");
    retry(id);
    noteStatus(id, "complete");
    assertEquals("Recovered after interruption.", vault.get("transcript"));
  }

  @Test
  public void emptyResultDoesNotOverwriteTranscript() throws Exception {
    vault.put("transcript", "Keep this previous prompt.");
    try (FileOutputStream out = new FileOutputStream(DictationService.audio(context))) {
      out.write(new byte[32000]);
    }
    TestServer.transcripts("");
    send(DictationService.ENABLE); // the leftover becomes a note to retry
    Thread.sleep(500);
    String id = DictationService.unfinished(context).get(0);
    retry(id);
    noteStatus(id, "no speech");
    assertFalse(DictationService.audio(context).exists());
    assertEquals("Keep this previous prompt.", vault.get("transcript"));
    assertFalse(DictationService.busy());
  }

  @Test
  public void retryResumesCompletedChunks() throws Exception {
    try (RandomAccessFile f = new RandomAccessFile(DictationService.audio(context), "rw")) {
      f.setLength(AudioFiles.CHUNK_BYTES + 64000);
    }
    TestServer.transcripts("First part.", null, "Second part.");
    send(DictationService.ENABLE); // the leftover becomes a note to retry
    Thread.sleep(500);
    String id = DictationService.unfinished(context).get(0);
    retry(id);
    HistoryEntry failed = noteStatus(id, "needs attention");
    assertTrue(failed.text().contains("First part."));
    assertTrue(failed.json.has("transcribeFailed"));
    retry(id);
    noteStatus(id, "complete");
    assertEquals("First part.\nSecond part.", vault.get("transcript"));
  }
}
