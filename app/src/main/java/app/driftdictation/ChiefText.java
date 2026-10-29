package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Text the chief sends back for pasting. The chief posts it to the ntfy topic, tagged
 * "talkrouter-paste" and "req-<request ID>" (the dictate-and-delegate skill). While the panel is open, Talk
 * Router reads the topic's JSON stream itself (no background service) and offers Insert from
 * chief. When it's closed, the ntfy app shows the message; its Copy button sends a broadcast with
 * the request ID, which TalkAccessibility receives while it runs. The broadcast carries only the
 * ID: the text is fetched from the user's own topic, so another app can't put text on the
 * clipboard this way.
 */
final class ChiefText {
  private ChiefText() {}

  /** Six random lowercase letters and digits: short enough to read, unique enough per topic. */
  static String requestId() {
    String alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    SecureRandom r = new SecureRandom();
    StringBuilder s = new StringBuilder();
    for (int i = 0; i < 6; i++) s.append(alphabet.charAt(r.nextInt(alphabet.length())));
    return s.toString();
  }

  /** An ntfy message (one line of the JSON stream) that holds the text for this request. */
  static boolean matches(JSONObject message, String request) {
    if (!"message".equals(message.optString("event", "message"))) return false;
    JSONArray tags = message.optJSONArray("tags");
    boolean paste = false, ours = false;
    for (int i = 0; tags != null && i < tags.length(); i++) {
      String t = tags.optString(i).trim();
      paste |= t.equalsIgnoreCase(BbBridge.PASTE_TAG);
      ours |= t.equalsIgnoreCase(BbBridge.requestTag(request));
    }
    return paste && ours;
  }

  /**
   * The text of a matching message. ntfy turns messages over 4,096 bytes into a text attachment;
   * then the text is fetched from its URL, but only from the ntfy server itself: an attachment
   * elsewhere (ntfy's Attach header) could make the phone fetch any address.
   */
  static String text(JSONObject message, String server) throws IOException {
    JSONObject attachment = message.optJSONObject("attachment");
    String url = attachment == null ? "" : attachment.optString("url");
    if (!url.isEmpty() && url.startsWith(server + "/")) {
      String type = attachment.optString("type", "text/plain");
      if (type.startsWith("text/")) return get("ntfy attachment", url, 200_000, "").trim();
    }
    return message.optString("message").trim();
  }

  /** <server>/<topic>/json?since=…: the stream from that moment (unix seconds), or a poll. */
  static String streamUrl(String server, String topic, long sinceSeconds, boolean poll) {
    return server + "/" + topic + "/json?since=" + sinceSeconds + (poll ? "&poll=1" : "");
  }

  private static String get(String what, String url, int max, String topic) throws IOException {
    return NetLog.request(
        NetLog.begin(what, "GET", url, topic),
        net -> {
          HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
          try {
            c.setConnectTimeout(15_000);
            c.setReadTimeout(20_000);
            net.status(c.getResponseCode());
            if (c.getResponseCode() >= 300) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
              byte[] got = in.readNBytes(max);
              net.received(got.length);
              return new String(got, StandardCharsets.UTF_8);
            }
          } finally {
            c.disconnect();
          }
        });
  }

  // ------------------------------------------------------------------ the stream in the network log

  /**
   * Connects to the topic's stream (what's open is c), in the network log: the status and how long
   * connecting took, with the reconnect number. Throws what connecting threw.
   */
  static void connect(HttpURLConnection c, String what, String url, String topic, String request, int reconnect) throws IOException {
    NetLog.Call net = NetLog.begin(what + " connect", "GET", url, topic).request(request).retry(reconnect);
    try {
      net.status(c.getResponseCode());
      if (c.getResponseCode() >= 300) throw new IOException("HTTP " + c.getResponseCode());
    } catch (IOException | RuntimeException ex) {
      net.fail(ex);
      c.disconnect();
      throw ex;
    } finally {
      net.end();
    }
  }

  /** A message from the stream, in the network log: ntfy's ID, the request it's for and how late it came. Not its text. */
  static void received(String what, JSONObject m) {
    if (!"message".equals(m.optString("event", "message"))) return;
    JSONArray tags = m.optJSONArray("tags");
    String request = "", kind = "";
    for (int i = 0; tags != null && i < tags.length(); i++) {
      String t = tags.optString(i).trim();
      if (t.toLowerCase(java.util.Locale.ROOT).startsWith("req-")) request = t.substring(4);
      else if (t.equalsIgnoreCase(SPEAK_TAG)) kind = "spoken";
      else if (t.equalsIgnoreCase(BbBridge.PASTE_TAG)) kind = "paste";
    }
    long time = m.optLong("time") * 1000;
    String late = time <= 0 ? "" : "published " + NetLog.stamp(time) + ", here " + Math.max(0, NetLog.clock.getAsLong() - time) / 1000 + " s later";
    int size = m.optString("message").getBytes(StandardCharsets.UTF_8).length;
    NetLog.event(
        what + " message", "", "id " + m.optString("id") + (kind.isEmpty() ? "" : " (" + kind + ")"), request,
        late + (late.isEmpty() ? "" : ", ") + NetLog.size(size));
  }

  /** The stream ended: why (null: the server ended it), after how long, with how many messages. */
  static void closed(String what, String url, String topic, String request, Exception why, boolean stopped, long openedNanos, int messages) {
    String result = stopped ? "closed by the app" : why == null ? "ended by the server" : NetLog.classify(why);
    long s = (System.nanoTime() - openedNanos) / 1_000_000_000;
    NetLog.event(
        what + " closed", url, result, request,
        String.format(java.util.Locale.ROOT, "open %d:%02d min, %d %s", s / 60, s % 60, messages, messages == 1 ? "message" : "messages"),
        topic);
  }

  /**
   * Reads the topic's stream until the text for the request arrives or stop() is called;
   * reconnects after a dropped connection. found runs on this listener's thread.
   */
  static final class Listener extends Thread {
    private final String server, topic, request;
    private final long since;
    private final Consumer<String> found;
    private volatile boolean stopped;
    private volatile HttpURLConnection open;

    Listener(String server, String topic, String request, long sinceSeconds, Consumer<String> found) {
      super("ntfy-" + request);
      setDaemon(true);
      this.server = server;
      this.topic = topic;
      this.request = request;
      this.since = sinceSeconds;
      this.found = found;
    }

    void finish() {
      stopped = true;
      HttpURLConnection c = open;
      if (c != null) c.disconnect();
      interrupt();
    }

    @Override
    public void run() {
      for (int reconnect = 0; !stopped; reconnect++) {
        String url = streamUrl(server, topic, since, false);
        long opened = 0;
        int messages = 0;
        try {
          HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
          open = c;
          c.setConnectTimeout(15_000);
          c.setReadTimeout(90_000); // ntfy sends a keepalive every 45 s.
          connect(c, "ntfy paste text", url, topic, request, reconnect);
          opened = System.nanoTime();
          Exception why = null;
          try (BufferedReader in =
              new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; !stopped && (line = in.readLine()) != null; ) {
              if (line.isBlank()) continue;
              JSONObject m;
              try {
                m = new JSONObject(line);
              } catch (Exception ex) {
                continue;
              }
              if (!"keepalive".equals(m.optString("event")) && !"open".equals(m.optString("event"))) {
                messages++;
                received("ntfy paste text", m);
              }
              if (matches(m, request)) {
                String t = text(m, server);
                if (!t.isEmpty()) {
                  stopped = true; // Found: the stream is closed on purpose.
                  found.accept(t);
                  return;
                }
              }
            }
          } catch (Exception ex) {
            why = ex;
            throw ex;
          } finally {
            closed("ntfy paste text", url, topic, request, why, stopped, opened, messages);
            c.disconnect();
          }
        } catch (Exception ex) {
          /* Dropped or unreachable (in the network log): try again in a moment. */
        }
        try {
          Thread.sleep(3000);
        } catch (InterruptedException ex) {
          return;
        }
      }
    }
  }

  /** The ntfy tag on spoken replies in hands-free mode (the dictate-and-delegate skill). */
  static final String SPEAK_TAG = "talkrouter-speak";

  /** The request ID of a spoken reply ("req-<id>" next to SPEAK_TAG), or "" for any other message. */
  static String spokenRequest(JSONObject message) {
    if (!"message".equals(message.optString("event", "message"))) return "";
    JSONArray tags = message.optJSONArray("tags");
    boolean speak = false;
    String request = "";
    for (int i = 0; tags != null && i < tags.length(); i++) {
      String t = tags.optString(i).trim();
      if (t.equalsIgnoreCase(SPEAK_TAG)) speak = true;
      else if (t.toLowerCase(java.util.Locale.ROOT).startsWith("req-")) request = t.substring(4);
    }
    return speak ? request : "";
  }

  /** Is it a spoken reply (SPEAK_TAG), with or without a request ID? */
  static boolean spoken(JSONObject message) {
    if (!"message".equals(message.optString("event", "message"))) return false;
    JSONArray tags = message.optJSONArray("tags");
    for (int i = 0; tags != null && i < tags.length(); i++) if (tags.optString(i).trim().equalsIgnoreCase(SPEAK_TAG)) return true;
    return false;
  }

  /**
   * Hands-free mode: reads the topic's stream until finish() and hands every spoken reply for one
   * of our requests to the callback, in order and once each; reconnects after a dropped connection.
   */
  static final class Replies extends Thread {
    interface Callback {
      /**
       * A spoken reply for request; published: when ntfy got it (unix ms, whole seconds), 0 if
       * unknown; untagged: it came without a request ID (request is then untagged's).
       */
      void reply(String request, String text, long published, boolean untagged);
    }

    private final String server, topic;
    private final java.util.function.Predicate<String> ours;
    private final java.util.function.Supplier<String> untagged;
    private final Callback callback;
    private volatile boolean stopped;
    private volatile HttpURLConnection open;
    private String since;
    private final java.util.Set<String> seen = new java.util.HashSet<>();

    Replies(String server, String topic, long sinceSeconds, java.util.function.Predicate<String> ours, Callback callback) {
      this(server, topic, sinceSeconds, ours, () -> "", callback);
    }

    /**
     * As above; a spoken reply without a request ID counts as one for the request untagged names
     * ("" drops it): the talker passes on the chief's results that way.
     */
    Replies(String server, String topic, long sinceSeconds, java.util.function.Predicate<String> ours,
        java.util.function.Supplier<String> untagged, Callback callback) {
      super("ntfy-replies");
      this.untagged = untagged;
      setDaemon(true);
      this.server = server;
      this.topic = topic;
      this.since = String.valueOf(sinceSeconds);
      this.ours = ours;
      this.callback = callback;
    }

    void finish() {
      stopped = true;
      HttpURLConnection c = open;
      if (c != null) c.disconnect();
      interrupt();
    }

    @Override
    public void run() {
      for (int reconnect = 0; !stopped; reconnect++) {
        String url = server + "/" + topic + "/json?since=" + since;
        long opened = 0;
        int messages = 0;
        try {
          HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
          open = c;
          c.setConnectTimeout(15_000);
          c.setReadTimeout(90_000);
          connect(c, "ntfy replies", url, topic, "", reconnect);
          opened = System.nanoTime();
          Exception why = null;
          try (BufferedReader in =
              new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; !stopped && (line = in.readLine()) != null; ) {
              if (line.isBlank()) continue;
              JSONObject m;
              try {
                m = new JSONObject(line);
              } catch (Exception ex) {
                continue;
              }
              if (!"keepalive".equals(m.optString("event")) && !"open".equals(m.optString("event"))) {
                messages++;
                received("ntfy replies", m);
              }
              String id = m.optString("id");
              if (!id.isEmpty()) since = id; // Reconnect from here, not from the start.
              String request = spokenRequest(m);
              boolean noTag = request.isEmpty();
              if (noTag && spoken(m)) request = untagged.get();
              if (request.isEmpty() || !seen.add(id) || !ours.test(request)) continue;
              String t = text(m, server);
              if (!t.isEmpty()) callback.reply(request, t, m.optLong("time") * 1000, noTag);
            }
          } catch (Exception ex) {
            why = ex;
            throw ex;
          } finally {
            closed("ntfy replies", url, topic, "", why, stopped, opened, messages);
            c.disconnect();
          }
        } catch (Exception ex) {
          /* Dropped or unreachable (in the network log): try again in a moment. */
        }
        try {
          Thread.sleep(3000);
        } catch (InterruptedException ex) {
          return;
        }
      }
    }
  }

  /** The text for a request, from the messages the topic still holds (ntfy keeps them 12 h). */
  static String fetch(Context context, String request) throws Exception {
    BbBridge bb = new BbBridge(context);
    String server = bb.ntfyServer();
    long since = System.currentTimeMillis() / 1000 - 12 * 3600;
    String all = get("ntfy poll", streamUrl(server, bb.ntfyTopic(), since, true), 2_000_000, bb.ntfyTopic());
    String text = "";
    for (String line : all.split("\n")) {
      try {
        JSONObject m = new JSONObject(line);
        if (matches(m, request)) text = text(m, server); // The latest one wins.
      } catch (Exception ignored) {
        /* Not a message. */
      }
    }
    return text;
  }

  /**
   * ntfy's Copy button on the chief's paste message (action "broadcast", intent COPY_ACTION,
   * extras.request): copies that request's text and keeps it with the note.
   */
  static final class CopyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
      String request = intent.getStringExtra("request");
      if (request == null || !request.matches("[a-z0-9]{4,12}")) return;
      PendingResult pending = goAsync();
      Context app = context.getApplicationContext();
      new Thread(
              () -> {
                String message;
                try {
                  String text = fetch(app, request);
                  if (text.isEmpty()) message = tr("Your chief's text isn't on your ntfy topic anymore.");
                  else {
                    DictationService.copy(app, text);
                    DictationService.keepReply(app, request, text);
                    message = tr("Copied your chief's text");
                  }
                } catch (Exception ex) {
                  message = tr("Couldn't get your chief's text from ntfy. Try again.");
                }
                String shown = message;
                new android.os.Handler(android.os.Looper.getMainLooper())
                    .post(
                        () -> {
                          android.widget.Toast.makeText(app, shown, android.widget.Toast.LENGTH_SHORT).show();
                          pending.finish();
                        });
              })
          .start();
    }
  }
}
