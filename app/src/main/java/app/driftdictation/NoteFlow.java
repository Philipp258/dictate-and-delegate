package app.driftdictation;

import static app.driftdictation.I18n.tr;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A note's journey, kept on the note itself so nothing lives only in memory: what it is for (its
 * intent: just a dictation, or a request to an assistant's chief), and two steps that each keep
 * their own state, tries and last error: writing it down (transcription), then delivering it to
 * the chief. Everything that moves a note on (the panel, the note page, Retry, the outbox's
 * background tries, the app starting again) reads and writes this state, never a copy in memory.
 *
 * <p>Rules:
 *
 * <ul>
 *   <li>The intent is saved the moment it's chosen (the panel's assistant button, also while
 *       recording), so ✕, a retry from anywhere, Android stopping the app or a restart can't lose
 *       it. Choosing it again, or Don't send, are saved the same way.
 *   <li>A note goes to the chief by itself only while it's fresh: within {@link #AUTO_MS} of the
 *       recording ending, the intent being chosen, or the user tapping Send on it. After that it
 *       waits in {@link Delivery#NEEDS_OK}, visible, until the user reads it and taps Send (or
 *       Don't send). So an old note never goes out hours or days later by itself.
 *   <li>Each note goes once: its request ID is saved before the first try, every try uses it, and
 *       a try after one whose outcome is unknown checks bb first.
 *   <li>Every try of either step is logged on the note ({@link #log}), with its real error.
 * </ul>
 *
 * Hands-free messages are notes too, but they are sent by the call itself; they never enter this
 * flow.
 */
final class NoteFlow {
  private NoteFlow() {}

  /** A note goes to the chief by itself only this long after it was recorded, chosen or confirmed. */
  static final long AUTO_MS = 15 * 60_000L;

  /** A try that started this long ago and never ended (the app was stopped) no longer counts as under way. */
  static final long SENDING_STALE_MS = 3 * 60_000L;

  /** The note's log keeps this many entries, the newest. */
  static final int LOG_MAX = 80;

  // ------------------------------------------------------------------ intent

  /** The user chose to send this note to an assistant's chief (now). Nothing changes once it's sent. */
  static void wantChief(JSONObject n, int assistant, long now) throws Exception {
    if (sent(n)) return;
    n.put("intent", new JSONObject().put("to", "chief").put("assistant", assistant).put("at", now));
    n.remove("intentDropped");
    // Older code and the notes list read these.
    n.put("route", "chief").put("assistant", assistant);
  }

  /**
   * The user took the choice back (a second tap while it's only chosen) or tapped Don't send.
   * False when it can't be taken back any more: sent, or a try is under way.
   */
  static boolean dropChief(JSONObject n, long now) throws Exception {
    if (sent(n) || sending(n, now)) return false;
    n.remove("intent");
    n.put("intentDropped", now);
    n.remove("chiefQueued");
    n.remove("chiefNextTry");
    if (!n.has("chiefRequest")) n.remove("route");
    return true;
  }

  /** The user tapped Send on this note: it goes now, also when it's old, and is tried again for a while. */
  static void confirm(JSONObject n, long now) throws Exception {
    n.put("chiefOkAt", now);
  }

  /** The note is meant for a chief (chosen, or from before intents were saved: it was sent or tried). */
  static boolean meantForChief(JSONObject n) {
    if (n.optBoolean("handsFree")) return false;
    if (n.has("intentDropped") && !n.has("intent")) return false;
    JSONObject intent = n.optJSONObject("intent");
    if (intent != null) return "chief".equals(intent.optString("to"));
    return n.has("chiefThread") || n.has("chiefFailed") || n.has("chiefSending");
  }

  /** The assistant it's meant for: the intent's, else the one it was tried with. */
  static int assistant(JSONObject n) {
    JSONObject intent = n.optJSONObject("intent");
    if (intent != null && intent.has("assistant")) return Assistants.clamp(intent.optInt("assistant"));
    return Assistants.of(n);
  }

  /** When the intent was chosen (0 for notes from before intents were saved). */
  static long chosenAt(JSONObject n) {
    JSONObject intent = n.optJSONObject("intent");
    return intent == null ? 0 : intent.optLong("at");
  }

  /** When the recording ended. */
  static long recordedAt(JSONObject n) {
    return n.optLong("created") + Math.round(n.optDouble("duration", 0) * 1000);
  }

  /** The latest of: the recording ending, the intent being chosen, the user tapping Send. */
  static long anchor(JSONObject n) {
    return Math.max(recordedAt(n), Math.max(chosenAt(n), n.optLong("chiefOkAt")));
  }

  /** Whether it may still go to the chief by itself (see AUTO_MS). */
  static boolean fresh(JSONObject n, long now) {
    long ok = n.optLong("chiefOkAt");
    // Cut off without Stop (the app or the microphone): it may be half a sentence, so it waits for the user.
    if (n.optBoolean("interrupted") && ok == 0) return false;
    // Stop trying: nothing goes on by itself until the user taps Retry or Send.
    if (n.optLong("stoppedAt") > ok) return false;
    return now - anchor(n) <= AUTO_MS;
  }

  // ------------------------------------------------------------------ delivery

  enum Delivery {
    /** Not meant for a chief. */
    NONE,
    /** Meant for a chief; the transcript isn't there yet (being written down, or that failed). */
    NEEDS_TRANSCRIPT,
    /** Goes now. */
    DUE,
    /** A try is under way. */
    SENDING,
    /** A try failed; the next goes by itself at chiefNextTry. */
    WAITING,
    /** Won't go by itself (too old, or the tries ran out): the user's Send sends it. */
    NEEDS_OK,
    SENT
  }

  static boolean sent(JSONObject n) {
    return n.has("chiefThread") && !n.has("chiefFailed") && !n.has("chiefSending");
  }

  static boolean sending(JSONObject n, long now) {
    long at = n.optLong("chiefSending");
    return at > 0 && now - at < SENDING_STALE_MS;
  }

  static boolean transcribed(JSONObject n) {
    return "complete".equals(n.optString("status")) && !n.optString("text").isBlank();
  }

  static Delivery delivery(JSONObject n, long now) {
    if (n.optBoolean("handsFree")) return n.has("chiefThread") ? Delivery.SENT : Delivery.NONE;
    if (sent(n)) return Delivery.SENT;
    if (!meantForChief(n)) return Delivery.NONE;
    if (!transcribed(n)) return Delivery.NEEDS_TRANSCRIPT;
    if (sending(n, now)) return Delivery.SENDING;
    if (!fresh(n, now)) return Delivery.NEEDS_OK;
    if (n.optInt("chiefTries") > 0 && !n.optBoolean("chiefQueued")) return Delivery.NEEDS_OK;
    if (n.optBoolean("chiefQueued") && n.optLong("chiefNextTry") > now) return Delivery.WAITING;
    return Delivery.DUE;
  }

  /** Whether a try may start now: by itself (confirmed false) only when DUE; the user's Send also when waiting or old. */
  static boolean maySend(JSONObject n, long now, boolean confirmed) {
    Delivery d = delivery(n, now);
    return d == Delivery.DUE || confirmed && (d == Delivery.WAITING || d == Delivery.NEEDS_OK);
  }

  /** A try starts: its request ID (the note's first one, kept for every try) is saved before anything goes out. */
  static void beginSend(JSONObject n, String request, int assistant, long now) throws Exception {
    n.put("chiefRequest", request).put("chiefSending", now).put("route", "chief").put("assistant", assistant);
  }

  /** Whether an earlier try may have arrived: then this one checks bb first, so it never arrives twice. */
  static boolean triedBefore(JSONObject n) {
    return !n.optString("chiefRequest").isEmpty();
  }

  /** A try failed (why: plain words with the real error): tried again by itself while fresh, else it waits for Send. */
  static void sendFailed(JSONObject n, String why, long now) throws Exception {
    n.remove("chiefSending");
    int tries = n.optInt("chiefTries") + 1;
    n.put("chiefFailed", why).put("chiefTries", tries).put("chiefFailedAt", n.optLong("chiefFailedAt", now)).put("chiefLastTry", now);
    if (fresh(n, now)) n.put("chiefQueued", true).put("chiefNextTry", now + Outbox.delayMs(tries));
    else {
      n.remove("chiefQueued");
      n.remove("chiefNextTry");
    }
  }

  /** It got there. chiefTries and chiefFailedAt stay, to say it took a while. */
  static void sendDone(JSONObject n, String chief, String link, long now) throws Exception {
    n.remove("chiefSending");
    n.remove("chiefQueued");
    n.remove("chiefNextTry");
    n.remove("chiefFailed");
    n.put("chiefThread", chief).put("chiefLink", link).put("chiefSent", now);
  }

  /**
   * Notes from before 3.8.0 queued to go again by themselves for two days: from now on only fresh
   * ones do. An old queued one stops and waits for the user (NEEDS_OK).
   */
  static boolean settle(JSONObject n, long now) {
    if (!n.optBoolean("chiefQueued") || fresh(n, now)) return false;
    n.remove("chiefQueued");
    n.remove("chiefNextTry");
    return true;
  }

  // ------------------------------------------------------------------ writing it down

  /** A try of writing it down failed for good (why: plain words with the real error). */
  static void speechFailed(JSONObject n, String why, long now) throws Exception {
    n.put("transcribeFailed", why).put("speechFailedAt", n.optLong("speechFailedAt", now)).put("speechLastTry", now);
    n.put("speechTries", n.optInt("speechTries") + 1);
  }

  /** It's written down: the failure goes (the log keeps it). */
  static void speechDone(JSONObject n) {
    n.remove("transcribeFailed");
  }

  // ------------------------------------------------------------------ the note's log

  /**
   * One try of a step, on the note: when, which step ("speech", "bb"), what it went to (a model,
   * "chief"), how long, and the result: "ok", or the error in plain words with the technical
   * detail (HTTP status, the provider's message). Kept on the note for good, unlike the network
   * log, which keeps a week.
   */
  static JSONObject log(JSONObject n, long at, String step, String target, long ms, String error) throws Exception {
    JSONArray log = n.optJSONArray("log");
    if (log == null) n.put("log", log = new JSONArray());
    JSONObject e = new JSONObject().put("at", at).put("step", step).put("target", target == null ? "" : target).put("ms", ms);
    if (error == null) e.put("ok", true);
    else e.put("ok", false).put("error", error);
    log.put(e);
    while (log.length() > LOG_MAX) log.remove(0);
    return e;
  }

  /** The same, for something that happened rather than a try ("intent", "you chose …"). */
  static void event(JSONObject n, long at, String what) throws Exception {
    JSONArray log = n.optJSONArray("log");
    if (log == null) n.put("log", log = new JSONArray());
    log.put(new JSONObject().put("at", at).put("step", "event").put("what", what));
    while (log.length() > LOG_MAX) log.remove(0);
  }

  /**
   * The fields this flow owns besides writing it down: a transcription that runs with its own copy
   * of the note takes them over from the saved note before it saves, so a choice made meanwhile
   * (the assistant button while it's written down) is never overwritten.
   */
  static final String[] OWNED = {
    "intent", "intentDropped", "chiefOkAt", "stoppedAt", "route", "assistant", "chiefRequest", "chiefSending", "chiefTries", "chiefFailed",
    "chiefFailedAt", "chiefLastTry", "chiefQueued", "chiefNextTry", "chiefThread", "chiefLink", "chiefSent", "chiefReply", "chiefReplyAt"
  };

  /** Takes over the OWNED fields (and log entries it lacks) from saved into mine. */
  static void merge(JSONObject mine, JSONObject saved) throws Exception {
    if (saved == null) return;
    for (String k : OWNED) {
      if (saved.has(k)) mine.put(k, saved.get(k));
      else mine.remove(k);
    }
    JSONArray theirs = saved.optJSONArray("log"), own = mine.optJSONArray("log");
    if (theirs == null) return;
    if (own == null) {
      mine.put("log", theirs);
      return;
    }
    // Both added entries: all of them, in time order, once.
    java.util.Map<String, JSONObject> all = new java.util.TreeMap<>();
    for (JSONArray a : new JSONArray[] {theirs, own})
      for (int i = 0; i < a.length(); i++) {
        JSONObject e = a.optJSONObject(i);
        if (e != null) all.put(String.format(Locale.ROOT, "%015d|%s", e.optLong("at"), e.toString()), e);
      }
    JSONArray out = new JSONArray();
    for (JSONObject e : all.values()) out.put(e);
    while (out.length() > LOG_MAX) out.remove(0);
    mine.put("log", out);
  }

  // ------------------------------------------------------------------ in words

  /**
   * Where a note is, in one line: recorded, being written down, written down, going to the chief,
   * sent, or failed at a step and why; problem: it needs the user. to: the chief's name as the
   * user knows it ("your chief of staff", "Personal").
   */
  record Status(String line, boolean problem) {}

  static Status status(JSONObject n, long now, boolean transcribing, boolean audioKept, String to, ZoneId zone) {
    String state = n.optString("status");
    Delivery d = delivery(n, now);
    String failed = n.optString("transcribeFailed");
    boolean forChief = meantForChief(n);
    String prefix = forChief && d != Delivery.SENT ? tr("For %1$s: ", to) : "";
    if (transcribing) return new Status(prefix + tr("being written down…"), false);
    if (!transcribed(n)) {
      if (state.equals("no speech")) return new Status(prefix + tr("no speech was recognized, nothing to send."), forChief);
      if (state.equals("audio discarded")) return new Status(prefix + tr("you discarded the audio; nothing was written down or sent."), false);
      if (!audioKept)
        return new Status(prefix + tr("not written down, and its audio is gone (%1$s).", state.isEmpty() ? "?" : state), true);
      if (!failed.isEmpty()) {
        int tries = n.optInt("speechTries");
        return new Status(
            prefix
                + (tries > 1
                    ? tr("not written down (%1$d rounds of tries, last at %2$s): %3$s The audio is kept.", tries, clock(n.optLong("speechLastTry"), zone), failed)
                    : tr("not written down: %1$s The audio is kept.", failed))
                + (forChief ? " " + tr("It goes to %1$s once it's written down.", to) : ""),
            true);
      }
      return new Status(
          prefix
              + (n.optBoolean("interrupted")
                  ? tr("not written down: the recording was cut off without Stop. The audio is kept.")
                  : tr("not written down yet (the app stopped). The audio is kept.")),
          true);
    }
    return switch (d) {
      case NONE -> new Status(tr("Written down."), false);
      case NEEDS_TRANSCRIPT -> new Status(prefix + tr("waiting for the transcript."), false);
      case SENDING -> new Status(tr("Sending to %1$s…", to), false);
      case DUE -> new Status(tr("Going to %1$s now.", to), false);
      case WAITING ->
          new Status(
              tr("Not sent to %1$s yet (%2$d× tried): %3$s Next try by itself at %4$s.", to, n.optInt("chiefTries"), n.optString("chiefFailed"), clock(n.optLong("chiefNextTry"), zone)),
              true);
      case NEEDS_OK ->
          new Status(
              n.has("chiefFailed")
                  ? tr("Not sent to %1$s (%2$d× tried, last at %3$s): %4$s It doesn't go by itself any more: read it, then Send.", to, n.optInt("chiefTries"), clock(n.optLong("chiefLastTry", n.optLong("chiefFailedAt")), zone), n.optString("chiefFailed"))
                  : tr("Not sent to %1$s: %2$s, so it waits for you. Read it, then Send or Don't send.", to, waitReason(n, now, zone)),
              true);
      case SENT ->
          new Status(
              tr("Sent to %1$s at %2$s", to, when(n.optLong("chiefSent"), now, zone))
                  + (n.optString("chiefRequest").isEmpty() ? "" : " · " + tr("request %1$s", n.optString("chiefRequest")))
                  + (n.optInt("chiefTries") > 0 ? " · " + tr("on try %1$d", n.optInt("chiefTries") + 1) : ""),
              false);
    };
  }

  /** Why a note that wasn't tried doesn't go by itself, in words. */
  static String waitReason(JSONObject n, long now, ZoneId zone) {
    long ok = n.optLong("chiefOkAt");
    if (n.optLong("stoppedAt") > ok) return tr("you stopped it");
    if (n.optBoolean("interrupted") && ok == 0) return tr("the recording was cut off without Stop");
    return tr("it was recorded %1$s", when(recordedAt(n), now, zone));
  }

  /** A short badge for the notes list; null for a plain finished dictation. */
  static String badge(JSONObject n, long now, boolean transcribing, boolean audioKept, String to) {
    if (transcribing) return tr("writing down");
    Delivery d = delivery(n, now);
    String state = n.optString("status");
    if (!transcribed(n)) {
      if (state.equals("no speech")) return tr("no speech");
      String b = audioKept ? (n.has("transcribeFailed") ? tr("failed: writing down") : tr("unfinished")) : tr("audio gone");
      return meantForChief(n) ? (to == null ? b : to + " · " + b) : b;
    }
    String who = to == null ? tr("chief of staff") : to;
    return switch (d) {
      case NONE -> null;
      case NEEDS_TRANSCRIPT, DUE, SENDING -> who + " · " + tr("sending");
      case WAITING -> who + " · " + tr("not sent yet");
      case NEEDS_OK -> who + " · " + tr("not sent");
      case SENT -> who;
    };
  }

  private static String clock(long ms, ZoneId zone) {
    return ms <= 0 ? "?" : DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT).format(Instant.ofEpochMilli(ms).atZone(zone));
  }

  /** "13:06" today, "9 Nov 18:12" before. */
  static String when(long ms, long now, ZoneId zone) {
    if (ms <= 0) return "?";
    java.time.ZonedDateTime t = Instant.ofEpochMilli(ms).atZone(zone), today = Instant.ofEpochMilli(now).atZone(zone);
    return t.toLocalDate().equals(today.toLocalDate())
        ? clock(ms, zone)
        : DateTimeFormatter.ofPattern("d MMM HH:mm", Locale.getDefault()).format(t);
  }

  /**
   * The note's details as text, to read or copy: its state, intent, each step's state, every try
   * in its log, and the network log's lines for it.
   */
  static String details(JSONObject n, String statusLine, String netLines, ZoneId zone, String app) {
    DateTimeFormatter full = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.ROOT).withZone(zone);
    StringBuilder s = new StringBuilder();
    s.append("Note ").append(n.optString("id")).append(" · ").append(app).append('\n');
    s.append("State: ").append(statusLine).append('\n');
    s.append("Recorded: ").append(full.format(Instant.ofEpochMilli(n.optLong("created")))).append(", ")
        .append(String.format(Locale.ROOT, "%.1f s", n.optDouble("duration", 0))).append(", model ").append(n.optString("model")).append('\n');
    JSONObject intent = n.optJSONObject("intent");
    s.append("Meant for: ")
        .append(intent != null ? "chief of assistant " + (intent.optInt("assistant") + 1) + ", chosen " + full.format(Instant.ofEpochMilli(intent.optLong("at")))
            : n.has("intentDropped") ? "nothing (choice taken back " + full.format(Instant.ofEpochMilli(n.optLong("intentDropped"))) + ")"
            : meantForChief(n) ? "chief (from before 3.8.0)" : "just a dictation")
        .append('\n');
    if (n.has("chiefOkAt")) s.append("Send tapped: ").append(full.format(Instant.ofEpochMilli(n.optLong("chiefOkAt")))).append('\n');
    s.append("Writing down: ").append(n.optString("status"));
    if (n.has("transcribeFailed")) s.append(" · failed: ").append(n.optString("transcribeFailed"));
    if (n.has("speechTries")) s.append(" · ").append(n.optInt("speechTries")).append(" failed round(s)");
    s.append('\n');
    if (meantForChief(n) || n.has("chiefRequest")) {
      s.append("Delivery: ").append(delivery(n, System.currentTimeMillis()).name().toLowerCase(Locale.ROOT).replace('_', ' '));
      if (n.has("chiefRequest")) s.append(" · request ").append(n.optString("chiefRequest"));
      if (n.has("chiefTries")) s.append(" · ").append(n.optInt("chiefTries")).append(" failed tries");
      if (n.has("chiefFailed")) s.append(" · last error: ").append(n.optString("chiefFailed"));
      if (n.has("chiefNextTry")) s.append(" · next try ").append(full.format(Instant.ofEpochMilli(n.optLong("chiefNextTry"))));
      if (n.has("chiefSent")) s.append(" · sent ").append(full.format(Instant.ofEpochMilli(n.optLong("chiefSent"))));
      s.append('\n');
    }
    JSONArray log = n.optJSONArray("log");
    s.append("\nSteps and tries (").append(log == null ? 0 : log.length()).append("):\n");
    if (log == null || log.length() == 0) s.append("(none recorded; notes from before 3.8.0 have no step log)\n");
    else
      for (int i = 0; i < log.length(); i++) {
        JSONObject e = log.optJSONObject(i);
        if (e == null) continue;
        s.append(full.format(Instant.ofEpochMilli(e.optLong("at")))).append(" | ");
        if (e.optString("step").equals("event")) s.append(e.optString("what"));
        else {
          s.append(e.optString("step").equals("speech") ? "writing down" : e.optString("step").equals("bb") ? "to the chief" : e.optString("step"))
              .append(" | ").append(e.optString("target"))
              .append(" | ").append(e.optLong("ms")).append(" ms | ")
              .append(e.optBoolean("ok") ? "ok" : "failed: " + e.optString("error"));
        }
        s.append('\n');
      }
    JSONArray steps = n.optJSONArray("steps");
    if (steps != null && steps.length() > 0) s.append("\nActivity steps (cost): ").append(steps).append('\n');
    s.append("\nNetwork log for this note (requests, results, sizes, error bodies; kept a week):\n")
        .append(netLines == null || netLines.isBlank() ? "(none in the log)\n" : netLines);
    return s.toString();
  }
}
