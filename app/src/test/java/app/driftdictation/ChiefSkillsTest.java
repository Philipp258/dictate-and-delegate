package app.driftdictation;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;

public class ChiefSkillsTest {
  static String template(String name) throws Exception {
    return new String(Files.readAllBytes(Path.of("src/main/assets/skills/" + name + "/SKILL.md")), java.nio.charset.StandardCharsets.UTF_8);
  }

  String router(String name, String topic, String link) throws Exception {
    return ChiefSkills.fill(ChiefSkills.ROUTER, template(ChiefSkills.ROUTER), name, "https://ntfy.sh", topic, link);
  }

  @Test
  public void theTemplatesAreFilledIn() throws Exception {
    String r = router("Alex", "talkrouter-abc", "https://someone.getbb.app");
    assertFalse(r, r.contains("{{"));
    assertTrue(r.contains("the voice app on Alex's phone"));
    assertTrue(r.contains("--data-binary @- https://ntfy.sh/talkrouter-abc <<'TEXT'"));
    assertTrue(r.contains("-H \"Click: https://someone.getbb.app/threads/$BB_THREAD_ID\""));
    // The paste flow: request ID, tags and the Copy broadcast.
    assertTrue(r.contains("[request: <id>]"));
    assertTrue(r.contains("Tags: talkrouter-paste,req-<id>"));
    assertTrue(r.contains("intent=" + TalkAccessibility.COPY_ACTION + ", extras.request=<id>"));
    assertTrue(r.startsWith("---\nname: dictate-and-delegate\n"));
    String c = ChiefSkills.fill(ChiefSkills.CHIEF, template(ChiefSkills.CHIEF), "Alex", "https://ntfy.sh", "t", "");
    assertTrue(c.contains("You're Alex's chief of staff."));
    assertTrue(c.contains("When a decision is Alex's, ask."));
    assertFalse(c.contains("{{"));
  }

  String talker(String name, String server, String topic) throws Exception {
    return ChiefSkills.fill(ChiefSkills.TALKER, template(ChiefSkills.TALKER), name, server, topic, "https://x.getbb.app");
  }

  @Test
  public void theTalkerSkillIsFilledInWithTheAppsNtfyAndNothingPersonal() throws Exception {
    String t = talker("Alex", "https://ntfy.example.org", "talkrouter-abc");
    assertFalse(t, t.contains("{{"));
    assertTrue(t.startsWith("---\nname: dictate-and-delegate-talker\n"));
    assertTrue(t.contains("the voice app on Alex's phone"));
    assertTrue(t.contains("--data-binary @- https://ntfy.example.org/talkrouter-abc <<'TEXT'"));
    assertTrue(t.contains("Tags: talkrouter-speak,req-<id>"));
    assertTrue(t.contains("use `Tags: talkrouter-speak` without `req-`"));
    // The rules it carries.
    assertTrue(t.contains("you never pass anything on and never say you will"));
    assertTrue(t.contains("use no tools except speaking"));
    assertTrue(t.contains("A briefing, background the chief sends you"));
    assertTrue(t.contains("Answer their new message first."));
    assertTrue(t.contains("`[didn't hear your reply: \"…\"]`"));
    assertTrue(t.contains("`[heard up to: \"…\"]`"));
    assertTrue(t.contains("Never invent it."));
    assertTrue(t.contains("say only a very short holding phrase: \"Checking.\" / \"One moment.\" / \"On it.\""));
    assertTrue(t.contains("don't explain what will be checked, don't guess, don't add advice or warnings of your own"));
    assertTrue(t.contains("Everything else, including general knowledge"));
    assertTrue(t.contains("as the answer itself (no \"the chief says\")"));
    assertTrue(t.contains("Use it only if Alex asks what's going on."));
    assertTrue(t.contains("[you are the talker]"));
    // Open source: no thread IDs, no topic, no person of its own.
    String template = template(ChiefSkills.TALKER);
    assertFalse(template.contains("thr_"));
    assertFalse(template.contains("talkrouter-I"));
    assertFalse(template.contains("Philipp"));
    assertFalse(template.contains("Alex"));
    String hash = ChiefSkills.marker(t);
    assertTrue(t.endsWith("\n<!-- dictate-and-delegate-talker-skill: " + hash + " -->\n"));
    assertNotEquals(hash, ChiefSkills.marker(talker("Alex", "https://ntfy.example.org", "talkrouter-new")));
    assertNotEquals(hash, ChiefSkills.marker(talker("Alex", "https://ntfy.sh", "talkrouter-abc")));
    assertTrue(talker(" ", "https://ntfy.sh", "t").contains("the voice app on the user's phone"));
  }

  @Test
  public void aTalkerIsToldAgainOnlyWhenItOrItsSkillChanged() throws Exception {
    Map<String, String> files = Map.of(ChiefSkills.TALKER, talker("Alex", "https://ntfy.sh", "a"));
    String told = ChiefSkills.talkerToldValue("thr_talk", files);
    assertEquals("thr_talk:" + ChiefSkills.marker(files.get(ChiefSkills.TALKER)), told);
    assertEquals(told, ChiefSkills.talkerToldValue("thr_talk", Map.of(ChiefSkills.TALKER, talker("Alex", "https://ntfy.sh", "a"))));
    assertNotEquals(told, ChiefSkills.talkerToldValue("thr_other", files));
    assertNotEquals(told, ChiefSkills.talkerToldValue("thr_talk", Map.of(ChiefSkills.TALKER, talker("Alex", "https://ntfy.sh", "b"))));
    assertEquals("no talker, nothing to tell", "", ChiefSkills.talkerToldValue("", files));
    assertTrue(ChiefSkills.TALKER_START.contains("Use the dictate-and-delegate-talker skill"));
    assertEquals("[hands-free call started] [you are the talker]", HandsFree.TALKER_CALL_STARTED);
  }

  @Test
  public void theChiefSkillStatesTheTalkerContractAndTheTurnRule() throws Exception {
    String r = router("Alex", "t", "");
    assertTrue(r.contains("from the call start until `[hands-free call ended]` you post nothing to ntfy: no spoken replies and no notifications"));
    assertTrue(r.contains("bb thread tell <talker thread id> --mode queue --message-file -"));
    assertTrue(r.contains("[chief] <what Alex needs to know or decide"));
    assertTrue(r.contains("A reply never plays while it's Alex's turn"));
    assertFalse("the old pause rule is gone", r.contains("plays at their next pause, even if they haven't sent"));
    assertTrue(r.contains("it was dropped because Alex had already sent a newer message"));
  }

  @Test
  public void withoutANameItSaysTheUser() throws Exception {
    String c = ChiefSkills.fill(ChiefSkills.CHIEF, template(ChiefSkills.CHIEF), "  ", "https://ntfy.sh", "t", "");
    assertTrue(c.contains("Act as the user's chief of staff"));
    assertTrue(c.contains("You manage the user's tasks"));
    String r = router("", "t", "");
    assertTrue(r.contains("when you need the user,"));
    // Without a link base there's no Click header.
    assertFalse(r.contains("Click:"));
    assertFalse(r.contains("{{"));
  }

  @Test
  public void theMarkerChangesWithTheTemplateAndThePlaceholdersOnly() throws Exception {
    String a = router("Alex", "talkrouter-abc", "https://x.getbb.app");
    String hash = ChiefSkills.marker(a);
    assertTrue(hash, hash.matches("[0-9a-f]{12}"));
    assertTrue(a.endsWith("\n<!-- dictate-and-delegate-skill: " + hash + " -->\n"));
    assertEquals(hash, ChiefSkills.marker(router("Alex", "talkrouter-abc", "https://x.getbb.app")));
    assertNotEquals(hash, ChiefSkills.marker(router("Alex", "talkrouter-new", "https://x.getbb.app")));
    assertNotEquals(hash, ChiefSkills.marker(router("Sam", "talkrouter-abc", "https://x.getbb.app")));
    assertNotEquals(hash, ChiefSkills.marker(router("Alex", "talkrouter-abc", "https://y.getbb.app")));
    String changed = template(ChiefSkills.ROUTER).replace("odd misheard word", "occasional misheard word");
    assertNotEquals(
        hash,
        ChiefSkills.marker(ChiefSkills.fill(ChiefSkills.ROUTER, changed, "Alex", "https://ntfy.sh", "talkrouter-abc", "https://x.getbb.app")));
    assertEquals("", ChiefSkills.marker("no marker here"));
  }

  @Test
  public void outdatedMeansMissingUnmarkedOrAnotherHash() throws Exception {
    Map<String, String> files = new LinkedHashMap<>();
    files.put(ChiefSkills.CHIEF, ChiefSkills.fill(ChiefSkills.CHIEF, template(ChiefSkills.CHIEF), "", "s", "t", ""));
    files.put(ChiefSkills.ROUTER, router("", "t", ""));
    String c = ChiefSkills.marker(files.get(ChiefSkills.CHIEF)), r = ChiefSkills.marker(files.get(ChiefSkills.ROUTER));
    assertEquals(List.of(), ChiefSkills.outdated(files, new JSONObject().put("chief-of-staff", c).put("dictate-and-delegate", r)));
    assertEquals(
        List.of("dictate-and-delegate"),
        ChiefSkills.outdated(files, new JSONObject().put("chief-of-staff", c).put("dictate-and-delegate", "old")));
    assertEquals(List.of("chief-of-staff", "dictate-and-delegate"), ChiefSkills.outdated(files, new JSONObject()));
    // After the rename: the old talk-router skill still there counts as outdated, so it's removed.
    assertEquals(
        List.of("talk-router"),
        ChiefSkills.outdated(
            files, new JSONObject().put("chief-of-staff", c).put("dictate-and-delegate", r).put("talk-router", "abc")));
    assertEquals("chief-of-staff:" + c + ",dictate-and-delegate:" + r, ChiefSkills.summary(files));
  }

  @Test
  public void theInstallThreadGetsTheFilesVerbatim() throws Exception {
    Map<String, String> files = new LinkedHashMap<>();
    files.put(ChiefSkills.CHIEF, "chief file\n");
    files.put(ChiefSkills.ROUTER, "router file\n");
    files.put(ChiefSkills.TALKER, "talker file\n");
    String p = ChiefSkills.installPrompt(files);
    assertTrue(p.contains("`chief-of-staff` describes the role of the user's chief of staff"));
    assertTrue(p.contains("`dictate-and-delegate-talker` is for the talker"));
    assertTrue(p.contains("shows `chief-of-staff`, `dictate-and-delegate` and `dictate-and-delegate-talker` as user skills and no `talk-router`"));
    assertTrue(p.contains("===== ~/.bb/skills/dictate-and-delegate-talker/SKILL.md (begins on the next line) =====\ntalker file\n"));
    assertTrue(ChiefSkills.checkSnippet().contains("\"dictate-and-delegate-talker\""));
    assertTrue(
        p.contains(
            "===== ~/.bb/skills/dictate-and-delegate/SKILL.md (begins on the next line) =====\nrouter file\n===== end of dictate-and-delegate ====="));
    assertTrue(p.contains("remove `~/.bb/skills/talk-router` if it's there"));
    assertTrue(p.contains("so keep it as it is"));
    assertTrue(p.contains("fix it the way the author obviously meant"));
    assertFalse(p.contains("byte for byte"));
    assertTrue(code(p).contains("\"--title\",\"Dictate & Delegate: install skills\""));

    assertTrue(ChiefSkills.checkSnippet().contains("x.scope === \"bb-user\""));
  }

  static String code(String prompt) {
    return ChiefSkills.spawnSnippet(prompt);
  }

  /** The front matter between the --- lines as key → value, unquoting a double-quoted value. */
  static Map<String, String> frontMatter(String file) {
    assertTrue(file.startsWith("---\n"));
    int end = file.indexOf("\n---\n", 4);
    assertTrue(end > 0);
    Map<String, String> out = new LinkedHashMap<>();
    for (String line : file.substring(4, end).split("\n")) {
      int colon = line.indexOf(": ");
      assertTrue(line, colon > 0 && line.substring(0, colon).matches("[a-z-]+"));
      String value = line.substring(colon + 2);
      if (value.startsWith("\"")) {
        // A closed double-quoted string: only \\ and \" escapes, nothing after the closing quote.
        StringBuilder v = new StringBuilder();
        int i = 1;
        for (; i < value.length() && value.charAt(i) != '"'; i++) {
          char ch = value.charAt(i);
          if (ch == '\\') {
            char next = value.charAt(++i);
            assertTrue(line, next == '\\' || next == '"');
            v.append(next);
          } else v.append(ch);
        }
        assertEquals(line, value.length() - 1, i);
        value = v.toString();
      } else assertFalse(line, value.contains(": ") || value.contains("\""));
      out.put(line.substring(0, colon), value);
    }
    return out;
  }

  @Test
  public void theFrontMatterStaysValidWithATrickyName() throws Exception {
    String name = "Ada \"A.\" O'Neil: Jr \\ x";
    for (String skill : ChiefSkills.NAMES) {
      String filled = ChiefSkills.fill(skill, template(skill), name, "https://ntfy.sh", "t", "https://x.getbb.app");
      Map<String, String> front = frontMatter(filled);
      assertEquals(skill, front.get("name"));
      assertTrue(front.get("description"), front.get("description").contains(name + "'s"));
      assertEquals(2, front.size());
      // In the body the name stays as typed.
      assertTrue(filled.substring(filled.indexOf("\n---\n", 4)).contains(name));
    }
    // Without a name too.
    for (String skill : ChiefSkills.NAMES)
      assertTrue(frontMatter(ChiefSkills.fill(skill, template(skill), "", "s", "t", "")).get("description").contains("the user"));
  }
}
