package app.driftdictation;

import static org.junit.Assert.*;

import android.app.UiAutomation;
import android.content.*;
import android.os.SystemClock;
import android.view.KeyEvent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.io.File;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

/**
 * The floating panel with Dictate & Delegate's Accessibility service on: Insert into the test pad's text
 * field, Insert refined replacing it in place, the copy fallback, the chief's text back, ntfy's
 * Copy broadcast, and the volume-key start. UiAutomation is told not to suppress other
 * accessibility services, so ours runs while the test drives the screen.
 *
 * <p>Screenshots for the docs: run with -e shots true; they go to the app's external files dir
 * (Android/data/app.driftdictation/files/panel).
 */
@RunWith(AndroidJUnit4.class)
public class PanelTest {
  static final String SERVICE = "app.driftdictation/app.driftdictation.TalkAccessibility";
  static final String LINKS = "https://someone.getbb.app";

  Context context;
  UiDevice device;
  SharedPreferences prefs;
  boolean shots;

  void shell(String command) throws Exception {
    device.executeShellCommand(command);
  }

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
    fail("Expected " + state + "; got " + prefs.getString("state", "") + ": " + prefs.getString("detail", ""));
  }

  void until(String what, java.util.function.BooleanSupplier ready) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 15000;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (ready.getAsBoolean()) return;
      Thread.sleep(150);
    }
    fail("Never happened: " + what);
  }

  /** A text on screen, or a panel button by its name: the panel's buttons are icons. */
  UiObject2 find(String text) {
    long end = SystemClock.uptimeMillis() + 10000;
    while (SystemClock.uptimeMillis() < end) {
      UiObject2 o = device.findObject(By.text(text));
      if (o == null) o = device.findObject(By.desc(text));
      if (o != null) return o;
      SystemClock.sleep(200);
    }
    return find(By.desc(text), text);
  }


  UiObject2 find(BySelector selector, String what) {
    UiObject2 found = device.wait(Until.findObject(selector), 10000);
    if (found == null) {
      StringBuilder seen = new StringBuilder();
      for (UiObject2 o : device.findObjects(By.textContains("")))
        seen.append(" | ").append(o.getText());
      fail("Expected on screen: " + what + "; saw" + seen);
    }
    return found;
  }

  int notes() throws Exception {
    try (HistoryStore h = new HistoryStore(context)) {
      return h.all().size();
    }
  }

  HistoryEntry latest() throws Exception {
    try (HistoryStore h = new HistoryStore(context)) {
      return h.list(1, 0).get(0);
    }
  }

  /** Dictate & Delegate in front: Android only lets the app in focus read the clipboard. */
  void front() {
    context.startActivity(
        new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    device.wait(Until.hasObject(By.pkg(context.getPackageName()).depth(0)), 5000);
  }

  void setClipboard(String text) {
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> context.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("mine", text)));
  }

  String clipboard() {
    String[] clip = {null};
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> {
              ClipData c = context.getSystemService(ClipboardManager.class).getPrimaryClip();
              clip[0] = c == null ? null : String.valueOf(c.getItemAt(0).getText());
            });
    return clip[0];
  }

  /** The test pad's text field, with this text in it and the cursor at its end. */
  UiObject2 pad(String text) throws Exception {
    shell("am start -W --activity-clear-task -n app.driftdictation.test/app.driftdictation.TestPadActivity"); // Alone: no web pad below it.
    UiObject2 field = find(By.clazz("android.widget.EditText"), "the test pad's field");
    field.setText(text);
    field.click();
    Thread.sleep(400);
    device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END);
    Thread.sleep(300);
    // The keyboard sometimes trims a trailing space as the field gets focus: put it back.
    if (!text.equals(padText())) {
      field.setText(text);
      Thread.sleep(300);
      device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END);
      Thread.sleep(300);
    }
    assertEquals("the pad's text before inserting", text, padText());
    return field;
  }

  String padText() {
    UiObject2 field = device.findObject(By.clazz("android.widget.EditText").pkg("app.driftdictation.test"));
    if (field == null) return null;
    String text = field.getText();
    return text == null || text.equals("Paste your transcription") ? "" : text;
  }

  /** This dictation's note. */
  HistoryEntry note() throws Exception {
    try (HistoryStore h = new HistoryStore(context)) {
      return h.get(DictationService.session().noteId);
    }
  }

  void shot(String name) throws Exception {
    if (!shots) return;
    Thread.sleep(700);
    File dir = new File(context.getExternalFilesDir(null), "panel");
    dir.mkdirs();
    device.takeScreenshot(new File(dir, name + ".png"));
  }

  void dictate() throws Exception {
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1200);
    send(DictationService.STOP);
    waitFor("copied");
  }

  void accessibility(boolean on) throws Exception {
    // Off first: after the app was reinstalled, a changed setting makes Android bind it again.
    shell("settings delete secure enabled_accessibility_services");
    if (on) {
      until("the service stops", () -> TalkAccessibility.instance == null);
      shell("settings put secure enabled_accessibility_services " + SERVICE);
    }
    shell("settings put secure accessibility_enabled " + (on ? 1 : 0));
    until(on ? "the service starts" : "the service stops", () -> (TalkAccessibility.instance != null) == on);
  }

  @Before
  public void setup() throws Exception {
    // Before the first UiDevice: keep other accessibility services (ours) running.
    Configurator.getInstance().setUiAutomationFlags(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    prefs = context.getSharedPreferences("settings", 0);
    shots = "true".equals(InstrumentationRegistry.getArguments().getString("shots"));
    shell("pm grant app.driftdictation android.permission.RECORD_AUDIO");
    shell("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    shell("cmd locale set-app-locales app.driftdictation --locales en-US");
    shell("input keyevent KEYCODE_WAKEUP");
    shell("wm dismiss-keyguard");
    send(DictationService.DISCARD);
    TestServer.reset();
    TestServer.bbReset();
    TestServer.ntfyReset();
    TestServer.useKey(context);
    new BbBridge(context).disconnect();
    prefs
        .edit()
        .putString("model", "microsoft/mai-transcribe-2")
        .putString("bubbleMode", "recording")
        .putBoolean("onboarded", true)
        .putInt("bubbleX", 16)
        .putInt("bubbleY", 900) // Clear of the test pad's field and of Android's clipboard chip.
        .remove(TalkAccessibility.VOLUME_KEY)
        .remove(BbBridge.CHIEF_ID)
        .remove(ChiefSkills.USER_NAME)
        .remove(ChiefSkills.INSTALLED)
        .remove(ChiefSkills.CHECKED_VERSION)
        .remove(ChiefSkills.CHIEF_TOLD)
        .remove(BbBridge.CHIEF_NAME)
        .remove(BbBridge.NTFY_SERVER)
        .commit();
    Templates templates = new Templates(context);
    for (Templates.Template t : templates.all()) templates.delete(t.id());
    new Attachments(context).clearPending();
    accessibility(true);
  }

  @After
  public void cleanup() throws Exception {
    if (DictationService.busy()) {
      send(DictationService.STOP);
      Thread.sleep(800);
    }
    send(DictationService.HIDE);
    Thread.sleep(300);
    accessibility(false);
    TestServer.reset();
    TestServer.bbReset();
    TestServer.ntfyReset();
    new BbBridge(context).disconnect();
    prefs
        .edit()
        .remove(BbBridge.CHIEF_ID)
        .remove(TextModel.PREF_MODEL)
        .remove(TextModel.PREF_NAME)
        .remove(TextModel.PREF_CLAUDE)
        .remove(BbBridge.CHIEF_NAME)
        .remove(BbBridge.MODE)
        .remove(BbBridge.NTFY_SERVER)
        .remove(TalkAccessibility.VOLUME_KEY)
        .commit();
    device.pressHome();
  }

  @Test
  public void insertPutsTheTranscriptAtTheCursorThenRefinedReplacesItInPlace() throws Exception {
    TestServer.transcripts("um so see you at ten I mean eleven");
    TestServer.replies("See you at eleven.");
    setClipboard("something I still need");
    pad("Hi Jana, ");
    send(DictationService.RECORD);
    waitFor("recording");
    find(By.desc("Stop recording"), "the stop button");
    find("✨ Refine");
    shot("1-recording");
    send(DictationService.STOP);
    waitFor("copied");
    find("Insert");
    shot("2-transcript");
    find("Insert").click();
    until("the transcript is in the field", () -> "Hi Jana, um so see you at ten I mean eleven".equals(padText()));
    find("Inserted");
    // Refine runs when tapped, and its button becomes Insert refined.
    find("✨ Refine").click();
    find("Insert refined");
    shot("3-refined");
    find("Insert refined").click();
    until("the refined text replaced it", () -> "Hi Jana, See you at eleven.".equals(padText()));
    find("Replaced with the refined text");
    // Insert and replace paste through the clipboard, then put back what was there when Android lets the app read it.
    front();
    assertEquals("something I still need", clipboard());
    HistoryEntry e = note();
    assertEquals("See you at eleven.", e.json.optString("processed"));
    assertEquals("um so see you at ten I mean eleven", e.json.optString("original"));
  }

  /**
   * Inserts into a web field (WebPadActivity: kind, with text in it already) and returns what the
   * field holds afterwards. A real message began with the bb editor's placeholder: Chromium
   * reports an empty web field's placeholder as its text.
   */
  String insertIntoWebField(String kind, String already) throws Exception {
    TestServer.reset();
    TestServer.transcripts("I mean, I don't know");
    // A fresh page each time; spaces in the text go as _ (the shell command isn't quoted).
    shell("am start -W --activity-clear-task -n app.driftdictation.test/app.driftdictation.WebPadActivity --es kind " + kind
        + (already.isEmpty() ? "" : " --es text " + already.replace(' ', '_')));
    UiObject2 field = find(By.clazz("android.widget.EditText"), "the web field");
    field.click();
    Thread.sleep(800);
    dictate();
    find("Insert").click();
    String[] now = {null};
    until(
        "the transcript is in the " + kind + " field",
        () -> {
          UiObject2 f = device.findObject(By.clazz("android.widget.EditText"));
          now[0] = f == null ? null : f.getText();
          return now[0] != null && now[0].contains("I mean, I don't know");
        });
    return now[0];
  }

  @Test
  public void insertIntoEmptyWebFieldsLeavesTheirPlaceholderOut() throws Exception {
    for (String kind : new String[] {"textarea", "aria", "css"}) {
      String t = insertIntoWebField(kind, "");
      assertEquals(kind + ": " + t, "I mean, I don't know", t.trim());
    }
  }

  @Test
  public void insertIntoWebFieldsWithTextStillGoesAtTheCursor() throws Exception {
    for (String kind : new String[] {"textarea", "aria", "css"}) {
      String t = insertIntoWebField(kind, "Hi Jana, ");
      // A web editor drops the space at the end of its text (HTML): either is right.
      assertTrue(kind + ": " + t, t.replace('\u00a0', ' ').trim().matches("Hi Jana, ?I mean, I don't know"));
    }
  }

  @Test
  public void editedMeanwhileTheRefinedTextGoesAtTheCursorInstead() throws Exception {
    TestServer.transcripts("see you at ten");
    TestServer.replies("See you at 10.");
    UiObject2 field = pad("");
    dictate();
    find("Insert").click();
    until("the transcript is in the field", () -> "see you at ten".equals(padText()));
    // Text around it doesn't matter: the transcript is still there, unchanged.
    field.setText("Ok, see you at ten, then");
    find("✨ Refine").click();
    find("Insert refined").click();
    until("replaced in place", () -> "Ok, See you at 10., then".equals(padText()));
    // Changed by hand: the refined text goes at the cursor instead.
    field.setText("see you at 10 then");
    field.click();
    device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END);
    Thread.sleep(300);
    find("Insert refined").click();
    until("inserted at the cursor", () -> "see you at 10 thenSee you at 10.".equals(padText()));
  }

  @Test
  public void refineChosenWhileRecordingRunsOnceTheTranscriptIsReady() throws Exception {
    TestServer.transcripts("hello there");
    TestServer.script("text", new JSONObject().put("text", "Hello there!").put("delay", 2));
    send(DictationService.RECORD);
    waitFor("recording");
    find("✨ Refine").click();
    find("✨ Refine ✓");
    assertTrue(TestServer.requests().length() == 0);
    send(DictationService.STOP);
    waitFor("copied");
    find("✨ Refining…");
    shot("2b-refining");
    find("Insert refined");
    assertEquals("Hello there!", note().json.optString("processed"));
  }

  @Test
  public void withAnAnthropicKeyRefineGoesToAnthropicOnItsCredits() throws Exception {
    new Vault(context).put(Anthropic.KEY, "sk-ant-good");
    try {
      TestServer.transcripts("tell Jana see you at ten");
      TestServer.script("anthropic", new JSONObject().put("text", "Hi Jana, see you at ten!"));
      dictate();
      find("✨ Refine").click();
      find("Insert refined");
      JSONArray r = TestServer.requests();
      boolean anthropic = false, openRouterText = false;
      for (int i = 0; i < r.length(); i++) {
        String kind = r.getJSONObject(i).getString("kind");
        anthropic |= kind.equals("anthropic");
        openRouterText |= kind.equals("text");
      }
      assertTrue(anthropic);
      assertFalse(openRouterText);
      HistoryEntry e = note();
      assertEquals("Hi Jana, see you at ten!", e.json.optString("processed"));
      // 1,000 input and 100 output tokens at list price: $0.003, kept apart from the note's cost.
      assertEquals(0, new java.math.BigDecimal("0.003").compareTo(e.anthropicCost()));
      assertEquals(0, TestServer.SPEECH.add(TestServer.JEV).compareTo(e.cost()));
      JSONArray steps = e.json.getJSONArray("steps");
      JSONObject refine = steps.getJSONObject(steps.length() - 1);
      assertEquals("anthropic", refine.getString("provider"));
      assertEquals("claude-sonnet-5-5", refine.getString("model"));
      assertTrue(refine.getBoolean("approx"));
      assertFalse(e.json.has("anthropicWarning"));
    } finally {
      new Vault(context).remove(Anthropic.KEY);
    }
  }

  @Test
  public void thePickedClaudeModelIsCalledAndPricedAsItself() throws Exception {
    new Vault(context).put(Anthropic.KEY, "sk-ant-good");
    prefs.edit().putString(TextModel.PREF_CLAUDE, "claude-opus-5-5").commit();
    try {
      TestServer.transcripts("tell Jana see you at ten");
      TestServer.script("anthropic", new JSONObject().put("text", "Hi Jana, see you at ten!"));
      dictate();
      find("✨ Refine").click();
      find("Insert refined");
      JSONObject body = null;
      JSONArray r = TestServer.requests();
      for (int i = 0; i < r.length(); i++)
        if (r.getJSONObject(i).getString("kind").equals("anthropic")) body = r.getJSONObject(i).getJSONObject("body");
      assertNotNull(body);
      assertEquals("claude-opus-5-5", body.getString("model"));
      // Opus rejects between_tools: no thinking setting, low effort.
      assertFalse(body.has("thinking"));
      HistoryEntry e = note();
      // 1,000 × $4/M + 100 × $20/M.
      assertEquals(0, new java.math.BigDecimal("0.006").compareTo(e.anthropicCost()));
      JSONArray steps = e.json.getJSONArray("steps");
      assertEquals("claude-opus-5-5", steps.getJSONObject(steps.length() - 1).getString("model"));
    } finally {
      new Vault(context).remove(Anthropic.KEY);
      prefs.edit().remove(TextModel.PREF_CLAUDE).commit();
    }
  }

  @Test
  public void aBadAnthropicKeyFallsBackToOpenRouterAndSaysSo() throws Exception {
    new Vault(context).put(Anthropic.KEY, "sk-ant-good");
    try {
      TestServer.transcripts("tell Jana see you at ten");
      TestServer.script("anthropic", new JSONObject().put("error", "key"));
      TestServer.replies("Hi Jana, see you at ten.");
      dictate();
      find("✨ Refine").click();
      find("Insert refined");
      HistoryEntry e = note();
      assertEquals("Hi Jana, see you at ten.", e.json.optString("processed"));
      assertEquals(0, e.anthropicCost().signum());
      // The fallback costs real money, like any OpenRouter call.
      assertEquals(0, TestServer.SPEECH.add(TestServer.JEV).add(TestServer.TEXT).compareTo(e.cost()));
      JSONArray steps = e.json.getJSONArray("steps");
      JSONObject refine = steps.getJSONObject(steps.length() - 1);
      assertEquals("openrouter", refine.getString("provider"));
      assertTrue(refine.getString("fallback"), refine.getString("fallback").contains("Anthropic key"));
      assertTrue(e.json.optString("anthropicWarning").contains("Anthropic key"));
    } finally {
      new Vault(context).remove(Anthropic.KEY);
    }
  }

  @Test
  public void withoutTheServiceInsertCopiesInstead() throws Exception {
    accessibility(false);
    TestServer.transcripts("copy me please");
    pad("");
    dictate();
    find("Insert").click();
    find(By.textStartsWith("Copied instead, paste with a long press"), "the fallback message");
    shot("6-copied-fallback");
    assertEquals("", padText());
    front();
    until("copied", () -> "copy me please".equals(clipboard()));
  }

  @Test
  public void cancelWhileRecordingThrowsItAwayAndCostsNothing() throws Exception {
    TestServer.transcripts("should never be transcribed");
    int notes = notes();
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(800);
    // ✕ on the outer edge: right of every other button.
    UiObject2 cancel = find(By.desc("Cancel: nothing is transcribed or sent"), "✕");
    assertTrue(cancel.getVisibleBounds().left > find(By.desc("Stop recording"), "■").getVisibleBounds().right);
    assertTrue(cancel.getVisibleBounds().left > find(By.desc("Add context to this dictation"), "📎").getVisibleBounds().right);
    cancel.click();
    until("the panel is gone", () -> !DictationService.bubbleVisible());
    until("ready again", () -> DictationService.READY.equals(prefs.getString("state", "")) || DictationService.instance == null);
    assertEquals(0, TestServer.requests().length());
    assertFalse(DictationService.audio(context).exists());
    assertEquals(notes, notes());
  }

  @Test
  public void closeHidesThePanelAndTheNoteStays() throws Exception {
    TestServer.transcripts("a note to keep");
    dictate();
    find("Insert");
    UiObject2 close = find(By.desc("Close"), "✕");
    assertTrue(close.getVisibleBounds().left > find("Insert").getVisibleBounds().right);
    close.click();
    until("the panel is gone", () -> !DictationService.bubbleVisible());
    assertEquals("a note to keep", latest().text());
  }

  /** bb at the fake in custom-address mode with its chief, and ntfy at the fake. */
  BbBridge chief() throws Exception {
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    bb.setChief(new BbBridge.ThreadInfo(TestServer.CHIEF, "Chief of staff", "idle"));
    bb.setNtfyServer(TestServer.ntfyRoot());
    TestServer.skillsCurrent(context);
    return bb;
  }

  @Test
  public void theChiefsTextBackAppearsInThePanelAndInserts() throws Exception {
    BbBridge bb = chief();
    TestServer.transcripts("Henry, write Tom that I'm running late");
    pad("");
    dictate();
    find("🧑‍💼 Chief").click();
    find("Open chat ↗");
    shot("4-chief-sent");
    String request = note().json.optString("chiefRequest");
    assertFalse(request.isEmpty());
    // The panel listens to the topic from the moment it was sent.
    until(
        "the panel subscribes to the topic",
        () -> {
          try {
            JSONArray r = TestServer.ntfyRequests();
            for (int i = 0; i < r.length(); i++)
              if (r.getJSONObject(i).optString("method").equals("subscribe")) return true;
            return false;
          } catch (Exception ex) {
            return false;
          }
        });
    TestServer.ntfyPaste(bb.ntfyTopic(), "other1", "Not for this request.");
    TestServer.ntfyPaste(bb.ntfyTopic(), request, "Hi Tom, I'm running about ten minutes late.");
    find("Insert from chief");
    shot("5-insert-from-chief");
    find("Insert from chief").click();
    until("the chief's text is in the field", () -> "Hi Tom, I'm running about ten minutes late.".equals(padText()));
    until(
        "the note keeps it",
        () -> {
          try {
            return "Hi Tom, I'm running about ten minutes late.".equals(note().json.optString("chiefReply"));
          } catch (Exception ex) {
            return false;
          }
        });
  }

  @Test
  public void refineThenChiefWrapsWholeButtonsInsteadOfSqueezingThem() throws Exception {
    // German, where Insert refined and Open chat ↗ are long: four buttons don't fit one row.
    shell("cmd locale set-app-locales " + context.getPackageName() + " --locales de-DE");
    try {
      chief();
      TestServer.transcripts("sag Tom, dass ich mich verspäte, und mach es höflich");
      TestServer.replies("Hallo Tom, ich verspäte mich etwas. Entschuldige!");
      dictate();
      find("✨ Verfeinern").click();
      find("Verfeinertes einfügen");
      find("🧑‍💼 Chief").click();
      find("Chat öffnen ↗");
      shot("7-refined-and-chief-de");
      for (String label : new String[] {"Einfügen", "Verfeinertes einfügen", "Chat öffnen ↗"}) {
        android.graphics.Rect r = find(label).getVisibleBounds();
        assertTrue(label + " is on screen: " + r, r.left >= 0 && r.right <= device.getDisplayWidth());
      }
      boolean[] fits = {false};
      InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> fits[0] = DictationService.panelFits());
      assertTrue("every button shows its whole label", fits[0]);
      // The chief got what was said, not the refined text, with its request ID.
      List<String> snippets = TestServer.bbSnippets();
      String tell = snippets.get(snippets.size() - 1);
      assertTrue(tell, tell.contains("sag Tom, dass ich mich verspäte"));
      assertFalse(tell, tell.contains("Entschuldige!"));
      assertTrue(tell, tell.contains("[request: " + note().json.optString("chiefRequest") + "]"));
    } finally {
      shell("cmd locale set-app-locales " + context.getPackageName() + " --locales en-US");
    }
  }

  /**
   * Opt-in check against a real bb and a real ntfy server; speech and Jev stay fake. Run with
   * -e realMcp <bb MCP address> -e realLinks <bb web address> -e realNtfy <ntfy server> and
   * -e realTitle <thread title>. Creates a chief with that title (archive it afterwards; its ID is
   * in logcat under TalkRouterReal) and waits for its text to paste as long as the panel does. The
   * skills go to that chief as its first message, not into bb's skills.
   */
  @Test
  public void realBbChiefSendsTextBackToThePanel() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    Assume.assumeTrue(args.getString("realMcp") != null);
    BbBridge bb = new BbBridge(context);
    bb.useCustom(args.getString("realMcp"), "", args.getString("realLinks"));
    bb.setNtfyServer(args.getString("realNtfy"));
    // Never into the real ~/.bb/skills: this chief gets the filled skills as its first message.
    TestServer.skillsCurrent(context);
    java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
    String prompt =
        "For this test, follow these two skills as if they were installed, then reply \"ready\".\n\n"
            + files.get(ChiefSkills.CHIEF)
            + "\n"
            + files.get(ChiefSkills.ROUTER);
    String snippet =
        BbBridge.spawnSnippet(prompt)
            .replace(JSONObject.quote(BbBridge.CHIEF_TITLE), JSONObject.quote(args.getString("realTitle")));
    JSONObject created = bb.run(snippet);
    String chiefId = created.getString("id");
    android.util.Log.i("TalkRouterReal", "chief " + chiefId + " topic " + bb.ntfyTopic());
    bb.setChief(new BbBridge.ThreadInfo(chiefId, args.getString("realTitle"), created.optString("status")));
    TestServer.transcripts(
        "Henry, write a two-sentence reply to Sarah saying I can't make it on Thursday but Friday"
            + " works, and send me the text to paste.");
    pad("");
    dictate();
    find("🧑‍💼 Chief").click();
    find("Open chat ↗");
    shot("real-1-chief-sent");
    // The panel waits five minutes for the chief's text (DictationService.PANEL_WAIT_MS).
    UiObject2 insert = device.wait(Until.findObject(By.desc("Insert from chief")), DictationService.PANEL_WAIT_MS);
    assertNotNull("the chief's text arrived while the panel waited", insert);
    shot("real-2-insert-from-chief");
    insert.click();
    until("the chief's text is in the field", () -> padText().length() > 20);
    android.util.Log.i("TalkRouterReal", "inserted: " + padText());
    shot("real-3-inserted");
  }

  /**
   * Opt-in, like the test above (same -e real… arguments): a red picture goes to a real chief as
   * an attachment, and its answer comes back to the panel.
   */
  @Test
  public void realBbChiefSeesAnAttachedImage() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    Assume.assumeTrue(args.getString("realMcp") != null);
    BbBridge bb = new BbBridge(context);
    bb.useCustom(args.getString("realMcp"), "", args.getString("realLinks"));
    bb.setNtfyServer(args.getString("realNtfy"));
    TestServer.skillsCurrent(context);
    java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
    String prompt =
        "For this test, follow these two skills as if they were installed, then reply \"ready\".\n\n"
            + files.get(ChiefSkills.CHIEF)
            + "\n"
            + files.get(ChiefSkills.ROUTER);
    JSONObject created =
        bb.run(BbBridge.spawnSnippet(prompt).replace(JSONObject.quote(BbBridge.CHIEF_TITLE), JSONObject.quote(args.getString("realTitle"))));
    android.util.Log.i("TalkRouterReal", "chief " + created.getString("id"));
    bb.setChief(new BbBridge.ThreadInfo(created.getString("id"), args.getString("realTitle"), created.optString("status")));
    // -e realBase64 true: as over bb Connect, the upload is refused and a large photo-sized
    // picture (red with noise, over bb's 100,000-character limit as base64) goes in parts.
    boolean base64 = "true".equals(args.getString("realBase64"));
    BbBridge.refuseUploads = base64;
    int side = base64 ? 1200 : 64;
    android.graphics.Bitmap red = android.graphics.Bitmap.createBitmap(side, side, android.graphics.Bitmap.Config.ARGB_8888);
    java.util.Random noise = new java.util.Random(3);
    int[] pixels = new int[side * side];
    for (int i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | ((200 + noise.nextInt(56)) << 16) | (noise.nextInt(40) << 8) | noise.nextInt(40);
    red.setPixels(pixels, 0, side, 0, 0, side, side);
    java.io.ByteArrayOutputStream jpeg = new java.io.ByteArrayOutputStream();
    red.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, jpeg);
    android.util.Log.i("TalkRouterReal", "picture " + jpeg.size() + " bytes");
    new Attachments(context).add("image", "colour.jpg", jpeg.toByteArray(), ".jpg");
    TestServer.transcripts(
        "Henry, look at the attached picture and send me just the name of its colour, in English, as text to paste.");
    pad("");
    dictate();
    find("🧑‍💼 Chief").click();
    find("Open chat ↗");
    UiObject2 insert = device.wait(Until.findObject(By.desc("Insert from chief")), DictationService.PANEL_WAIT_MS);
    assertNotNull("the chief's answer arrived while the panel waited", insert);
    insert.click();
    until("the answer is in the field", () -> padText().toLowerCase().contains("red"));
    JSONArray steps = note().json.getJSONArray("steps");
    android.util.Log.i("TalkRouterReal", "answer: " + padText() + " · " + steps.getJSONObject(steps.length() - 1));
    shot(base64 ? "real-5-image-base64-answer" : "real-4-image-answer");
    BbBridge.refuseUploads = false;
  }

  @Test
  public void ntfysCopyButtonCopiesTheChiefsText() throws Exception {
    BbBridge bb = chief();
    TestServer.ntfyPaste(bb.ntfyTopic(), "abc234", "The text from the notification.");
    front(); // The receiver copies either way; the test may only read it in front.
    // What ntfy's broadcast action sends: an implicit broadcast with the request as an extra.
    shell("am broadcast -a " + TalkAccessibility.COPY_ACTION + " --es request abc234");
    until("copied", () -> "The text from the notification.".equals(clipboard()));
    // Only an ID goes in: text in the broadcast itself is never copied.
    shell("am broadcast -a " + TalkAccessibility.COPY_ACTION + " --es request '../x' --es text evil");
    Thread.sleep(1000);
    assertEquals("The text from the notification.", clipboard());
  }

  /** Hands the service a key event as Android's input filter would. */
  boolean key(int action, int code) {
    boolean[] consumed = {false};
    long t = SystemClock.uptimeMillis();
    InstrumentationRegistry.getInstrumentation()
        .runOnMainSync(
            () -> consumed[0] = TalkAccessibility.instance.onKeyEvent(new KeyEvent(t, t, action, code, 0)));
    return consumed[0];
  }

  @Test
  public void aVolumeKeyStartAfterAnotherDictationShowsTheRecordingPanel() throws Exception {
    TestServer.transcripts("the first one", "the second one");
    prefs.edit().putString(TalkAccessibility.VOLUME_KEY, TalkAccessibility.DOWN).putInt(TalkAccessibility.HOLD_MS, 300).commit();
    pad("");
    dictate();
    find("Insert");
    assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN));
    Thread.sleep(500);
    assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_DOWN));
    waitFor("recording");
    find(By.desc("Stop recording"), "the stop button");
    find("✨ Refine");
    shot("0b-volume-recording-again");
    assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN));
    Thread.sleep(100);
    assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_DOWN));
    waitFor("copied");
    find("Insert");
  }

  @Test
  public void holdingTheVolumeKeyStartsAndStopsAShortPressIsTheVolume() throws Exception {
    TestServer.transcripts("started with the volume key");
    prefs.edit().putString(TalkAccessibility.VOLUME_KEY, TalkAccessibility.DOWN).putInt(TalkAccessibility.HOLD_MS, 300).commit();
    device.pressHome();
    // Other keys, and the other volume key, are left alone.
    assertFalse(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP));
    assertFalse(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A));
    // A short press is held back, then sent on as a volume change; nothing records.
    assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN));
    Thread.sleep(100);
    assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_DOWN));
    Thread.sleep(800);
    assertFalse(DictationService.busy());
    // Held: recording starts (through the tile's short-lived window), then a hold stops it.
    assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN));
    Thread.sleep(500);
    assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_DOWN));
    waitFor("recording");
    // The panel is there while recording, so Refine and Chief can be chosen while talking.
    find(By.desc("Stop recording"), "the stop button");
    find("✨ Refine");
    shot("0-volume-recording");
    Thread.sleep(1000);
    assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN));
    Thread.sleep(500);
    assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_DOWN));
    waitFor("copied");
    assertEquals("started with the volume key", note().text());
    // Switched off, the key is Android's again.
    prefs.edit().putString(TalkAccessibility.VOLUME_KEY, TalkAccessibility.OFF).commit();
    assertFalse(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_DOWN));
  }

  /** With a second assistant, holding the other volume key starts a dictation for it: its buttons first. */
  @Test
  public void holdingTheOtherVolumeKeyStartsADictationForTheSecondAssistant() throws Exception {
    chief();
    BbBridge work = new BbBridge(context, 1);
    work.useCustom(TestServer.bbUrl(), "", LINKS);
    work.setChief(new BbBridge.ThreadInfo("thr_workchief", "Chief of staff", "idle"));
    Assistants.setName(context, 1, "Work");
    prefs.edit().putString(Assistants.key(1, ChiefSkills.INSTALLED), ChiefSkills.summary(ChiefSkills.filled(context, 1))).putInt(Assistants.key(1, ChiefSkills.CHECKED_VERSION), BuildConfig.VERSION_CODE).commit();
    try {
      TestServer.transcripts("for work");
      prefs.edit().putString(TalkAccessibility.VOLUME_KEY, TalkAccessibility.DOWN).putInt(TalkAccessibility.HOLD_MS, 300).commit();
      device.pressHome();
      assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP));
      Thread.sleep(500);
      assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_UP));
      waitFor("recording");
      assertEquals(1, DictationService.session().keyAssistant);
      // Work's W first, before Personal's P.
      android.graphics.Rect w = find("Send to Work").getVisibleBounds(), p = find("Send to Personal").getVisibleBounds();
      assertTrue(w + " before " + p, w.centerX() < p.centerX());
      shot("0b-volume-up-work");
      // Its own key stops it too.
      Thread.sleep(800);
      assertTrue(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP));
      Thread.sleep(500);
      assertTrue(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_UP));
      waitFor("copied");
      // Switched off in Settings → Start: volume up is the volume again.
      prefs.edit().putBoolean(Assistants.OTHER_KEY, false).commit();
      assertFalse(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP));
    } finally {
      work.disconnect();
      work.forgetChief();
      prefs.edit().remove(Assistants.OTHER_KEY).remove(Assistants.key(1, Assistants.NAME)).remove(Assistants.key(1, BbBridge.MODE)).commit();
      prefs.edit().putString(TalkAccessibility.VOLUME_KEY, TalkAccessibility.OFF).commit();
    }
  }

  @Test
  public void thePanelStaysDraggableAndNeverTakesFocus() throws Exception {
    TestServer.transcripts("drag me");
    UiObject2 field = pad("");
    dictate();
    UiObject2 insert = find("Insert");
    android.graphics.Rect before = insert.getVisibleBounds();
    // Drag by a button: a move past the touch slop drags the panel and doesn't press it.
    device.drag(before.centerX(), before.centerY(), before.centerX(), before.centerY() - 400, 30);
    Thread.sleep(600);
    android.graphics.Rect after = find("Insert").getVisibleBounds();
    assertTrue(before + " → " + after, after.centerY() < before.centerY() - 200);
    // The field still has focus: Insert lands in it.
    assertTrue(field.isFocused());
    find("Insert").click();
    until("inserted", () -> "drag me".equals(padText()));
    assertFalse(device.findObjects(By.desc("Insert")).isEmpty()); // Still there.
  }

  /** The 📎 while recording: the file picker over the panel takes taps, and the file is attached. */
  @Test
  public void theFilePickerFromThePanelTakesTapsAndAttachesTheFile() throws Exception {
    // A small text file in Downloads (no shell redirect here: a copy of the hosts file).
    device.executeShellCommand("cp /system/etc/hosts /sdcard/Download/attach-me.txt");
    device.executeShellCommand("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/attach-me.txt");
    new Attachments(context).clearPending();
    send(DictationService.RECORD);
    waitFor("recording");
    find(By.desc("Add context to this dictation"), "📎").click();
    find("Attach a file").click();
    // Android's picker: open Downloads if it doesn't start there, then the file.
    UiObject2 file = device.wait(Until.findObject(By.text("attach-me.txt")), 5000);
    if (file == null) {
      UiObject2 roots = device.wait(Until.findObject(By.desc("Show roots")), 5000);
      if (roots != null) roots.click();
      Thread.sleep(1000); // The drawer slides in.
      UiObject2 downloads = device.wait(Until.findObject(By.text("Downloads")), 5000);
      assertNotNull("Downloads in the picker", downloads);
      downloads.click();
      file = device.wait(Until.findObject(By.text("attach-me.txt")), 5000);
    }
    assertNotNull("the file in the picker", file);
    // Nothing of Dictate & Delegate over the picker: some pickers ignore every tap under another
    // app's window.
    assertFalse("no panel over the picker", DictationService.bubbleVisible());
    shot("attach-picker");
    file.click();
    until("the file is attached", () -> new Attachments(context).pending().size() == 1);
    assertEquals("attach-me.txt", new Attachments(context).pending().get(0).name());
    // Back from the picker: the panel is there again, still recording.
    until("the panel is back", DictationService::bubbleVisible);
    assertEquals(DictationService.RECORDING, prefs.getString("state", ""));
    send(DictationService.DISCARD);
  }
}
