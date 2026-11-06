package app.driftdictation;

import static org.junit.Assert.*;

import android.content.*;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

/**
 * Hands-free mode against the fakes: the microphone is replaced by frames the test feeds, speech
 * and the voice come from the fake OpenRouter, the chief from the fake bb, replies from the fake
 * ntfy.
 */
@RunWith(AndroidJUnit4.class)
public class HandsFreeFlowTest {
  static final String LINKS = "https://someone.getbb.app";
  Context context;
  UiDevice device;
  SharedPreferences prefs;

  @Before
  public void setup() throws Exception {
    context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    prefs = context.getSharedPreferences("settings", 0);
    device.executeShellCommand("pm grant app.driftdictation android.permission.RECORD_AUDIO");
    device.executeShellCommand("cmd locale set-app-locales app.driftdictation --locales en-US");
    device.executeShellCommand("input keyevent KEYCODE_WAKEUP");
    TestServer.reset();
    TestServer.bbReset();
    TestServer.useKey(context);
    prefs
        .edit()
        .putBoolean("onboarded", true)
        .putInt(HandsFree.PAUSE_MS, 1000)
        .putInt(HandsFree.SILENCE_END_MS, 600_000)
        .remove(HandsFree.SEND_WORDS)
        .remove(HandsFree.END_WORDS)
        .putString(HandsFree.VOICE, Voice.KOKORO.id())
        .putBoolean(HandsFree.LIVE, false)
        .remove(HandsFree.LIVE_MODEL)
        .remove(HandsFree.OPEN_AUDIO)
        .remove(BbBridge.TALKER_ID)
        .remove(BbBridge.TALKER_ON)
        .commit();
    // Live transcription only where a test turns it on (with a key for the fake).
    new Vault(context).remove(StreamingSpeech.ASSEMBLYAI_KEY);
    new Vault(context).remove(StreamingSpeech.ELEVENLABS_KEY);
    TestServer.liveReset();
    BbBridge bb = new BbBridge(context);
    bb.useCustom(TestServer.bbUrl(), "", LINKS);
    bb.setChief(new BbBridge.ThreadInfo(TestServer.CHIEF, "Chief of staff", "idle"));
    bb.setNtfyServer(TestServer.ntfyRoot());
    TestServer.skillsCurrent(context);
    HandsFreeService.noMicrophone = true;
  }

  @After
  public void tearDown() throws Exception {
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> HandsFreeService.instance == null, "hands-free ended");
    HandsFreeService.noMicrophone = false;
    BbBridge work = new BbBridge(context, 1);
    work.disconnect();
    work.forgetChief();
    prefs.edit().remove(Assistants.key(1, BbBridge.MODE)).remove(Assistants.key(1, BbBridge.NTFY_SERVER)).remove(Assistants.key(1, Assistants.NAME)).commit();
  }

  static final String WORK_CHIEF = "thr_workchief";

  /** A second assistant ("Work") at the same fake bb and ntfy, with its own chief (and its own topic). */
  BbBridge work() throws Exception {
    BbBridge work = new BbBridge(context, 1);
    work.useCustom(TestServer.bbUrl(), "", LINKS);
    work.setChief(new BbBridge.ThreadInfo(WORK_CHIEF, "Chief of staff", "idle"));
    work.setNtfyServer(TestServer.ntfyRoot());
    Assistants.setName(context, 1, "Work");
    // Its skills count as installed, so no install thread runs at the fake bb meanwhile.
    prefs.edit().putString(Assistants.key(1, ChiefSkills.INSTALLED), ChiefSkills.summary(ChiefSkills.filled(context, 1))).putInt(Assistants.key(1, ChiefSkills.CHECKED_VERSION), BuildConfig.VERSION_CODE).commit();
    assertNotEquals(new BbBridge(context).ntfyTopic(), work.ntfyTopic());
    return work;
  }

  /**
   * Two assistants: in a call with the first, the second's chief answering, even with the call's
   * request ID, isn't spoken; the first's answer is. A call with the second goes to its chief.
   */
  @Test
  public void aReplyFromTheSecondAssistantIsNotSpokenInACallWithTheFirst() throws Exception {
    BbBridge work = work();
    HandsFreeService.logFile(context).delete();
    TestServer.transcripts("Is the table booked? Over.", "Is the table booked? Over.");
    HandsFreeService.start(context, 0);
    until(() -> HandsFreeService.session() != null, "the call with the first started");
    assertEquals(0, HandsFreeService.callWith());
    talk();
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    assertTrue(lastTell(), lastTell().contains(org.json.JSONObject.quote(TestServer.CHIEF)));
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(lastTell());
    assertTrue(m.find());
    String request = m.group(1);
    // The work chief posts to its own topic: tagged with this call's request, and for a note of its own.
    TestServer.ntfySpeak(work.ntfyTopic(), request, "Work: the deploy is done.");
    TestServer.ntfySpeak(work.ntfyTopic(), "workq1", "The work build is green.");
    Thread.sleep(4000);
    String log = HandsFreeService.log(context);
    assertFalse(log, log.contains("chief message " + request));
    assertFalse(log, log.contains("chief message workq1"));
    // The personal chief's answer on its topic is the one heard.
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), request, "Yes, the table is booked for eight.");
    until(() -> HandsFreeService.log(context).contains("chief message " + request), "the first assistant's reply");
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> HandsFreeService.instance == null, "ended");
    assertTrue(tellsTo(WORK_CHIEF).isEmpty());
  }

  @Test
  public void aCallWithTheSecondAssistantGoesToItsChiefAndHearsItsReplies() throws Exception {
    BbBridge work = work();
    HandsFreeService.logFile(context).delete();
    TestServer.transcripts("Is the deploy done? Over.", "Is the deploy done? Over.");
    HandsFreeService.start(context, 1);
    until(() -> HandsFreeService.session() != null, "the call with the second started");
    assertEquals(1, HandsFreeService.callWith());
    until(() -> toldTo(WORK_CHIEF, HandsFree.CALL_STARTED), "the work chief told the call started");
    talk();
    until(() -> !messagesTo(WORK_CHIEF).isEmpty(), "the message sent to the work chief");
    assertTrue(messagesTo(TestServer.CHIEF).isEmpty());
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(messagesTo(WORK_CHIEF).get(0));
    assertTrue(m.find());
    String request = m.group(1);
    // The personal chief's topic isn't read in this call.
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), request, "Personal: wrong call.");
    Thread.sleep(3000);
    assertFalse(HandsFreeService.log(context).contains("chief message " + request));
    TestServer.ntfySpeak(work.ntfyTopic(), request, "Yes, the deploy is done.");
    until(() -> HandsFreeService.log(context).contains("chief message " + request), "the work reply");
    // The message's note belongs to the second assistant.
    HistoryEntry note;
    try (HistoryStore h = new HistoryStore(context)) {
      note = h.list(1, 0).get(0);
    }
    assertEquals(1, note.json.optInt("assistant"));
    assertEquals(WORK_CHIEF, note.json.optString("chiefThread"));
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> HandsFreeService.instance == null, "ended");
    until(() -> toldTo(WORK_CHIEF, HandsFree.CALL_ENDED), "the work chief told the call ended");
    assertFalse(toldTo(TestServer.CHIEF, HandsFree.CALL_STARTED));
  }

  void until(Callable<Boolean> c, String what) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + 20_000;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (c.call()) return;
      Thread.sleep(100);
    }
    fail("Never happened: " + what);
  }

  /** 1.2 s of speech (enough to take the turn), then a second and a half of quiet: one part. */
  /** Each stretch of speech a little louder than the last, so no two parts are the same audio. */
  private int stretches;

  void talk() throws Exception {
    HandsFreeSession s = HandsFreeService.session();
    assertNotNull(s);
    int level = 6000 + 10 * stretches++;
    for (int i = 0; i < 60; i++) s.frame(HandsFreeTestFrames.frame(level));
    for (int i = 0; i < 75; i++) s.frame(HandsFreeTestFrames.frame(50));
  }

  /** The last message from the call (not the call's start or end signal). */
  String lastTell() throws Exception {
    List<String> snippets = TestServer.bbSnippets();
    for (int i = snippets.size() - 1; i >= 0; i--)
      if (snippets.get(i).contains("\"thread\",\"tell\"") && snippets.get(i).contains("[request:")) return snippets.get(i);
    return "";
  }

  static final String TALKER = "thr_faketalker";

  /** What was sent to one thread with bb thread tell, oldest first. */
  List<String> tellsTo(String thread) throws Exception {
    List<String> out = new java.util.ArrayList<>();
    for (String code : TestServer.bbSnippets())
      if (code.contains("\"thread\",\"tell\"," + org.json.JSONObject.quote(thread))) out.add(code);
    return out;
  }

  boolean toldTo(String thread, String line) throws Exception {
    for (String code : tellsTo(thread)) if (code.contains(line)) return true;
    return false;
  }

  /** The hands-free messages (with a request) sent to one thread. */
  List<String> messagesTo(String thread) throws Exception {
    List<String> out = new java.util.ArrayList<>();
    for (String code : tellsTo(thread)) if (code.contains("[request:")) out.add(code);
    return out;
  }

  String reasons() {
    StringBuilder out = new StringBuilder();
    for (HandsFreeSession.Reason r : HandsFreeService.session().reasons()) out.append(r.text()).append('\n');
    return out.toString();
  }

  boolean told(String line) throws Exception {
    for (String code : TestServer.bbSnippets()) if (code.contains("\"thread\",\"tell\"") && code.contains(line)) return true;
    return false;
  }

  @Test
  public void talkSendByWordHearTheReplyThenEndByWord() throws Exception {
    // At each longer pause the new part is written down and Jev asked whether the turn is done;
    // what's sent is the whole turn written down in one pass.
    TestServer.transcripts(
        "I've been thinking about the trip.",
        "Book a table for Friday. Over.",
        "End the call.");
    TestServer.turns("unfinished", "over", "end");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> HandsFreeService.session().pending().equals("I've been thinking about the trip."), "the first part");
    assertEquals("", lastTell());
    talk();
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    String tell = lastTell();
    // The whole turn's text, from its own pass.
    assertTrue(tell, tell.contains("I've been thinking about the trip. Book a table for Friday."));
    assertFalse(tell, tell.contains("Over"));
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(tell);
    assertTrue(tell, m.find());
    String request = m.group(1);
    // Each part written down once at its pause, the whole turn once more, and Jev asked each time.
    JSONArray r = TestServer.requests();
    int transcriptions = 0, wholes = 0, decisions = 0;
    for (int i = 0; i < r.length(); i++) {
      if (r.getJSONObject(i).getString("kind").equals("transcribe")) {
        if (r.getJSONObject(i).getJSONObject("body").optBoolean("whole")) wholes++;
        else transcriptions++;
      }
      if (r.getJSONObject(i).getString("kind").equals("decide")) decisions++;
    }
    assertEquals(2, transcriptions);
    assertEquals(1, wholes);
    assertEquals(2, decisions);
    // The note keeps it, with the chief's thread.
    try (HistoryStore h = new HistoryStore(context)) {
      HistoryEntry e = h.list(1, 0).get(0);
      assertTrue(e.json.optBoolean("handsFree"));
      assertEquals(request, e.json.optString("chiefRequest"));
    }
    // The chief's quick reaction is read aloud, then it listens again.
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), "notours", "Not for this session.");
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), request, "Good idea, let me check.");
    until(
        () -> {
          JSONArray all = TestServer.requests();
          for (int i = 0; i < all.length(); i++) {
            JSONObject q = all.getJSONObject(i);
            if (q.getString("kind").equals("speech")) return q.getJSONObject("body").getString("input").equals("Good idea, let me check.");
          }
          return false;
        },
        "the reply sent to the voice model");
    // Its audio is fetched first (the floor stays open meanwhile), then it's read.
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.READING, "reading the reply");
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.LISTENING, "listening again after reading");
    // Reading it cost $0.0001 (the fake's generation); the note of that message has it, on top of
    // the three transcriptions (two parts and the whole turn, $0.001 each) and Jev's two answers
    // ($0.00002 each); the call total counts them all.
    until(
        () -> {
          try (HistoryStore h = new HistoryStore(context)) {
            HistoryEntry e = h.list(1, 0).get(0);
            return e.voiceCost().compareTo(new java.math.BigDecimal("0.0001")) == 0;
          }
        },
        "the voice's cost on the note");
    try (HistoryStore h = new HistoryStore(context)) {
      HistoryEntry e = h.list(1, 0).get(0);
      assertEquals(0, new java.math.BigDecimal("0.00314").compareTo(e.cost()));
      assertEquals("hexgrad/kokoro-82m", e.json.optString("voiceModel"));
      JSONArray steps = e.json.getJSONArray("steps");
      assertEquals("voice", steps.getJSONObject(steps.length() - 1).getString("kind"));
      assertTrue(e.json.getJSONArray("handsFreeLog").length() > 0);
      assertFalse(e.json.optString("call").isEmpty());
    }
    assertEquals(0, new java.math.BigDecimal("0.00314").compareTo(HandsFreeService.callCost));
    int speech = 0;
    JSONArray all = TestServer.requests();
    for (int i = 0; i < all.length(); i++) if (all.getJSONObject(i).getString("kind").equals("speech")) speech++;
    assertEquals(1, speech);
    // "End the call" ends hands-free (once the microphone is back after the reply's tail).
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    talk();
    until(() -> HandsFreeService.instance == null, "hands-free ended by the end word");
    // The chief was told when the call started and ended.
    assertTrue(told("[hands-free call started]"));
    until(() -> told("[hands-free call ended]"), "the call's end told");
  }

  @Test
  public void theScreenStartsSendsAndEnds() throws Exception {
    TestServer.transcripts("Remind me to call Jana");
    TestServer.turns("unfinished"); // Not done at the pause: Send sends it.
    context.startActivity(
        new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    UiObject2 entry = device.wait(Until.findObject(By.text("🎧 Hands-free with your chief")), 8000);
    assertNotNull(entry);
    entry.click();
    UiObject2 start = device.wait(Until.findObject(By.text("Start hands-free")), 5000);
    assertNotNull(start);
    start.click();
    // Android asks for notifications (the lock-screen controls); the mode works either way.
    UiObject2 deny = device.wait(Until.findObject(By.textStartsWith("Don")), 3000);
    if (deny != null) deny.click();
    until(() -> HandsFreeService.session() != null, "hands-free started");
    // Speech without a send word, then the screen's Send now.
    HandsFreeSession s = HandsFreeService.session();
    for (int i = 0; i < 60; i++) s.frame(HandsFreeTestFrames.frame(6000));
    for (int i = 0; i < 75; i++) s.frame(HandsFreeTestFrames.frame(50));
    until(() -> HandsFreeService.session().pending().equals("Remind me to call Jana"), "the part");
    UiObject2 send = device.wait(Until.findObject(By.text("Send now")), 5000);
    if (send == null) {
      StringBuilder seen = new StringBuilder();
      for (UiObject2 o : device.findObjects(By.textContains(""))) seen.append(" | ").append(o.getText());
      fail("No Send now; saw" + seen);
    }
    send.click();
    until(() -> lastTell().contains("Remind me to call Jana"), "sent by the button");
    device.wait(Until.findObject(By.text("End hands-free")), 5000).click();
    until(() -> HandsFreeService.instance == null, "ended on screen");
  }

  /**
   * Opt-in check against a real bb and ntfy (as PanelTest's: -e realMcp, realLinks, realNtfy,
   * realTitle): a test chief with the filled skills as its first message gets a hands-free message
   * and has to answer with a quick spoken reaction and then a spoken answer, both read aloud.
   */
  @Test
  public void realChiefAnswersHandsFreeInSpeakableReplies() throws Exception {
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
    TestServer.transcripts("Which is bigger, the Atlantic or the Indian Ocean, and by roughly how much? Over.");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> HandsFreeService.session().sent() == 1, "the message sent");
    // A first real answer; a final one only if the request needs work, so a minute more for it.
    long deadline = SystemClock.elapsedRealtime() + 5 * 60_000;
    List<String> spoken = new java.util.ArrayList<>();
    while (SystemClock.elapsedRealtime() < deadline && spoken.size() < 2) {
      spoken.clear();
      JSONArray all = TestServer.requests();
      for (int i = 0; i < all.length(); i++)
        if (all.getJSONObject(i).getString("kind").equals("speech"))
          spoken.add(all.getJSONObject(i).getJSONObject("body").getString("input"));
      if (spoken.size() == 1) deadline = Math.min(deadline, SystemClock.elapsedRealtime() + 60_000);
      Thread.sleep(1000);
    }
    for (String t : spoken) android.util.Log.i("TalkRouterReal", "spoken: " + t);
    assertFalse("an answer, read aloud", spoken.isEmpty());
    for (String t : spoken) {
      assertFalse(t, t.contains("|") || t.contains("**") || t.contains("```") || t.contains("\n- "));
    }
    assertFalse("a real first answer, not a filler: " + spoken.get(0), spoken.get(0).toLowerCase().contains("one moment"));
  }

  /**
   * Opt-in, against a real bb and ntfy (the same arguments as above): a turn ending in "over" and
   * one sent with the call bar's send button both reach a real chief, and its spoken replies play
   * to the end. Logs the hands-free events with their timings (tag TalkRouterReal).
   */
  @Test
  public void realChiefGetsTurnsByWordAndByButtonAndRepliesPlayToTheEnd() throws Exception {
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
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    TestServer.transcripts(
        "Quick test call: is the Atlantic bigger than the Indian Ocean? Answer in one short sentence. Over.",
        "And which one is deeper? One short sentence");
    // The first turn ends at its pause (done), the second isn't done there and goes by the button.
    TestServer.turns("question", "unfinished");
    // Only this call's events count: the log goes on across calls.
    HandsFreeService.logFile(context).delete();
    try {
      realTurnsByWordAndButton();
    } finally {
      for (String line : HandsFreeService.log(context).split("\n")) android.util.Log.i("TalkRouterReal", line);
    }
  }

  /**
   * Opt-in, against a real bb: the three skills installed through an install thread, then a test
   * talker (-e realTalker, never a real one) told once to use its skill. -e realName, realNtfy,
   * realTopic and realLinks fill the skills as the user's phone does, so what's installed is what
   * that phone would install. Logged with tag TalkRouterSkills.
   */
  @Test
  public void realSkillsInstallAndATestTalkerIsToldToUseItsSkill() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    Assume.assumeTrue(args.getString("realMcp") != null && args.getString("realTalker") != null && args.getString("realTopic") != null);
    BbBridge bb = new BbBridge(context);
    bb.useCustom(args.getString("realMcp"), "", args.getString("realLinks", ""));
    bb.setNtfyServer(args.getString("realNtfy", "https://ntfy.sh"));
    new Vault(context).put(BbBridge.NTFY_TOPIC, args.getString("realTopic"));
    prefs.edit()
        .putString(ChiefSkills.USER_NAME, args.getString("realName", ""))
        .putString(BbBridge.TALKER_ID, args.getString("realTalker"))
        .putBoolean(BbBridge.TALKER_ON, true)
        .remove(ChiefSkills.TALKER_TOLD)
        .remove(ChiefSkills.INSTALLED)
        .commit();
    java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
    long start = SystemClock.elapsedRealtime();
    ChiefSkills.ensure(context, 0, files);
    android.util.Log.i("TalkRouterSkills", "installed and checked in " + (SystemClock.elapsedRealtime() - start) + " ms");
    JSONObject installed = bb.read(ChiefSkills.checkSnippet()).getJSONObject("skills");
    for (String name : ChiefSkills.NAMES) {
      android.util.Log.i("TalkRouterSkills", name + ": " + installed.optString(name) + " (wanted " + ChiefSkills.marker(files.get(name)) + ")");
      assertEquals(name, ChiefSkills.marker(files.get(name)), installed.optString(name));
    }
    prefs.edit().putString(ChiefSkills.INSTALLED, ChiefSkills.summary(files)).commit();
    ChiefSkills.tellTalker(context, 0);
    assertEquals(ChiefSkills.talkerToldValue(args.getString("realTalker"), files), prefs.getString(ChiefSkills.TALKER_TOLD, ""));
    android.util.Log.i("TalkRouterSkills", "talker told: " + prefs.getString(ChiefSkills.TALKER_TOLD, ""));
  }

  /**
   * Opt-in, against a real bb (-e realMcp, and two test threads: -e realChief, -e realTalker; never
   * real ones, as each round sends them messages): how long until each thread has a message, sent
   * to one after the other and to both at once (BbBridge.tellEach), -e realRounds times (5).
   * Logged with tag TalkRouterTiming: each send's start (epoch ms) and when bb took it per thread,
   * to set against the threads' own event times in bb.
   */
  @Test
  public void realTalkerAndChiefSendTimings() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    Assume.assumeTrue(args.getString("realMcp") != null && args.getString("realChief") != null && args.getString("realTalker") != null);
    BbBridge bb = new BbBridge(context);
    bb.useCustom(args.getString("realMcp"), "", "");
    String chief = args.getString("realChief"), talker = args.getString("realTalker");
    int rounds = Integer.parseInt(args.getString("realRounds", "5"));
    bb.test(); // Warm: the first connection isn't one of the measured.
    for (int r = 1; r <= rounds; r++) {
      String tag = "timing-" + r + "-" + System.currentTimeMillis();
      long start = System.currentTimeMillis(), t0 = SystemClock.elapsedRealtime();
      bb.send(chief, tag + " one after the other");
      long chiefMs = SystemClock.elapsedRealtime() - t0;
      bb.send(talker, tag + " one after the other");
      long talkerMs = SystemClock.elapsedRealtime() - t0;
      android.util.Log.i("TalkRouterTiming", String.format(java.util.Locale.ROOT, "sequential %s start %d chief %d ms talker %d ms", tag, start, chiefMs, talkerMs));
      Thread.sleep(2000);
      // As a call sends them (HandsFreeService.sendBoth).
      java.util.Map<String, String> to = HandsFreeService.bothTo(chief, talker, tag + " at once", tag + " at once");
      java.util.Map<String, Long> took = new java.util.HashMap<>();
      start = System.currentTimeMillis();
      java.util.Map<String, String> failed = bb.tellEach(to, took);
      assertTrue(failed.toString(), failed.isEmpty());
      android.util.Log.i("TalkRouterTiming", String.format(java.util.Locale.ROOT, "parallel %s start %d chief %d ms talker %d ms", tag, start, took.get(chief), took.get(talker)));
      Thread.sleep(2000);
    }
  }

  private static int count(String log, String what) {
    return log.split(java.util.regex.Pattern.quote(what), -1).length - 1;
  }

  private void realTurnsByWordAndButton() throws Exception {
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    // 1. A turn ending in the send word.
    talk();
    until(() -> HandsFreeService.session().sent() == 1, "the turn ending in over sent");
    long deadline = SystemClock.elapsedRealtime() + 4 * 60_000;
    while (SystemClock.elapsedRealtime() < deadline && count(HandsFreeService.log(context), "reply played to the end") == 0)
      Thread.sleep(1000);
    assertTrue("the first reply played to the end", count(HandsFreeService.log(context), "reply played to the end") > 0);
    // Wait until nothing is read, so the next turn starts on an open floor.
    deadline = SystemClock.elapsedRealtime() + 2 * 60_000;
    while (SystemClock.elapsedRealtime() < deadline && HandsFreeService.session().phase() == HandsFreeSession.Phase.READING)
      Thread.sleep(500);
    // The microphone stays muted a moment after a reply (its echo), as on the phone.
    Thread.sleep(1500);
    // 2. A turn without a send word, sent with the call bar's send button.
    talk();
    UiObject2 send = device.wait(Until.findObject(By.desc("Send now")), 5000);
    assertNotNull("the call bar's send button", send);
    send.click();
    until(() -> HandsFreeService.session().sent() == 2, "the turn sent with the button");
    int played = count(HandsFreeService.log(context), "reply played to the end");
    deadline = SystemClock.elapsedRealtime() + 4 * 60_000;
    while (SystemClock.elapsedRealtime() < deadline && count(HandsFreeService.log(context), "reply played to the end") <= played)
      Thread.sleep(1000);
    String log = HandsFreeService.log(context);
    assertTrue("the second reply played to the end", count(log, "reply played to the end") > played);
    assertFalse("no reply cut off", log.contains("the reply played too long") || log.contains("the reply's audio didn't start"));
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> HandsFreeService.instance == null, "ended");
  }

  /** One message out ("over"), then the chief's spoken reply to it; returns the hands-free log afterwards. */
  private String callWithOneReply(String reply, long waitForMs, String expect) throws Exception {
    HandsFreeService.logFile(context).delete();
    TestServer.transcripts("Is the table booked? Over.", "Is the table booked? Over.");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(lastTell());
    assertTrue(m.find());
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), m.group(1), reply);
    long deadline = SystemClock.elapsedRealtime() + waitForMs;
    while (SystemClock.elapsedRealtime() < deadline && !HandsFreeService.log(context).contains(expect)) Thread.sleep(200);
    String log = HandsFreeService.log(context);
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> HandsFreeService.instance == null, "ended");
    return log;
  }

  @Test
  public void aSlowVoiceAnswerIsBeatenByASecondRequest() throws Exception {
    // OpenRouter's voice stalls now and then (seconds, any provider): a second request after 1 s
    // wins, and the reply is still read in the chosen voice, not Android's.
    TestServer.script("speech", new JSONObject().put("delay", 4));
    String log = callWithOneReply("The table is booked for Friday at eight.", 15_000, "reply played to the end");
    assertTrue(log, log.contains("second request won"));
    assertFalse(log, log.contains("Android's voice reads it"));
    assertTrue(log, log.contains("reply played to the end"));
  }

  @Test
  public void wordsNotSentWhenTheCallEndsGoBeforeTheEndSignal() throws Exception {
    TestServer.transcripts("And also look at the latency");
    TestServer.turns("more"); // Not done at the pause.
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> HandsFreeService.session().pending().equals("And also look at the latency"), "the words");
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> told("[hands-free call ended]"), "the call's end told");
    int words = -1, end = -1;
    List<String> snippets = TestServer.bbSnippets();
    for (int i = 0; i < snippets.size(); i++) {
      if (snippets.get(i).contains("And also look at the latency")) words = i;
      if (snippets.get(i).contains("[hands-free call ended]")) end = i;
    }
    assertTrue("the last words sent", words >= 0);
    assertTrue("before the end signal", words < end);
    assertTrue(HandsFreeService.log(context).contains("they're sent before the call's end"));
  }

  @Test
  public void whenTheVoiceModelNeverAnswersAndroidsVoiceReadsTheWholeReply() throws Exception {
    // 3.2.7: Kokoro never answered, and Android's voice then failed too ("the voice stopped").
    for (int i = 0; i < 3; i++) TestServer.script("speech", new JSONObject().put("delay", 30));
    String log = callWithOneReply("The table is booked for Friday at eight.", 40_000, "reply played to the end");
    assertTrue(log, log.contains("Android's voice reads it"));
    assertTrue(log, log.contains("audio started"));
    assertTrue(log, log.contains("reply played to the end"));
    assertFalse(log, log.contains("trying again"));
    assertFalse(log, log.contains("reply not heard"));
  }

  @Test
  public void onAPhoneWithoutAndroidsVoiceASlowReplyIsWaitedForNotLost() throws Exception {
    // Some phones (GrapheneOS) have no text-to-speech engine: falling back to it lost the reply.
    device.executeShellCommand("pm disable-user --user 0 com.google.android.tts");
    try {
      Thread.sleep(500);
      TestServer.script("speech", new JSONObject().put("delay", 5));
      String log = callWithOneReply("The table is booked for Friday at eight.", 30_000, "reply played to the end");
      assertTrue(log, log.contains("Android's voice: not available"));
      assertTrue(log, log.contains("reply played to the end"));
      assertFalse(log, log.contains("Android's voice reads it") || log.contains("reply not heard"));
    } finally {
      device.executeShellCommand("pm enable com.google.android.tts");
    }
  }

  @Test
  public void androidsVoiceReadsOneReplyAfterAnother() throws Exception {
    // The second reply read by Android's voice must not be ended by the first one's engine.
    for (int i = 0; i < 6; i++) TestServer.script("speech", new JSONObject().put("delay", 30));
    HandsFreeService.logFile(context).delete();
    TestServer.transcripts("Is the table booked? Over.");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(lastTell());
    assertTrue(m.find());
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), m.group(1), "First, the table is booked.");
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), m.group(1), "Second, it's for Friday at eight.");
    long deadline = SystemClock.elapsedRealtime() + 40_000;
    while (SystemClock.elapsedRealtime() < deadline && count(HandsFreeService.log(context), "reply played to the end") < 2) Thread.sleep(200);
    String log = HandsFreeService.log(context);
    assertEquals(log, 2, count(log, "reply played to the end"));
    assertFalse(log, log.contains("trying again") || log.contains("reply not heard"));
  }

  @Test
  public void onlyWhenEveryVoiceRequestIsSlowAndroidsVoiceReads() throws Exception {
    TestServer.script("speech", new JSONObject().put("delay", 6));
    TestServer.script("speech", new JSONObject().put("delay", 6));
    TestServer.script("speech", new JSONObject().put("delay", 6));
    String log = callWithOneReply("The table is booked for Friday at eight.", 20_000, "Android's voice reads it");
    assertTrue(log, log.contains("Kokoro: no answer in 3.0 s"));
    assertTrue(log, log.contains("Android's voice reads it"));
  }

  @Test
  public void aVoiceThatSendsRawSamplesIsPlayedToTheEnd() throws Exception {
    // Gemini and HeyGen send only PCM: wrapped as WAV at the rate their Content-Type says.
    prefs.edit().putString(HandsFree.VOICE, "gemini-kore").commit();
    try {
      String log = callWithOneReply("The table is booked for Friday at eight.", 15_000, "reply played to the end");
      assertTrue(log, log.contains("voice google/gemini-3.8-flash-lite-tts (Kore) for"));
      assertTrue(log, log.contains("reply played to the end"));
      assertFalse(log, log.contains("Voice failed") || log.contains("Android's voice reads it"));
      JSONArray all = TestServer.requests();
      boolean pcm = false;
      for (int i = 0; i < all.length(); i++)
        if (all.getJSONObject(i).getString("kind").equals("speech")) pcm |= all.getJSONObject(i).getJSONObject("body").optString("response_format").equals("pcm");
      assertTrue("asked for PCM", pcm);
    } finally {
      prefs.edit().putString(HandsFree.VOICE, Voice.KOKORO.id()).commit();
    }
  }

  /** The reply's audio started playing before all of it was in (by the log's order and times). */
  private static void playedWhileComing(String log) {
    Matcher playable = Pattern.compile("playable after (\\d+) ms").matcher(log), all = Pattern.compile("all of it after (\\d+) ms").matcher(log);
    assertTrue(log, playable.find() && all.find());
    assertTrue(log, Long.parseLong(playable.group(1)) < 1500);
    assertTrue(log, Long.parseLong(all.group(1)) >= 2000);
    assertTrue(log, log.indexOf("audio started") < log.indexOf("all of it after"));
    assertTrue(log, log.contains("reply played to the end"));
    assertFalse(log, log.contains("Android's voice reads it") || log.contains("trying again"));
  }

  @Test
  public void aReplyPlaysWhileItsAudioStillComesIn() throws Exception {
    // Fish sent its first audio after 0.4 s and the rest over 4 s: playing starts with the first.
    TestServer.script("speech", new JSONObject().put("parts", 4).put("every", 0.8));
    playedWhileComing(callWithOneReply("The table is booked for Friday at eight.", 20_000, "reply played to the end"));
  }

  @Test
  public void aVoiceThatSendsRawSamplesPlaysWhileTheyStillComeIn() throws Exception {
    prefs.edit().putString(HandsFree.VOICE, "gemini-kore").commit();
    try {
      TestServer.script("speech", new JSONObject().put("parts", 4).put("every", 0.8));
      playedWhileComing(callWithOneReply("The table is booked for Friday at eight.", 20_000, "reply played to the end"));
    } finally {
      prefs.edit().putString(HandsFree.VOICE, Voice.KOKORO.id()).commit();
    }
  }

  @Test
  public void aReplyWhoseAudioStopsComingPartWayIsNotPlayedAgain() throws Exception {
    // Its first part plays, then nothing comes for longer than Voice.STALL_MS: it's given up, not
    // played again from its start (you heard that already); your next message says how far.
    TestServer.script("speech", new JSONObject().put("parts", 4).put("stall", 12));
    String log = callWithOneReply("The table is booked for Friday at eight.", 30_000, "reply stopped part-way");
    assertTrue(log, log.contains("its audio stopped coming for 5 s"));
    assertTrue(log, log.contains("reply stopped part-way"));
    assertFalse(log, log.contains("trying again"));
  }

  @Test
  public void anMp3WhoseFirstPieceIsLessThanAFrameStillPlays() throws Exception {
    // The decoder was used before it existed when the first bytes held no whole frame.
    TestServer.script("speech", new JSONObject().put("first", 50).put("every", 0.3));
    String log = callWithOneReply("The table is booked for Friday at eight.", 20_000, "reply played to the end");
    assertTrue(log, log.contains("playable after"));
    assertTrue(log, log.contains("reply played to the end"));
    assertFalse(log, log.contains("Voice failed") || log.contains("Android's voice reads it"));
  }

  /** Live transcription with this model, and a key the fake takes. */
  private void liveOn(String model) throws Exception {
    prefs.edit().putBoolean(HandsFree.LIVE, true).putString(HandsFree.LIVE_MODEL, model).commit();
    new Vault(context).put(StreamingSpeech.keyName(StreamingSpeech.choice(model)), "fake-key");
  }

  private static int count(JSONArray requests, String kind) throws Exception {
    int n = 0;
    for (int i = 0; i < requests.length(); i++) if (requests.getJSONObject(i).getString("kind").equals(kind)) n++;
    return n;
  }

  /** A turn ending in a send phrase goes as soon as live transcription has it and Jev agrees: no pause. */
  private void sendPhraseSendsAtOnce(String model, String path) throws Exception {
    liveOn(model);
    TestServer.liveTexts("Book a table for Friday. Over.");
    TestServer.turns("over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    HandsFreeSession s = HandsFreeService.session();
    for (int i = 0; i < 60; i++) s.frame(HandsFreeTestFrames.frame(6000)); // Speech,
    for (int i = 0; i < 25; i++) s.frame(HandsFreeTestFrames.frame(50)); // then half a second of quiet: not yet a pause.
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    String tell = lastTell(), log = HandsFreeService.log(context);
    assertTrue(tell, tell.contains("Book a table for Friday."));
    assertFalse(tell, tell.contains("Over"));
    assertTrue(log, log.contains("live transcription " + StreamingSpeech.choice(model).model()));
    assertTrue(log, log.contains("send phrase: quiet "));
    assertTrue(log, log.contains("ms after the phrase was heard)"));
    JSONArray r = TestServer.requests();
    assertEquals("nothing written down from audio", 0, count(r, "transcribe"));
    assertEquals("Jev asked once, on the send word", 1, count(r, "decide"));
    assertTrue(log, log.contains("Jev on the send phrase in "));
    JSONArray live = TestServer.liveLog();
    assertEquals(path, live.getJSONObject(0).getString("path"));
    android.util.Log.i("HandsFreeTimings", model + ": " + log.replaceAll("(?s).*(send phrase: final text in [^\n]*).*", "$1"));
  }

  @Test
  public void withAssemblyAiTheSendPhraseSendsAtOnce() throws Exception {
    sendPhraseSendsAtOnce("aai-pro", "/v3/ws");
  }

  @Test
  public void withElevenLabsTheSendPhraseSendsAtOnce() throws Exception {
    sendPhraseSendsAtOnce("eleven", "/v1/speech-to-text/realtime");
  }

  @Test
  public void whenLiveTranscriptionDropsMidCallYourWordsAreWrittenDownAndStillGo() throws Exception {
    liveOn("aai-pro");
    TestServer.liveTexts((String) null); // The connection drops as you start.
    TestServer.transcripts("Book a table for Friday. Over.");
    TestServer.turns("over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    assertTrue(lastTell(), lastTell().contains("Book a table for Friday."));
    String log = HandsFreeService.log(context);
    assertTrue(log, log.contains("live transcription failed ("));
    assertTrue(log, log.contains("→ Live transcription failed ("));
    assertEquals(1, count(TestServer.requests(), "transcribe"));
  }

  @Test
  public void withoutAKeyLiveTranscriptionIsOffAndSaysWhy() throws Exception {
    prefs.edit().putBoolean(HandsFree.LIVE, true).putInt(HandsFreePanel.X, 40).putInt(HandsFreePanel.Y, 1500).commit();
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    TestServer.transcripts("Book a table. Over.");
    context.startActivity(
        new Intent(context, MainActivity.class).putExtra("open", "handsfree").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    assertNotNull(device.wait(Until.findObject(By.text("Start hands-free")), 8000));
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    String off = "Live transcription is off: no AssemblyAI key (Settings → Hands-free)";
    // On the screen, in its own line and as the latest reason; on the call bar, short.
    assertNotNull("the screen's line", device.wait(Until.findObject(By.text(off)), 8000));
    assertNotNull("the reason", device.findObject(By.textContains("  " + off)));
    assertNotNull("the call bar", device.wait(Until.findObject(By.text("Live off · no AssemblyAI key")), 5000));
    assertNotNull("in full for TalkBack", device.findObject(By.desc(off)));
    shot("hf-live-off");
    // The call works as before: written down from the audio.
    talk();
    until(() -> lastTell().contains("[hands-free]"), "the message sent");
    assertTrue(HandsFreeService.log(context).contains("live transcription on, but no AssemblyAI key: written down from audio"));
    assertTrue(HandsFreeService.log(context).contains("→ " + off));
    assertEquals(0, TestServer.liveLog().length());
    // Still on the screen after the message went.
    assertNotNull(device.wait(Until.findObject(By.text(off)), 5000));
  }

  /** How long after the floor was taken the reply's first sound came out (from the log). */
  private static long firstSoundMs(String log) {
    Matcher m = Pattern.compile("audio started \\([0-9.]+ s\\) after (\\d+) ms").matcher(log);
    assertTrue(log, m.find());
    return Long.parseLong(m.group(1));
  }

  @Test
  public void withTheCallAudioKeptOpenAReplyStartsSooner() throws Exception {
    prefs.edit().putBoolean(HandsFree.OPEN_AUDIO, false).commit();
    String closed = callWithOneReply("The table is booked for Friday at eight.", 15_000, "reply played to the end");
    TestServer.reset();
    TestServer.bbReset();
    prefs.edit().putBoolean(HandsFree.OPEN_AUDIO, true).commit();
    String open = callWithOneReply("The table is booked for Friday at eight.", 15_000, "reply played to the end");
    assertTrue(open, open.contains("audio: kept open for the call"));
    assertFalse(closed, closed.contains("audio: kept open for the call"));
    for (String log : List.of(open, closed)) {
      assertTrue(log, log.contains("reply played to the end"));
      assertFalse(log, log.contains("Android's voice reads it") || log.contains("trying again"));
    }
    long before = firstSoundMs(closed), after = firstSoundMs(open);
    android.util.Log.i("HandsFreeTimings", "first sound: " + before + " ms with a track per reply, " + after + " ms with the call audio open");
    for (String line : open.split("\n"))
      if (line.contains("voice") || line.contains("audio") || line.contains("timing") || line.contains("reading")) android.util.Log.i("HandsFreeTimings", "open: " + line);
    assertTrue(before + " → " + after, after < before);
  }

  @Test
  public void aVoiceThatFailsSaysWhyAndTheReplyIsStillRead() throws Exception {
    for (int i = 0; i < 3; i++) TestServer.script("speech", new JSONObject().put("status", 503).put("message", "No provider available"));
    String log = callWithOneReply("The table is booked for Friday at eight.", 20_000, "reply played to the end");
    assertTrue(log, log.contains("HTTP 503: No provider available"));
    assertTrue(log, log.contains("→ Voice failed (Kokoro: HTTP 503: No provider available): Android's voice reads the reply"));
    assertTrue(log, log.contains("reply played to the end"));
  }

  @Test
  public void theDictationPanelsCallButtonSwitchesToHandsFreeKeepingWhatWasSaid() throws Exception {
    TestServer.transcripts("I was dictating about the trip");
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    // The dictation panel somewhere else than the call panel's own place.
    prefs.edit()
        .putString("bubbleMode", "recording")
        .putInt("bubbleX", 140)
        .putInt("bubbleY", 900)
        .putInt(HandsFreePanel.X, 16)
        .putInt(HandsFreePanel.Y, 300)
        .commit();
    DictationService.send(context, DictationService.RECORD);
    long deadline = SystemClock.elapsedRealtime() + 10_000;
    while (!"recording".equals(prefs.getString("state", "")) && SystemClock.elapsedRealtime() < deadline) Thread.sleep(100);
    Thread.sleep(1200);
    UiObject2 call = device.wait(Until.findObject(By.desc("Hands-free call with your chief")), 8000);
    assertNotNull("the 📞 on the dictation panel", call);
    int[] dictationPanel = DictationService.panelPosition();
    call.click();
    until(() -> HandsFreeService.session() != null, "hands-free started from the dictation");
    until(() -> "I was dictating about the trip".equals(HandsFreeService.session().pending()), "the dictation became the first turn");
    // The dictation itself left no note and no saved audio.
    assertFalse(DictationService.audio(context).exists());
    // The call floats: its panel shows the state and End.
    assertNotNull(device.wait(Until.findObject(By.text("Not sent yet")), 5000));
    assertNotNull(device.wait(Until.findObject(By.desc("End hands-free")), 5000));
    // Exactly where the dictation panel was, and its own place stays as it was.
    assertArrayEquals(dictationPanel, HandsFreeService.panelPosition());
    assertEquals(300, prefs.getInt(HandsFreePanel.Y, 0));
  }

  @Test
  public void startedFromHomeTheCallPanelIsWhereItWasLastDragged() throws Exception {
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    prefs.edit().putInt(HandsFreePanel.X, 60).putInt(HandsFreePanel.Y, 500).commit();
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.panelPosition() != null, "the call panel");
    assertArrayEquals(new int[] {60, 500}, HandsFreeService.panelPosition());
  }

  @Test
  public void aCallIsOneEntryInAllNotesWithItsMessagesAndCost() throws Exception {
    long now = System.currentTimeMillis();
    try (HistoryStore h = new HistoryStore(context)) {
      for (HistoryEntry old : h.all()) h.delete(old.id()); // Only this call on the list.
      String[] said = {"First message of the call.", "Second message of the call."};
      for (int i = 0; i < 2; i++) {
        HistoryEntry e = HistoryEntry.create(java.util.UUID.randomUUID().toString(), "m", 3);
        e.json
            .put("created", now - 60_000 + i * 20_000)
            .put("text", said[i])
            .put("status", "complete")
            .put("requests", 1)
            .put("handsFree", true)
            .put("route", "chief")
            .put("call", "call-test")
            .put("knownCost", "0.0011");
        h.save(e);
      }
    }
    prefs.edit().putLong("historyRevision", System.nanoTime()).commit();
    context.startActivity(
        new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    UiObject2 all = device.wait(Until.findObject(By.text("All notes")), 8000);
    assertNotNull(all);
    all.click();
    UiObject2 call = device.wait(Until.findObject(By.text("▸ 📞 Call with your chief · 2 messages")), 8000);
    assertNotNull("the call as one entry", call);
    // Its cost: both messages (transcription and voice).
    assertNotNull(device.wait(Until.findObject(By.textContains("$0.0022")), 3000));
    assertNull(device.findObject(By.text("Second message of the call.")));
    call.click();
    assertNotNull("opened, its messages follow", device.wait(Until.findObject(By.text("Second message of the call.")), 3000));
    assertNotNull(device.findObject(By.text("▾ 📞 Call with your chief · 2 messages")));
  }

  @Test
  public void theCallPanelIsCompactAndFitsTheScreenInEveryState() throws Exception {
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    // Dragged to the right edge last time: it must still show every button.
    prefs.edit().putInt(HandsFreePanel.X, 5000).putInt(HandsFreePanel.Y, 600).commit();
    TestServer.transcripts("Book the hotel. Over.");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.panelPosition() != null, "the call panel");
    assertNotNull(device.wait(Until.findObject(By.text("Listening")), 5000));
    until(HandsFreeService::panelFits, "every button on screen while listening");
    shot("call-bar-listening");
    talk();
    until(() -> HandsFreeService.session().sent() == 1, "the message sent");
    // Sent, then waiting for the chief: a short label on the bar, the full words for TalkBack;
    // send and hang-up as icons.
    assertNotNull(device.wait(Until.findObject(By.text("Working…")), 8000));
    assertNotNull(device.findObject(By.desc("Waiting for the chief · you can talk")));
    assertNotNull(device.findObject(By.desc("Send now"))); // The paper plane.
    assertNotNull(device.findObject(By.desc("End hands-free")));
    until(HandsFreeService::panelFits, "every button on screen while the chief works");
    shot("call-bar-working");
  }

  /**
   * With -e shots true only: the hands-free screen listening, with a reason, and with a reply
   * waiting while you talk; and the call bar (for the release QA).
   */
  @Test
  public void screenshotsOfTheLiveStateAndItsReasons() throws Exception {
    Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("shots")));
    device.executeShellCommand("appops set app.driftdictation SYSTEM_ALERT_WINDOW allow");
    prefs.edit().putInt(HandsFreePanel.X, 40).putInt(HandsFreePanel.Y, 1500).commit();
    TestServer.transcripts("Book a table for Friday. Over.", "Also check the train");
    TestServer.turns("over", "unfinished");
    context.startActivity(
        new Intent(context, MainActivity.class).putExtra("open", "handsfree").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    UiObject2 start = device.wait(Until.findObject(By.text("Start hands-free")), 8000);
    assertNotNull(start);
    start.click();
    UiObject2 deny = device.wait(Until.findObject(By.textStartsWith("Don")), 3000);
    if (deny != null) deny.click();
    until(() -> HandsFreeService.session() != null, "hands-free started");
    HandsFreeSession s = HandsFreeService.session();
    for (int i = 0; i < 50; i++) s.frame(HandsFreeTestFrames.frame(50));
    assertNotNull(device.wait(Until.findObject(By.textContains("Listening")), 5000));
    shot("hf-1-listening");
    // Send with nothing said: ignored, and the screen says why.
    device.wait(Until.findObject(By.text("Send now")), 5000).click();
    assertNotNull(device.wait(Until.findObject(By.textContains("Send ignored: nothing heard yet")), 5000));
    shot("hf-2-reason");
    // A message, then a reply arriving while you talk: it waits.
    talk();
    until(() -> s.sent() == 1, "the message sent");
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(lastTell());
    assertTrue(m.find());
    Thread.sleep(3500); // Past Sent ✓.
    for (int i = 0; i < 60; i++) s.frame(HandsFreeTestFrames.frame(6000));
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), m.group(1), "The table is booked for Friday at eight.");
    until(() -> s.held() == 1, "the reply waiting");
    // A pause long enough to end the part, shorter than the reply's 1.5 s: it still waits.
    for (int i = 0; i < 55; i++) s.frame(HandsFreeTestFrames.frame(50));
    until(() -> s.pending().equals("Also check the train"), "your words");
    assertNotNull(device.wait(Until.findObject(By.textContains("Reply waiting")), 5000));
    shot("hf-3-reply-waiting");
    // The call bar over another app.
    device.pressHome();
    Thread.sleep(800);
    assertNotNull(device.wait(Until.findObject(By.desc("End hands-free")), 5000));
    shot("hf-4-call-bar");
  }

  /** With -e shots true: a screenshot on the device, in the app's files/panel. */
  void shot(String name) throws Exception {
    if (!"true".equals(InstrumentationRegistry.getArguments().getString("shots"))) return;
    Thread.sleep(700);
    java.io.File dir = new java.io.File(context.getExternalFilesDir(null), "panel");
    dir.mkdirs();
    device.takeScreenshot(new java.io.File(dir, name + ".png"));
    // Also where it outlives the test's uninstall: adb pull /data/local/tmp/drift-shots.
    device.executeShellCommand("mkdir -p /data/local/tmp/drift-shots");
    device.executeShellCommand("screencap -p /data/local/tmp/drift-shots/" + name + ".png");
  }

  @Test
  public void talkingOverAReplyStopsItAndYourMessageSaysWhatYouHeard() throws Exception {
    // The message; your words over the reply (not done yet); then "over" after them.
    TestServer.transcripts("Book a table for Friday. Over.", "Hold on, book the train instead", "Over.");
    TestServer.turns("over", "unfinished", "over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> HandsFreeService.session().sent() == 1, "the message sent");
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(lastTell());
    assertTrue(m.find());
    TestServer.ntfySpeak(
        new BbBridge(context).ntfyTopic(), m.group(1), "The flight leaves at nine in the morning from gate twelve, and the train costs about forty euros.");
    HandsFreeSession s = HandsFreeService.session();
    until(s::audioPlaying, "the reply playing");
    // With the call audio open it starts at once: the reply's sound (CUE_MS) has to be over first.
    Thread.sleep(HandsFreeSession.CUE_MS + 100);
    // What's left of its echo, then you over it: the reply stops, and what you said is your turn.
    for (int i = 0; i < 50; i++) s.frame(HandsFreeTestFrames.frame(300));
    assertTrue("its echo doesn't stop it", s.audioPlaying());
    for (int i = 0; i < 20; i++) s.frame(HandsFreeTestFrames.frame(8000));
    assertEquals("stopped at once", HandsFreeSession.State.LISTENING, s.state());
    for (int i = 0; i < 75; i++) s.frame(HandsFreeTestFrames.frame(50));
    until(() -> s.pending().equals("Hold on, book the train instead"), "your interruption, your turn");
    assertTrue(HandsFreeService.log(context).contains("barge-in: speech 300 ms → stopped"));
    // The rest of the reply is dropped: your next message says how far you heard it.
    talk();
    long deadline = SystemClock.elapsedRealtime() + 20_000;
    while (SystemClock.elapsedRealtime() < deadline && HandsFreeService.session().sent() < 2) Thread.sleep(100);
    assertEquals(HandsFreeService.log(context), 2, HandsFreeService.session().sent());
    String tell = lastTell();
    assertTrue(tell, tell.contains("Hold on, book the train instead"));
    assertTrue(tell, tell.contains("[heard up to: ") || tell.contains("[not played: "));
    Thread.sleep(3000);
    assertEquals("never played again", 1, count(HandsFreeService.log(context), "floor: chief, reading " + m.group(1)));
  }

  @Test
  public void withATalkerEachMessageAndTheCallsStartAndEndGoToBoth() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).commit();
    TestServer.transcripts("Book a table for Friday. Over.", "End the call.");
    TestServer.turns("over", "end");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    // The chief learns who the talker is; the talker gets the plain call start.
    until(() -> toldTo(TestServer.CHIEF, "[hands-free call started] [talker: " + TALKER + "]"), "the chief told the call started, with the talker");
    until(() -> toldTo(TALKER, "[hands-free call started]"), "the talker told the call started");
    assertFalse(toldTo(TALKER, "[talker: "));
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 1 && messagesTo(TALKER).size() == 1, "the message sent to both");
    // The same message to both, with the same request ID.
    String toChief = messagesTo(TestServer.CHIEF).get(0), toTalker = messagesTo(TALKER).get(0);
    assertTrue(toChief, toChief.contains("Book a table for Friday.\\n\\n[hands-free]\\n\\n[request: "));
    assertEquals(toChief.replace(TestServer.CHIEF, TALKER), toTalker);
    until(() -> HandsFreeService.session().sent() == 1, "counted as sent");
    until(() -> HandsFreeService.log(context).contains("to the talker too"), "the log says the talker got it");
    assertTrue(HandsFreeService.log(context), HandsFreeService.log(context).contains("talker " + TALKER + ": every message goes to it and to the chief"));
    // The talker's spoken reply plays like the chief's.
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(toTalker);
    assertTrue(m.find());
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), m.group(1), "Sure, the chief is booking it.");
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.READING, "reading the talker's reply");
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.LISTENING, "listening again after reading");
    // The chief's result, passed on by the talker without a request ID, plays too.
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), "", "The table is booked for eight.");
    until(() -> spoken().contains("The table is booked for eight."), "the talker's update read aloud");
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.LISTENING, "listening again after the update");
    // Both played on the call's audio kept open (on by default), to the end.
    String played = HandsFreeLog.lastCalls(HandsFreeService.log(context), 1);
    assertTrue(played, played.contains("audio: kept open for the call"));
    assertEquals(played, 2, count(played, "reply played to the end"));
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    talk();
    until(() -> HandsFreeService.instance == null, "hands-free ended by the end word");
    until(() -> toldTo(TestServer.CHIEF, "[hands-free call ended]") && toldTo(TALKER, "[hands-free call ended]"), "both told the call ended");
  }

  private static String requestOf(String message) {
    Matcher m = Pattern.compile("\\[request: ([a-z0-9]+)\\]").matcher(message);
    assertTrue(message, m.find());
    return m.group(1);
  }

  @Test
  public void withATalkerRepliesToAnOlderMessageArentPlayedAndBothAreToldWhichWerent() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).commit();
    TestServer.transcripts("Book a table for Friday. Over.", "And the train to Lisbon. Over.", "Anything else? Over.");
    TestServer.turns("over", "over", "over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    String topic = new BbBridge(context).ntfyTopic();
    talk();
    until(() -> messagesTo(TALKER).size() == 1, "the first message sent");
    String first = requestOf(messagesTo(TALKER).get(0));
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    talk();
    until(() -> messagesTo(TALKER).size() == 2, "the second message sent");
    String second = requestOf(messagesTo(TALKER).get(1));
    // The answer to the first message, after the second went: not played.
    TestServer.ntfySpeak(topic, first, "Yes, the table is booked for eight.");
    until(() -> HandsFreeService.log(context).contains("chief message " + first + " dropped"), "the outdated reply dropped");
    // The answer to the second plays.
    TestServer.ntfySpeak(topic, second, "The train leaves at nine.");
    until(() -> spoken().contains("The train leaves at nine."), "the current reply read aloud");
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.LISTENING, "listening again");
    assertFalse(HandsFreeService.log(context).contains("floor: chief, reading " + first));
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    // The next message tells both which reply wasn't heard.
    talk();
    until(() -> messagesTo(TALKER).size() == 3, "the third message sent");
    String note = "[not played: \\\"Yes, the table is booked for eight.\\\"]";
    assertTrue(messagesTo(TALKER).get(2), messagesTo(TALKER).get(2).contains("Anything else?\\n\\n" + note));
    assertTrue(messagesTo(TestServer.CHIEF).get(2), messagesTo(TestServer.CHIEF).get(2).contains(note));
    // Two more answers to the second message come late; the call ends before another message.
    TestServer.ntfySpeak(topic, second, "Also, the return train is at six.");
    TestServer.ntfySpeak(topic, second, "And there's a dining car.");
    until(() -> count(HandsFreeService.log(context), "chief message " + second + " dropped") == 2, "both dropped");
    HandsFreeService.send(context, HandsFreeService.END);
    until(() -> HandsFreeService.instance == null, "ended");
    String end = "[hands-free call ended]\\n\\n[not played: \\\"Also, the return train is at six.\\\"]\\n[not played: \\\"And there's a dining car.\\\"]";
    until(() -> toldTo(TALKER, end) && toldTo(TestServer.CHIEF, end), "the call's end tells both");
  }

  @Test
  public void aReplyToAnOlderMessageIsNeverPlayedAndTheNextMessageSaysSo() throws Exception {
    TestServer.transcripts("Book a table for Friday. Over.", "And the train to Lisbon. Over.", "Anything else? Over.");
    TestServer.turns("over", "over", "over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 1, "the first message sent");
    String first = requestOf(messagesTo(TestServer.CHIEF).get(0));
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 2, "the second message sent");
    String second = requestOf(messagesTo(TestServer.CHIEF).get(1));
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), first, "Yes, the table is booked for eight.");
    until(() -> HandsFreeService.log(context).contains("chief message " + first + " dropped unplayed"), "the old turn's reply dropped");
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), second, "The train leaves at nine.");
    until(() -> spoken().contains("The train leaves at nine."), "the new turn's reply read aloud");
    assertFalse(spoken().contains("Yes, the table is booked for eight."));
    until(() -> HandsFreeService.session().state() == HandsFreeSession.State.LISTENING, "listening again");
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 3, "the third message sent");
    assertTrue(messagesTo(TestServer.CHIEF).get(2), messagesTo(TestServer.CHIEF).get(2).contains("Anything else?\\n\\n[not played: \\\"Yes, the table is booked for eight.\\\"]"));
  }

  @Test
  public void aReplyArrivingDuringYourUnsentWordsIsDroppedAndNeverPlaysAfterThem() throws Exception {
    TestServer.transcripts("Book a table for Friday. Over.", "Hmm, and also");
    TestServer.turns("over", "more");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 1, "the first message sent");
    String first = requestOf(messagesTo(TestServer.CHIEF).get(0));
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    // Words not sent yet (Jev: more to say), then you think.
    talk();
    until(() -> HandsFreeService.session().pending().equals("Hmm, and also"), "your words, unsent");
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), first, "The table is booked.");
    until(() -> HandsFreeService.log(context).contains("chief message " + first + " dropped unplayed"), "dropped: you've started a new turn");
    HandsFreeService.send(context, HandsFreeService.SEND);
    until(() -> messagesTo(TestServer.CHIEF).size() == 2, "your words sent");
    assertTrue(messagesTo(TestServer.CHIEF).get(1), messagesTo(TestServer.CHIEF).get(1).contains("Hmm, and also\\n\\n[not played: \\\"The table is booked.\\\"]"));
    Thread.sleep(3000);
    assertFalse("never played after your turn", HandsFreeService.log(context).contains("floor: chief, reading " + first));
  }

  @Test
  public void aTalkerIsToldOnceToUseItsSkillAndLearnsItIsTheTalkerAtEachCallStart() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).remove(ChiefSkills.TALKER_TOLD).commit();
    TestServer.skillsCurrent(context); // With a talker, its skill is one of them.
    for (int call = 1; call <= 2; call++) {
      int n = call;
      HandsFreeService.send(context, HandsFreeService.START);
      until(() -> HandsFreeService.session() != null, "hands-free started");
      until(() -> count(String.join("\n", tellsTo(TALKER)), "[hands-free call started] [you are the talker]") == n, "call " + n + " started for the talker");
      HandsFreeService.send(context, HandsFreeService.END);
      until(() -> HandsFreeService.instance == null, "ended");
    }
    List<String> told = tellsTo(TALKER);
    assertEquals(told.toString(), 1, count(String.join("\n", told), "Use the dictate-and-delegate-talker skill"));
    // Told before the first call start.
    int skill = -1, start = -1;
    for (int i = 0; i < told.size(); i++) {
      if (skill < 0 && told.get(i).contains("Use the dictate-and-delegate-talker skill")) skill = i;
      if (start < 0 && told.get(i).contains("[hands-free call started]")) start = i;
    }
    assertTrue(told.toString(), skill >= 0 && skill < start);
    assertEquals(ChiefSkills.talkerToldValue(TALKER, ChiefSkills.filled(context, 0)), prefs.getString(ChiefSkills.TALKER_TOLD, ""));
    // The chief isn't told it.
    assertFalse(String.join("\n", tellsTo(TestServer.CHIEF)).contains("dictate-and-delegate-talker"));
  }

  @Test
  public void theTalkerAndTheChiefGetEachMessageAtTheSameTime() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).commit();
    TestServer.transcripts("Book a table for Friday. Over.", "End the call.");
    TestServer.turns("over", "end");
    // Each tell takes 1.5 s: one after the other, a message to both would take 3 s or more.
    TestServer.bbTellDelay(1500);
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    until(() -> HandsFreeService.log(context).contains("told the talker (" + TALKER + "): [hands-free call started]")
        && HandsFreeService.log(context).contains("told the chief: [hands-free call started]"), "both told the call started");
    talk();
    until(() -> HandsFreeService.log(context).contains("to the talker too"), "the message sent to both");
    String log = HandsFreeService.log(context);
    Matcher m = Pattern.compile("sent \\S+ \\([^,]+, \\d+ characters; bb took (\\d+) ms").matcher(log);
    assertTrue(log, m.find());
    assertTrue("at the same time: " + m.group(1) + " ms", Long.parseLong(m.group(1)) < 2800);
    Matcher each = Pattern.compile("bb took (\\d+) ms for the talker, (\\d+) ms for the chief").matcher(log);
    assertTrue(log, each.find());
    assertTrue(log, Long.parseLong(each.group(1)) >= 1500 && Long.parseLong(each.group(2)) >= 1500);
    TestServer.bbTellDelay(0);
    Thread.sleep(HandsFreeSession.TAIL_MS + 300);
    talk();
    until(() -> HandsFreeService.instance == null, "hands-free ended by the end word");
  }

  @Test
  public void oneOfTalkerAndChiefFailingDoesntHoldUpTheOther() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).commit();
    TestServer.transcripts("Book a table for Friday. Over.", "And the train. Over.");
    TestServer.turns("over", "over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    until(() -> toldTo(TestServer.CHIEF, "[hands-free call started]") && toldTo(TALKER, "[hands-free call started]"), "both told the call started");
    // The talker can't be reached: the chief still gets the message, and it counts as sent.
    TestServer.bbFail("tell", "tool", TALKER);
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 1, "the message sent to the chief");
    until(() -> reasons().contains("Sent ✓ to the chief. The talker didn't get it: bb couldn't do it:"), "the reason says the talker missed it");
    assertEquals("", HandsFreeService.session().pending());
    String log = HandsFreeService.log(context);
    assertTrue(log, log.contains("the talker (" + TALKER + ") didn't get "));
    // The chief can't be reached: the talker still gets the message.
    TestServer.bbFail("tell", "tool", TestServer.CHIEF);
    Thread.sleep(3500); // Past Sent ✓.
    talk();
    // (The fake lists the tell it failed too.)
    until(() -> messagesTo(TALKER).size() == 2, "the message sent to the talker");
    until(() -> reasons().contains("Sent to the talker only. The chief didn't get it: bb couldn't do it:"), "the reason says the chief missed it");
    assertEquals(2, HandsFreeService.session().sent());
    assertEquals("", HandsFreeService.session().pending());
    assertTrue(HandsFreeService.log(context).contains("the chief didn't get "));
    assertTrue(messagesTo(TALKER).get(1), messagesTo(TALKER).get(1).contains("And the train."));
  }

  @Test
  public void withTheTalkerSwitchedOffOnlyTheChiefHearsTheCall() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, false).commit();
    TestServer.transcripts("Book a table for Friday. Over.");
    TestServer.turns("over");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    talk();
    until(() -> messagesTo(TestServer.CHIEF).size() == 1, "the message sent to the chief");
    until(() -> told("[hands-free call started]"), "the call start told");
    assertFalse(told("[talker: "));
    assertTrue(tellsTo(TALKER).isEmpty());
    // Without a talker, a spoken message without a request isn't this call's.
    TestServer.ntfySpeak(new BbBridge(context).ntfyTopic(), "", "Not for this call.");
    Thread.sleep(3000);
    assertFalse(spoken().contains("Not for this call."));
  }

  /** What was sent to the voice model, oldest first. */
  List<String> spoken() throws Exception {
    List<String> out = new java.util.ArrayList<>();
    JSONArray all = TestServer.requests();
    for (int i = 0; i < all.length(); i++)
      if (all.getJSONObject(i).getString("kind").equals("speech")) out.add(all.getJSONObject(i).getJSONObject("body").getString("input"));
    return out;
  }

  /**
   * Opt-in, against a real bb (the same arguments as the real checks above; realNtfy best the fake
   * ntfy, which bb's agents reach too): a test chief with the skills and a test talker both get
   * the call. The talker answers by voice at once; the chief hands its result to the talker, which
   * speaks it. Logs both thread IDs and what was spoken (tag TalkRouterReal), to archive them after.
   */
  @Test
  public void realTalkerAndChiefBothGetTheCallAndTheChiefsResultIsSpoken() throws Exception {
    android.os.Bundle args = InstrumentationRegistry.getArguments();
    Assume.assumeTrue(args.getString("realMcp") != null);
    BbBridge bb = new BbBridge(context);
    bb.useCustom(args.getString("realMcp"), "", args.getString("realLinks"));
    bb.setNtfyServer(args.getString("realNtfy"));
    TestServer.skillsCurrent(context);
    java.util.Map<String, String> files = ChiefSkills.filled(context, 0);
    String title = args.getString("realTitle");
    String chiefPrompt =
        "For this test, follow these two skills as if they were installed, then reply \"ready\".\n\n"
            + files.get(ChiefSkills.CHIEF)
            + "\n"
            + files.get(ChiefSkills.ROUTER);
    JSONObject chief =
        bb.run(BbBridge.spawnSnippet(chiefPrompt).replace(JSONObject.quote(BbBridge.CHIEF_TITLE), JSONObject.quote(title + " chief")));
    android.util.Log.i("TalkRouterReal", "chief " + chief.getString("id"));
    String speak =
        "curl -s -H \"Title: Spoken reply\" -H \"Tags: talkrouter-speak,req-<id>\" -H \"Priority: low\" --data-binary @- "
            + bb.ntfyServer() + "/" + bb.ntfyTopic() + " <<'TEXT'\n<what to say>\nTEXT";
    String talkerPrompt =
        "You are the talker in a test of hands-free voice calls (the Dictate & Delegate app). Another agent thread, the chief, gets every message from the user too and does all the work. Your only job is the conversation: short spoken replies, fast.\n\n"
            + "- A message tagged [hands-free] with [request: <id>]: answer by voice right away in one or two short sentences. Acknowledge it, or say the chief is looking into it. Never invent facts or results.\n"
            + "- A message starting with [chief]: the chief's result. Tell the user its gist by voice, in your own short words.\n"
            + "- [hands-free call started] and [hands-free call ended]: don't speak.\n\n"
            + "To speak, run this one command and nothing else, with the request ID from the user's message (for a [chief] message, which has none, use Tags: talkrouter-speak without req-):\n\n"
            + speak
            + "\n\nUse no other tools. Plain spoken words, no markdown. Keep your text reply in the thread to one line. Now reply \"ready\" without speaking.";
    JSONObject talker =
        bb.run(BbBridge.spawnSnippet(talkerPrompt).replace(JSONObject.quote(BbBridge.CHIEF_TITLE), JSONObject.quote(title + " talker")));
    String talkerId = talker.getString("id");
    android.util.Log.i("TalkRouterReal", "talker " + talkerId);
    bb.setChief(new BbBridge.ThreadInfo(chief.getString("id"), title + " chief", chief.optString("status")));
    prefs.edit().putString(BbBridge.TALKER_ID, talkerId).putBoolean(BbBridge.TALKER_ON, true).commit();
    TestServer.transcripts("Quick test call: look up which city is the capital of Australia, and since when. Over.");
    HandsFreeService.logFile(context).delete();
    try {
      HandsFreeService.send(context, HandsFreeService.START);
      until(() -> HandsFreeService.session() != null, "hands-free started");
      talk();
      until(() -> HandsFreeService.session().sent() == 1, "the message sent");
      assertTrue(HandsFreeService.log(context), HandsFreeService.log(context).contains("to the talker too"));
      // The talker's quick answer, then the chief's result through the talker.
      long deadline = SystemClock.elapsedRealtime() + 6 * 60_000;
      // Each reply once, though the voice may be asked for it more than once.
      java.util.Set<String> spoken = new java.util.LinkedHashSet<>();
      while (SystemClock.elapsedRealtime() < deadline && spoken.size() < 2) {
        JSONArray all = TestServer.requests();
        for (int i = 0; i < all.length(); i++)
          if (all.getJSONObject(i).getString("kind").equals("speech"))
            spoken.add(all.getJSONObject(i).getJSONObject("body").getString("input"));
        Thread.sleep(1000);
      }
      until(() -> HandsFreeService.session().state() == HandsFreeSession.State.LISTENING, "the last reply read");
      for (String t : spoken) android.util.Log.i("TalkRouterReal", "spoken: " + t);
      assertTrue("the talker's answer and the chief's result, spoken: " + spoken, spoken.size() >= 2);
      HandsFreeService.send(context, HandsFreeService.END);
      until(() -> HandsFreeService.instance == null, "hands-free ended");
      Thread.sleep(5000);
    } finally {
      for (String line : HandsFreeService.log(context).split("\n")) android.util.Log.i("TalkRouterReal", line);
    }
  }

  @Test
  public void withATalkerAndLiveTranscriptionEveryOverSendsWithRepliesInBetween() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).commit();
    liveOn("aai-pro");
    String[] said = {"Book a table for Friday. Over.", "And the train to Lisbon. Over.", "Thanks, that's all. Over."};
    TestServer.liveTexts(said);
    HandsFreeService.logFile(context).delete(); // Only this call's events count.
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    String topic = new BbBridge(context).ntfyTopic();
    try {
      for (int i = 0; i < said.length; i++) {
        int n = i + 1;
        HandsFreeSession s = HandsFreeService.session();
        for (int k = 0; k < 60; k++) s.frame(HandsFreeTestFrames.frame(6000 + 10 * k)); // Speech,
        for (int k = 0; k < 25; k++) s.frame(HandsFreeTestFrames.frame(50)); // then a moment of quiet.
        until(() -> messagesTo(TALKER).size() == n && messagesTo(TestServer.CHIEF).size() == n, "message " + n + " sent by its over");
        assertTrue(messagesTo(TALKER).get(i), messagesTo(TALKER).get(i).contains(said[i].replace(" Over.", "")));
        // The talker answers; the reply plays before the next turn.
        TestServer.ntfySpeak(topic, requestOf(messagesTo(TALKER).get(i)), "Reply number " + n + ".");
        until(() -> count(HandsFreeService.log(context), "reply played to the end") == n, "reply " + n + " played");
        Thread.sleep(HandsFreeSession.TAIL_MS + 500);
      }
      String log = HandsFreeService.log(context);
      assertEquals(log, 3, count(log, "send phrase: quiet "));
      // No phrase skipped for a reason that would lose it (repeats of one being checked are fine).
      assertFalse(log, log.contains("not acted on: nobody had the floor") || log.contains("not acted on: a reply is playing")
          || log.contains("isn't working") || log.contains("phrase isn't checked"));
    } finally {
      for (String line : HandsFreeService.log(context).split("\n")) android.util.Log.i("TalkRouterTurns", line);
    }
  }

  @Test
  public void withATalkerASendPhraseHeardLiveGoesToBoth() throws Exception {
    prefs.edit().putString(BbBridge.TALKER_ID, TALKER).putBoolean(BbBridge.TALKER_ON, true).commit();
    liveOn("aai-pro");
    TestServer.liveTexts("Book a table for Friday. Over.");
    HandsFreeService.send(context, HandsFreeService.START);
    until(() -> HandsFreeService.session() != null, "hands-free started");
    HandsFreeSession s = HandsFreeService.session();
    for (int i = 0; i < 60; i++) s.frame(HandsFreeTestFrames.frame(6000)); // Speech,
    for (int i = 0; i < 25; i++) s.frame(HandsFreeTestFrames.frame(50)); // then half a second of quiet: not yet a pause.
    until(() -> messagesTo(TestServer.CHIEF).size() == 1 && messagesTo(TALKER).size() == 1, "the message sent to both");
    String toChief = messagesTo(TestServer.CHIEF).get(0), toTalker = messagesTo(TALKER).get(0);
    assertTrue(toChief, toChief.contains("Book a table for Friday."));
    assertEquals(toChief.replace(TestServer.CHIEF, TALKER), toTalker);
    until(() -> HandsFreeService.log(context).contains("to the talker too"), "the log says the talker got it");
    String log = HandsFreeService.log(context);
    assertTrue(log, log.contains("send phrase: quiet "));
    assertEquals("Jev asked once, on the send word", 1, count(TestServer.requests(), "decide"));
  }
}
