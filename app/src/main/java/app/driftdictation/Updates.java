package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Updates from inside the app: the newest release of the app on GitHub (tags v1.2.3, not
 * pre-releases, with an APK), checked on start when the last check is a day old and with Check for
 * updates. Update downloads the APK, checks its SHA-256 against the release's SHA256SUMS (or
 * GitHub's digest) and that it's signed with the installed app's key, then hands it to Android's
 * installer, which asks to confirm. Only anonymous requests to GitHub; failures stay quiet unless
 * you asked.
 */
final class Updates {
  private Updates() {}

  static final String REPO = "Philipp258/dictate-and-delegate";

  /** GitHub's API; tests point it at a fake. */
  static volatile String api = "https://api.github.com";

  /** A check at most this often on its own. */
  static final long EVERY_MS = 20L * 3600 * 1000;

  static final String CHECKED = "updateChecked", RELEASE = "updateRelease";

  /** A release this app can update to. */
  record Release(String version, String tag, String notes, String url, String apkName, String apkUrl, long size, String sumsUrl, String digest) {
    JSONObject json() throws Exception {
      return new JSONObject()
          .put("version", version).put("tag", tag).put("notes", notes).put("url", url).put("apkName", apkName)
          .put("apkUrl", apkUrl).put("size", size).put("sumsUrl", sumsUrl).put("digest", digest);
    }

    static Release of(JSONObject j) {
      return new Release(j.optString("version"), j.optString("tag"), j.optString("notes"), j.optString("url"), j.optString("apkName"),
          j.optString("apkUrl"), j.optLong("size"), j.optString("sumsUrl"), j.optString("digest"));
    }
  }

  // ------------------------------------------------------------------ versions and releases

  private static final Pattern TAG = Pattern.compile("^v(\\d+)\\.(\\d+)\\.(\\d+)$");

  /**
   * a against b, by their numbers (3.2.19 < 3.3.0); a suffix ("-beta.1") comes before the same
   * numbers without one. Negative, 0 or positive.
   */
  static int compare(String a, String b) {
    String[] x = a.split("-", 2), y = b.split("-", 2);
    String[] p = x[0].split("\\."), q = y[0].split("\\.");
    for (int i = 0; i < Math.max(p.length, q.length); i++) {
      int c = Integer.compare(number(p, i), number(q, i));
      if (c != 0) return c;
    }
    return Boolean.compare(x.length == 1, y.length == 1);
  }

  private static int number(String[] parts, int i) {
    try {
      return i < parts.length ? Integer.parseInt(parts[i].replaceAll("\\D", "")) : 0;
    } catch (NumberFormatException ex) {
      return 0;
    }
  }

  /** The newest plain release (v1.2.3, no draft or pre-release) with an APK; null without one. */
  static Release pick(JSONArray releases) {
    Release best = null;
    for (int i = 0; releases != null && i < releases.length(); i++) {
      JSONObject r = releases.optJSONObject(i);
      if (r == null || r.optBoolean("draft") || r.optBoolean("prerelease")) continue;
      Matcher m = TAG.matcher(r.optString("tag_name"));
      if (!m.matches()) continue;
      String version = m.group(1) + "." + m.group(2) + "." + m.group(3);
      JSONObject apk = null, sums = null;
      JSONArray assets = r.optJSONArray("assets");
      for (int j = 0; assets != null && j < assets.length(); j++) {
        JSONObject a = assets.optJSONObject(j);
        if (a == null) continue;
        String name = a.optString("name");
        if (name.endsWith(".apk") && apk == null) apk = a;
        else if (name.equals("SHA256SUMS")) sums = a;
      }
      if (apk == null) continue;
      Release candidate =
          new Release(version, r.optString("tag_name"), r.optString("body"), r.optString("html_url"), apk.optString("name"),
              apk.optString("browser_download_url"), apk.optLong("size"), sums == null ? "" : sums.optString("browser_download_url"),
              apk.optString("digest"));
      if (best == null || compare(candidate.version, best.version) > 0) best = candidate;
    }
    return best;
  }

  /**
   * The SHA-256 the APK must have: its line in SHA256SUMS ("hex  name"), else GitHub's digest
   * ("sha256:hex"). Throws when the release has neither: an unchecked download isn't installed.
   */
  static String expectedSha(String sums, String name, String digest) throws IOException {
    for (String line : (sums == null ? "" : sums).split("\n")) {
      String[] f = line.trim().split("\\s+\\*?", 2);
      if (f.length == 2 && f[1].trim().equals(name) && f[0].matches("[0-9a-fA-F]{64}")) return f[0].toLowerCase(Locale.ROOT);
    }
    if (digest != null && digest.startsWith("sha256:") && digest.substring(7).matches("[0-9a-fA-F]{64}"))
      return digest.substring(7).toLowerCase(Locale.ROOT);
    throw new IOException(tr("the release has no checksum"));
  }

  /** The release notes as plain short text: no markdown marks, without the download and checksum parts. */
  static String notes(String body) {
    String s = body == null ? "" : body.replace("\r", "");
    int cut = s.length();
    for (String h : new String[] {"\n## Download", "\n## SHA256", "## Download", "## SHA256"}) {
      int at = s.indexOf(h);
      if (at >= 0) cut = Math.min(cut, at);
    }
    s = s.substring(0, cut).replaceAll("(?m)^#+\\s*", "").replace("**", "").replace("`", "").replaceAll("\\[([^\\]]+)\\]\\([^)]+\\)", "$1").trim();
    return s.length() > 700 ? s.substring(0, 700).trim() + "…" : s;
  }

  static String sha256(File f) throws Exception {
    MessageDigest d = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(f)) {
      byte[] b = new byte[64 * 1024];
      for (int n; (n = in.read(b)) > 0; ) d.update(b, 0, n);
    }
    StringBuilder s = new StringBuilder();
    for (byte x : d.digest()) s.append(String.format(Locale.ROOT, "%02x", x));
    return s.toString();
  }

  // ------------------------------------------------------------------ GitHub

  /** The newest release on GitHub (null without one). Anonymous; at most a few kB. */
  static Release latest() throws IOException {
    String url = api + "/repos/" + REPO + "/releases?per_page=30";
    try {
      return pick(new JSONArray(get("update check", url, 2_000_000)));
    } catch (org.json.JSONException ex) {
      throw new IOException(tr("GitHub sent something unexpected"), ex);
    }
  }

  private static String get(String what, String url, int max) throws IOException {
    return NetLog.request(
        what,
        "GET",
        url,
        net -> {
          HttpURLConnection c = open(url);
          try {
            int status = c.getResponseCode();
            net.status(status);
            if (status == 403 || status == 429) throw new IOException(tr("GitHub's limit for now; it checks again later"));
            if (status >= 300) throw new IOException("HTTP " + status);
            try (InputStream in = c.getInputStream()) {
              byte[] b = in.readNBytes(max);
              net.received(b.length);
              return new String(b, StandardCharsets.UTF_8);
            }
          } finally {
            c.disconnect();
          }
        });
  }

  private static HttpURLConnection open(String url) throws IOException {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(15_000);
    c.setReadTimeout(30_000);
    c.setRequestProperty("Accept", "application/vnd.github+json");
    c.setRequestProperty("User-Agent", "Dictate-and-Delegate-android/" + BuildConfig.VERSION_NAME);
    return c;
  }

  // ------------------------------------------------------------------ checking

  /** What the last check found, if it's newer than this app; null otherwise. */
  static Release available(Context context) {
    String saved = prefs(context).getString(RELEASE, "");
    if (saved.isEmpty()) return null;
    try {
      Release r = Release.of(new JSONObject(saved));
      return compare(r.version(), BuildConfig.VERSION_NAME) > 0 ? r : null;
    } catch (Exception ex) {
      return null;
    }
  }

  /** On start: checks in the background when the last check is EVERY_MS old; done runs after (on that thread). */
  static void checkIfDue(Context context, Runnable done) {
    if (System.currentTimeMillis() - prefs(context).getLong(CHECKED, 0) < EVERY_MS) return;
    new Thread(
            () -> {
              try {
                check(context);
              } catch (Exception ex) {
                /* Quiet: it tries again next time. */
              }
              done.run();
            },
            "update-check")
        .start();
  }

  /** Checks now; returns the newer release or null when this app is up to date. */
  static Release check(Context context) throws IOException {
    Release r = latest();
    SharedPreferences.Editor e = prefs(context).edit().putLong(CHECKED, System.currentTimeMillis());
    try {
      e.putString(RELEASE, r == null ? "" : r.json().toString());
    } catch (Exception ex) {
      e.remove(RELEASE);
    }
    e.apply();
    return r != null && compare(r.version(), BuildConfig.VERSION_NAME) > 0 ? r : null;
  }

  private static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences("settings", Context.MODE_PRIVATE);
  }

  // ------------------------------------------------------------------ downloading and installing

  /**
   * Downloads the release's APK (progress: percent) into the cache and checks it: its SHA-256,
   * that it's this app, newer, and signed with the installed app's key. Returns the file.
   */
  static File download(Context context, Release r, Consumer<Integer> progress) throws Exception {
    String expected = expectedSha(r.sumsUrl().isEmpty() ? "" : get("update checksums", r.sumsUrl(), 100_000), r.apkName(), r.digest());
    File dir = new File(context.getCacheDir(), "updates");
    File[] old = dir.listFiles();
    for (int i = 0; old != null && i < old.length; i++) old[i].delete();
    dir.mkdirs();
    File apk = new File(dir, r.apkName().replaceAll("[^A-Za-z0-9._-]", "_"));
    NetLog.request(
        "update download",
        "GET",
        r.apkUrl(),
        net -> {
          HttpURLConnection c = open(r.apkUrl());
          c.setRequestProperty("Accept", "application/octet-stream");
          try {
            int status = c.getResponseCode();
            net.status(status);
            if (status >= 300) throw new IOException("HTTP " + status);
            long total = r.size() > 0 ? r.size() : c.getContentLengthLong(), got = 0;
            int shown = -1;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
              byte[] b = new byte[64 * 1024];
              for (int n; (n = in.read(b)) > 0; ) {
                out.write(b, 0, n);
                net.received(got += n);
                int pct = total > 0 ? (int) Math.min(100, got * 100 / total) : -1;
                if (pct != shown) progress.accept(shown = pct);
              }
            }
            return null;
          } finally {
            c.disconnect();
          }
        });
    if (!sha256(apk).equals(expected)) {
      apk.delete();
      throw new IOException(tr("the download is damaged (checksum)"));
    }
    verify(context, apk);
    return apk;
  }

  /** The APK is this app, newer than the installed one, and signed with the same key. */
  static void verify(Context context, File apk) throws Exception {
    PackageManager pm = context.getPackageManager();
    PackageInfo theirs = pm.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
    PackageInfo ours = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
    if (theirs == null || !context.getPackageName().equals(theirs.packageName)) throw new IOException(tr("it isn't this app"));
    if (theirs.getLongVersionCode() <= ours.getLongVersionCode()) throw new IOException(tr("it isn't newer than this version"));
    if (theirs.signingInfo == null || !signers(theirs).equals(signers(ours))) throw new IOException(tr("it isn't signed with this app's key"));
  }

  private static Set<String> signers(PackageInfo p) throws Exception {
    Set<String> out = new HashSet<>();
    Signature[] s = p.signingInfo.hasMultipleSigners() ? p.signingInfo.getApkContentsSigners() : p.signingInfo.getSigningCertificateHistory();
    for (Signature x : s) {
      MessageDigest d = MessageDigest.getInstance("SHA-256");
      StringBuilder hex = new StringBuilder();
      for (byte b : d.digest(x.toByteArray())) hex.append(String.format(Locale.ROOT, "%02x", b));
      out.add(hex.toString());
    }
    return out;
  }

  /** May this app hand APKs to the installer? Android asks once (Install unknown apps). */
  static boolean mayInstall(Context context) {
    return context.getPackageManager().canRequestPackageInstalls();
  }

  /** The setting where you allow it, for this app. */
  static Intent allowInstalls(Context context) {
    return new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:" + context.getPackageName()))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
  }

  /** Hands the checked APK to Android's installer; UpdateReceiver shows its confirmation. */
  static void install(Context context, File apk) throws Exception {
    PackageInstaller installer = context.getPackageManager().getPackageInstaller();
    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
    params.setAppPackageName(context.getPackageName());
    params.setSize(apk.length());
    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED); // Asks anyway unless allowed.
    int id = installer.createSession(params);
    try (PackageInstaller.Session session = installer.openSession(id)) {
      try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("base.apk", 0, apk.length())) {
        byte[] b = new byte[64 * 1024];
        for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
        session.fsync(out);
      }
      Intent done = new Intent(context, UpdateReceiver.class).setAction(UpdateReceiver.ACTION);
      android.app.PendingIntent pending =
          android.app.PendingIntent.getBroadcast(
              context, id, done, android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_MUTABLE);
      session.commit(pending.getIntentSender());
    }
  }
}
