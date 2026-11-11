package app.driftdictation;

import static org.junit.Assert.*;

import android.content.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.UiDevice;
import java.io.*;
import java.math.BigDecimal;
import org.junit.*;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ComparisonTest {
  Context c;

  void send(String action) {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(() -> DictationService.send(c, action));
  }

  void await(String state) throws Exception {
    for (int i = 0; i < 150; i++) {
      if (c.getSharedPreferences("settings", 0).getString("state", "").equals(state)) return;
      Thread.sleep(100);
    }
    fail("Did not reach " + state);
  }

  @Before
  public void setup() throws Exception {
    c = InstrumentationRegistry.getInstrumentation().getTargetContext();
    UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        .executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    TestServer.reset();
    c.getSharedPreferences("settings", 0)
        .edit()
        .putBoolean("retainAudio", true)
        .putString("bubbleMode", "recording")
        .commit();
    TestServer.useKey(c);
    send(DictationService.DISCARD);
    Thread.sleep(300);
  }

  @After
  public void cleanup() throws Exception {
    send(DictationService.DISCARD);
    Thread.sleep(300);
    send(DictationService.HIDE);
    TestServer.reset();
  }

  @Test
  public void sameAudioCreatesIndependentVersionAndOnePreference() throws Exception {
    String id = java.util.UUID.randomUUID().toString();
    File source = new File(c.getCacheDir(), "comparison.pcm");
    try (FileOutputStream f = new FileOutputStream(source)) {
      f.write(new byte[32000]);
    }
    new AudioArchive(c).retain(id, source);
    try (HistoryStore h = new HistoryStore(c)) {
      HistoryEntry first = HistoryEntry.create(id, "openai/whisper-1", 1);
      first.accept(new OpenRouter.Result("Original text", new BigDecimal("0.01")), 32000);
      first.json.put("status", "complete");
      h.save(first);
    }
    TestServer.transcripts("Better text");
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () ->
                c.startForegroundService(
                    new Intent(c, DictationService.class)
                        .setAction(DictationService.COMPARE)
                        .putExtra("recordingId", id)
                        .putExtra("model", "microsoft/mai-transcribe-2")));
    await("copied");
    try (HistoryStore h = new HistoryStore(c)) {
      var versions = h.versions(id);
      assertEquals(2, versions.size());
      assertEquals("Original text", h.get(id).text());
      HistoryEntry second = versions.stream().filter(e -> !e.id().equals(id)).findFirst().get();
      assertEquals("Better text", second.text());
      assertEquals("microsoft/mai-transcribe-2", second.model());
      assertEquals(0, TestServer.SPEECH.compareTo(second.cost()));
      h.prefer(second);
      assertEquals(
          "Better text", NoteList.group(h.versions(id)).get(0).shown().text());
      h.prefer(h.get(id));
      assertEquals(
          "Original text", NoteList.group(h.versions(id)).get(0).shown().text());
      new AudioArchive(c).delete(id);
      assertNull(new AudioArchive(c).get(id));
      assertEquals(2, h.versions(id).size());
    }
    assertFalse(DictationService.audio(c).exists());
  }

  @Test
  public void errorIconExpiresButPendingAudioSurvives() throws Exception {
    try (FileOutputStream f = new FileOutputStream(DictationService.audio(c))) {
      f.write(new byte[32000]);
    }
    TestServer.transcripts((String) null);
    // Retry without a note (3.8.0: never "all of them") says what to do instead.
    send(DictationService.RETRY);
    await("error");
    Thread.sleep(4100);
    assertFalse(DictationService.bubbleVisible());
    // The leftover audio became a note to retry; nothing was lost.
    assertEquals(1, DictationService.unfinished(c).size());
    assertFalse(DictationService.busy());
  }

  @Test
  public void expiredAndDisabledAudioCannotBeCompared() throws Exception {
    AudioArchive archive = new AudioArchive(c);
    String id = java.util.UUID.randomUUID().toString();
    File source = new File(c.getCacheDir(), "expiry.pcm");
    try (FileOutputStream f = new FileOutputStream(source)) {
      f.write(new byte[32000]);
    }
    archive.retain(id, source);
    File retained = archive.get(id);
    assertNotNull(retained);
    assertTrue(retained.setLastModified(System.currentTimeMillis() - AudioArchive.WEEK - 1000));
    assertNull(archive.get(id));
    archive.retain(id, source);
    c.getSharedPreferences("settings", 0).edit().putBoolean("retainAudio", false).commit();
    assertNull(archive.get(id));
    c.getSharedPreferences("settings", 0).edit().putBoolean("retainAudio", true).commit();
  }
}
