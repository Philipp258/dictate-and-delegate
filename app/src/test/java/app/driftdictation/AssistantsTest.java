package app.driftdictation;

import static org.junit.Assert.*;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Two assistants: their settings kept apart, and each call hearing only its own assistant's replies. */
public class AssistantsTest {
  @Test
  public void theFirstKeepsItsSettingsAndTheSecondHasItsOwn() throws Exception {
    assertEquals("chiefId", Assistants.key(0, "chiefId"));
    assertEquals("a2.chiefId", Assistants.key(1, "chiefId"));
    assertEquals("a2.bbAuth", Assistants.key(1, BbOAuth.TOKENS));
    assertEquals("bb", Assistants.logName(0));
    assertEquals("bb2", Assistants.logName(1));
    assertEquals(0, Assistants.clamp(-3));
    assertEquals(1, Assistants.clamp(7));
    assertNotEquals(Assistants.color(0), Assistants.color(1));
    assertNotEquals(Assistants.bright(0), Assistants.bright(1));
    // Notes from before 3.7.0 went to the first.
    assertEquals(0, Assistants.of(new JSONObject()));
    assertEquals(1, Assistants.of(new JSONObject().put("assistant", 1)));
  }

  /**
   * A call with the first assistant reads only that assistant's topic. The second assistant's chief
   * answering on its own topic, even with the call's request ID (or for a note sent to it), is
   * never spoken in this call; the first's reply is.
   */
  @Test
  public void aReplyFromTheSecondAssistantIsNotSpokenInACallWithTheFirst() throws Exception {
    Map<String, List<String>> topics = new ConcurrentHashMap<>();
    topics.put("talkrouter-personal", new CopyOnWriteArrayList<>());
    topics.put("talkrouter-work", new CopyOnWriteArrayList<>());
    // A small ntfy: GET /<topic>/json answers the topic's messages, one JSON per line, then closes.
    ServerSocket ntfy = new ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress());
    Thread serving =
        new Thread(
            () -> {
              while (!ntfy.isClosed()) {
                try (Socket c = ntfy.accept()) {
                  BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                  String first = in.readLine();
                  for (String l = first; l != null && !l.isEmpty(); l = in.readLine()) {}
                  String path = first == null ? "" : first.split(" ")[1].replaceFirst("\\?.*$", "");
                  List<String> lines = topics.get(path.replaceFirst("^/", "").replaceFirst("/json$", ""));
                  StringBuilder body = new StringBuilder();
                  if (lines != null) for (String l : lines) body.append(l).append("\n");
                  byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
                  OutputStream out = c.getOutputStream();
                  out.write(((lines == null ? "HTTP/1.1 404 Not Found" : "HTTP/1.1 200 OK") + "\r\nContent-Type: application/json\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                  out.write(b);
                  out.flush();
                } catch (Exception ex) {
                  /* Closed. */
                }
              }
            });
    serving.setDaemon(true);
    serving.start();
    String server = "http://127.0.0.1:" + ntfy.getLocalPort();
    // Assistant 2 (work) answers first: to a work note, and once even tagged with the call's request.
    topics.get("talkrouter-work").add(speak("w1", "workq1", "The work build is green."));
    topics.get("talkrouter-work").add(speak("w2", "callq1", "Work: the deploy is done."));
    topics.get("talkrouter-personal").add(speak("p1", "callq1", "The table is booked for eight."));
    List<String> spoken = new CopyOnWriteArrayList<>();
    // The call with assistant 1: its topic, its requests (what HandsFreeService starts for a call).
    ChiefText.Replies replies =
        new ChiefText.Replies(server, "talkrouter-personal", 0, r -> r.equals("callq1"), (request, text, at, untagged) -> spoken.add(text));
    replies.start();
    try {
      long until = System.currentTimeMillis() + 10_000;
      while (spoken.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(50);
      Thread.sleep(500); // Anything else would have come by now.
      assertEquals(List.of("The table is booked for eight."), spoken);
    } finally {
      replies.finish();
      ntfy.close();
    }
  }

  private static String speak(String id, String request, String text) throws Exception {
    return new JSONObject()
        .put("id", id)
        .put("event", "message")
        .put("time", 1_800_000_000L)
        .put("message", text)
        .put("tags", new JSONArray().put(ChiefText.SPEAK_TAG).put("req-" + request))
        .toString();
  }

  @Test
  public void eachAssistantsReportHoldsOnlyItsOwnBbLines() {
    String log =
        "2026-11-06T09:00:00.000+01:00 | bb tell chief | req abc123 | POST https://philipp.getbb.app/mcp | 200 | 900 ms\n"
            + "2026-11-06T09:00:01.000+01:00 | bb2 tell chief | req wrk001 | POST https://acme.getbb.app/mcp | 502 | 300 ms\n"
            + "2026-11-06T09:00:02.000+01:00 | bb sign-in setup | GET https://acme.getbb.app/.well-known/oauth-protected-resource/mcp | 200\n"
            + "2026-11-06T09:00:03.000+01:00 | transcribe | POST https://openrouter.ai/api/v1/audio/transcriptions | 200 | 2100 ms\n";
    String personal = Outbox.ownLines(log, 0, List.of("acme.getbb.app"));
    assertTrue(personal.contains("req abc123"));
    assertTrue(personal.contains("transcribe"));
    assertFalse(personal.contains("bb2 tell"));
    assertFalse(personal.contains("acme"));
    String work = Outbox.ownLines(log, 1, List.of("philipp.getbb.app"));
    assertTrue(work.contains("bb2 tell chief"));
    assertTrue(work.contains("transcribe"));
    assertFalse(work.contains("req abc123"));
  }

  @Test
  public void failuresGoToTheirAssistantAndTheRestToTheFirstThatTakesMessages() throws Exception {
    JSONArray list = new JSONArray();
    Outbox.addFailure(list, "chief:abc123", "chief", "Note to you, request abc123", "HTTP 502", 0, 1000);
    Outbox.addFailure(list, "chief:wrk001", "chief", "Note to you, request wrk001", "HTTP 502", 1, 1000);
    Outbox.addFailure(list, "recording:n1", "recording", "Recording", "timeout", Outbox.NONE, 1000);
    // Both take messages: each its own; the recording to the first.
    assertEquals(2, Outbox.forAssistant(list, 0, 0).length());
    assertEquals(1, Outbox.forAssistant(list, 1, 0).length());
    assertEquals("chief:wrk001", Outbox.forAssistant(list, 1, 0).getJSONObject(0).getString("key"));
    // Only the second takes messages: the recording goes there.
    assertEquals(1, Outbox.forAssistant(list, 0, 1).length());
    assertEquals(2, Outbox.forAssistant(list, 1, 1).length());
  }

  @Test
  public void theSameBbIsRecognisedWhateverTheSlashOrCase() {
    assertTrue(Assistants.sameAddress("https://bb.tail.ts.net/mcp/", "HTTPS://bb.tail.ts.net/mcp"));
    assertFalse(Assistants.sameAddress("https://bb.tail.ts.net/mcp", "https://work.tail.ts.net/mcp"));
  }
}
