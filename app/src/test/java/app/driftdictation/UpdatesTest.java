package app.driftdictation;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

public class UpdatesTest {
  private NetLogTest.Fake server;

  @After
  public void tearDown() throws Exception {
    if (server != null) server.close();
    Updates.api = "https://api.github.com";
  }

  @Test
  public void versionsCompareByTheirNumbersAndABetaComesFirst() {
    assertTrue(Updates.compare("3.3.0", "3.2.19") > 0);
    assertTrue(Updates.compare("3.2.19-beta.1", "3.3.0") < 0);
    assertTrue(Updates.compare("3.10.0", "3.9.9") > 0);
    assertTrue(Updates.compare("3.3.0-beta.1", "3.3.0") < 0);
    assertEquals(0, Updates.compare("3.3.0", "3.3.0"));
    assertTrue(Updates.compare("3.3.1", "3.3") > 0);
  }

  private static JSONObject release(String tag, boolean prerelease, String... assets) throws Exception {
    JSONArray a = new JSONArray();
    for (String n : assets)
      a.put(new JSONObject().put("name", n).put("browser_download_url", "https://github.com/x/releases/download/" + tag + "/" + n).put("size", 1000));
    return new JSONObject().put("tag_name", tag).put("prerelease", prerelease).put("draft", false).put("body", "Notes for " + tag)
        .put("html_url", "https://github.com/x/releases/tag/" + tag).put("assets", a);
  }

  @Test
  public void theNewestPlainAndroidReleaseWithAnApkIsPicked() throws Exception {
    JSONArray all = new JSONArray()
        .put(release("mac-v0.9.0", false, "Dictate-and-Delegate-0.9.0-mac-arm64.zip"))
        .put(release("v3.4.0-beta.1", true, "Dictate-and-Delegate-3.4.0-beta.1.apk"))
        .put(release("v3.5.0", true, "Dictate-and-Delegate-3.5.0.apk"))
        .put(release("v3.3.1", false, "SHA256SUMS")) // No APK.
        .put(release("v3.3.0", false, "Dictate-and-Delegate-3.3.0.apk", "SHA256SUMS"))
        .put(release("v3.2.19-beta.1", false, "Dictate-and-Delegate-3.2.19-beta.1.apk"));
    Updates.Release r = Updates.pick(all);
    assertEquals("3.3.0", r.version());
    assertEquals("Dictate-and-Delegate-3.3.0.apk", r.apkName());
    assertTrue(r.sumsUrl().endsWith("/v3.3.0/SHA256SUMS"));
    assertEquals(r, Updates.Release.of(r.json()));
    assertNull(Updates.pick(new JSONArray().put(release("mac-v0.2.0", false, "x.zip"))));
  }

  @Test
  public void theChecksumComesFromSha256SumsOrGitHubsDigestElseNothingIsInstalled() throws Exception {
    String hex = "cc56ae76331d5e34f8b1547c217a88fefdfe320f04d15907d5e6a6071639d9a2";
    String sums = "d1cf388ef09f40506503fdaf78b6e20f857c642822f7b10648c7662e6fe66b19  Dictate-and-Delegate-3.3.0.aab\n" + hex.toUpperCase() + "  Dictate-and-Delegate-3.3.0.apk\n";
    assertEquals(hex, Updates.expectedSha(sums, "Dictate-and-Delegate-3.3.0.apk", ""));
    assertEquals(hex, Updates.expectedSha("", "Dictate-and-Delegate-3.3.0.apk", "sha256:" + hex));
    try {
      Updates.expectedSha(sums, "other.apk", "");
      fail("no checksum, no install");
    } catch (java.io.IOException expected) {
      /* Refused. */
    }
    File f = Files.createTempFile("apk", ".apk").toFile();
    Files.write(f.toPath(), "abc".getBytes(StandardCharsets.UTF_8));
    assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Updates.sha256(f));
  }

  @Test
  public void theNotesLeaveOutDownloadsChecksumsAndMarkdown() {
    String body = "Fixes **Insert**.\n\n## Fixed\n\n- A `thing`, see [the guide](https://x).\n\n## SHA256\n\n```\nabc  x.apk\n```";
    assertEquals("Fixes Insert.\n\nFixed\n\n- A thing, see the guide.", Updates.notes(body));
  }

  @Test
  public void theCheckAsksGitHubAnonymouslyAndLogsIt() throws Exception {
    java.util.List<String> paths = new java.util.ArrayList<>();
    JSONArray all = new JSONArray().put(release("v99.0.0", false, "Dictate-and-Delegate-99.0.0.apk", "SHA256SUMS"));
    server = new NetLogTest.Fake((method, path, body) -> {
      paths.add(method + " " + path);
      return new String[] {"200", "Content-Type: application/json\r\n", all.toString()};
    });
    Updates.api = "http://127.0.0.1:" + server.port();
    Updates.Release r = Updates.latest();
    assertEquals("99.0.0", r.version());
    assertEquals(java.util.List.of("GET /repos/Philipp258/dictate-and-delegate/releases?per_page=30"), paths);
    server.close();
    server = new NetLogTest.Fake((method, path, body) -> new String[] {"403", "", "{\"message\":\"API rate limit exceeded\"}"});
    Updates.api = "http://127.0.0.1:" + server.port();
    try {
      Updates.latest();
      fail("rate limited");
    } catch (java.io.IOException expected) {
      assertEquals("GitHub's limit for now; it checks again later", expected.getMessage());
    }
  }
}
