package app.driftdictation;

import static org.junit.Assert.*;

import java.time.ZoneId;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class OutboxTest {
  private static final long T = 1_793_460_000_000L; // 2026-10-31 16:20:00 in Berlin

  @Test
  public void triesComeFurtherApartUpToAQuarterHour() {
    assertEquals(0, Outbox.delayMs(0));
    assertEquals(15_000, Outbox.delayMs(1));
    assertEquals(30_000, Outbox.delayMs(2));
    assertEquals(60_000, Outbox.delayMs(3));
    assertEquals(600_000, Outbox.delayMs(6));
    assertEquals(900_000, Outbox.delayMs(7));
    assertEquals(900_000, Outbox.delayMs(50));
  }

  @Test
  public void aFailedNoteIsQueuedWithItsNextTry() throws Exception {
    JSONObject note = new JSONObject().put("route", "chief");
    Outbox.failed(note, "bb isn't reachable right now (HTTP 502).", 1, T);
    assertEquals(Outbox.State.RETRYING, Outbox.state(note));
    assertEquals(T, note.getLong("chiefFailedAt"));
    assertEquals(T + 15_000, note.getLong("chiefNextTry"));
    assertFalse(Outbox.due(note, T + 14_999));
    assertTrue(Outbox.due(note, T + 15_000));

    // The second failure keeps when it first failed and waits longer.
    Outbox.failed(note, "again", 2, T + 20_000);
    assertEquals(T, note.getLong("chiefFailedAt"));
    assertEquals(T + 20_000 + 30_000, note.getLong("chiefNextTry"));
    assertEquals(2, note.getInt("chiefTries"));
  }

  @Test
  public void afterTwoDaysItIsNoLongerTriedByItself() throws Exception {
    JSONObject note = new JSONObject();
    Outbox.failed(note, "first", 1, T);
    Outbox.failed(note, "still", 40, T + Outbox.GIVE_UP_MS);
    assertEquals(Outbox.State.FAILED, Outbox.state(note));
    assertFalse(note.has("chiefNextTry"));
    assertFalse(Outbox.due(note, T + Outbox.GIVE_UP_MS * 2));
  }

  @Test
  public void aSentNoteLeavesTheQueueButSaysItTookTries() throws Exception {
    JSONObject note = new JSONObject();
    Outbox.failed(note, "502", 3, T);
    Outbox.sent(note);
    note.put("chiefThread", "thr_c");
    assertEquals(Outbox.State.SENT, Outbox.state(note));
    assertFalse(note.has("chiefQueued"));
    assertEquals(3, note.getInt("chiefTries"));
    assertTrue(note.has("chiefFailedAt"));
  }

  @Test
  public void notesFromBeforeTheOutboxCountAsFailed() throws Exception {
    assertEquals(Outbox.State.FAILED, Outbox.state(new JSONObject().put("chiefFailed", "old")));
    assertEquals(Outbox.State.NONE, Outbox.state(new JSONObject()));
  }

  @Test
  public void failuresOfOneRequestBecomeOneEntry() throws Exception {
    JSONArray list = new JSONArray();
    Outbox.addFailure(list, "chief:abc", "chief", "Note to you, request abc", "HTTP 502", T);
    Outbox.addFailure(list, "chief:abc", "chief", "Note to you, request abc", "connect timeout", T + 30_000);
    Outbox.addFailure(list, "recording:s1", "recording", "Recording", "no connection", T + 40_000);
    assertEquals(2, list.length());
    JSONObject f = list.getJSONObject(0);
    assertEquals(2, f.getInt("count"));
    assertEquals(T, f.getLong("first"));
    assertEquals(T + 30_000, f.getLong("last"));
    assertEquals("connect timeout", f.getString("why"));
    Outbox.resolve(list, "chief:abc", T + 60_000);
    assertEquals(T + 60_000, list.getJSONObject(0).getLong("resolved"));
    // A new failure of a resolved request starts a new entry.
    Outbox.addFailure(list, "chief:abc", "chief", "Note to you, request abc", "HTTP 503", T + 70_000);
    assertEquals(3, list.length());
  }

  @Test
  public void atMostTwentyFailuresAreKept() throws Exception {
    JSONArray list = new JSONArray();
    for (int i = 0; i < 25; i++) Outbox.addFailure(list, "k" + i, "chief", "n", "w", T + i);
    assertEquals(Outbox.FAILURES_MAX, list.length());
    assertEquals("k5", list.getJSONObject(0).getString("key"));
  }

  @Test
  public void theReportSaysWhatFailedWithTheLogAroundIt() throws Exception {
    ZoneId berlin = ZoneId.of("Europe/Berlin");
    NetLog.zone = berlin;
    JSONArray list = new JSONArray();
    Outbox.addFailure(list, "chief:k3x9qa", "chief", "Note to you, request k3x9qa", "bb isn't reachable right now (HTTP 502).", T);
    Outbox.addFailure(list, "chief:k3x9qa", "chief", "Note to you, request k3x9qa", "bb isn't reachable right now (HTTP 502).", T + 45_000);
    Outbox.resolve(list, "chief:k3x9qa", T + 90_000);
    String old = NetLog.stamp(T - 10 * 60_000) + " | bb tell chief | HTTP 200";
    String near = NetLog.stamp(T - 60_000) + " | network now | mobile, v4+v6";
    String bad = NetLog.stamp(T) + " | bb tell chief | req k3x9qa | POST lyricquest.getbb.app/mcp | HTTP 502 bad gateway | 120 ms";
    String text = Outbox.report("Dictate & Delegate 3.3.6 (Android 16)", list, old + "\n" + near + "\n" + bad + "\n", T + 90_000, berlin, "abc123");
    assertTrue(text, text.startsWith("[app failure report] Dictate & Delegate 3.3.6 (Android 16): something went wrong, and this report got through now."));
    assertTrue(text, text.contains("• Note to you, request k3x9qa: failed 2× from 16:20:00 to 16:20:45, went through at 16:21:30. Last error: bb isn't reachable right now (HTTP 502)."));
    assertTrue(text, text.contains("(2 lines;"));
    assertTrue(text, text.contains(near));
    assertTrue(text, text.contains(bad));
    assertFalse(text, text.contains(old));
    assertTrue(text, text.endsWith("Report ID: r-abc123"));
    // The report's ID is its mark: a try that may have arrived isn't sent twice.
    assertEquals("Report ID: r-abc123", BbBridge.mark(text));
  }

  @Test
  public void aSendReportTapIsSaidAsSuch() throws Exception {
    ZoneId berlin = ZoneId.of("Europe/Berlin");
    JSONArray list = new JSONArray();
    Outbox.addFailure(list, "asked:1", "asked", "Recording (writing it down)", "it didn't finish: No connection to OpenRouter.", T);
    String text = Outbox.report("D&D", list, "", T, berlin, "x1");
    assertTrue(text, text.contains("• Recording (writing it down): I tapped Send report at 16:20:00: it didn't finish: No connection to OpenRouter."));
    assertTrue(text, text.contains("(no entries)"));
  }

  @Test
  public void theExcerptKeepsTheLastLinesFromItsStart() {
    StringBuilder log = new StringBuilder("not a line\n");
    for (int i = 0; i < 10; i++) log.append(NetLog.stamp(T + i * 1000)).append(" | x").append(i).append("\n");
    List<String> lines = Outbox.excerpt(log.toString(), T + 2000, 5);
    assertEquals(5, lines.size());
    assertTrue(lines.get(0).endsWith("x5"));
    assertTrue(lines.get(4).endsWith("x9"));
  }
}
