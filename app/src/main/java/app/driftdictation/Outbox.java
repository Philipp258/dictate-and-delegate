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
 * What hasn't reached the chief yet, and what went wrong on the way. The notes' own state
 * (NoteFlow) says what's due: a note whose send failed is sent again by itself, further apart each
 * time (delayMs), also after the app restarts or the phone had no network (a job that needs a
 * network does it), but only while it's fresh (NoteFlow.AUTO_MS); after that it waits for the
 * user, who gets a notification. The same request ID goes each time, and a try after one that may
 * have arrived checks first, so the chief never gets a note twice.
 *
 * <p>Failures (a note not sent, a hands-free message not sent, a recording not transcribed) are
 * kept, and once bb takes a message again they go to the chief as one "[app failure report]",
 * with the network log around them, so it can find out why. Send report does that at once.
 *
 * <p>Each note and failure remembers its assistant (Assistants): a queued note goes to the bb it
 * was meant for, also days later, and its failure is reported to that assistant's chief. A
 * failure that belongs to none (a recording) goes to the first assistant that takes messages.
 * One assistant's bb being down never holds up the other's notes.
 */
final class Outbox {
  private Outbox() {}

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

  // ------------------------------------------------------------------ failures

  /**
   * Keeps a failure for the next report: one entry per key (a request, or "recording"), with when
   * it first and last failed, how often and the last reason. At most FAILURES_MAX, oldest out.
   */
  static JSONArray addFailure(JSONArray list, String key, String kind, String what, String why, long now) throws Exception {
    return addFailure(list, key, kind, what, why, NONE, now);
  }

  /** The same, for an assistant's note or call (NONE: it belongs to no assistant, like a recording). */
  static JSONArray addFailure(JSONArray list, String key, String kind, String what, String why, int assistant, long now) throws Exception {
    for (int i = 0; i < list.length(); i++) {
      JSONObject f = list.getJSONObject(i);
      if (f.optString("key").equals(key) && !f.has("resolved")) {
        f.put("last", now).put("count", f.optInt("count", 1) + 1).put("why", why);
        return list;
      }
    }
    JSONObject f = new JSONObject().put("key", key).put("kind", kind).put("what", what).put("why", why).put("first", now).put("last", now).put("count", 1);
    if (assistant != NONE) f.put("assistant", assistant);
    list.put(f);
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

  /** A failure that belongs to no assistant (a recording): it goes to the first that takes messages. */
  static final int NONE = -1;

  /**
   * The failures an assistant's chief is told about: its own, and, when it's the first that can
   * get messages (first), those that belong to none.
   */
  static JSONArray forAssistant(JSONArray list, int assistant, int first) {
    JSONArray out = new JSONArray();
    for (int i = 0; i < list.length(); i++) {
      JSONObject f = list.optJSONObject(i);
      int owner = f.has("assistant") ? f.optInt("assistant") : NONE;
      if (owner == assistant || owner == NONE && assistant == first) out.put(f);
    }
    return out;
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

  /**
   * The log's lines from the time from on, the last max of them (each at most 1200 characters). A
   * line is stamped when its request started, so one still running at from counts too: a request
   * that hung for minutes before it failed was left out of the report.
   */
  static List<String> excerpt(String log, long from, int max) {
    List<String> out = new ArrayList<>();
    for (String line : log.split("\n")) {
      long t = NetLog.time(line);
      if (t < 0) continue;
      if (t < from && t + Math.max(0, NetLog.duration(line)) < from) continue;
      out.add(line.length() > 1200 ? line.substring(0, 1200) + "…" : line);
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
    failure(context, key, kind, what, why, NONE);
  }

  /** The same, for an assistant's note or call: reported to that assistant's chief. */
  static void failure(Context context, String key, String kind, String what, String why, int assistant) {
    synchronized (LOCK) {
      try {
        JSONArray list = addFailure(failures(context), key, kind, what, why, assistant, System.currentTimeMillis());
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

  /**
   * An assistant was removed: its notes still waiting aren't tried any more (they stay, not sent)
   * and its failures go.
   */
  static void forget(Context context, int assistant) {
    for (HistoryEntry e : queued(context)) {
      if (NoteFlow.assistant(e.json) != assistant) continue;
      try {
        DictationService.update(context, e.id(), n -> {
          long now = System.currentTimeMillis();
          NoteFlow.dropChief(n.json, now);
          NoteFlow.event(n.json, now, "its assistant was removed; not sent");
        });
      } catch (Exception ignored) {
        /* Deleted meanwhile. */
      }
    }
    synchronized (LOCK) {
      JSONArray list = failures(context), left = new JSONArray();
      for (int i = 0; i < list.length(); i++) {
        JSONObject f = list.optJSONObject(i);
        if (!f.has("assistant") || f.optInt("assistant") != assistant) left.put(f);
      }
      prefs(context).edit().putString(FAILURES, left.toString()).remove(Assistants.key(assistant, REPORT_TRIES)).remove(Assistants.key(assistant, REPORT_NEXT)).remove(Assistants.key(assistant, "reportId")).apply();
    }
  }

  /** Failures waiting for the next report. */
  static int failuresWaiting(Context context) {
    return failures(context).length();
  }

  /** Send report: the note's failure goes to its assistant's chief now, or as soon as bb takes it. */
  static void askReport(Context context, String what, String why, int assistant) {
    String key = "asked:" + System.currentTimeMillis();
    synchronized (LOCK) {
      try {
        JSONArray list = addFailure(failures(context), key, "asked", what, why, assistant, System.currentTimeMillis());
        SharedPreferences.Editor edit = prefs(context).edit().putString(FAILURES, list.toString());
        for (int a = 0; a < Assistants.COUNT; a++) edit.putInt(Assistants.key(a, REPORT_TRIES), 0).putLong(Assistants.key(a, REPORT_NEXT), 0);
        edit.apply();
      } catch (Exception ignored) {
        /* As above. */
      }
    }
  }

  /**
   * Something reached an assistant's bb: what's waiting for it goes now (in the background). The
   * other assistant's notes keep their own times: its bb may still be down.
   */
  static void worked(Context context, int assistant) {
    Context app = context.getApplicationContext();
    new Thread(() -> flush(app, assistant), "outbox").start();
  }

  /** flush's force: every assistant's notes and reports now (Send report), or none (by their times). */
  static final int ALL = -2, DUE = -1;

  /**
   * The app started: what's waiting gets a try soon (when there's a network). Not when a try is
   * scheduled already: scheduling it again would stop it if it's running (the app may have
   * started for it).
   */
  static void kick(Context context) {
    JobScheduler js = context.getSystemService(JobScheduler.class);
    if (js != null && js.getPendingJob(JOB) != null) return;
    // Also for notes that wait for the transcript or the user: one may need its notification.
    if (waiting(context) || failuresWaiting(context) > 0 || !queuedRecordings(context).isEmpty()) schedule(context, 0);
  }

  /** Notes queued for the chief. */
  static boolean waiting(Context context) {
    return !queued(context).isEmpty();
  }

  /** The recordings of the queued notes: their attachments are kept until they're sent. */
  static java.util.Set<String> queuedRecordings(Context context) {
    java.util.Set<String> out = new java.util.HashSet<>();
    long now = System.currentTimeMillis();
    // Also those that wait for the transcript or for the user's Send: they may still go.
    for (HistoryEntry e : recent(context)) {
      NoteFlow.Delivery d = NoteFlow.delivery(e.json, now);
      if (d != NoteFlow.Delivery.NONE && d != NoteFlow.Delivery.SENT) out.add(e.recordingId());
    }
    return out;
  }

  /** A note meant for a chief whose writing down nothing does any more (the app was stopped mid-way), not told yet. */
  private static boolean cutOff(Context context, HistoryEntry e, long now) {
    return NoteFlow.meantForChief(e.json)
        && e.json.optString("status").equals("pending")
        && !e.json.has("speechAskedAt")
        && !DictationService.transcribing(e.id())
        && DictationService.recording(context, e.id()).exists()
        && now - e.created() < 2 * 24 * 3600_000L;
  }

  /** Notes on their way to a chief that the outbox may send: due now, or waiting for their next try. */
  private static List<HistoryEntry> queued(Context context) {
    List<HistoryEntry> out = new ArrayList<>();
    long now = System.currentTimeMillis();
    for (HistoryEntry e : recent(context)) {
      NoteFlow.Delivery d = NoteFlow.delivery(e.json, now);
      if (d == NoteFlow.Delivery.DUE || d == NoteFlow.Delivery.WAITING) out.add(e);
    }
    return out;
  }

  /**
   * Notes that stopped going by themselves (too old, or the window ran out while it failed): told
   * once, as a notification. Old queued ones from before 3.8.0 stop here too.
   */
  private static void settle(Context context) {
    long now = System.currentTimeMillis();
    for (HistoryEntry e : recent(context)) {
      if (cutOff(context, e, now)) {
        // Meant for a chief, being written down when Android stopped the app: say so.
        try {
          DictationService.update(context, e.id(), n -> {
            n.json.put("speechAskedAt", now);
            NoteFlow.event(n.json, now, "writing it down was cut off (the app was stopped); told you");
          });
          Problems.notWritten(context, e, tr("The app was stopped while it was being written down."));
        } catch (Exception ignored) {
          /* Deleted meanwhile. */
        }
        continue;
      }
      if (e.json.optBoolean("handsFree") || e.json.has("chiefAskedAt") || !NoteFlow.meantForChief(e.json) || NoteFlow.sent(e.json)) continue;
      boolean settled = e.json.optBoolean("chiefQueued") && !NoteFlow.fresh(e.json, now);
      if (!settled && NoteFlow.delivery(e.json, now) != NoteFlow.Delivery.NEEDS_OK) continue;
      // Notes from long ago (before 3.8.0) stay quiet: the notes list shows them as not sent.
      long last = Math.max(NoteFlow.anchor(e.json), Math.max(e.json.optLong("chiefLastTry"), e.json.optLong("chiefFailedAt")));
      if (now - last > 2 * 24 * 3600_000L) continue;
      try {
        DictationService.update(context, e.id(), n -> {
          NoteFlow.settle(n.json, now);
          n.json.put("chiefAskedAt", now);
          NoteFlow.event(n.json, now, "stopped going by itself; waits for you");
        });
        HistoryEntry fresh = DictationService.load(context, e.id());
        if (fresh != null && NoteFlow.transcribed(fresh.json)) {
          if (fresh.json.has("chiefFailed")) Problems.notSent(context, fresh, fresh.json.optString("chiefFailed") + " " + tr("It doesn't go by itself any more."));
          else Problems.waitsForYou(context, fresh);
        }
      } catch (Exception ignored) {
        /* Deleted meanwhile. */
      }
    }
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
   * Sends the queued notes that are due (all: every queued one, as bb just took something), each
   * to its own assistant, then, for each assistant none of whose notes failed, its failure report.
   * Schedules the next try. Returns whether all went.
   */
  static boolean flush(Context context, boolean all) {
    return flush(context, all ? ALL : DUE);
  }

  /** The same, forcing one assistant's (its bb just took something), ALL or DUE. */
  static boolean flush(Context context, int force) {
    synchronized (LOCK) {
      if (flushing) return false;
      flushing = true;
    }
    try {
      long now = System.currentTimeMillis();
      boolean[] failed = new boolean[Assistants.COUNT], went = new boolean[Assistants.COUNT];
      for (int a = 0; a < Assistants.COUNT; a++) went[a] = force == ALL || force == a;
      // Once one went, that bb takes messages again: the rest for it go too, also those not due
      // yet. One that can't be reached holds up only its own notes.
      settle(context);
      for (int pass = 0; pass < 2; pass++)
        for (HistoryEntry e : queued(context)) {
          int a = NoteFlow.assistant(e.json);
          boolean due = NoteFlow.delivery(e.json, now) == NoteFlow.Delivery.DUE;
          if (failed[a] || !went[a] && !due) continue;
          String why = DictationService.sendNote(context, e.id(), -1, went[a] ? DictationService.Send.NOW : DictationService.Send.AUTO);
          if (why != null) failed[a] = true; // The others for it wait for the next try.
          else went[a] = true;
        }
      boolean ok = true;
      for (int a = 0; a < Assistants.COUNT; a++) {
        if (failed[a]) ok = false;
        else if (!sendReport(context, a, went[a])) ok = false;
      }
      return ok;
    } finally {
      flushing = false;
      scheduleNext(context);
    }
  }

  /** Sends each assistant's failure report that is there and due. False when one couldn't be sent. */
  static boolean sendReport(Context context, boolean force) {
    boolean ok = true;
    for (int a = 0; a < Assistants.COUNT; a++) ok &= sendReport(context, a, force);
    return ok;
  }

  /** The first assistant whose chief can get messages; failures of none go to it (the first assistant's wait while none can). */
  private static int firstReady(Context context) {
    List<Integer> ready = Assistants.ready(context);
    return ready.isEmpty() ? 0 : ready.get(0);
  }

  /** Sends an assistant's failure report, if there's one and it's due. False when it couldn't be sent. */
  static boolean sendReport(Context context, int assistant, boolean force) {
    JSONArray list;
    String next = Assistants.key(assistant, REPORT_NEXT), triesKey = Assistants.key(assistant, REPORT_TRIES), idKey = Assistants.key(assistant, "reportId");
    synchronized (LOCK) {
      list = forAssistant(failures(context), assistant, firstReady(context));
      if (list.length() == 0) return true;
      if (!force && prefs(context).getLong(next, 0) > System.currentTimeMillis()) return true;
    }
    BbBridge bb = new BbBridge(context, assistant);
    // Nobody to tell yet, or a call with this chief is on (it would read it out): kept for later.
    boolean call = HandsFreeService.callWith() == assistant;
    if (!bb.connected() || bb.chiefId().isEmpty() || call) {
      prefs(context).edit().putLong(next, System.currentTimeMillis() + (call ? 5 * 60_000L : 15 * 60_000L)).apply();
      return true;
    }
    String id = prefs(context).getString(idKey, "");
    if (id.isEmpty()) {
      id = ChiefText.requestId();
      prefs(context).edit().putString(idKey, id).apply();
    }
    // Only this assistant's part of the network log: the other's bb lines (its address, threads,
    // requests) aren't this chief's business.
    String text = report(appName(), list, ownLines(NetLog.read(), assistant, otherHosts(context, assistant)), System.currentTimeMillis(), ZoneId.systemDefault(), id);
    try {
      bb.tell(bb.chiefId(), text, List.of(), true);
    } catch (Exception ex) {
      synchronized (LOCK) {
        int tries = prefs(context).getInt(triesKey, 0) + 1;
        prefs(context).edit().putInt(triesKey, tries).putLong(next, System.currentTimeMillis() + delayMs(tries)).apply();
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
      prefs(context).edit().putString(FAILURES, left.toString()).remove(triesKey).remove(next).remove(idKey).apply();
    }
    return true;
  }

  static String appName() {
    return "Dictate & Delegate " + BuildConfig.VERSION_NAME + " (Android " + android.os.Build.VERSION.RELEASE + ")";
  }

  /** The next try: the earliest queued note's, or the report's. */
  private static void scheduleNext(Context context) {
    long now = System.currentTimeMillis(), next = Long.MAX_VALUE;
    boolean[] waiting = new boolean[Assistants.COUNT];
    for (HistoryEntry e : queued(context)) {
      next = Math.min(next, NoteFlow.delivery(e.json, now) == NoteFlow.Delivery.DUE ? now + 5_000 : e.json.optLong("chiefNextTry", now));
      waiting[NoteFlow.assistant(e.json)] = true;
    }
    for (HistoryEntry e : recent(context)) {
      // A note meant for a chief is being written down: a look in a few minutes, in case the app is stopped.
      if (NoteFlow.meantForChief(e.json) && e.json.optString("status").equals("pending") && !e.json.has("speechAskedAt") && DictationService.recording(context, e.id()).exists())
        next = Math.min(next, now + 5 * 60_000L);
      // A try under way: should the app be stopped mid-way, it's due again once it counts as cut off.
      if (NoteFlow.delivery(e.json, now) == NoteFlow.Delivery.SENDING) next = Math.min(next, e.json.optLong("chiefSending") + NoteFlow.SENDING_STALE_MS + 1_000);
    }
    // An assistant's report goes after its notes, when one of them got through; alone, at its own time.
    if (failuresWaiting(context) > 0) {
      JSONArray list = failures(context);
      int first = firstReady(context);
      for (int a = 0; a < Assistants.COUNT; a++)
        if (!waiting[a] && forAssistant(list, a, first).length() > 0)
          next = Math.min(next, Math.max(now, prefs(context).getLong(Assistants.key(a, REPORT_NEXT), now)));
    }
    if (next != Long.MAX_VALUE) schedule(context, Math.max(0, next - now));
  }

  /**
   * The lines of the network log an assistant's report may hold: not the other assistant's bb
   * lines ("bb2 …" for the first, "bb …" for the second) nor lines with the other's bb address
   * (otherHosts, e.g. its sign-in). OpenRouter, ntfy (topics are never in the log) and the phone's
   * network stay.
   */
  static String ownLines(String log, int assistant, List<String> otherHosts) {
    StringBuilder out = new StringBuilder();
    for (String line : log.split("\n")) {
      String[] f = line.split(java.util.regex.Pattern.quote(NetLog.SEP), 3);
      String what = f.length > 1 ? f[1] : "";
      boolean other = false;
      for (int a = 0; a < Assistants.COUNT; a++)
        if (a != assistant && what.startsWith(Assistants.logName(a) + " ")) other = true;
      for (String host : otherHosts) if (!host.isEmpty() && line.contains(host)) other = true;
      if (!other) out.append(line).append('\n');
    }
    return out.toString();
  }

  /** The other assistants' bb hosts, when they differ from this one's. */
  private static List<String> otherHosts(Context context, int assistant) {
    List<String> hosts = new ArrayList<>();
    String own = host(new BbBridge(context, assistant));
    for (int a = 0; a < Assistants.COUNT; a++) {
      if (a == assistant) continue;
      String h = host(new BbBridge(context, a));
      if (!h.isEmpty() && !h.equalsIgnoreCase(own)) hosts.add(h);
    }
    return hosts;
  }

  private static String host(BbBridge bb) {
    if (!bb.connected()) return "";
    try {
      String base = bb.apiBase();
      return base.isEmpty() ? "" : java.net.URI.create(base).getHost();
    } catch (RuntimeException ex) {
      return "";
    }
  }

  static final int JOB = 4711;

  /** A try within delay ms, unless one is scheduled already (it may be sooner). */
  static void soon(Context context, long delay) {
    JobScheduler js = context.getSystemService(JobScheduler.class);
    long at = System.currentTimeMillis() + delay;
    if (js != null && js.getPendingJob(JOB) != null && prefs(context).getLong(SCHEDULED, Long.MAX_VALUE) <= at) return;
    schedule(context, delay);
  }

  /** When the scheduled try is due (wall clock), for soon(). */
  private static final String SCHEDULED = "scheduledAt";

  /** A try in delay ms, once there's a network; survives restarts. Replaces the one scheduled. */
  static void schedule(Context context, long delay) {
    try {
      JobScheduler js = context.getSystemService(JobScheduler.class);
      if (js == null) return;
      prefs(context).edit().putLong(SCHEDULED, System.currentTimeMillis() + delay).apply();
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

}
