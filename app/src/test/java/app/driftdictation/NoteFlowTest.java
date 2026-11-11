package app.driftdictation;

import static org.junit.Assert.*;

import java.time.ZoneId;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NoteFlowTest {
  private static final long T = 1_794_398_400_000L; // 2026-11-11 13:00:00 in Berlin
  private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
  private static final long MIN = 60_000;

  /** A note recorded from T for seconds, written down. */
  private static JSONObject note(long created, double seconds) throws Exception {
    JSONObject n = HistoryEntry.create("n1", "microsoft/mai-transcribe-2", seconds).json;
    n.put("created", created);
    return n;
  }

  private static JSONObject written(JSONObject n) throws Exception {
    return n.put("status", "complete").put("text", "Hello").put("original", "Hello");
  }

  @Test
  public void aPlainDictationGoesNowhere() throws Exception {
    JSONObject n = written(note(T, 10));
    assertFalse(NoteFlow.meantForChief(n));
    assertEquals(NoteFlow.Delivery.NONE, NoteFlow.delivery(n, T + MIN));
    assertNull(NoteFlow.badge(n, T + MIN, false, false, null));
  }

  @Test
  public void theChoiceIsKeptOnTheNoteAndWaitsForTheTranscript() throws Exception {
    JSONObject n = note(T, 10);
    NoteFlow.wantChief(n, 1, T + 5_000);
    assertTrue(NoteFlow.meantForChief(n));
    assertEquals(1, NoteFlow.assistant(n));
    assertEquals(NoteFlow.Delivery.NEEDS_TRANSCRIPT, NoteFlow.delivery(n, T + 20_000));
    written(n);
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(n, T + 20_000));
    assertTrue(NoteFlow.maySend(n, T + 20_000, false));
  }

  @Test
  public void takingTheChoiceBackMeansItIsJustADictation() throws Exception {
    JSONObject n = written(note(T, 10));
    NoteFlow.wantChief(n, 0, T + 11_000);
    assertTrue(NoteFlow.dropChief(n, T + 12_000));
    assertFalse(NoteFlow.meantForChief(n));
    assertEquals(NoteFlow.Delivery.NONE, NoteFlow.delivery(n, T + 13_000));
    // Chosen again: meant for it again.
    NoteFlow.wantChief(n, 0, T + 14_000);
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(n, T + 15_000));
  }

  @Test
  public void anOldNoteNeverGoesByItself() throws Exception {
    // Recorded two days ago and meant for the chief, written down only now (a late Retry).
    JSONObject n = note(T - 2 * 24 * 60 * MIN, 30);
    NoteFlow.wantChief(n, 0, T - 2 * 24 * 60 * MIN + 31_000);
    written(n);
    assertEquals(NoteFlow.Delivery.NEEDS_OK, NoteFlow.delivery(n, T));
    assertFalse(NoteFlow.maySend(n, T, false));
    assertTrue(NoteFlow.maySend(n, T, true));
    NoteFlow.Status s = NoteFlow.status(n, T, false, false, "Personal", BERLIN);
    assertTrue(s.problem());
    assertTrue(s.line(), s.line().contains("waits for you"));
    // The user's Send: fresh from now on.
    NoteFlow.confirm(n, T);
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(n, T + 1000));
  }

  @Test
  public void itGoesByItselfOnlyWithinTheWindow() throws Exception {
    JSONObject n = written(note(T, 60));
    NoteFlow.wantChief(n, 0, T + 10_000);
    long end = T + 60_000;
    assertTrue(NoteFlow.fresh(n, end + NoteFlow.AUTO_MS));
    assertFalse(NoteFlow.fresh(n, end + NoteFlow.AUTO_MS + 1));
  }

  @Test
  public void aFailedSendIsTriedAgainWhileFreshThenWaitsForTheUser() throws Exception {
    JSONObject n = written(note(T, 10));
    NoteFlow.wantChief(n, 0, T + 10_000);
    NoteFlow.beginSend(n, "abc123", 0, T + 11_000);
    assertEquals(NoteFlow.Delivery.SENDING, NoteFlow.delivery(n, T + 12_000));
    NoteFlow.sendFailed(n, "bb answered with HTTP 502.", T + 12_000);
    assertEquals(NoteFlow.Delivery.WAITING, NoteFlow.delivery(n, T + 13_000));
    assertEquals(T + 12_000 + 15_000, n.getLong("chiefNextTry"));
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(n, T + 27_000));
    // Its request ID stays: the next try checks bb first.
    assertTrue(NoteFlow.triedBefore(n));
    assertEquals("abc123", n.getString("chiefRequest"));
    // Past the window it stops and waits for Send.
    long late = T + 10_000 + NoteFlow.AUTO_MS + MIN;
    NoteFlow.beginSend(n, "abc123", 0, late);
    NoteFlow.sendFailed(n, "still 502", late);
    assertFalse(n.has("chiefQueued"));
    assertEquals(NoteFlow.Delivery.NEEDS_OK, NoteFlow.delivery(n, late + 1));
    NoteFlow.Status s = NoteFlow.status(n, late + 1, false, false, "your chief of staff", BERLIN);
    assertTrue(s.line(), s.line().contains("still 502"));
    assertTrue(s.line(), s.line().contains("2× tried"));
  }

  @Test
  public void aSentNoteStaysSentAndCannotBeTakenBack() throws Exception {
    JSONObject n = written(note(T, 10));
    NoteFlow.wantChief(n, 0, T + 10_000);
    NoteFlow.beginSend(n, "abc123", 0, T + 11_000);
    assertFalse(NoteFlow.dropChief(n, T + 11_500)); // under way
    NoteFlow.sendDone(n, "thr_c", "https://x/thr_c", T + 12_000);
    assertEquals(NoteFlow.Delivery.SENT, NoteFlow.delivery(n, T + 13_000));
    assertFalse(NoteFlow.dropChief(n, T + 14_000));
    assertFalse(NoteFlow.maySend(n, T + 14_000, true));
    assertTrue(NoteFlow.status(n, T + 14_000, false, false, "Work", BERLIN).line().contains("request abc123"));
  }

  @Test
  public void aTryCutOffByTheAppStoppingCountsAsMaybeArrived() throws Exception {
    JSONObject n = written(note(T, 10));
    NoteFlow.wantChief(n, 0, T + 10_000);
    NoteFlow.beginSend(n, "abc123", 0, T + 11_000);
    // The app was stopped mid-send: after a while it's due again, with the same request ID.
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(n, T + 11_000 + NoteFlow.SENDING_STALE_MS));
    assertTrue(NoteFlow.triedBefore(n));
  }

  @Test
  public void stopTryingAndInterruptedRecordingsWaitForTheUser() throws Exception {
    JSONObject n = written(note(T, 10));
    NoteFlow.wantChief(n, 0, T + 10_000);
    n.put("stoppedAt", T + 15_000);
    assertEquals(NoteFlow.Delivery.NEEDS_OK, NoteFlow.delivery(n, T + 20_000));
    n.remove("stoppedAt"); // Retry tapped
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(n, T + 20_000));

    n.put("stoppedAt", T + 15_000);
    assertTrue(NoteFlow.status(n, T + 20_000, false, false, "Work", BERLIN).line().contains("you stopped it"));
    n.remove("stoppedAt");

    JSONObject cut = written(note(T, 10)).put("interrupted", true);
    NoteFlow.wantChief(cut, 0, T + 5_000);
    assertEquals(NoteFlow.Delivery.NEEDS_OK, NoteFlow.delivery(cut, T + 20_000));
    NoteFlow.confirm(cut, T + 30_000);
    assertEquals(NoteFlow.Delivery.DUE, NoteFlow.delivery(cut, T + 31_000));
  }

  @Test
  public void notesFromBeforeIntentsAreReadFromWhatHappened() throws Exception {
    JSONObject sent = written(note(T, 10)).put("route", "chief").put("chiefThread", "thr_c").put("chiefRequest", "r1");
    assertEquals(NoteFlow.Delivery.SENT, NoteFlow.delivery(sent, T + MIN));
    // 3.7.2 kept a failed one queued for two days: an old one now waits for the user.
    JSONObject queued = written(note(T - 3 * 60 * MIN, 10)).put("route", "chief").put("chiefFailed", "502").put("chiefTries", 3).put("chiefQueued", true).put("chiefNextTry", T);
    assertEquals(NoteFlow.Delivery.NEEDS_OK, NoteFlow.delivery(queued, T));
    assertTrue(NoteFlow.settle(queued, T));
    assertFalse(queued.has("chiefQueued"));
    // A hands-free message is the call's business.
    JSONObject call = written(note(T, 5)).put("handsFree", true).put("route", "chief").put("chiefThread", "thr_c");
    assertFalse(NoteFlow.meantForChief(call));
    assertEquals(NoteFlow.Delivery.SENT, NoteFlow.delivery(call, T));
  }

  @Test
  public void aFailedTranscriptionSaysWhyAndThatTheChiefWaits() throws Exception {
    JSONObject n = note(T, 180).put("status", "needs attention");
    NoteFlow.wantChief(n, 0, T + 100_000);
    NoteFlow.speechFailed(n, "The model is busy or rate-limited (HTTP 429 too many requests from Azure: Rate limit exceeded).", T + 240_000);
    NoteFlow.Status s = NoteFlow.status(n, T + 300_000, false, true, "Personal", BERLIN);
    assertTrue(s.problem());
    assertTrue(s.line(), s.line().startsWith("For Personal: not written down"));
    assertTrue(s.line(), s.line().contains("HTTP 429"));
    assertTrue(s.line(), s.line().contains("goes to Personal once it's written down"));
    assertEquals("Personal · failed: writing down", NoteFlow.badge(n, T + 300_000, false, true, "Personal"));
    assertEquals("writing down", NoteFlow.badge(n, T + 300_000, true, true, "Personal"));
  }

  @Test
  public void aTranscriptionSavingItsCopyKeepsAChoiceMadeMeanwhile() throws Exception {
    JSONObject saved = note(T, 10);
    JSONObject mine = new JSONObject(saved.toString());
    // While it's written down, the user taps the assistant button (saved on the note).
    NoteFlow.wantChief(saved, 1, T + 12_000);
    NoteFlow.event(saved, T + 12_000, "chose");
    // The transcription's copy logs a try and saves.
    NoteFlow.log(mine, T + 11_000, "speech", "m", 900, null);
    NoteFlow.merge(mine, saved);
    assertTrue(NoteFlow.meantForChief(mine));
    assertEquals(1, NoteFlow.assistant(mine));
    JSONArray log = mine.getJSONArray("log");
    assertEquals(2, log.length());
    assertEquals(T + 11_000, log.getJSONObject(0).getLong("at"));
    assertEquals("event", log.getJSONObject(1).getString("step"));
    // Taken back meanwhile: the copy loses it too.
    NoteFlow.dropChief(saved, T + 13_000);
    NoteFlow.merge(mine, saved);
    assertFalse(NoteFlow.meantForChief(mine));
  }

  @Test
  public void theLogKeepsEveryTryUpToItsLimit() throws Exception {
    JSONObject n = note(T, 10);
    for (int i = 0; i < NoteFlow.LOG_MAX + 5; i++) NoteFlow.log(n, T + i, "speech", "m", 1, i % 2 == 0 ? "HTTP 429" : null);
    JSONArray log = n.getJSONArray("log");
    assertEquals(NoteFlow.LOG_MAX, log.length());
    assertEquals(T + 5, log.getJSONObject(0).getLong("at"));
    String d = NoteFlow.details(n, "state", "line | note n1", BERLIN, "app");
    assertTrue(d.contains("failed: HTTP 429"));
    assertTrue(d.contains("line | note n1"));
  }

  @Test
  public void whenSaysTheDayForOlderNotes() {
    assertEquals("13:00", NoteFlow.when(T, T + MIN, BERLIN));
    assertTrue(NoteFlow.when(T - 2 * 24 * 60 * MIN, T, BERLIN).startsWith("9 "));
  }
}
