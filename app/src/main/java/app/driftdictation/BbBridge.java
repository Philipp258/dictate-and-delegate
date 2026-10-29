package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.IOException;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The bridge to bb (getbb.app), through bb's built-in MCP server (plugin bb--mcp). Its "run" tool
 * takes a JavaScript snippet that calls the bb command line ({@code await bb.json([...])}), at most
 * 25 seconds each; snippets here are one or two bb calls and never wait.
 *
 * <p>Two ways to reach bb: bb Connect (https://<handle>.getbb.app/mcp, signed in with OAuth, see
 * BbOAuth), or a custom address with an optional bearer token (a tailnet, or adb reverse to bb's
 * local address http://127.0.0.1:38886/api/v1/plugins/bb--mcp/http/mcp).
 *
 * <p>The chief of staff is one bb thread in Personal that receives every agent request. It
 * notifies the user through ntfy itself; Dictate & Delegate sends no notifications. Each request carries a
 * short ID; text meant for pasting comes back as an ntfy message tagged with it (ChiefText).
 */
final class BbBridge {
  static final String CONNECT = "connect", CUSTOM = "custom";

  /** bb's project for threads outside any repository ("no project"). */
  static final String PROJECT = "proj_personal";

  static final String CHIEF_TITLE = "Chief of staff";

  /** Settings (not secret) in the "settings" preferences; tokens and the topic in Vault. */
  static final String MODE = "bbMode",
      HANDLE = "bbHandle",
      URL = "bbUrl",
      LINK_BASE = "bbLinkBase",
      CHIEF_ID = "chiefId",
      CHIEF_NAME = "chiefTitle",
      TALKER_ID = "talkerId",
      TALKER_ON = "talkerOn",
      NTFY_SERVER = "ntfyServer",
      TOKEN = "bbToken",
      NTFY_TOPIC = "ntfyTopic";

  static final String NTFY_DEFAULT = "https://ntfy.sh";

  /** A bb thread: its id, title and status. */
  record ThreadInfo(String id, String title, String status) {}

  private final Context context;
  private final SharedPreferences prefs;
  private final Vault vault;

  BbBridge(Context context) {
    this.context = context.getApplicationContext();
    prefs = this.context.getSharedPreferences("settings", Context.MODE_PRIVATE);
    vault = new Vault(this.context);
  }

  // ------------------------------------------------------------------ settings

  String mode() {
    return prefs.getString(MODE, CONNECT);
  }

  String handle() {
    return prefs.getString(HANDLE, "");
  }

  /** The MCP address in use: bb Connect's for the handle, or the custom one. */
  String url() {
    return mode().equals(CUSTOM) ? prefs.getString(URL, "") : handle().isEmpty() ? "" : BbOAuth.resource(handle());
  }

  /** Where thread links point: the bb web app (PWA), e.g. https://<handle>.getbb.app. */
  String linkBase() {
    String custom = prefs.getString(LINK_BASE, "");
    if (mode().equals(CUSTOM) && !custom.isEmpty()) return custom;
    if (!handle().isEmpty()) return BbOAuth.origin(handle());
    return mode().equals(CUSTOM) ? linkBaseFor(prefs.getString(URL, "")) : "";
  }

  /** bb Connect signed in, or a custom address saved. */
  boolean connected() {
    return mode().equals(CUSTOM)
        ? !prefs.getString(URL, "").isEmpty()
        : !handle().isEmpty() && BbOAuth.signedIn(context);
  }

  String chiefId() {
    return prefs.getString(CHIEF_ID, "");
  }

  String chiefTitle() {
    return prefs.getString(CHIEF_NAME, "");
  }

  /** The talker thread as saved (Settings → Hands-free), on or off; "" for none. */
  String savedTalker() {
    return prefs.getString(TALKER_ID, "");
  }

  boolean talkerOn() {
    return prefs.getBoolean(TALKER_ON, false);
  }

  /**
   * The talker for hands-free calls: a fast thread that does the talking while the chief does the
   * work. "" when off, not set, or the chief itself.
   */
  String talkerId() {
    String t = savedTalker();
    return talkerOn() && !t.equals(chiefId()) ? t : "";
  }

  /** The chief can get requests: bb is connected and a chief is set. */
  static boolean ready(Context context) {
    BbBridge b = new BbBridge(context);
    return b.connected() && !b.chiefId().isEmpty();
  }

  void useConnect(String handle) {
    prefs.edit().putString(MODE, CONNECT).putString(HANDLE, handle).apply();
  }

  void useCustom(String url, String token, String linkBase) throws Exception {
    prefs
        .edit()
        .putString(MODE, CUSTOM)
        .putString(URL, url.trim())
        .putString(LINK_BASE, linkBase.trim().replaceAll("/+$", ""))
        .apply();
    if (token.isBlank()) vault.remove(TOKEN);
    else vault.put(TOKEN, token.trim());
  }

  String customToken() {
    try {
      return vault.get(TOKEN);
    } catch (Exception ex) {
      return "";
    }
  }

  void setChief(ThreadInfo t) {
    prefs
        .edit()
        .putString(CHIEF_ID, t.id())
        .putString(CHIEF_NAME, t.title())
        .putBoolean(ChiefSkills.CHIEF_TOLD, true)
        .apply();
  }

  void forgetChief() {
    prefs.edit().remove(CHIEF_ID).remove(CHIEF_NAME).remove(ChiefSkills.CHIEF_TOLD).apply();
  }

  /** Signs out of bb Connect (revoking the tokens) or forgets the custom address. */
  void disconnect() {
    if (mode().equals(CUSTOM)) {
      prefs.edit().remove(URL).remove(LINK_BASE).apply();
      vault.remove(TOKEN);
    } else BbOAuth.signOut(context);
  }

  /** Forgets everything about bb on this phone (Delete local data); revokes in the background. */
  static void forgetAll(Context context) {
    String tokens = BbOAuth.forget(context);
    new java.lang.Thread(() -> BbOAuth.revoke(tokens)).start();
    Vault v = new Vault(context);
    v.remove(TOKEN);
    v.remove(NTFY_TOPIC);
  }

  String ntfyServer() {
    return prefs.getString(NTFY_SERVER, NTFY_DEFAULT);
  }

  void setNtfyServer(String server) {
    String s = server.trim().replaceAll("/+$", "");
    prefs.edit().putString(NTFY_SERVER, s.isEmpty() ? NTFY_DEFAULT : s).apply();
  }

  /** The ntfy topic, made once: whoever knows it can read the notifications. */
  synchronized String ntfyTopic() throws Exception {
    String topic = vault.get(NTFY_TOPIC);
    if (topic.isEmpty()) {
      topic = newTopic();
      vault.put(NTFY_TOPIC, topic);
    }
    return topic;
  }

  /** "talkrouter-" and 24 random URL-safe characters (144 bits). */
  static String newTopic() {
    return "talkrouter-" + BbOAuth.random(18);
  }

  // ------------------------------------------------------------------ pure helpers (unit-tested)

  private static final Pattern THREAD = Pattern.compile("\\bthr_[A-Za-z0-9]+");

  /** A thread id from "thr_…" or a link like https://<handle>.getbb.app/threads/thr_…; "" if none. */
  static String threadId(String idOrLink) {
    Matcher m = THREAD.matcher(idOrLink == null ? "" : idOrLink.trim());
    return m.find() ? m.group() : "";
  }

  static String threadLink(String linkBase, String id) {
    return linkBase.isEmpty() || id.isEmpty() ? "" : linkBase + "/threads/" + id;
  }

  /** https://<handle>.getbb.app/mcp → https://<handle>.getbb.app; other addresses: "". */
  static String linkBaseFor(String mcpUrl) {
    Matcher m = Pattern.compile("^(https://[a-z0-9-]+\\.getbb\\.app)(/.*)?$").matcher(mcpUrl.trim());
    return m.matches() ? m.group(1) : "";
  }

  /** A JavaScript string literal (JSON is valid JavaScript). */
  static String js(String s) {
    return JSONObject.quote(s);
  }

  /** The snippet that sends a message to a thread, queued behind a running turn, else started. */
  static String tellSnippet(String id, String message) {
    return tellSnippet(id, message, List.of());
  }

  /** The same, with uploaded attachments: {"--image" or "--file", path inside bb's attachments}. */
  static String tellSnippet(String id, String message, List<String[]> attachments) {
    StringBuilder files = new StringBuilder();
    for (String[] a : attachments) files.append(",").append(js(a[0])).append(",").append(js(a[1]));
    return "const r = await bb.json([\"thread\",\"tell\","
        + js(id)
        + ",\"--mode\",\"queue\",\"--message-file\",\"-\""
        + files
        + "], {stdin: "
        + js(message)
        + "});\nreturn {threadId: r.threadId, delivery: r.delivery};";
  }

  static String spawnSnippet(String prompt) {
    return "const t = await bb.json([\"thread\",\"spawn\",\"--project\","
        + js(PROJECT)
        + ",\"--title\","
        + js(CHIEF_TITLE)
        + ",\"--prompt-file\",\"-\"], {stdin: "
        + js(prompt)
        + "});\nreturn {id: t.id, title: t.title, status: t.status};";
  }

  static String showSnippet(String id) {
    return "const s = await bb.json([\"thread\",\"show\","
        + js(id)
        + "]);\nreturn {id: s.thread.id, title: s.thread.title || s.thread.titleFallback || \"\","
        + " status: s.thread.status, archived: !!s.thread.archivedAt};";
  }

  /** The ntfy tag that marks text meant for pasting, and the one that names its request. */
  static final String PASTE_TAG = "talkrouter-paste";

  static String requestTag(String request) {
    return "req-" + request;
  }



  /** The ntfy app's subscribe link: ntfy://<host>/<topic> (secure=false for plain HTTP). */
  static String ntfyLink(String server, String topic) {
    String host = server.replaceFirst("^[a-zA-Z]+://", "").replaceAll("/+$", "");
    return "ntfy://" + host + "/" + topic + (server.startsWith("http://") ? "?secure=false" : "");
  }

  /**
   * The message for the chief: the dictation as said, then pasted text as context, then a note
   * about the attached files when there is one ("" for none), then the request ID.
   */
  static String message(String said, List<String[]> pasted, String note, String request) {
    StringBuilder s = new StringBuilder(said.trim());
    // Pasted text shares bb's 100,000-character limit with everything else: at most this much.
    int room = PASTED_MAX;
    for (String[] p : pasted) {
      String text = p[1].trim();
      if (room <= 0) break;
      if (text.length() > room) text = text.substring(0, room) + "\n[… shortened by Dictate & Delegate]";
      room -= text.length();
      s.append("\n\n<pasted name=\"")
          .append(p[0].replace("\"", "'"))
          .append("\">\n")
          .append(text)
          .append("\n</pasted>");
    }
    if (!note.isEmpty()) s.append("\n\n").append(note);
    if (!request.isEmpty()) s.append("\n\n[request: ").append(request).append("]");
    return s.toString();
  }

  // ------------------------------------------------------------------ operations

  /** Checks that bb answers and offers the run tool. */
  void test() throws Exception {
    call(
        "bb check",
        c -> {
          for (Mcp.Tool t : c.tools()) if (t.name().equals("run")) return null;
          throw new IOException(tr("bb answers, but it doesn't offer the run tool. Update bb and check that the MCP plugin is on."));
        });
  }

  /**
   * Creates the chief of staff in Personal and keeps it. Its instructions are the chief-of-staff
   * and dictate-and-delegate skills, installed first; the thread itself only gets one line.
   */
  ThreadInfo createChief() throws Exception {
    ChiefSkills.ensure(context, ChiefSkills.filled(context));
    JSONObject r = run(spawnSnippet(ChiefSkills.START));
    ThreadInfo t = new ThreadInfo(r.optString("id"), r.optString("title", CHIEF_TITLE), r.optString("status"));
    if (t.id().isEmpty()) throw new IOException(tr("bb didn't say which thread it created."));
    setChief(t);
    return t;
  }

  /** Posts a test notification to the topic, as the chief would. */
  void ntfyTest() throws Exception {
    String url = ntfyServer() + "/" + ntfyTopic();
    NetLog.Call net = NetLog.begin("ntfy test", "POST", url, ntfyTopic());
    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
    try {
      c.setConnectTimeout(15_000);
      c.setReadTimeout(20_000);
      c.setRequestMethod("POST");
      c.setRequestProperty("Title", "Dictate & Delegate");
      byte[] body =
          tr("Test from Dictate & Delegate. Your chief of staff's notifications arrive like this.")
              .getBytes(java.nio.charset.StandardCharsets.UTF_8);
      c.setDoOutput(true);
      c.setFixedLengthStreamingMode(body.length);
      try (java.io.OutputStream out = c.getOutputStream()) {
        out.write(body);
      }
      int status = c.getResponseCode();
      net.status(status);
      if (status >= 300) throw new IOException(tr("The ntfy server answered with HTTP %1$d.", status));
    } catch (java.net.UnknownHostException | java.net.ConnectException ex) {
      net.fail(ex);
      throw new IOException(tr("Could not reach %1$s. Check the address and your connection.", ntfyServer()), ex);
    } catch (java.net.SocketTimeoutException ex) {
      net.fail(ex);
      throw new IOException(tr("%1$s didn't answer in time. Try again.", ntfyServer()), ex);
    } catch (Exception ex) {
      net.fail(ex);
      throw ex;
    } finally {
      net.end();
      c.disconnect();
    }
  }

  /**
   * Uses an existing bb thread as the chief of staff, after checking it exists: the skills are
   * installed, then it gets the one line.
   */
  ThreadInfo useExistingChief(String idOrLink) throws Exception {
    String id = threadId(idOrLink);
    if (id.isEmpty())
      throw new IOException(tr("That isn't a bb thread link or id (it starts with thr_)."));
    JSONObject r = run(showSnippet(id));
    if (r.optBoolean("archived"))
      throw new IOException(tr("That thread is archived in bb. Unarchive it or pick another."));
    ThreadInfo t = new ThreadInfo(r.optString("id", id), r.optString("title"), r.optString("status"));
    ChiefSkills.ensure(context, ChiefSkills.filled(context));
    send(t.id(), ChiefSkills.START);
    setChief(t);
    return t;
  }

  /** Sends a message to the chief: queued behind a turn that is running, else it starts one. */
  void send(String chiefId, String message) throws Exception {
    run(tellSnippet(chiefId, message));
  }

  /**
   * How the files reached the chief: how many went along, "upload" (bb attachments), "base64"
   * (text parts the chief decodes) or "" for none; the HTTP status bb refused the upload with (0
   * when it didn't); and the files that couldn't be passed on.
   */
  record Sent(int files, String how, int refused, List<String> failed) {}

  /** bb's MCP tools take at most 100,000 characters of code; a base64 part stays well below. */
  static final int CODE_LIMIT = 100_000, PART = 80_000, PASTED_MAX = 60_000;

  /** For the opt-in real check: treat the upload as refused, as bb Connect does. */
  static volatile boolean refuseUploads;

  /** Larger files don't go the base64 way: too many parts. */
  static final int BASE64_MAX = 3_000_000;

  /**
   * Sends a request to the chief (its instructions come from the skills): what was said, pasted
   * text, and the images and PDFs, images first. Files are uploaded to bb's attachments and go
   * with the message (--image, --file), so the chief sees them. If bb refuses the upload (bb
   * Connect may not take the app's sign-in for it), they go as base64 text in parts through MCP,
   * and the message tells the chief to join and decode them. A file that can't go either way is
   * named in the message; the dictation always goes.
   */
  Sent sendRequest(String chiefId, String said, List<String[]> pasted, List<Attachments.Binary> files, String request)
      throws Exception {
    List<String[]> refs = new java.util.ArrayList<>();
    List<String> failed = new java.util.ArrayList<>(), encoded = new java.util.ArrayList<>();
    int refused = 0, sent = 0;
    for (Attachments.Binary b : files) {
      try {
        if (refused == 0) {
          try {
            refs.add(new String[] {b.image() ? "--image" : "--file", upload(b.fileName(), b.mimeType(), b.data())});
            sent++;
            continue;
          } catch (UploadRefused ex) {
            refused = ex.status;
          }
        }
        if (b.data().length > BASE64_MAX) throw new IOException(tr("it's too big to pass on this way"));
        List<String> parts = uploadBase64(b.fileName(), b.data());
        for (String path : parts) refs.add(new String[] {"--file", path});
        encoded.add(b.fileName() + " (" + parts.size() + (parts.size() == 1 ? " part)" : " parts)"));
        sent++;
      } catch (Exception ex) {
        failed.add(b.fileName() + ": " + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
      }
    }
    StringBuilder note = new StringBuilder();
    if (!encoded.isEmpty()) note.append(base64Note(encoded));
    if (!failed.isEmpty())
      note.append(note.length() == 0 ? "" : "\n\n")
          .append("(I also attached ")
          .append(String.join("; ", failed))
          .append(". Dictate & Delegate couldn't pass that on.)");
    run(tellSnippet(chiefId, message(said, pasted, note.toString(), request), refs));
    String how = sent == 0 ? "" : encoded.isEmpty() ? "upload" : sent == encoded.size() ? "base64" : "upload+base64";
    return new Sent(sent, how, refused, failed);
  }

  /** A message from hands-free mode: what was said, tagged so the chief answers in speakable form. */
  void sendHandsFree(String chiefId, String said, String request) throws Exception {
    run(tellSnippet(chiefId, handsFreeMessage(said, request)));
  }

  static String handsFreeMessage(String said, String request) {
    return message(said, List.of(), HandsFree.TAG, request);
  }

  /**
   * Sends each thread its message, all at the same time: a failure to reach one doesn't hold up
   * the others. Returns the failures, thread ID → why; empty when every thread got its message.
   */
  java.util.Map<String, String> tellEach(java.util.Map<String, String> messages) {
    return tellEach(messages, new java.util.HashMap<>());
  }

  /** The same; took gets how long each thread's send took, thread ID → ms. */
  java.util.Map<String, String> tellEach(java.util.Map<String, String> messages, java.util.Map<String, Long> took) {
    java.util.Map<String, String> failed = new java.util.concurrent.ConcurrentHashMap<>();
    java.util.Map<String, Long> ms = new java.util.concurrent.ConcurrentHashMap<>();
    List<java.lang.Thread> others = new java.util.ArrayList<>();
    String first = null;
    for (String id : messages.keySet()) {
      if (first == null) {
        first = id;
        continue;
      }
      java.lang.Thread t = new java.lang.Thread(() -> tellOne(id, messages.get(id), failed, ms), "bb-tell");
      t.start();
      others.add(t);
    }
    if (first != null) tellOne(first, messages.get(first), failed, ms);
    for (java.lang.Thread t : others) {
      try {
        t.join();
      } catch (InterruptedException ex) {
        java.lang.Thread.currentThread().interrupt();
      }
    }
    took.putAll(ms);
    return new java.util.LinkedHashMap<>(failed);
  }

  private void tellOne(String id, String message, java.util.Map<String, String> failed, java.util.Map<String, Long> took) {
    long start = System.nanoTime();
    try {
      run(tellSnippet(id, message));
    } catch (Exception ex) {
      failed.put(id, ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
    } finally {
      took.put(id, (System.nanoTime() - start) / 1_000_000);
    }
  }

  /** What the chief is told about files that came as base64 text parts. */
  static String base64Note(List<String> names) {
    return "(Dictate & Delegate couldn't upload my attachments directly, so they come as base64 text in"
        + " parts, attached as <name>.partNNofMM.b64: for each file, join its parts in order and"
        + " decode them, e.g. `cat <name>.part*.b64 | base64 -d > <name>`, before you look at it: "
        + String.join(", ", names)
        + ".)";
  }

  /** bb refused an upload (HTTP 401, 403, 404 or 405): the base64 way is used instead. */
  static final class UploadRefused extends IOException {
    final int status;

    UploadRefused(int status) {
      super("HTTP " + status);
      this.status = status;
    }
  }

  /** bb's own address for its REST API, next to the MCP address. */
  String apiBase() {
    if (mode().equals(CONNECT)) return handle().isEmpty() ? "" : BbOAuth.origin(handle());
    String u = url().replaceAll("/+$", "");
    if (u.endsWith("/api/v1/plugins/bb--mcp/http/mcp")) return u.substring(0, u.length() - "/api/v1/plugins/bb--mcp/http/mcp".length());
    if (u.endsWith("/mcp")) return u.substring(0, u.length() - 4);
    java.net.URI uri = java.net.URI.create(u);
    return uri.getScheme() + "://" + uri.getRawAuthority();
  }

  /**
   * Uploads a file to bb's attachments for Personal (POST /api/v1/projects/proj_personal/attachments,
   * multipart, like bb's own app) and returns its path there, for bb thread tell.
   */
  String upload(String name, String mimeType, byte[] data) throws Exception {
    if (refuseUploads) throw new UploadRefused(401);
    boolean connect = mode().equals(CONNECT);
    for (int attempt = 0; ; attempt++) {
      String token = connect ? BbOAuth.accessToken(context, attempt > 0) : customToken();
      String address = apiBase() + "/api/v1/projects/" + PROJECT + "/attachments";
      NetLog.Call net = NetLog.begin("bb upload", "POST", address).retry(attempt);
      java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(address).openConnection();
      try {
        String boundary = "talkrouter" + BbOAuth.random(12);
        java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream();
        body.write(
            ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + name.replace("\"", "_")
                    + "\"\r\nContent-Type: " + mimeType + "\r\n\r\n")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        body.write(data);
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] payload = body.toByteArray();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setInstanceFollowRedirects(false);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        c.setFixedLengthStreamingMode(payload.length);
        net.sent(payload.length);
        try (java.io.OutputStream out = c.getOutputStream()) {
          out.write(payload);
        }
        int status = c.getResponseCode();
        net.status(status);
        if (status == 401 && connect && attempt == 0) continue;
        if (status == 401 || status == 403 || status == 404 || status == 405) throw new UploadRefused(status);
        if (status >= 300) throw new IOException(tr("bb couldn't take the attachment (HTTP %1$d).", status));
        try (java.io.InputStream in = c.getInputStream()) {
          String path = new JSONObject(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)).optString("path");
          if (path.isEmpty()) throw new IOException(tr("bb sent something unexpected. Update bb, then try again."));
          return path;
        }
      } catch (java.net.UnknownHostException | java.net.ConnectException | java.net.SocketTimeoutException ex) {
        net.fail(ex);
        throw new IOException(tr("bb isn't reachable right now. Is your computer on and bb running?"), ex);
      } catch (Exception ex) {
        net.fail(ex);
        throw ex;
      } finally {
        net.end();
        c.disconnect();
      }
    }
  }

  /**
   * A file as base64 text through MCP (bb.cli takes text only), in parts that keep each snippet
   * under bb's code limit: <name>.partNNofMM.b64. Returns their paths in bb's attachments.
   */
  List<String> uploadBase64(String name, byte[] data) throws Exception {
    String all = java.util.Base64.getEncoder().encodeToString(data);
    int count = Math.max(1, (all.length() + PART - 1) / PART);
    List<String> paths = new java.util.ArrayList<>();
    for (int i = 0; i < count; i++) {
      String part = all.substring(i * PART, Math.min(all.length(), (i + 1) * PART));
      String file = String.format(java.util.Locale.ROOT, "%s.part%02dof%02d.b64", name, i + 1, count);
      String code =
          "const a = await bb.json([\"project\",\"attachment\",\"upload\","
              + js(PROJECT)
              + ",\"--client-file\",\"/dev/stdin\",\"--filename\","
              + js(file)
              + ",\"--mime-type\",\"text/plain\"], {stdin: "
              + js(part)
              + "});\nreturn {path: a.path};";
      String path = run(code).optString("path");
      if (path.isEmpty()) throw new IOException(tr("bb sent something unexpected. Update bb, then try again."));
      paths.add(path);
    }
    return paths;
  }


  String threadLink(String id) {
    return threadLink(linkBase(), id);
  }

  /**
   * Opens a bb link in the browser. Chromium browsers (Chrome, Vanadium) reuse the tab they last
   * opened for the same application ID, so the bb tab doesn't pile up with every Open chat.
   */
  static android.content.Intent view(String link) {
    return new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(link))
        .putExtra(android.provider.Browser.EXTRA_APPLICATION_ID, "app.driftdictation.bb")
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
  }

  // ------------------------------------------------------------------ transport

  private interface Call<T> {
    T with(Mcp.Connection c) throws Exception;
  }

  /** Runs a snippet with the run tool; its returned value as JSON. */
  JSONObject run(String code) throws Exception {
    return snippet("run", code);
  }

  /** Runs a snippet that only looks (bb skill list/show) with the read tool. */
  JSONObject read(String code) throws Exception {
    return snippet("read", code);
  }

  private JSONObject snippet(String tool, String code) throws Exception {
    if (code.length() > CODE_LIMIT)
      throw new IOException(tr("This is too long for bb (%1$d characters, at most %2$d).", code.length(), CODE_LIMIT));
    return call(
        "bb " + what(code, tool, chiefId(), talkerId()),
        c -> {
          JSONObject result = c.callResult(tool, new JSONObject().put("code", code));
          String text = Mcp.Connection.text(result).trim();
          if (result.optBoolean("isError")) {
            if (text.length() > 400) text = text.substring(0, 400) + "…";
            throw new IOException(tr("bb couldn't do it: %1$s", text.isEmpty() ? tr("no details") : text));
          }
          try {
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
          } catch (Exception ex) {
            return new JSONObject().put("text", text);
          }
        });
  }

  /**
   * What a snippet does, for the network log: "tell chief", "tell talker", "tell thr_…", "check
   * skills", "spawn thread", "archive thread", "show thread", "upload part"; else the tool.
   */
  static String what(String code, String tool, String chief, String talker) {
    java.util.regex.Matcher tell = java.util.regex.Pattern.compile("\\[\"thread\",\"tell\",\"([^\"]*)\"").matcher(code);
    if (tell.find()) {
      String id = tell.group(1);
      return "tell " + (!id.isEmpty() && id.equals(chief) ? "chief" : !id.isEmpty() && id.equals(talker) ? "talker" : id);
    }
    if (code.contains("[\"skill\",\"list\"]")) return "check skills";
    if (code.contains("[\"thread\",\"spawn\"")) return "spawn thread";
    if (code.contains("[\"thread\",\"archive\"")) return "archive thread";
    if (code.contains("[\"thread\",\"show\"")) return "show thread";
    if (code.contains("[\"project\",\"attachment\",\"upload\"")) return "upload part";
    return tool;
  }

  /**
   * One MCP session. With bb Connect, an expired or refused token is refreshed once and the call
   * tried again. Every failure comes back as a plain IOException with a readable message.
   */
  private <T> T call(String what, Call<T> work) throws Exception {
    String url = url();
    if (!connected() || url.isEmpty()) throw new IOException(tr("bb isn't connected. Connect it in Settings → bb."));
    boolean connect = mode().equals(CONNECT);
    try {
      for (int attempt = 0; ; attempt++) {
        String token = connect ? BbOAuth.accessToken(context, attempt > 0) : customToken();
        Mcp.Connection c = new Mcp.Connection(new Mcp.Server("bb", url, token));
        c.what = what;
        c.retry = attempt;
        try {
          c.open();
          return work.with(c);
        } catch (Mcp.McpException ex) {
          if (ex.status == 401 && connect && attempt == 0) continue;
          throw ex;
        }
      }
    } catch (Mcp.McpException ex) {
      throw new IOException(explain(ex, connect), ex);
    } catch (BbOAuth.SignedOut ex) {
      throw new IOException(ex.getMessage(), ex);
    } catch (BbOAuth.HttpError ex) {
      throw new IOException(ex.getMessage(), ex);
    } catch (IOException ex) {
      if (ex.getClass() == IOException.class && ex.getMessage() != null) throw ex;
      throw new IOException(tr("The connection to bb broke off. Try again."), ex);
    } catch (org.json.JSONException ex) {
      throw new IOException(tr("bb sent something unexpected. Update bb, then try again."), ex);
    }
  }

  private static String explain(Mcp.McpException ex, boolean connect) {
    return switch (ex.status) {
      case 0 -> ex.getMessage();
      case 401 ->
          connect
              ? tr("bb no longer accepts this sign-in. Sign in again in Settings → bb.")
              : tr("bb refused the token (HTTP 401). Check the token in Settings → bb.");
      case 403 -> tr("bb refused the request (HTTP 403). Is this address allowed to use bb's MCP server?");
      case 404 -> tr("No MCP server at this address (HTTP 404). Check the address, and that bb's MCP plugin is on.");
      case 502, 503, 504 ->
          tr("bb isn't reachable right now (HTTP %1$d). Is your computer on and bb running?", ex.status);
      default -> ex.getMessage();
    };
  }
}
