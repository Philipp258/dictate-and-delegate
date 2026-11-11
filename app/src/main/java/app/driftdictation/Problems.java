package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/**
 * Fail loudly: a recording that wasn't written down, or a note that didn't reach its chief, shows
 * as a phone notification (besides the note and Home) until it's resolved, written down, sent or
 * discarded. Tapping it opens the note, with what went wrong and its details. One per note.
 */
final class Problems {
  private Problems() {}

  static final String CHANNEL = "needs_you";

  private static NotificationManager manager(Context context) {
    NotificationManager m = context.getSystemService(NotificationManager.class);
    if (m != null && m.getNotificationChannel(CHANNEL) == null) {
      NotificationChannel c = new NotificationChannel(CHANNEL, tr("Not written down or not sent"), NotificationManager.IMPORTANCE_DEFAULT);
      c.setDescription(tr("A recording that wasn't written down, or a note that didn't reach your chief of staff."));
      m.createNotificationChannel(c);
    }
    return m;
  }

  private static int id(String noteId) {
    return 1000 + (noteId.hashCode() & 0x3fffffff);
  }

  private static String to(Context context, HistoryEntry e) {
    return Assistants.several(context) ? Assistants.name(context, NoteFlow.assistant(e.json)) : tr("your chief of staff");
  }

  /** It wasn't written down (why: plain words with the real error). */
  static void notWritten(Context context, HistoryEntry e, String why) {
    boolean chief = NoteFlow.meantForChief(e.json);
    show(context, e, chief ? tr("Not written down, not sent to %1$s", to(context, e)) : tr("Recording not written down"), why + " " + tr("The audio is kept: open it to retry."));
  }

  /** It didn't reach its chief, and isn't tried again by itself (or keeps failing). */
  static void notSent(Context context, HistoryEntry e, String why) {
    show(context, e, tr("Not sent to %1$s", to(context, e)), why);
  }

  /** Written down, meant for a chief, but too old to go by itself: the user reads it and sends it. */
  static void waitsForYou(Context context, HistoryEntry e) {
    show(
        context,
        e,
        tr("Not sent to %1$s: waits for you", to(context, e)),
        tr("%1$s, so it doesn't go by itself. Open it to read it, then Send or Don't send.", capital(NoteFlow.waitReason(e.json, System.currentTimeMillis(), java.time.ZoneId.systemDefault()))));
  }

  private static String capital(String s) {
    return s.isEmpty() ? s : s.substring(0, 1).toUpperCase(java.util.Locale.getDefault()) + s.substring(1);
  }

  private static void show(Context context, HistoryEntry e, String title, String text) {
    try {
      NotificationManager m = manager(context);
      if (m == null) return;
      String said = e.text().replaceAll("\\s+", " ").trim();
      String body = text + (said.isEmpty() ? "" : "\n“" + (said.length() > 120 ? said.substring(0, 120) + "…" : said) + "”");
      Intent open = new Intent(context, MainActivity.class).putExtra("open", "note").putExtra("note", e.recordingId()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      PendingIntent tap = PendingIntent.getActivity(context, id(e.id()), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      m.notify(
          id(e.id()),
          new Notification.Builder(context, CHANNEL)
              .setSmallIcon(R.drawable.ic_mic)
              .setContentTitle(title)
              .setContentText(text)
              .setStyle(new Notification.BigTextStyle().bigText(body))
              .setContentIntent(tap)
              .setAutoCancel(true)
              .setOnlyAlertOnce(true)
              .build());
    } catch (RuntimeException ignored) {
      /* No permission to post: the note and Home still show it. */
    }
  }

  /** Resolved (written down, sent, discarded): its notification goes. */
  static void clear(Context context, String noteId) {
    try {
      NotificationManager m = context.getSystemService(NotificationManager.class);
      if (m != null) m.cancel(id(noteId));
    } catch (RuntimeException ignored) {
      /* Nothing to take back. */
    }
  }
}
