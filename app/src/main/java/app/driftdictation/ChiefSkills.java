package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The instructions as three bb user skills: chief-of-staff and dictate-and-delegate for the chief,
 * dictate-and-delegate-talker for the talker of hands-free calls. Their templates
 * ship in assets/skills; Dictate & Delegate fills in the user's name, the ntfy server and topic and the bb
 * link base. Each filled file ends with a marker holding a hash of its content, e.g.
 * {@code <!-- dictate-and-delegate-skill: 3f2a9c1b04de -->}: a changed template (an app update) or a changed
 * placeholder (topic, server, link, name) gives another hash, so one comparison says whether bb has
 * the current version.
 *
 * <p>Dictate & Delegate reads the installed markers through bb's MCP "read" tool. When one is missing or
 * different, a short-lived bb thread writes the files to ~/.bb/skills (MCP snippets can't write
 * files), Dictate & Delegate waits until bb lists the new versions, then archives that thread.
 */
final class ChiefSkills {
  private ChiefSkills() {}

  static final String CHIEF = "chief-of-staff", ROUTER = "dictate-and-delegate", TALKER = "dictate-and-delegate-talker";

  /** The second skill's name before the rename (3.1.0): the install removes it. */
  static final String OLD_ROUTER = "talk-router";
  static final String[] NAMES = {CHIEF, ROUTER, TALKER};

  static final String INSTALL_TITLE = "Dictate & Delegate: install skills";

  /** The line a chief gets when it's created or adopted, and an older chief once. */
  static final String START = "You're my chief of staff. Use the chief-of-staff and dictate-and-delegate skills.";

  /** The line a talker gets once, when it's set and whenever its skill changed. */
  static final String TALKER_START =
      "You're the talker in my hands-free calls from Dictate & Delegate: you do the talking while my chief of staff"
          + " does the work. Use the " + TALKER + " skill for every call.";

  /** Prefs: which talker was told, with which version of its skill: "<thread id>:<hash>". */
  static final String TALKER_TOLD = "talkerToldSkill";

  /** Prefs: the user's name (shared); per assistant, the hashes installed last time and the app version that checked. */
  static final String USER_NAME = "bbUserName", INSTALLED = "skillsInstalled", CHECKED_VERSION = "skillsCheckedVersion";

  /** Prefs: the chief was told to use the skills (new chiefs at once, older ones after install). */
  static final String CHIEF_TOLD = "chiefToldSkills2"; // 2: after the rename, chiefs hear the new names once.

  // ------------------------------------------------------------------ filling (unit-tested)

  /**
   * A template with its placeholders filled and its marker appended. Without a name, "{{NAME}}"
   * reads "the user"; without a link base, the notification has no Click header.
   */
  static String fill(String skill, String template, String name, String server, String topic, String linkBase) {
    String n = name == null ? "" : name.trim();
    String t = template;
    if (n.isEmpty()) t = t.replace("{{NAME}}'s", "the user's").replace("{{NAME}}", "the user");
    else {
      // In the front matter the name sits in a double-quoted YAML string: escape \ and ".
      int end = t.startsWith("---\n") ? t.indexOf("\n---", 4) : -1;
      String front = end < 0 ? "" : t.substring(0, end), body = end < 0 ? t : t.substring(end);
      t = front.replace("{{NAME}}", n.replace("\\", "\\\\").replace("\"", "\\\"")) + body.replace("{{NAME}}", n);
    }
    if (linkBase.isEmpty()) t = t.replace(" -H \"Click: {{LINK_BASE}}/threads/$BB_THREAD_ID\"", "");
    t = t.replace("{{LINK_BASE}}", linkBase).replace("{{NTFY_SERVER}}", server).replace("{{TOPIC}}", topic);
    if (!t.endsWith("\n")) t += "\n";
    return t + "\n<!-- " + skill + "-skill: " + hash(t) + " -->\n";
  }

  /** The first 12 hex digits of the SHA-256 of a filled file (without its marker). */
  static String hash(String filled) {
    try {
      byte[] d = MessageDigest.getInstance("SHA-256").digest(filled.getBytes(StandardCharsets.UTF_8));
      StringBuilder s = new StringBuilder();
      for (int i = 0; i < 6; i++) s.append(String.format("%02x", d[i]));
      return s.toString();
    } catch (Exception ex) {
      throw new IllegalStateException(ex);
    }
  }

  private static final Pattern MARKER = Pattern.compile("<!-- ([a-z-]+)-skill: ([0-9a-f]+) -->");

  /** The hash in a filled file's marker; "" without one. */
  static String marker(String content) {
    Matcher m = MARKER.matcher(content);
    return m.find() ? m.group(2) : "";
  }

  /**
   * The skills bb should have: name → filled file. The talker's only with a talker set (and on):
   * a user without one doesn't wait for it, and setting one installs it.
   */
  static Map<String, String> filled(Context context, int assistant) throws Exception {
    BbBridge bb = new BbBridge(context, assistant);
    SharedPreferences prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE);
    Map<String, String> files = new LinkedHashMap<>();
    for (String name : NAMES)
      if (!name.equals(TALKER) || !bb.talkerId().isEmpty())
        files.put(
          name,
            fill(name, template(context, name), prefs.getString(USER_NAME, ""), bb.ntfyServer(), bb.ntfyTopic(), bb.linkBase()));
    return files;
  }

  static String template(Context context, String name) throws IOException {
    try (InputStream in = context.getAssets().open("skills/" + name + "/SKILL.md")) {
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  /** "chief-of-staff:<hash>,dictate-and-delegate:<hash>": what's installed when all is current. */
  static String summary(Map<String, String> files) {
    StringBuilder s = new StringBuilder();
    for (Map.Entry<String, String> e : files.entrySet())
      s.append(s.length() == 0 ? "" : ",").append(e.getKey()).append(':').append(marker(e.getValue()));
    return s.toString();
  }

  // ------------------------------------------------------------------ bb snippets

  /** Reads the markers of the installed user skills: {"skills": {name: hash, "" missing, "old" unmarked}}. */
  static String checkSnippet() {
    return "const l = await bb.json([\"skill\",\"list\"]);\n"
        + "const out = {};\n"
        + "for (const name of [\"" + CHIEF + "\",\"" + ROUTER + "\",\"" + TALKER + "\",\"" + OLD_ROUTER + "\"]) {\n"
        + "  const s = (l.skills || []).find(x => x.name === name && x.scope === \"bb-user\");\n"
        + "  if (!s) { out[name] = \"\"; continue; }\n"
        + "  const f = await bb.json([\"skill\",\"show\",s.id]);\n"
        + "  const m = /<!-- [a-z-]+-skill: ([0-9a-f]+) -->/.exec(f.content || \"\");\n"
        + "  out[name] = m ? m[1] : \"old\";\n"
        + "}\n"
        + "return {skills: out};";
  }

  /**
   * The install thread's brief, for a capable colleague: what the skills are for, where bb reads
   * them, what done looks like, and the files; it may fix what obviously wouldn't load. The app
   * never needs the files byte for byte: it only reads each file's marker line (checkSnippet,
   * marker), so a file the thread fixed still counts as current, and after the thread is done the
   * app checks bb itself (both skills listed, talk-router gone) before it says "Installed".
   */
  static String installPrompt(Map<String, String> files) {
    StringBuilder s =
        new StringBuilder(
            "Please install or update three bb user skills. They come from Dictate & Delegate, the voice"
                + " app on the user's phone: `chief-of-staff` describes the role of the user's chief of"
                + " staff, `dictate-and-delegate` explains the messages the app sends and how to notify the"
                + " user or send text back through ntfy, and `dictate-and-delegate-talker` is for the"
                + " talker, the thread that does the talking in the user's hands-free calls.\n\n"
                + "bb reads user skills from `~/.bb/skills/<name>/SKILL.md`. Put each file below there,"
                + " replacing what's there now. Each file ends with a line like"
                + " `<!-- dictate-and-delegate-skill: 3f2a9c1b04de -->`: the app reads that line to tell"
                + " whether the installed skill is current, so keep it as it is. If something in a file"
                + " wouldn't load (bb skips a skill whose front matter isn't valid YAML, for example), fix"
                + " it the way the author obviously meant, and keep the meaning.\n\n"
                + "The second skill used to be called `"
                + OLD_ROUTER
                + "`; remove `~/.bb/skills/"
                + OLD_ROUTER
                + "` if it's there.\n\n"
                + "You're done when `bb skill list` shows `chief-of-staff`, `dictate-and-delegate` and"
                + " `dictate-and-delegate-talker` as user skills and no `"
                + OLD_ROUTER
                + "`. Then reply with one short line saying so. This is housekeeping, so no"
                + " notification.\n");
    for (Map.Entry<String, String> e : files.entrySet())
      s.append("\n===== ~/.bb/skills/")
          .append(e.getKey())
          .append("/SKILL.md (begins on the next line) =====\n")
          .append(e.getValue())
          .append("===== end of ")
          .append(e.getKey())
          .append(" =====\n");
    return s.toString();
  }

  static String spawnSnippet(String prompt) {
    return "const t = await bb.json([\"thread\",\"spawn\",\"--project\","
        + BbBridge.js(BbBridge.PROJECT)
        + ",\"--title\","
        + BbBridge.js(INSTALL_TITLE)
        + ",\"--prompt-file\",\"-\"], {stdin: "
        + BbBridge.js(prompt)
        + "});\nreturn {id: t.id, status: t.status};";
  }

  static String archiveSnippet(String id) {
    return "await bb.json([\"thread\",\"archive\"," + BbBridge.js(id) + "]);\nreturn {archived: true};";
  }

  /** Which skills differ from what bb has (missing, unmarked or another hash), and the old one if it's still there. */
  static List<String> outdated(Map<String, String> files, JSONObject installed) {
    List<String> out = new ArrayList<>();
    for (Map.Entry<String, String> e : files.entrySet())
      if (!marker(e.getValue()).equals(installed.optString(e.getKey()))) out.add(e.getKey());
    if (!installed.optString(OLD_ROUTER).isEmpty()) out.add(OLD_ROUTER);
    return out;
  }

  // ------------------------------------------------------------------ keeping bb current

  /** Where the install stands, for setup and Settings → bb. */
  enum State {
    IDLE,
    CHECKING,
    INSTALLING,
    INSTALLED,
    FAILED
  }

  /** Each assistant's bb is kept current on its own: where its install stands, and why it failed. */
  private static final State[] states = {State.IDLE, State.IDLE};

  private static final String[] problems = {"", ""};
  private static final boolean[] running = new boolean[Assistants.COUNT];

  static State state(int assistant) {
    return states[assistant];
  }

  static String problem(int assistant) {
    return problems[assistant];
  }

  /** For the tests: back to the start. */
  static void reset() {
    for (int a = 0; a < Assistants.COUNT; a++) {
      states[a] = State.IDLE;
      problems[a] = "";
    }
  }

  /** An assistant's own name for one of these settings (Assistants.key). */
  private static String k(int assistant, String name) {
    return Assistants.key(assistant, name);
  }

  /** How long the app waits for the install thread, polling every few seconds. */
  static long installWaitMs = 4 * 60_000, pollMs = 3000;

  /** Once the chief's skills are in, how long the talker's may still take. */
  static long talkerGraceMs = 20_000;

  /** Why the talker's skill isn't in bb, and why the talker couldn't be told; "" when all is well. */
  static volatile String talkerSkillProblem = "", talkerTellProblem = "";

  /** What the talker setting says is wrong, "" when nothing is. */
  static String talkerProblem() {
    return !talkerSkillProblem.isEmpty() ? talkerSkillProblem : talkerTellProblem;
  }

  /** Brings every connected assistant's bb up to date (see below). */
  static void sync(Context context, boolean force) {
    for (int a = 0; a < Assistants.COUNT; a++) sync(context, a, force);
  }

  /**
   * Brings an assistant's bb skills up to date in the background, filled with its own topic, server
   * and link. Without force it only asks bb when something changed since the last install: the
   * filled files (template, name, topic, server, link) or the app version.
   */
  static synchronized void sync(Context context, int assistant, boolean force) {
    Context app = context.getApplicationContext();
    if (running[assistant] || !new BbBridge(app, assistant).connected()) return;
    SharedPreferences prefs = app.getSharedPreferences("settings", Context.MODE_PRIVATE);
    Map<String, String> files;
    try {
      files = filled(app, assistant);
    } catch (Exception ex) {
      return;
    }
    boolean same =
        summary(files).equals(prefs.getString(k(assistant, INSTALLED), ""))
            && prefs.getInt(k(assistant, CHECKED_VERSION), 0) == BuildConfig.VERSION_CODE;
    if (same && !force) {
      states[assistant] = State.INSTALLED;
      if (!talkerTold(app, assistant, files)) new Thread(() -> safelyTellTalker(app, assistant), "talker-skill").start();
      return;
    }
    running[assistant] = true;
    new Thread(
            () -> {
              try {
                List<String> missing = ensure(app, assistant, files);
                // The talker's skill if bb didn't take it: tried again at the next sync, and said
                // on its own, never as the chief's skills failing.
                Map<String, String> got = new LinkedHashMap<>(files);
                for (String name : missing) got.remove(name);
                prefs.edit().putString(k(assistant, INSTALLED), summary(got)).putInt(k(assistant, CHECKED_VERSION), BuildConfig.VERSION_CODE).apply();
                // The talker is the first assistant's (Settings → Hands-free): only its sync says how it is.
                if (assistant == 0) talkerSkillProblem = missing.contains(TALKER) ? tr("bb didn't install the talker's skill. It's tried again next time.") : "";
                states[assistant] = State.INSTALLED;
                problems[assistant] = "";
                tellOlderChief(app, assistant);
              } catch (Exception ex) {
                problems[assistant] = DictationService.friendly(ex);
                states[assistant] = State.FAILED;
              } finally {
                running[assistant] = false;
              }
              safelyTellTalker(app, assistant); // Its own try: a talker that can't be told is said apart.
            },
            "chief-skills")
        .start();
  }

  /**
   * Checks bb and, if needed, installs through a thread and waits for it. Blocks. Only the chief's
   * skills must be there for it to succeed; returns the optional ones (the talker's) still missing.
   */
  static List<String> ensure(Context app, int assistant, Map<String, String> files) throws Exception {
    BbBridge bb = new BbBridge(app, assistant);
    states[assistant] = State.CHECKING;
    JSONObject installed = bb.read(checkSnippet()).optJSONObject("skills");
    List<String> outdated = outdated(files, installed == null ? new JSONObject() : installed);
    if (outdated.isEmpty()) return List.of();
    states[assistant] = State.INSTALLING;
    String id = bb.run(spawnSnippet(installPrompt(files))).optString("id");
    if (id.isEmpty()) throw new IOException(tr("bb didn't say which thread it created."));
    try {
      long until = SystemClock.elapsedRealtime() + installWaitMs, talkerSince = 0;
      while (true) {
        Thread.sleep(pollMs);
        JSONObject skills = bb.read(checkSnippet()).optJSONObject("skills");
        List<String> left = skills == null ? List.of(CHIEF) : outdated(files, skills);
        if (left.isEmpty()) return List.of();
        if (!left.contains(CHIEF) && !left.contains(ROUTER) && !left.contains(OLD_ROUTER)) {
          // The chief's are in: the talker's gets a little longer (written last), then it's said apart.
          if (talkerSince == 0) talkerSince = SystemClock.elapsedRealtime();
          if (SystemClock.elapsedRealtime() - talkerSince > talkerGraceMs) return left;
        }
        if (SystemClock.elapsedRealtime() > until)
          throw new IOException(tr("bb didn't install the chief's skills in time. Try again."));
      }
    } finally {
      try {
        bb.run(archiveSnippet(id));
      } catch (Exception ignored) {
        /* The thread stays; it did its job or failed. */
      }
    }
  }

  /** What TALKER_TOLD holds once this talker was told about this version of its skill; "" without a talker. */
  static String talkerToldValue(String talker, Map<String, String> files) {
    return talker.isEmpty() ? "" : talker + ":" + marker(files.get(TALKER));
  }

  static boolean talkerTold(Context app, int assistant, Map<String, String> files) {
    String value = talkerToldValue(new BbBridge(app, assistant).talkerId(), files);
    return value.isEmpty() || value.equals(app.getSharedPreferences("settings", Context.MODE_PRIVATE).getString(k(assistant, TALKER_TOLD), ""));
  }

  /**
   * The talker (set and on) gets TALKER_START once: when it's set or changed, and whenever its
   * skill changed. Only once bb has the current skills, so it finds the one it's told to use.
   */
  static synchronized void tellTalker(Context app, int assistant) throws Exception {
    SharedPreferences prefs = app.getSharedPreferences("settings", Context.MODE_PRIVATE);
    Map<String, String> files = filled(app, assistant);
    if (talkerTold(app, assistant, files) || !summary(files).equals(prefs.getString(k(assistant, INSTALLED), ""))) return;
    BbBridge bb = new BbBridge(app, assistant);
    String talker = bb.talkerId();
    bb.send(talker, TALKER_START);
    prefs.edit().putString(k(assistant, TALKER_TOLD), talkerToldValue(talker, files)).apply();
  }

  /** The same, for a background thread: a failure is said apart, and tried again at the next call or sync. */
  static void safelyTellTalker(Context app, int assistant) {
    if (assistant != 0) return; // Only the first assistant has a talker.
    try {
      tellTalker(app, assistant);
      talkerTellProblem = "";
    } catch (Exception ex) {
      talkerTellProblem = tr("Couldn't tell the talker to use its skill: %1$s", DictationService.friendly(ex));
      android.util.Log.w("TalkRouter", "talker not told: " + ex);
    }
  }

  /** A chief from before the skills gets the one line once, now that they're there. */
  static void tellOlderChief(Context app, int assistant) throws Exception {
    BbBridge bb = new BbBridge(app, assistant);
    SharedPreferences prefs = app.getSharedPreferences("settings", Context.MODE_PRIVATE);
    if (bb.chiefId().isEmpty() || prefs.getBoolean(k(assistant, CHIEF_TOLD), false)) return;
    bb.send(bb.chiefId(), START);
    prefs.edit().putBoolean(k(assistant, CHIEF_TOLD), true).apply();
  }
}
