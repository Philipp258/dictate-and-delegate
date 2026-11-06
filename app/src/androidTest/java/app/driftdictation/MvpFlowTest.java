package app.driftdictation;

import static org.junit.Assert.*;

import android.content.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.math.BigDecimal;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

/**
 * Setup, the key, Jev and Refine, costs and translation as a user meets them, against the fake
 * OpenRouter.
 */
@RunWith(AndroidJUnit4.class)
public class MvpFlowTest {
  Context context;
  UiDevice device;
  SharedPreferences prefs;

  void send(String action) {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(() -> DictationService.send(context, action));
  }

  void waitFor(String state) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 20000;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (state.equals(prefs.getString("state", ""))) return;
      Thread.sleep(100);
    }
    fail("Expected " + state + "; got " + prefs.getString("state", "") + ": " + detail());
  }

  String detail() {
    return prefs.getString("detail", "");
  }

  void dictate() throws Exception {
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1200);
    send(DictationService.STOP);
    waitFor("copied");
  }

  /** A dictation, then ✨ on the panel: Refine never starts by itself. */
  void dictateAndRefine() throws Exception {
    dictate();
    find("✨ Refine").click();
  }

  HistoryEntry latest() throws Exception {
    try (HistoryStore h = new HistoryStore(context)) {
      return h.list(1, 0).get(0);
    }
  }

  /** The latest note once it matches, e.g. once Refine or Jev wrote to it. */
  HistoryEntry latestOnce(java.util.function.Predicate<HistoryEntry> ready, String what) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 15000;
    while (SystemClock.elapsedRealtime() < deadline) {
      HistoryEntry e = latest();
      if (ready.test(e)) return e;
      Thread.sleep(150);
    }
    fail("The note never got " + what + ": " + latest().json);
    return null;
  }

  static boolean hasStep(HistoryEntry e, String kind) {
    JSONArray steps = e.json.optJSONArray("steps");
    for (int i = 0; steps != null && i < steps.length(); i++)
      if (kind.equals(steps.optJSONObject(i).optString("kind"))) return true;
    return false;
  }

  /** The requests of one kind ("transcribe", "decide", "text") the fake received, oldest first. */
  java.util.List<JSONObject> sent(String kind) throws Exception {
    java.util.List<JSONObject> out = new java.util.ArrayList<>();
    JSONArray all = TestServer.requests();
    for (int i = 0; i < all.length(); i++)
      if (all.getJSONObject(i).getString("kind").equals(kind))
        out.add(all.getJSONObject(i).getJSONObject("body"));
    return out;
  }

  /** With -e shots true: a screenshot under the app's files/panel on the device. */
  void shot(String name) throws Exception {
    if (!"true".equals(InstrumentationRegistry.getArguments().getString("shots"))) return;
    Thread.sleep(700);
    java.io.File dir = new java.io.File(context.getExternalFilesDir(null), "panel");
    dir.mkdirs();
    device.takeScreenshot(new java.io.File(dir, name + ".png"));
  }

  void launch() throws Exception {
    context.startActivity(
        new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    device.wait(Until.hasObject(By.pkg(context.getPackageName()).depth(0)), 5000);
    Thread.sleep(500);
  }

  UiObject2 find(String text) {
    UiObject2 found = device.wait(Until.findObject(By.text(text)), 5000);
    if (found == null) {
      StringBuilder seen = new StringBuilder();
      for (UiObject2 o : device.findObjects(By.textContains("")))
        seen.append(" | ").append(o.getText());
      fail("Expected on screen: " + text + "; saw" + seen);
    }
    return found;
  }

  /** Scrolls the page until the text is on screen, then taps it. */
  void tap(String text) throws Exception {
    UiScrollable page = new UiScrollable(new UiSelector().scrollable(true));
    if (page.exists()) {
      page.scrollIntoView(new UiSelector().text(text));
      // scrollIntoView stops as soon as the edge shows; keep it clear of the gesture bar.
      UiObject2 shown = find(text);
      if (shown.getVisibleBounds().bottom > device.getDisplayHeight() * 0.85) {
        // A short drag, not a fling: a fling can carry the row off the top of a long page.
        int x = device.getDisplayWidth() / 2, h = device.getDisplayHeight();
        device.swipe(x, h * 7 / 10, x, h * 4 / 10, 40);
      }
    }
    Thread.sleep(700); // A tap during a fling only stops the fling.
    find(text).click();
    Thread.sleep(400);
  }

  @Before
  public void setup() throws Exception {
    context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    prefs = context.getSharedPreferences("settings", 0);
    device.executeShellCommand("pm grant app.driftdictation android.permission.RECORD_AUDIO");
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    device.executeShellCommand("cmd locale set-app-locales app.driftdictation --locales en-US");
    device.executeShellCommand("input keyevent KEYCODE_WAKEUP");
    send(DictationService.DISCARD);
    TestServer.reset();
    TestServer.useKey(context);
    prefs
        .edit()
        .putString("model", "microsoft/mai-transcribe-2")
        .putString("bubbleMode", "recording")
        .putBoolean("onboarded", true)
        .remove("processingPrompt")
        .remove("profileWords")
        .remove(TextModel.PREF_MODEL)
        .remove(TextModel.PREF_NAME)
        .remove(TextModel.PREF_CLAUDE)
        .commit();
    new Attachments(context).clearPending();
    Templates templates = new Templates(context);
    for (Templates.Template t : templates.all()) templates.delete(t.id());
    TestServer.transcripts("um hi Jana see you at ten");
    TestServer.replies("Hi Jana, see you at ten.");
  }

  @After
  public void cleanup() throws Exception {
    if (DictationService.busy()) {
      send(DictationService.STOP);
      Thread.sleep(800);
    }
    send(DictationService.HIDE);
    TestServer.reset();
    TestServer.useKey(context);
    new Attachments(context).clearPending();
    device.executeShellCommand("cmd locale set-app-locales app.driftdictation --locales en-US");
    // The app's resources switch back asynchronously; later tests look for English labels.
    long deadline = SystemClock.elapsedRealtime() + 5000;
    while (SystemClock.elapsedRealtime() < deadline
        && !context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("en"))
      Thread.sleep(100);
    device.pressHome();
  }

  @Test
  public void setupChecksTheKeyThenTeachesStartStopAndPaste() throws Exception {
    prefs.edit().putBoolean("onboarded", false).commit();
    TestServer.removeKey(context);
    launch();
    find("Talk anywhere.");
    tap("Get started");
    find("Your OpenRouter key");
    UiObject2 field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 5000);
    field.setText(TestServer.BAD_KEY);
    tap("Check and save");
    assertNotNull(device.wait(Until.findObject(By.textStartsWith("This key isn't valid")), 10000));
    assertFalse(OpenRouter.hasKey(context));
    field = device.findObject(By.clazz("android.widget.EditText"));
    field.setText(TestServer.KEY);
    tap("Check and save");
    assertNotNull(device.wait(Until.findObject(By.text("Microphone and privacy")), 10000));
    assertEquals(TestServer.KEY, new Vault(context).get(OpenRouter.KEY));
    tap("Continue");
    find("Transcript first, then you decide");
    find("Insert");
    shot("setup-1-how");
    tap("Continue");
    find("Start from any app");
    find("Volume down");
    shot("setup-2-start");
    tap("Continue");
    find("Insert where you type");
    find("Insert · Accessibility permission");
    shot("setup-3-accessibility");
    tap("Continue");
    find("Try it once");
    find("Start").click();
    waitFor("recording");
    Thread.sleep(1200);
    find("Stop").click();
    waitFor("copied");
    UiObject2 box = find("Insert here");
    box.click();
    device.wait(Until.findObject(By.desc("Insert")), 5000).click();
    // Without the Accessibility service, Insert copies instead and says so; then paste.
    if (!device.wait(Until.hasObject(By.text("um hi Jana see you at ten")), 2000))
      device.pressKeyCode(android.view.KeyEvent.KEYCODE_PASTE);
    find("um hi Jana see you at ten");
    tap("Continue");
    // bb is optional: "Later" ends setup, and the app works as a dictation app.
    find("Connect bb");
    find("bb Connect");
    tap("Later");
    find("Start dictating");
    assertTrue(prefs.getBoolean("onboarded", false));
    find("Voice-to-text model");
    if ("true".equals(InstrumentationRegistry.getArguments().getString("shots"))) {
      tap("Settings");
      tap("Start and insert");
      shot("settings-1-start");
      device.pressBack();
      tap("Refine");
      shot("settings-2-refine");
      device.pressBack();
    }
  }

  /** Keys and models together, costs apart from any provider, About instead of a legal page, a local wipe. */
  @Test
  public void settingsGroupModelsCostsDataAndAbout() throws Exception {
    new Vault(context).put(Anthropic.KEY, "sk-ant-test");
    try {
      launch();
      tap("Settings");
      shot("settings-1-top");
      int[] order = {
        find("MODELS & PROVIDERS").getVisibleBounds().top,
        find("OpenRouter key").getVisibleBounds().top,
        find("Anthropic key").getVisibleBounds().top,
        find("Voice-to-text").getVisibleBounds().top,
        find("Text-to-speech").getVisibleBounds().top,
        find("Decisions").getVisibleBounds().top,
        find("Refine").getVisibleBounds().top
      };
      for (int i = 1; i < order.length; i++) assertTrue("order " + i, order[i] > order[i - 1]);
      find("Saved, encrypted · Refine uses your Anthropic credits");
      find("Claude Sonnet 5.5 · Anthropic, your key");
      tap("Decisions");
      find("Refine automatically");
      find("Send to chief when addressed");
      find("Jev · " + Jev.MODEL);
      shot("settings-4-decisions");
      device.pressBack();
      tap("Refine instructions");
      find("Instructions for Refine");
      device.pressBack();
      // No legal-style pages: one plain line in About.
      assertNull(device.findObject(By.text("Privacy")));
      new UiScrollable(new UiSelector().scrollable(true))
          .scrollTextIntoView("Your voice and text go only to the providers you choose. There's no Dictate & Delegate server.");
      find("Your voice and text go only to the providers you choose. There's no Dictate & Delegate server.");
      tap("Source code");
      device.pressBack();
      launch();
      tap("Settings");
      tap("Report a problem");
      device.pressBack();
      launch();
      tap("Settings");
      assertNull(device.findObject(By.text("Legal & support")));
      assertNull(device.findObject(By.text("Imprint")));
      tap("Delete local data");
      find("Delete local data?");
      shot("settings-3-delete-local");
      find("DELETE EVERYTHING").click();
      find("Get started");
      assertFalse(OpenRouter.hasKey(context));
      assertFalse(Anthropic.hasKey(context));
      assertFalse(prefs.getBoolean("onboarded", false));
    } finally {
      new Vault(context).remove(Anthropic.KEY);
    }
  }

  @Test
  public void refinePicksAnyOpenRouterTextModel() throws Exception {
    launch();
    tap("Settings");
    tap("Refine");
    find("Refine model");
    // The catalog's text models, the default first; the image model is left out.
    find("Anthropic: Claude Sonnet 5.5");
    assertNull(device.findObject(By.text("Fake Image Maker")));
    find("$1.00 / $4.00");
    shot("settings-5-refine-model");
    tap("Fake GPT");
    assertEquals("openai/gpt-fake", prefs.getString(TextModel.PREF_MODEL, ""));
    device.pressBack();
    find("Fake GPT · OpenRouter");
    dictateAndRefine();
    HistoryEntry e = latestOnce(n -> n.json.has("processed"), "the refined text");
    assertEquals("openai/gpt-fake", sent("text").get(0).getString("model"));
    assertEquals("openai/gpt-fake", e.json.optString("textModel"));
  }

  @Test
  public void withoutAKeyNothingIsRecorded() throws Exception {
    TestServer.removeKey(context);
    send(DictationService.RECORD);
    waitFor("error");
    assertTrue(detail(), detail().contains("OpenRouter key"));
    assertFalse(DictationService.busy());
    assertFalse(DictationService.audio(context).exists());
    launch();
    find("Add your OpenRouter key to start dictating").click();
    find("OpenRouter key");
    find("Get a key on openrouter.ai");
  }

  @Test
  public void tileWithoutAKeyOpensTheKeyInsteadOfRecording() throws Exception {
    TestServer.removeKey(context);
    device.executeShellCommand("cmd statusbar add-tile app.driftdictation/.DictationTile");
    device.pressHome();
    device.executeShellCommand("cmd statusbar click-tile app.driftdictation/.DictationTile");
    find("Check and save");
    assertFalse(DictationService.busy());
    assertNotEquals("recording", prefs.getString("state", ""));
  }

  @Test
  public void tappedRefineCostsWhatOpenRouterReportedAndKeepsWhatYouSaid() throws Exception {
    new Profile(prefs).addWord("Jana");
    // Asking for a text in the same breath starts nothing by itself; ✨ does.
    dictate();
    Thread.sleep(800);
    assertFalse(latest().json.has("processed"));
    assertEquals(DictationService.IDLE, DictationService.session().refine);
    find("✨ Refine").click();
    HistoryEntry e = latestOnce(n -> n.json.has("processed"), "the refined text");
    // The note is saved first, the last transcript right after it.
    Vault vault = new Vault(context);
    for (int i = 0; i < 50 && !"Hi Jana, see you at ten.".equals(vault.get("transcript")); i++) Thread.sleep(100);
    assertEquals("Hi Jana, see you at ten.", vault.get("transcript"));

    // Exactly what the fake reported: no fee on top. Jev isn't asked without templates.
    BigDecimal all = TestServer.SPEECH.add(TestServer.TEXT);
    assertEquals(0, all.compareTo(e.cost()));
    assertFalse(e.incompleteCost());
    assertTrue(sent("decide").isEmpty());
    assertEquals(TextModel.MODEL, e.json.optString("textModel"));
    assertEquals(0, TestServer.TEXT.compareTo(e.textCost()));
    assertEquals("Hi Jana, see you at ten.", e.json.optString("processed"));
    assertEquals("um hi Jana see you at ten", e.json.optString("original"));
    // The activity log: speech, then Refine.
    JSONArray steps = e.json.getJSONArray("steps");
    assertEquals(2, steps.length());
    assertEquals("speech", steps.getJSONObject(0).getString("kind"));
    assertEquals("microsoft/mai-transcribe-2", steps.getJSONObject(0).getString("model"));
    assertEquals(
        0, TestServer.SPEECH.compareTo(new BigDecimal(steps.getJSONObject(0).getString("cost"))));
    assertEquals("refine", steps.getJSONObject(1).getString("kind"));
    assertEquals(TextModel.MODEL, steps.getJSONObject(1).getString("model"));
    assertEquals(
        0, TestServer.TEXT.compareTo(new BigDecimal(steps.getJSONObject(1).getString("cost"))));
    assertFalse(steps.getJSONObject(1).has("detail"));

    // What went to OpenRouter: WAV audio with the words for Azure, then Refine; every chat call
    // asks for its cost.
    JSONObject speech = sent("transcribe").get(0);
    assertEquals("microsoft/mai-transcribe-2", speech.getString("model"));
    assertEquals("wav", speech.getJSONObject("input_audio").getString("format"));
    assertEquals(
        "Jana",
        speech
            .getJSONObject("provider")
            .getJSONObject("options")
            .getJSONObject("azure")
            .getJSONObject("phraseList")
            .getJSONArray("phrases")
            .getString(0));
    JSONObject text = sent("text").get(0);
    assertEquals(TextModel.MODEL, text.getString("model"));
    assertEquals(TextModel.MAX_TOKENS, text.getInt("max_tokens"));
    assertTrue(text.getJSONObject("usage").getBoolean("include"));
    assertTrue(
        text.getJSONArray("messages").getJSONObject(0).getString("content").startsWith(TextModel.DEFAULT_PROMPT));
    assertEquals(
        "um hi Jana see you at ten",
        text.getJSONArray("messages").getJSONObject(1).getString("content"));

    send(DictationService.HIDE);
    Thread.sleep(500);
    launch();
    find("Hi Jana, see you at ten.").click();
    find("Refined");
    find("What you said").click();
    find("um hi Jana see you at ten");
    tap("Copy");
    String[] clip = {null};
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> {
              ClipData c = context.getSystemService(ClipboardManager.class).getPrimaryClip();
              clip[0] = c == null ? null : c.getItemAt(0).getText().toString();
            });
    assertEquals("um hi Jana see you at ten", clip[0]);

    // Settings → Activity shows the same steps.
    launch();
    tap("Settings");
    tap("Activity");
    find("Activity");
    assertNotNull(device.wait(Until.findObject(By.textStartsWith("Transcription · ")), 5000));
    assertNotNull(
        device.wait(
            Until.findObject(By.textStartsWith("Refine · " + TextModel.NAME + " · ")), 5000));
    tap("Hi Jana, see you at ten.");
    find("Refined");
  }

  @Test
  public void aNamedTemplateGoesToRefine() throws Exception {
    Templates templates = new Templates(context);
    for (Templates.Template t : templates.all()) templates.delete(t.id());
    templates.save(null, "Weekly update", "Done: …\nNext: …");
    try {
      TestServer.reset();
      TestServer.transcripts("fill in my weekly update, shipped the panel");
      TestServer.decide(0.2, 0, "Weekly update");
      TestServer.replies("Done: the panel\nNext: tests");
      dictate();
      // Naming it doesn't start Refine; a tapped ✨ uses it.
      Thread.sleep(800);
      assertEquals(DictationService.IDLE, DictationService.session().refine);
      find("✨ Refine").click();
      HistoryEntry e = latestOnce(n -> n.json.has("processed"), "the refined text");
      assertEquals("Weekly update", e.json.optString("template"));
      JSONObject q = sent("decide").get(0).getJSONObject("questions");
      assertTrue(q.getJSONObject("template").getJSONObject("criteria").has("Weekly update"));
      assertTrue(
          sent("text").get(0).getJSONArray("messages").getJSONObject(0).getString("content")
              .contains("<template name=\"Weekly update\">"));
    } finally {
      for (Templates.Template t : templates.all()) templates.delete(t.id());
    }
  }

  @Test
  public void withoutTemplatesJevIsntAskedAndNothingStarts() throws Exception {
    dictate();
    Thread.sleep(800);
    assertEquals("um hi Jana see you at ten", new Vault(context).get("transcript"));
    // Only the transcription ran.
    assertEquals(0, TestServer.SPEECH.compareTo(latest().cost()));
    assertTrue(sent("decide").isEmpty());
    assertTrue(sent("text").isEmpty());
  }

  @Test
  public void whenJevFailsATappedRefineStillRunsWithoutATemplate() throws Exception {
    Templates templates = new Templates(context);
    for (Templates.Template t : templates.all()) templates.delete(t.id());
    templates.save(null, "Weekly update", "Done: …\nNext: …");
    try {
      TestServer.reset();
      TestServer.transcripts("make this an email");
      TestServer.error("decide", "provider");
      dictate();
      HistoryEntry e = latestOnce(n -> hasStep(n, "jev"), "the failed Jev step");
      Thread.sleep(500);
      assertFalse(latest().json.has("processed"));
      assertTrue(sent("text").isEmpty());
      find("✨ Refine").click();
      e = latestOnce(n -> n.json.has("processed"), "the refined text");
      assertFalse(e.json.has("template"));
    } finally {
      for (Templates.Template t : templates.all()) templates.delete(t.id());
    }
  }

  @Test
  public void failedProcessingStillDeliversWhatYouSaid() throws Exception {
    TestServer.reset();
    TestServer.transcripts("um hi Jana see you at ten");
    TestServer.replies((String) null);
    dictateAndRefine();
    latestOnce(n -> n.json.has("processingFailed"), "the Refine failure");
    assertEquals("um hi Jana see you at ten", new Vault(context).get("transcript"));
    // The note is saved first, the session's state right after it.
    for (int i = 0; i < 50 && !DictationService.FAILED.equals(DictationService.session().refine); i++) Thread.sleep(100);
    assertEquals(DictationService.FAILED, DictationService.session().refine);
  }

  @Test
  public void anUnknownCostIsNeverShownAsFree() throws Exception {
    TestServer.reset();
    TestServer.script("transcribe", new JSONObject().put("text", "Call Jana.").put("cost", JSONObject.NULL));
    dictate();
    HistoryEntry e = latest();
    assertTrue(e.incompleteCost());
    assertEquals(0, e.cost().signum());
    assertFalse(e.json.getJSONArray("steps").getJSONObject(0).has("cost"));
    launch();
    find("Call Jana.").click();
    find("OpenRouter reported no cost for this note yet.");
  }

  @Test
  public void usedUpCreditsKeepTheRecording() throws Exception {
    TestServer.reset();
    TestServer.error("transcribe", "credits");
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1200);
    send(DictationService.STOP);
    waitFor("unfinished");
    assertTrue(detail(), detail().contains("credits are used up"));
    assertEquals(1, DictationService.unfinished(context).size());
  }

  @Test
  public void pastedTextGoesWithTheRequestAndStaysWithTheNote() throws Exception {
    new Attachments(context).addText("Two-room flat, Hauptstraße 5, 900 euros, viewing Saturday 10:00");
    TestServer.reset();
    TestServer.transcripts("write a short application for this flat");
    TestServer.replies("Application for Hauptstraße 5.");
    dictateAndRefine();
    HistoryEntry e = latestOnce(n -> n.json.has("processed"), "the refined text");
    // The note is saved a moment before the last-transcript shortcut.
    long deadline = SystemClock.elapsedRealtime() + 5000;
    while (!"Application for Hauptstraße 5.".equals(new Vault(context).get("transcript"))
        && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100);
    assertEquals("Application for Hauptstraße 5.", new Vault(context).get("transcript"));
    assertEquals(1, e.json.optInt("attached"));
    assertTrue(new Attachments(context).pending().isEmpty());
    assertEquals(1, new Attachments(context).of(e.recordingId()).size());
    // Refine gets the dictation and the pasted text as parts.
    JSONArray parts =
        sent("text").get(0).getJSONArray("messages").getJSONObject(1).getJSONArray("content");
    assertEquals("write a short application for this flat", parts.getJSONObject(0).getString("text"));
    assertTrue(parts.getJSONObject(1).getString("text").contains("Hauptstraße 5"));
  }

  @Test
  public void interfaceFollowsTheAppLanguage() throws Exception {
    device.executeShellCommand("cmd locale set-app-locales app.driftdictation --locales de-DE");
    launch();
    find("Einstellungen").click();
    find("Spracherkennung");
    tap("Lokale Daten löschen");
    assertNotNull(
        device.wait(Until.findObject(By.text(Pattern.compile("(?i)alles löschen"))), 5000));
    device.pressBack();
  }
}
