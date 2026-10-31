package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What hasn't reached the chief yet, and what went wrong on the way. A note whose send failed
 * stays queued (in the note: chiefQueued, chiefTries, chiefNextTry) and is sent again by itself,
 * further apart each time (delayMs), also after the app restarts or the phone had no network: a
 * job that needs a network does it. The same request ID goes each time, and a try after one that
 * may have arrived checks first, so the chief never gets a note twice.
 *
 * <p>Failures (a note not sent, a hands-free message not sent, a recording not transcribed) are
 * kept, and once bb takes a message again they go to the chief as one "[app failure report]",
 * with the network log around them, so it can find out why. Send report does that at once.
 */
final class Outbox {
  private Outbox() {}

  /** A note's first try failed this long ago: no more tries by itself (Retry still works). */
  static final long GIVE_UP_MS = 48 * 3600_000L;

  /** The failures kept for the next report, at most. */
  static final int FAILURES_MAX = 20;

  /** Network log lines in a report, at most, and how far before the first failure they start. */
  static final int LOG_LINES = 80;

  static final long LOG_BEFORE_MS = 2 * 60_000L;

  /** The wait before try number tries + 1: 15 s, 30 s, 1, 2, 5, 10 min, then every 15 min. */
  static long delayMs(int tries) {
    long[] steps = {15_000, 30_000, 60_000, 120_000, 300_000, 600_000};
    return tries <= 0 ? 0 : tries <= steps.length ? steps[tries - 1] : 900_000;
  }

  // ------------------------------------------------------------------ a note's state

  enum State {
    /** Not a note for the chief, or it got there. */
    NONE,
    SENT,
    /** Not there yet: tried again by itself. */
    RETRYING,
    /** Not there, and not tried again by itself (given up, or from before 3.3.6). */
    FAILED
  }

  static State state(JSONObject note) {
    if (note.has("chiefThread") && !note.has("chiefFailed")) return State.SENT;
    if (!note.has("chiefFailed")) return State.NONE;
    return note.optBoolean("chiefQueued") ? State.RETRYING : State.FAILED;
  }

  /** A send of the note failed (its try number tries) at now: queued again, or given up. */
  static void failed(JSONObject note, String why, int tries, long now) throws Exception {
    long first = note.optLong("chiefFailedAt", now);
    note.put("chiefFailed", why).put("chiefTries", tries).put("chiefFailedAt", first);
    if (now - first < GIVE_UP_MS) note.put("chiefQueued", true).put("chiefNextTry", now + delayMs(tries));
    else note.remove("chiefQueued");
    if (!note.optBoolean("chiefQueued")) note.remove("chiefNextTry");
  }

  /** It got there: the queue's fields go; chiefTries and chiefFailedAt stay to say it took a while. */
  static void sent(JSONObject note) {
    note.remove("chiefQueued");
    note.remove("chiefNextTry");
    note.remove("chiefFailed");
  }

  /** The note is queued and its next try is due at now. */
  static boolean due(JSONObject note, long now) {
    return note.optBoolean("chiefQueued") && note.optLong("chiefNextTry", 0) <= now;
  }

  // ------------------------------------------------------------------ failures

  /**
   * Keeps a failure for the next report: one entry per key (a request, or "recording"), with when
   * it first and last failed, how often and the last reason. At most FAILURES_MAX, oldest out.
   */
  static JSONArray addFailure(JSONArray list, String key, String kind, String what, String why, long now) throws Exception {
    for (int i = 0; i < list.length(); i++) {
      JSONObject f = list.getJSONObject(i);
      if (f.optString("key").equals(key) && !f.has("resolved")) {
        f.put("last", now).put("count", f.optInt("count", 1) + 1).put("why", why);
        return list;
      }
    }
    list.put(new JSONObject().put("key", key).put("kind", kind).put("what", what).put("why", why).put("first", now).put("last", now).put("count", 1));
    while (list.length() > FAILURES_MAX) list.remove(0);
    return list;
  }

  /** The failure with this key worked in the end, at now (the report says so). */
  static void resolve(JSONArray list, String key, long now) throws Exception {
    for (int i = 0; i < list.length(); i++) {
      JSONObject f = list.getJSONObject(i);
      if (f.optString("key").equals(key) && !f.has("resolved")) f.put("resolved", now);
    }
  }

  /** The first failure's time in the list; now without one. */
  static long firstFailure(JSONArray list, long now) {
    long first = now;
    for (int i = 0; i < list.length(); i++) first = Math.min(first, list.optJSONObject(i).optLong("first", now));
    return first;
  }

  static final String LABEL = "[app failure report]";

  /**
   * The report for the chief: the label, what failed and when, the network log from shortly
   * before the first failure until now, and the report's ID (so a try that may have arrived
   * isn't sent twice). Never keys, tokens or what was said.
   */
  static String report(String app, JSONArray failures, String log, long now, ZoneId zone, String id) {
    DateTimeFormatter time = DateTimeFormatter.ofPattern("HH:mm:ss", Locale.ROOT).withZone(zone);
    DateTimeFormatter offset = DateTimeFormatter.ofPattern("xxx", Locale.ROOT).withZone(zone);
    StringBuilder s =
        new StringBuilder(LABEL)
            .append(" ")
            .append(app)
            .append(failures.length() == 1 ? ": something went wrong" : ": " + failures.length() + " things went wrong")
            .append(", and this report got through now. Find out why if you can, and fix what's on bb's side; tell me only if I need to do something.\n\nWhat failed (times ")
            .append(zone.getId())
            .append(", UTC")
            .append(offset.format(Instant.ofEpochMilli(now)))
            .append("):");
    for (int i = 0; i < failures.length(); i++) {
      JSONObject f = failures.optJSONObject(i);
      long first = f.optLong("first"), last = f.optLong("last", first);
      int count = f.optInt("count", 1);
      s.append("\n• ").append(f.optString("what")).append(": ");
      if (f.optString("kind").equals("asked")) s.append("I tapped Send report at ").append(time.format(Instant.ofEpochMilli(first)));
      else {
        s.append(count == 1 ? "failed at " : "failed " + count + "× from ").append(time.format(Instant.ofEpochMilli(first)));
        if (count > 1) s.append(" to ").append(time.format(Instant.ofEpochMilli(last)));
        if (f.has("resolved")) s.append(", went through at ").append(time.format(Instant.ofEpochMilli(f.optLong("resolved"))));
        else if (f.optString("kind").equals("chief")) s.append(", still queued");
      }
      String why = f.optString("why");
      if (!why.isEmpty()) s.append(f.optString("kind").equals("asked") ? ": " : ". Last error: ").append(why);
    }
    List<String> lines = excerpt(log, firstFailure(failures, now) - LOG_BEFORE_MS, LOG_LINES);
    s.append("\n\nNetwork log from ")
        .append(time.format(Instant.ofEpochMilli(firstFailure(failures, now) - LOG_BEFORE_MS)))
        .append(" (")
        .append(lines.size())
        .append(lines.size() == 1 ? " line" : " lines")
        .append("; when each request started, what, request, target, result, duration, retry, sizes, network):\n");
    s.append(lines.isEmpty() ? "(no entries)" : String.join("\n", lines));
    s.append("\n\nReport ID: r-").append(id);
    return s.toString();
  }

  /** The log's lines from the time from on, the last max of them (each at most 400 characters). */
  static List<String> excerpt(String log, long from, int max) {
    List<String> out = new ArrayList<>();
    for (String line : log.split("\n")) {
      long t = NetLog.time(line);
      if (t < 0 || t < from) continue;
      out.add(line.length() > 400 ? line.substring(0, 400) + "…" : line);
    }
    return out.size() <= max ? out : new ArrayList<>(out.subList(out.size() - max, out.size()));
  }

  // ------------------------------------------------------------------ on the phone

  private static final String PREFS = "outbox", FAILURES = "failures", REPORT_TRIES = "reportTries", REPORT_NEXT = "reportNext";

  private static final Object LOCK = new Object();

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static JSONArray failures(Context context) {
    try {
      return new JSONArray(prefs(context).getString(FAILURES, "[]"));
    } catch (Exception ex) {
      return new JSONArray();
    }
  }

  /** Keeps a failure for the next report (see addFailure), and makes sure a try is scheduled. */
  static void failure(Context context, String key, String kind, String what, String why) {
    synchronized (LOCK) {
      try {
        JSONArray list = addFailure(failures(context), key, kind, what, why, System.currentTimeMillis());
        prefs(context).edit().putString(FAILURES, list.toString()).apply();
      } catch (Exception ignored) {
        /* The report is a help, not a must. */
      }
    }
    schedule(context, delayMs(1));
  }

  /** The failure with this key went through in the end. */
  static void resolved(Context context, String key) {
    synchronized (LOCK) {
      try {
        JSONArray list = failures(context);
        resolve(list, key, System.currentTimeMillis());
        prefs(context).edit().putString(FAILURES, list.toString()).apply();
      } catch (Exception ignored) {
        /* As above. */
      }
    }
  }

  /** Failures waiting for the next report. */
  static int failuresWaiting(Context context) {
    return failures(context).length();
  }

  /** Send report: the note's failure goes to the chief now, or as soon as bb takes it. */
  static void askReport(Context context, String what, String why) {
    String key = "asked:" + System.currentTimeMillis();
    synchronized (LOCK) {
      try {
        JSONArray list = addFailure(failures(context), key, "asked", what, why, System.currentTimeMillis());
        prefs(context).edit().putString(FAILURES, list.toString()).putInt(REPORT_TRIES, 0).putLong(REPORT_NEXT, 0).apply();
      } catch (Exception ignored) {
        /* As above. */
      }
    }
  }

  /** Something reached bb: what's waiting goes now (in the background). */
  static void worked(Context context) {
    Context app = context.getApplicationContext();
    new Thread(() -> flush(app, true), "outbox").start();
  }

  /**
   * The app started: what's waiting gets a try soon (when there's a network). Not when a try is
   * scheduled already: scheduling it again would stop it if it's running (the app may have
   * started for it).
   */
  static void kick(Context context) {
    JobScheduler js = context.getSystemService(JobScheduler.class);
    if (js != null && js.getPendingJob(JOB) != null) return;
    if (waiting(context) || failuresWaiting(context) > 0) schedule(context, 0);
  }

  /** Notes queued for the chief. */
  static boolean waiting(Context context) {
    return !queued(context).isEmpty();
  }

  /** The recordings of the queued notes: their attachments are kept until they're sent. */
  static java.util.Set<String> queuedRecordings(Context context) {
    java.util.Set<String> out = new java.util.HashSet<>();
    for (HistoryEntry e : queued(context)) out.add(e.recordingId());
    return out;
  }

  private static List<HistoryEntry> queued(Context context) {
    List<HistoryEntry> out = new ArrayList<>();
    for (HistoryEntry e : recent(context)) if (e.json.optBoolean("chiefQueued")) out.add(e);
    return out;
  }

  private static List<HistoryEntry> recent(Context context) {
    synchronized (DictationService.NOTES) {
      try (HistoryStore h = new HistoryStore(context)) {
        return h.list(300, 0);
      } catch (Exception ex) {
        return List.of();
      }
    }
  }

  private static volatile boolean flushing;

  /**
   * Sends the queued notes that are due (all: every queued one, as bb just took something), then,
   * if none of them failed, the failure report. Schedules the next try. Returns whether all went.
   */
  static boolean flush(Context context, boolean all) {
    synchronized (LOCK) {
      if (flushing) return false;
      flushing = true;
    }
    try {
      long now = System.currentTimeMillis();
      boolean failed = false, went = all;
      // Once one went, bb takes messages again: the rest go too, also those not due yet.
      for (int pass = 0; pass < 2 && !failed; pass++)
        for (HistoryEntry e : queued(context)) {
          if (!went && !due(e.json, now)) continue;
          if (DictationService.sendNote(context, e.id()) != null) {
            failed = true;
            break; // bb can't be reached: the others wait for the next try.
          }
          went = true;
        }
      if (!failed) failed = !sendReport(context, went);
      return !failed;
    } finally {
      flushing = false;
      scheduleNext(context);
    }
  }

  /** Sends the failure report, if there's one and it's due. False when it couldn't be sent. */
  static boolean sendReport(Context context, boolean force) {
    JSONArray list;
    synchronized (LOCK) {
      list = failures(context);
      if (list.length() == 0) return true;
      if (!force && prefs(context).getLong(REPORT_NEXT, 0) > System.currentTimeMillis()) return true;
    }
    BbBridge bb = new BbBridge(context);
    // Nobody to tell yet, or a call is on (the chief would read it out): kept for later.
    boolean call = HandsFreeService.instance != null;
    if (!bb.connected() || bb.chiefId().isEmpty() || call) {
      prefs(context).edit().putLong(REPORT_NEXT, System.currentTimeMillis() + (call ? 5 * 60_000L : 15 * 60_000L)).apply();
      return true;
    }
    String id = prefs(context).getString("reportId", "");
    if (id.isEmpty()) {
      id = ChiefText.requestId();
      prefs(context).edit().putString("reportId", id).apply();
    }
    String text = report(appName(), list, NetLog.read(), System.currentTimeMillis(), ZoneId.systemDefault(), id);
    try {
      bb.tell(bb.chiefId(), text, List.of(), true);
    } catch (Exception ex) {
      synchronized (LOCK) {
        int tries = prefs(context).getInt(REPORT_TRIES, 0) + 1;
        prefs(context).edit().putInt(REPORT_TRIES, tries).putLong(REPORT_NEXT, System.currentTimeMillis() + delayMs(tries)).apply();
      }
      return false;
    }
    synchronized (LOCK) {
      // Only what the report held goes; a failure kept meanwhile waits for the next.
      JSONArray now = failures(context), left = new JSONArray();
      java.util.Set<String> reported = new java.util.HashSet<>();
      for (int i = 0; i < list.length(); i++) reported.add(list.optJSONObject(i).optString("key") + "@" + list.optJSONObject(i).optLong("last"));
      for (int i = 0; i < now.length(); i++) {
        JSONObject f = now.optJSONObject(i);
        if (!reported.contains(f.optString("key") + "@" + f.optLong("last"))) left.put(f);
      }
      prefs(context).edit().putString(FAILURES, left.toString()).remove(REPORT_TRIES).remove(REPORT_NEXT).remove("reportId").apply();
    }
    return true;
  }

  static String appName() {
    return "Dictate & Delegate " + BuildConfig.VERSION_NAME + " (Android " + android.os.Build.VERSION.RELEASE + ")";
  }

  /** The next try: the earliest queued note's, or the report's. */
  private static void scheduleNext(Context context) {
    long now = System.currentTimeMillis(), next = Long.MAX_VALUE;
    List<HistoryEntry> notes = queued(context);
    for (HistoryEntry e : notes) next = Math.min(next, e.json.optLong("chiefNextTry", now));
    // The report goes after the notes, when one of them got through; alone, at its own time.
    if (notes.isEmpty() && failuresWaiting(context) > 0) next = Math.max(now, prefs(context).getLong(REPORT_NEXT, now));
    if (next != Long.MAX_VALUE) schedule(context, Math.max(0, next - now));
  }

  static final int JOB = 4711;

  /** A try in delay ms, once there's a network; survives restarts. Replaces the one scheduled. */
  static void schedule(Context context, long delay) {
    try {
      JobScheduler js = context.getSystemService(JobScheduler.class);
      if (js == null) return;
      js.schedule(
          new JobInfo.Builder(JOB, new ComponentName(context, Job.class))
              .setMinimumLatency(delay)
              .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
              .setPersisted(true)
              .build());
    } catch (RuntimeException ignored) {
      /* The next start of the app tries again. */
    }
  }

  /** The job: flushes in the background; scheduleNext sets the next one. */
  public static final class Job extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
      new Thread(
              () -> {
                try {
                  flush(getApplicationContext(), false);
                } finally {
                  jobFinished(params, false);
                }
              },
              "outbox-job")
          .start();
      return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
      return true;
    }
  }

  /** The note page's line about a note that isn't there yet. */
  static String waitingLine(JSONObject note, long now) {
    int tries = note.optInt("chiefTries", 1);
    long next = note.optLong("chiefNextTry", now);
    long minutes = Math.max(0, (next - now + 59_999) / 60_000);
    return next <= now
        ? tr("Dictate & Delegate keeps it and sends it again by itself (tried %1$d×, next try now).", tries)
        : minutes <= 1
            ? tr("Dictate & Delegate keeps it and sends it again by itself (tried %1$d×, next try within a minute).", tries)
            : tr("Dictate & Delegate keeps it and sends it again by itself (tried %1$d×, next try in %2$d minutes).", tries, minutes);
  }
}
