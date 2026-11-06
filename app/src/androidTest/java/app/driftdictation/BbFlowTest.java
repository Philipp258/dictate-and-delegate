package app.driftdictation;

import static org.junit.Assert.*;

import android.content.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.math.BigDecimal;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

/**
 * bb and the chief of staff, against the fake OpenRouter and the fake bb MCP server
 * (scripts/fakes/fake_bb_mcp.py) in custom-address mode.
 */
@RunWith(AndroidJUnit4.class)
public class BbFlowTest {
  static final String LINKS = "https://someone.getbb.app";
  static final String CHIEF_LINK = LINKS + "/threads/" + TestServer.CHIEF;

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

  /** The latest note once it matches, e.g. once the chief got it. */
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

  void dictate(String finalState) throws Exception {
    send(DictationService.RECORD);
    waitFor("recording");
    Thread.sleep(1200);
    send(DictationService.STOP);
    waitFor(finalState);
  }

  HistoryEntry latest() throws Exception {
    try (HistoryStore h = new HistoryStore(context)) {
      return h.list(1, 0).get(0);
    }
  }

  List<JSONObject> sent(String kind) throws Exception {
    List<JSONObject> out = new java.util.ArrayList<>();
    JSONArray all = TestServer.requests();
    for (int i = 0; i < all.length(); i++)
      if (all.getJSONObject(i).getString("kind").equals(kind))
        out.add(all.getJSONObject(i).getJSONObject("body"));
    return out;
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

  void launch() throws Exception {
    context.startActivity(
        new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    device.wait(Until.hasObject(By.pkg(context.getPackageName()).depth(0)), 5000);
    Thread.sleep(500);
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
    UiObject2 found = device.wait(Until.findObject(selector), 8000);
    if (found == null) {
      StringBuilder seen = new StringBuilder();
      for (UiObject2 o : device.findObjects(By.textContains("")))
        seen.append(" | ").append(o.getText());
      fail("Expected on screen: " + what + "; saw" + seen);
    }
    return found;
  }

  void tap(String text) throws Exception {
    UiScrollable page = new UiScrollable(new UiSelector().scrollable(true));
    if (page.exists()) {
      page.scrollIntoView(new UiSelector().text(text));
      UiObject2 shown = find(text);
      if (shown.getVisibleBounds().bottom > device.getDisplayHeight() * 0.85) {
        // A short drag, not a fling: a fling can carry the row off the top of a long page.
        int x = device.getDisplayWidth() / 2, h = device.getDisplayHeight();
        device.swipe(x, h * 7 / 10, x, h * 4 / 10, 40);
      }
    }
    Thread.sleep(700);
    find(text).click();
    Thread.sleep(400);
  }

  /** bb in custom-address mode at the fake, with its chief, as Settings → bb leaves it. */
  void connectFake() throws Exception {
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    bb.setChief(new BbBridge.ThreadInfo(TestServer.CHIEF, "Chief of staff", "idle"));
    TestServer.skillsCurrent(context);
  }

  static final String WORK_CHIEF = "thr_workchief";

  /** A second assistant ("Work") at the same fake bb, with a chief of its own and its own topic. */
  BbBridge connectSecond() throws Exception {
    BbBridge work = new BbBridge(context, 1);
    work.useCustom(TestServer.bbUrl(), "", LINKS);
    work.setChief(new BbBridge.ThreadInfo(WORK_CHIEF, "Chief of staff", "idle"));
    Assistants.setName(context, 1, "Work");
    Assistants.setName(context, 0, "Personal");
    prefs
        .edit()
        .putString(Assistants.key(1, ChiefSkills.INSTALLED), ChiefSkills.summary(ChiefSkills.filled(context, 1)))
        .putInt(Assistants.key(1, ChiefSkills.CHECKED_VERSION), BuildConfig.VERSION_CODE)
        .commit();
    return work;
  }

  /** Forgets the second assistant. */
  void forgetSecond() {
    new BbBridge(context, 1).disconnect();
    SharedPreferences.Editor e = prefs.edit();
    for (String k : new String[] {BbBridge.MODE, BbBridge.HANDLE, BbBridge.URL, BbBridge.LINK_BASE, BbBridge.CHIEF_ID, BbBridge.CHIEF_NAME, BbBridge.NTFY_SERVER, ChiefSkills.INSTALLED, ChiefSkills.CHECKED_VERSION, ChiefSkills.CHIEF_TOLD, Assistants.NAME})
      e.remove(Assistants.key(1, k));
    e.remove(Assistants.NAME).remove(Assistants.OTHER_KEY).commit();
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
    TestServer.bbReset();
    TestServer.useKey(context);
    new BbBridge(context).disconnect();
    forgetSecond();
    prefs
        .edit()
        .putString("model", "microsoft/mai-transcribe-2")
        .putString("bubbleMode", "recording")
        .putBoolean("onboarded", true)
        .remove(BbBridge.MODE)
        .remove(BbBridge.HANDLE)
        .remove(BbBridge.URL)
        .remove(BbBridge.LINK_BASE)
        .remove(BbBridge.CHIEF_ID)
        .remove(ChiefSkills.USER_NAME)
        .remove(ChiefSkills.INSTALLED)
        .remove(ChiefSkills.CHECKED_VERSION)
        .remove(ChiefSkills.CHIEF_TOLD)
        .remove(BbBridge.CHIEF_NAME)
        .remove(BbBridge.NTFY_SERVER)
        .remove(BbBridge.TALKER_ID)
        .remove(BbBridge.TALKER_ON)
        .commit();
    new Attachments(context).clearPending();
  }

  @After
  public void cleanup() throws Exception {
    if (DictationService.busy()) {
      send(DictationService.STOP);
      Thread.sleep(800);
    }
    send(DictationService.HIDE);
    TestServer.reset();
    TestServer.bbReset();
    new BbBridge(context).disconnect();
    forgetSecond();
    prefs.edit().remove(BbBridge.CHIEF_ID).remove(BbBridge.CHIEF_NAME).remove(BbBridge.MODE).commit();
    new Attachments(context).clearPending();
    device.pressHome();
  }

  @Test
  public void settingsConnectACustomAddressThenCreateTheChief() throws Exception {
    launch();
    tap("Settings");
    tap("Connection");
    find("bb Connect");
    tap("Custom address");
    find("https://…/mcp").setText(TestServer.bbUrl());
    find("https://<handle>.getbb.app").setText(LINKS);
    tap("Save and test");
    BbBridge bb = new BbBridge(context);
    long deadline = SystemClock.elapsedRealtime() + 15000;
    while (!bb.connected() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(200);
    assertTrue(bb.connected());
    Thread.sleep(1000);
    assertEquals(BbBridge.CUSTOM, bb.mode());
    assertEquals(LINKS, bb.linkBase());
    // The test asked for the tools.
    JSONArray mcp = TestServer.bbRequests();
    boolean listed = false;
    for (int i = 0; i < mcp.length(); i++)
      listed |= mcp.getJSONObject(i).getString("method").equals("tools/list");
    assertTrue(listed);

    device.pressBack();
    // bb sits below Keys, Costs and Dictation in Settings.
    scrollTo(new UiSelector().textStartsWith("Custom address · 127.0.0.1"));
    find(By.textStartsWith("Custom address · 127.0.0.1"), "the connection");
    tap("Chief of staff");
    tap("Create chief of staff");
    deadline = SystemClock.elapsedRealtime() + 15000;
    while (new BbBridge(context).chiefId().isEmpty() && SystemClock.elapsedRealtime() < deadline)
      Thread.sleep(200);
    assertEquals(TestServer.CHIEF, new BbBridge(context).chiefId());
    // Connecting installed the skills through a short thread, with the topic and links filled in.
    String topic = new Vault(context).get(BbBridge.NTFY_TOPIC);
    assertTrue(topic, topic.matches("talkrouter-[A-Za-z0-9_-]{24}"));
    JSONObject skills = TestServer.bbSkills();
    String router = skills.getJSONObject("files").getString("dictate-and-delegate");
    assertTrue(router, router.contains("https://ntfy.sh/" + topic));
    assertTrue(router, router.contains(LINKS + "/threads/$BB_THREAD_ID"));
    assertTrue(skills.getJSONObject("files").getString("chief-of-staff").contains("the user's chief of staff"));
    // The chief itself only gets one line.
    String spawn = null;
    for (String code : TestServer.bbSnippets()) if (code.contains("\"--title\",\"Chief of staff\"")) spawn = code;
    assertNotNull(spawn);
    assertTrue(spawn, spawn.contains("\"thread\",\"spawn\",\"--project\",\"proj_personal\",\"--title\",\"Chief of staff\""));
    assertTrue(spawn, spawn.contains(ChiefSkills.START));
    assertFalse(spawn, spawn.contains("talkrouter-paste"));
    find("Open in bb ↗");

    device.pressBack();
    scrollTo(new UiSelector().text("Chief of staff · " + TestServer.CHIEF));
    find("Chief of staff · " + TestServer.CHIEF);
    tap("Notifications");
    find(topic);
    find("Open in ntfy");
  }

  static String sha256(byte[] data) throws Exception {
    StringBuilder s = new StringBuilder();
    for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(data)) s.append(String.format("%02x", b));
    return s.toString();
  }

  @Test
  public void imagesAndPdfsReachTheChiefAsAttachmentsImagesFirst() throws Exception {
    connectFake();
    byte[] pdf = "%PDF-1.4 fake offer".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    byte[] jpeg = new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2, 3, (byte) 0x80, (byte) 0xff, (byte) 0xd9};
    Attachments a = new Attachments(context);
    a.add("pdf", "offer (1).pdf", pdf, ".pdf");
    a.add("image", "IMG_20261016_152137_426.jpg", jpeg, ".jpg");
    a.addText("Flight TP 1234");
    TestServer.transcripts("Henry, look at this flat and the offer");
    TestServer.decide(0, 0.97, "none");
    dictate("copied");
    HistoryEntry e = latestOnce(n -> n.json.has("chiefThread"), "the chief");
    JSONArray uploads = TestServer.bbUploads();
    assertEquals(2, uploads.length());
    // The image first, byte for byte, then the PDF; both through bb's REST upload.
    assertEquals("IMG_20261016_152137_426.jpg", uploads.getJSONObject(0).getString("name"));
    assertEquals("image/jpeg", uploads.getJSONObject(0).getString("mimeType"));
    assertEquals(sha256(jpeg), uploads.getJSONObject(0).getString("sha256"));
    assertEquals("offer__1_.pdf", uploads.getJSONObject(1).getString("name"));
    assertEquals(sha256(pdf), uploads.getJSONObject(1).getString("sha256"));
    assertEquals("rest", uploads.getJSONObject(1).getString("via"));
    List<String> snippets = TestServer.bbSnippets();
    String tell = snippets.get(snippets.size() - 1);
    assertTrue(tell, tell.contains("\"--image\",\"" + uploads.getJSONObject(0).getString("path") + "\",\"--file\",\"" + uploads.getJSONObject(1).getString("path") + "\""));
    assertTrue(tell, tell.contains("Flight TP 1234"));
    assertFalse(tell, tell.contains("can't pass on"));
    assertFalse(tell, tell.contains("base64"));
    JSONArray steps = e.json.getJSONArray("steps");
    JSONObject bb = steps.getJSONObject(steps.length() - 1);
    assertEquals(2, bb.getInt("files"));
    assertEquals("upload", bb.getString("filesHow"));
  }

  /** The fake's base64 uploads for a file, joined in part order and decoded. */
  static byte[] joined(JSONArray uploads, String name) throws Exception {
    java.util.TreeMap<String, String> parts = new java.util.TreeMap<>();
    for (int i = 0; i < uploads.length(); i++) {
      JSONObject u = uploads.getJSONObject(i);
      if (u.getString("name").startsWith(name + ".part")) parts.put(u.getString("name"), u.getString("text"));
    }
    return android.util.Base64.decode(String.join("", parts.values()), android.util.Base64.DEFAULT);
  }

  @Test
  public void whenBbRefusesTheUploadALargeImageGoesAsBase64PartsUnderTheLimit() throws Exception {
    connectFake();
    TestServer.bbUploadStatus(401);
    byte[] big = new byte[230_000]; // 306,668 base64 characters: four parts under bb's limit
    new java.util.Random(7).nextBytes(big);
    byte[] small = new byte[] {(byte) 0xff, (byte) 0xd8, 0, 1, (byte) 0xfe, (byte) 0xff, (byte) 0xd9};
    Attachments a = new Attachments(context);
    a.add("image", "flat.jpg", big, ".jpg");
    a.add("image", "floor plan.jpg", small, ".jpg");
    TestServer.transcripts("Henry, what do you think of this flat");
    TestServer.decide(0, 0.97, "none");
    dictate("copied");
    HistoryEntry e = latestOnce(n -> n.json.has("chiefThread"), "the chief");
    JSONArray uploads = TestServer.bbUploads();
    // Four parts for the big one, one for the small one; every snippet under 100,000 characters.
    assertEquals(5, uploads.length());
    for (int i = 0; i < uploads.length(); i++) {
      assertEquals("mcp", uploads.getJSONObject(i).getString("via"));
      assertTrue(uploads.getJSONObject(i).getInt("codeLength") < 100_000);
    }
    assertEquals("flat.jpg.part01of04.b64", uploads.getJSONObject(0).getString("name"));
    assertEquals(sha256(big), sha256(joined(uploads, "flat.jpg")));
    assertEquals(sha256(small), sha256(joined(uploads, "floor_plan.jpg")));
    List<String> snippets = TestServer.bbSnippets();
    String tell = snippets.get(snippets.size() - 1);
    for (int i = 0; i < uploads.length(); i++)
      assertTrue(tell, tell.contains("\"--file\",\"" + uploads.getJSONObject(i).getString("path") + "\""));
    assertTrue(tell, tell.contains("cat <name>.part*.b64 | base64 -d > <name>"));
    assertTrue(tell, tell.contains("flat.jpg (4 parts), floor_plan.jpg (1 part)"));
    JSONObject step = e.json.getJSONArray("steps").getJSONObject(e.json.getJSONArray("steps").length() - 1);
    assertEquals("base64", step.getString("filesHow"));
    assertEquals(2, step.getInt("files"));
    assertEquals(401, step.getInt("uploadRefused"));
  }

  @Test
  public void aFileThatCantGoIsNamedAndTheDictationStillGoes() throws Exception {
    connectFake();
    TestServer.bbUploadStatus(403);
    // Over the base64 limit: it can't go, the dictation does, with a note.
    new Attachments(context).add("pdf", "contract.pdf", new byte[BbBridge.BASE64_MAX + 1], ".pdf");
    TestServer.transcripts("Henry, check the contract");
    TestServer.decide(0, 0.97, "none");
    dictate("copied");
    HistoryEntry e = latestOnce(n -> n.json.has("chiefThread"), "the chief");
    assertFalse(e.json.has("chiefFailed"));
    String tell = TestServer.bbSnippets().get(TestServer.bbSnippets().size() - 1);
    assertTrue(tell, tell.contains("Henry, check the contract"));
    assertTrue(tell, tell.contains("(I also attached contract.pdf: it's too big to pass on this way. Dictate & Delegate couldn't pass that on.)"));
    assertFalse(tell, tell.contains("--file"));
    JSONObject step = e.json.getJSONArray("steps").getJSONObject(e.json.getJSONArray("steps").length() - 1);
    assertTrue(step.getString("filesFailed").startsWith("contract.pdf"));
    assertEquals(403, step.getInt("uploadRefused"));
  }

  /** Scrolls the page to its end. */
  void scrollTo(UiSelector selector) throws Exception {
    new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(selector);
    Thread.sleep(300);
  }

  void toEnd() throws Exception {
    new UiScrollable(new UiSelector().scrollable(true)).scrollToEnd(5);
    Thread.sleep(500);
  }

  /** Waits up to 20 s for a condition. */
  void until(java.util.concurrent.Callable<Boolean> condition, String what) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 20000;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (condition.call()) return;
      Thread.sleep(200);
    }
    fail("Never happened: " + what);
  }

  void waitDecided() throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 8000;
    while (!DictationService.session().decided && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100);
    Thread.sleep(500);
  }

  @Test
  public void tappedChiefTheTaskGoesToTheChiefWithThePastedText() throws Exception {
    connectFake();
    new Attachments(context).addText("Flights: TP 1234 on 3 May, FR 88 on 4 May");
    TestServer.transcripts("Henry, find the cheapest of these flights");
    dictate("copied");
    find("🧑‍💼 Chief").click();
    HistoryEntry e = latestOnce(n -> n.json.has("chiefThread"), "the chief");
    // The note is saved a moment before the panel's state flips.
    until(() -> DictationService.DONE.equals(DictationService.session().chief), "the chief sent");

    // Jev wasn't asked (no templates); Refine didn't run.
    assertTrue(sent("decide").isEmpty());
    assertTrue(sent("text").isEmpty());

    // One tell to the chief, queued, with what was said, the pasted text and a request ID.
    List<String> snippets = TestServer.bbSnippets();
    assertEquals(1, snippets.size());
    String tell = snippets.get(0);
    assertTrue(tell, tell.contains("\"thread\",\"tell\",\"" + TestServer.CHIEF + "\",\"--mode\",\"queue\""));
    assertTrue(tell, tell.contains("Henry, find the cheapest of these flights"));
    assertTrue(tell, tell.contains("Flights: TP 1234 on 3 May, FR 88 on 4 May"));
    String request = e.json.optString("chiefRequest");
    assertTrue(request, request.matches("[a-z0-9]{6}"));
    assertTrue(tell, tell.contains("[request: " + request + "]"));

    assertEquals(TestServer.CHIEF, e.json.optString("chiefThread"));
    assertEquals(CHIEF_LINK, e.json.optString("chiefLink"));
    assertFalse(e.json.has("chiefFailed"));
    assertEquals(0, TestServer.SPEECH.compareTo(e.cost()));
    JSONArray steps = e.json.getJSONArray("steps");
    JSONObject bb = steps.getJSONObject(steps.length() - 1);
    assertEquals("bb", bb.getString("kind"));
    assertEquals("chief of staff", bb.getString("model"));
    assertFalse(bb.has("cost"));
    assertFalse(bb.has("detail"));

    // The panel's Chief button became Open chat ↗.
    find("Open chat ↗");
    send(DictationService.HIDE);
    Thread.sleep(500);
    launch();
    // In front now, so the test may read the clipboard: nothing was copied by itself.
    assertNotEquals("Henry, find the cheapest of these flights", clipboard());
    tap("Henry, find the cheapest of these flights");
    find("Sent to chief of staff ↗");
    find("What you said");

    launch();
    tap("Settings");
    tap("Activity");
    find(By.text(Pattern.compile("bb · Chief of staff · \\d+[.,]\\d s")), "the bb step");

    // The link opens the thread in the browser.
    launch();
    tap("Henry, find the cheapest of these flights");
    find("Sent to chief of staff ↗").click();
    assertTrue(
        "the browser opens",
        device.wait(Until.gone(By.pkg(context.getPackageName()).depth(0)), 8000));
    device.pressBack();
  }

  @Test
  public void nothingGoesToTheChiefOrIsRefinedByWhatWasSaid() throws Exception {
    connectFake();
    // Addressed by name and asking for a text: still nothing happens until a button is tapped.
    TestServer.transcripts("Henry, turn this into an email about the hotel booking");
    TestServer.decide(0.95, 0.99, "none");
    dictate("copied");
    waitDecided();
    Thread.sleep(1000);
    assertEquals(DictationService.IDLE, DictationService.session().chief);
    assertEquals(DictationService.IDLE, DictationService.session().refine);
    // Without templates Jev isn't even asked.
    assertTrue(sent("decide").isEmpty());
    assertTrue(sent("text").isEmpty());
    assertTrue(TestServer.bbSnippets().isEmpty());
    find("🧑‍💼 Chief");
  }

  @Test
  public void withTwoAssistantsEachHasItsButtonAndTheDictationGoesWhereTapped() throws Exception {
    connectFake();
    connectSecond();
    TestServer.transcripts("check why the work build is red");
    // The volume key of the second assistant started it: its buttons come first.
    context.startForegroundService(
        new Intent(context, DictationService.class).setAction(DictationService.RECORD).putExtra(DictationService.ASSISTANT, 1));
    waitFor("recording");
    assertEquals(1, DictationService.session().keyAssistant);
    assertEquals(java.util.List.of(0, 1), DictationService.session().assistants);
    find("Send to Personal");
    find("Hands-free call with Work");
    find("Hands-free call with Personal");
    Thread.sleep(1200);
    send(DictationService.STOP);
    waitFor("copied");
    find("Send to Work").click();
    HistoryEntry e = latestOnce(n -> n.json.has("chiefThread"), "the work chief");
    until(() -> DictationService.DONE.equals(DictationService.session().chief), "sent");
    assertEquals(1, e.json.optInt("assistant"));
    assertEquals(WORK_CHIEF, e.json.optString("chiefThread"));
    List<String> snippets = TestServer.bbSnippets();
    String tell = snippets.get(snippets.size() - 1);
    assertTrue(tell, tell.contains("\"thread\",\"tell\",\"" + WORK_CHIEF + "\""));
    assertFalse(tell, tell.contains(TestServer.CHIEF));
    find("Open the chat with Work ↗");
    // Once it went to Work, the Personal button is gone.
    assertNull(device.findObject(By.desc("Send to Personal")));
    find("Sent to Work");
  }

  @Test
  public void aNoteThatFailedGoesToItsOwnAssistantWhenTriedAgain() throws Exception {
    connectFake();
    connectSecond();
    long[] waits = BbBridge.AGAIN_MS;
    BbBridge.AGAIN_MS = new long[0];
    try {
      TestServer.transcripts("the work deploy needs a look");
      TestServer.bbFail("tell", "http503");
      dictate("copied");
      find("Send to Work").click();
      HistoryEntry e = latestOnce(n -> n.json.optBoolean("chiefQueued"), "queued");
      assertEquals(1, e.json.optInt("assistant"));
      String request = e.json.optString("chiefRequest");
      // Later, from the outbox: to the second assistant's chief, with the same request ID.
      assertTrue(Outbox.flush(context, true));
      e = latestOnce(n -> n.json.has("chiefThread") && !n.json.has("chiefFailed"), "sent");
      assertEquals(WORK_CHIEF, e.json.optString("chiefThread"));
      assertEquals(request, e.json.optString("chiefRequest"));
      for (String code : TestServer.bbSnippets())
        if (code.contains("[request: " + request + "]")) assertTrue(code, code.contains(WORK_CHIEF) && !code.contains(TestServer.CHIEF));
    } finally {
      BbBridge.AGAIN_MS = waits;
    }
  }

  @Test
  public void chosenWhileRecordingTheChiefGetsItOnceTheTranscriptIsReady() throws Exception {
    connectFake();
    TestServer.transcripts("the build is red again");
    send(DictationService.RECORD);
    waitFor("recording");
    find("🧑‍💼 Chief").click();
    find("🧑‍💼 Chief ✓");
    assertTrue(TestServer.bbSnippets().isEmpty());
    send(DictationService.STOP);
    waitFor("copied");
    latestOnce(n -> n.json.has("chiefThread"), "the chief");
    assertTrue(TestServer.bbSnippets().get(0).contains("the build is red again"));
  }

  @Test
  public void aTalkersSkillThatBbRefusesOrATalkerThatCantBeToldNeverFailsTheChiefsSkills() throws Exception {
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    bb.setChief(new BbBridge.ThreadInfo(TestServer.CHIEF, "Chief of staff", "idle"));
    prefs.edit()
        .putBoolean(ChiefSkills.CHIEF_TOLD, true)
        .putString(ChiefSkills.USER_NAME, "Alex")
        .putString(BbBridge.TALKER_ID, "thr_faketalker")
        .putBoolean(BbBridge.TALKER_ON, true)
        .remove(ChiefSkills.TALKER_TOLD)
        .commit();
    ChiefSkills.pollMs = 300;
    long grace = ChiefSkills.talkerGraceMs;
    ChiefSkills.talkerGraceMs = 1500;
    try {
      // bb leaves out the talker's skill: the chief's are installed, and that's said apart.
      TestServer.bbSkipSkills("dictate-and-delegate-talker");
      ChiefSkills.sync(context, true);
      until(() -> ChiefSkills.state(0) == ChiefSkills.State.INSTALLED && !ChiefSkills.talkerSkillProblem.isEmpty(), "installed, the talker's skill missing");
      assertEquals("", ChiefSkills.problem(0));
      JSONObject installed = TestServer.bbSkills().getJSONObject("installed");
      java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
      assertEquals(ChiefSkills.marker(files.get("dictate-and-delegate")), installed.getString("dictate-and-delegate"));
      assertEquals("", installed.optString("dictate-and-delegate-talker"));
      assertEquals("not told to use a skill that isn't there", "", prefs.getString(ChiefSkills.TALKER_TOLD, ""));
      // bb takes it next time; then the talker can't be reached: also said apart.
      TestServer.bbSkipSkills();
      TestServer.bbFail("tell", "tool", "thr_faketalker");
      ChiefSkills.sync(context, true);
      until(() -> ChiefSkills.state(0) == ChiefSkills.State.INSTALLED && ChiefSkills.talkerSkillProblem.isEmpty() && !ChiefSkills.talkerTellProblem.isEmpty(), "installed, the talker not told");
      assertEquals("", ChiefSkills.problem(0));
      assertTrue(ChiefSkills.talkerProblem(), ChiefSkills.talkerProblem().startsWith("Couldn't tell the talker to use its skill: "));
      // Reachable again: told at the next sync, once.
      ChiefSkills.sync(context, false);
      until(() -> ChiefSkills.talkerTellProblem.isEmpty() && !prefs.getString(ChiefSkills.TALKER_TOLD, "").isEmpty(), "told");
      long told = TestServer.bbSnippets().stream().filter(c -> c.contains("Use the dictate-and-delegate-talker skill")).count();
      assertEquals(2, told); // The failed try and the one that went.
    } finally {
      ChiefSkills.talkerGraceMs = grace;
    }
  }

  @Test
  public void connectingInstallsTheSkillsAndAnOlderChiefIsToldOnce() throws Exception {
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    // A chief from before the skills: it hasn't been told.
    bb.setChief(new BbBridge.ThreadInfo(TestServer.CHIEF, "Chief of staff", "idle"));
    prefs.edit().remove(ChiefSkills.CHIEF_TOLD).putString(ChiefSkills.USER_NAME, "Alex").commit();
    ChiefSkills.pollMs = 300;
    launch();
    tap("Settings");
    tap("Connection");
    find("Your chief's skills");
    toEnd();
    find(By.textContains("Installed in bb"), "installed");
    JSONObject installed = TestServer.bbSkills().getJSONObject("installed");
    java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
    assertEquals(ChiefSkills.marker(files.get("chief-of-staff")), installed.getString("chief-of-staff"));
    assertEquals(ChiefSkills.marker(files.get("dictate-and-delegate")), installed.getString("dictate-and-delegate"));
    assertEquals("no talker: no talker skill to wait for", "", installed.optString("dictate-and-delegate-talker"));
    assertTrue(TestServer.bbSkills().getJSONObject("files").getString("chief-of-staff").contains("You're Alex's chief of staff."));
    // The install thread was archived, and the older chief got the one line, once.
    List<String> snippets = TestServer.bbSnippets();
    long tells = snippets.stream().filter(c -> c.contains("\"thread\",\"tell\"")).count();
    assertEquals(1, tells);
    assertTrue(snippets.stream().anyMatch(c -> c.contains("\"thread\",\"archive\",\"thr_fakeinstall\"")));
    assertTrue(snippets.stream().anyMatch(c -> c.contains(ChiefSkills.START)));
    assertTrue(prefs.getBoolean(ChiefSkills.CHIEF_TOLD, false));
    // Up to date: checking again installs nothing.
    int before = snippets.size();
    toEnd();
    find("Check the skills in bb").click();
    Thread.sleep(1500);
    find(By.textContains("Installed in bb"), "installed");
    assertEquals(before, TestServer.bbSnippets().size());
  }

  @Test
  public void aNewTopicOrAnAppUpdateReinstallsAndCurrentSkillsAreLeftAlone() throws Exception {
    connectFake();
    ChiefSkills.pollMs = 300;
    java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
    // The update to 3.1.0: the skill's old name talk-router is still in bb next to current ones,
    // so the install runs once and removes it.
    TestServer.bbSetSkills(
        new JSONObject()
            .put("chief-of-staff", ChiefSkills.marker(files.get("chief-of-staff")))
            .put("dictate-and-delegate", ChiefSkills.marker(files.get("dictate-and-delegate")))
            .put("talk-router", "0ld0ld0ld0ld"),
        false);
    prefs.edit().putInt(ChiefSkills.CHECKED_VERSION, BuildConfig.VERSION_CODE - 1).commit();
    launch();
    until(() -> TestServer.bbSkillsOr("talk-router").isEmpty(), "the old talk-router skill removed");
    until(() -> prefs.getInt(ChiefSkills.CHECKED_VERSION, 0) == BuildConfig.VERSION_CODE, "checked");
    TestServer.bbReset();
    TestServer.bbSetSkills(
        new JSONObject()
            .put("chief-of-staff", ChiefSkills.marker(files.get("chief-of-staff")))
            .put("dictate-and-delegate", ChiefSkills.marker(files.get("dictate-and-delegate"))),
        false);
    // An app update with current skills in bb: checked, nothing installed.
    prefs.edit().putInt(ChiefSkills.CHECKED_VERSION, BuildConfig.VERSION_CODE - 1).commit();
    launch();
    until(() -> prefs.getInt(ChiefSkills.CHECKED_VERSION, 0) == BuildConfig.VERSION_CODE, "checked after the update");
    assertTrue(TestServer.bbSnippets().isEmpty());
    // An old dictate-and-delegate in bb, found after the next update: reinstalled.
    TestServer.bbSetSkills(
        new JSONObject()
            .put("chief-of-staff", ChiefSkills.marker(files.get("chief-of-staff")))
            .put("dictate-and-delegate", "0ld0ld0ld0ld"),
        false);
    prefs.edit().putInt(ChiefSkills.CHECKED_VERSION, BuildConfig.VERSION_CODE - 1).commit();
    launch();
    until(() -> TestServer.bbSkillsOr("dictate-and-delegate").equals(ChiefSkills.marker(files.get("dictate-and-delegate"))), "reinstalled");
    // A new ntfy server changes dictate-and-delegate: reinstalled with it.
    new BbBridge(context).setNtfyServer("https://ntfy.example.org");
    launch();
    until(() -> TestServer.bbSkillsOr("dictate-and-delegate").equals(ChiefSkills.marker(ChiefSkills.filled(context, 0).get("dictate-and-delegate"))), "reinstalled with the new server");
    assertTrue(TestServer.bbSkills().getJSONObject("files").getString("dictate-and-delegate").contains("https://ntfy.example.org/"));
  }

  @Test
  public void whenTheInstallThreadDoesNothingItSaysSo() throws Exception {
    connectFake();
    ChiefSkills.pollMs = 200;
    ChiefSkills.installWaitMs = 2000;
    try {
      TestServer.bbSetSkills(new JSONObject(), true);
      prefs.edit().remove(ChiefSkills.INSTALLED).commit();
      launch();
      tap("Settings");
      tap("Connection");
      toEnd();
      find(By.textStartsWith("Couldn't install the chief's skills:"), "the failure");
      assertTrue(TestServer.bbSnippets().stream().anyMatch(c -> c.contains("\"thread\",\"archive\",\"thr_fakeinstall\"")));
    } finally {
      ChiefSkills.installWaitMs = 4 * 60_000;
    }
  }

  @Test
  public void whenBbFailsTheNoteKeepsWhatYouSaidAndSendsAgain() throws Exception {
    connectFake();
    TestServer.bbFail("tell", "http503");
    TestServer.transcripts("Henry, book the table for Friday");
    TestServer.decide(0, 0.95, "none");
    dictate("copied");
    HistoryEntry e = latestOnce(n -> n.json.has("chiefFailed"), "the failure");
    assertTrue(e.json.optString("chiefFailed"), e.json.optString("chiefFailed").contains("isn't reachable right now (HTTP 503)"));
    JSONArray steps = e.json.getJSONArray("steps");
    assertTrue(steps.getJSONObject(steps.length() - 1).getString("detail").contains("HTTP 503"));
    // The note is saved before the session hears back.
    until(() -> DictationService.FAILED.equals(DictationService.session().chief), "the chief failed");
    find(By.textStartsWith("Not sent to your chief of staff:"), "the panel's message");
    find("🧑‍💼 Send again");

    send(DictationService.HIDE);
    Thread.sleep(500);
    launch();
    assertNotEquals("Henry, book the table for Friday", clipboard());
    tap("Henry, book the table for Friday");
    find(By.textStartsWith("Not sent to your chief of staff:"), "the failure");
    find("Copy");
    tap("Send again");
    find("Sent to chief of staff ↗");
    e = latest();
    assertFalse(e.json.has("chiefFailed"));
    assertEquals(CHIEF_LINK, e.json.optString("chiefLink"));
    List<String> snippets = TestServer.bbSnippets();
    assertTrue(snippets.get(snippets.size() - 1).contains("Henry, book the table for Friday"));
  }

  @Test
  public void withoutAChiefJevIsNotAskedAboutIt() throws Exception {
    TestServer.transcripts("tell my chief of staff to call the plumber");
    TestServer.decide(0, 0.99, "none"); // Even if Jev answered, nothing goes to bb.
    dictate("copied");
    long deadline = SystemClock.elapsedRealtime() + 8000;
    while (!DictationService.session().decided && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100);
    assertFalse(sent("decide").get(0).getJSONObject("questions").has("chief"));
    assertEquals(0, TestServer.bbRequests().length());
    assertNull(device.findObject(By.desc("🧑‍💼 Chief")));
    send(DictationService.HIDE);
    launch();
    assertNotEquals("tell my chief of staff to call the plumber", clipboard());
  }

  @Test
  public void aCustomTokenGoesAsBearerAndAWrongOneIsExplained() throws Exception {
    TestServer.bbToken("s3cret");
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "s3cret", LINKS);
    bb.test();
    JSONArray mcp = TestServer.bbRequests();
    assertEquals("Bearer s3cret", mcp.getJSONObject(mcp.length() - 1).getString("auth"));
    bb.useCustom(TestServer.bbUrl(), "wrong", LINKS);
    try {
      bb.test();
      fail("A wrong token must fail");
    } catch (java.io.IOException ex) {
      assertTrue(ex.getMessage(), ex.getMessage().contains("refused the token"));
    }
  }

  @Test
  public void anExistingThreadCanBeTheChiefAndGetsTheOneLine() throws Exception {
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    ChiefSkills.pollMs = 300;
    BbBridge.ThreadInfo t = bb.useExistingChief(LINKS + "/threads/thr_existing7");
    assertEquals("thr_existing7", t.id());
    assertEquals("thr_existing7", bb.chiefId());
    List<String> snippets = TestServer.bbSnippets();
    assertTrue(snippets.get(0).contains("\"thread\",\"show\",\"thr_existing7\""));
    // The skills first, then the one line.
    assertTrue(snippets.get(1).contains("Dictate & Delegate: install skills"));
    String tell = snippets.get(snippets.size() - 1);
    assertTrue(tell, tell.contains("\"thread\",\"tell\",\"thr_existing7\""));
    assertTrue(tell, tell.contains(ChiefSkills.START));
    assertFalse(tell, tell.contains(bb.ntfyTopic()));
    TestServer.bbFail("show", "tool");
    try {
      bb.useExistingChief("thr_gone");
      fail("A missing thread must fail");
    } catch (java.io.IOException ex) {
      assertTrue(ex.getMessage(), ex.getMessage().startsWith("bb couldn't do it:"));
    }
    assertEquals("thr_existing7", bb.chiefId());
  }


  @Test
  public void theTalkerIsSetInHandsFreeSettingsAndSwitchedOnAndOff() throws Exception {
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    bb.setChief(new BbBridge.ThreadInfo(TestServer.CHIEF, "Chief of staff", "idle"));
    context.startActivity(
        new Intent(context, MainActivity.class)
            .putExtra("open", "handsfree")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    find("Hands-free settings");
    tap("Hands-free settings");
    find("Send words"); // The settings page, before scrolling it.
    scrollTo(new UiSelector().text("Use the talker"));
    // Off, and none, until you set it.
    assertEquals("", bb.talkerId());
    UiObject2 field = find(By.clazz("android.widget.EditText").text("Talker thread link or id (thr_…)"), "the talker field");
    // The chief can't be its own talker.
    field.setText(LINKS + "/threads/" + TestServer.CHIEF);
    find(By.text("That's your chief of staff. The talker must be another thread."), "the chief refused");
    field.setText(LINKS + "/threads/thr_faketalker");
    until(() -> "thr_faketalker".equals(prefs.getString(BbBridge.TALKER_ID, "")), "the talker saved from its link");
    assertNull(device.findObject(By.textStartsWith("That's your chief")));
    assertEquals("still off", "", bb.talkerId());
    UiObject2 toggle = switchIn(find("Use the talker"));
    toggle.click();
    until(() -> "thr_faketalker".equals(new BbBridge(context).talkerId()), "the talker on");
    toggle.click();
    until(() -> new BbBridge(context).talkerId().isEmpty(), "the talker off");
    assertEquals("kept while off", "thr_faketalker", bb.savedTalker());
  }

  /** The switch in a settings row, from its title. */
  UiObject2 switchIn(UiObject2 title) {
    for (UiObject2 o = title.getParent(); o != null; o = o.getParent()) {
      UiObject2 s = o.findObject(By.checkable(true));
      if (s != null) return s;
    }
    fail("No switch next to " + title.getText());
    return null;
  }
}
