package app.driftdictation;

import static org.junit.Assert.*;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The request bodies the app sends to OpenRouter, as Drift's former server built them. */
public class OpenRouterTest {
  @Test
  public void wordsReachEachHostInItsOwnFormat() throws Exception {
    List<String> words = List.of("Kubernetes", " ", "Ljubljana");
    JSONObject mai = OpenRouter.transcriptionBody("microsoft/mai-transcribe-2", "UklGRg==", words);
    assertEquals("json", mai.getString("response_format"));
    assertEquals("wav", mai.getJSONObject("input_audio").getString("format"));
    assertEquals("UklGRg==", mai.getJSONObject("input_audio").getString("data"));
    JSONArray phrases =
        mai.getJSONObject("provider")
            .getJSONObject("options")
            .getJSONObject("azure")
            .getJSONObject("phraseList")
            .getJSONArray("phrases");
    assertEquals("[\"Kubernetes\",\"Ljubljana\"]", phrases.toString());

    JSONObject openai =
        OpenRouter.providerOptions("openai/gpt-transcribe", words).getJSONObject("options").getJSONObject("openai");
    assertEquals("Kubernetes, Ljubljana", openai.getString("prompt"));
    assertEquals(2, openai.getJSONArray("keywords").length());
    assertFalse(
        OpenRouter.providerOptions("openai/whisper-1", words)
            .getJSONObject("options")
            .getJSONObject("openai")
            .has("keywords"));
    assertEquals(
        2,
        OpenRouter.providerOptions("assemblyai/universal-3-5-pro", words)
            .getJSONObject("options")
            .getJSONObject("assemblyai")
            .getJSONArray("keyterms_prompt")
            .length());
  }

  @Test
  public void noWordsOrAModelWithoutHintsSendNoProviderOptions() throws Exception {
    assertNull(OpenRouter.providerOptions("microsoft/mai-transcribe-2", List.of()));
    assertNull(OpenRouter.providerOptions("deepgram/nova-3", List.of("Drift")));
    assertFalse(
        OpenRouter.transcriptionBody("microsoft/mai-transcribe-2", "x", List.of()).has("provider"));
    List<String> many = new ArrayList<>();
    for (int i = 0; i < 150; i++) many.add("w" + i);
    assertEquals(
        OpenRouter.MAX_WORDS,
        OpenRouter.providerOptions("assemblyai/universal-3-5-pro", many)
            .getJSONObject("options")
            .getJSONObject("assemblyai")
            .getJSONArray("keyterms_prompt")
            .length());
  }

  @Test
  public void chatBodiesReportTheirCostAndReadPdfsAsText() throws Exception {
    JSONArray plain =
        new JSONArray().put(new JSONObject().put("role", "user").put("content", "hi"));
    JSONObject check = OpenRouter.chatBody("fast/model", plain, 200, true);
    assertTrue(check.getJSONObject("usage").getBoolean("include"));
    assertEquals(200, check.getInt("max_tokens"));
    assertFalse(check.getJSONObject("reasoning").getBoolean("enabled"));
    assertFalse(check.has("plugins"));

    JSONArray parts =
        new JSONArray()
            .put(new JSONObject().put("type", "text").put("text", "reply to this"))
            .put(
                new JSONObject()
                    .put("type", "file")
                    .put("file", new JSONObject().put("filename", "offer.pdf")));
    JSONArray withPdf =
        new JSONArray().put(new JSONObject().put("role", "user").put("content", parts));
    JSONObject text = OpenRouter.chatBody(TextModel.MODEL, withPdf, 4096, false);
    assertFalse(text.has("reasoning"));
    JSONObject plugin = text.getJSONArray("plugins").getJSONObject(0);
    assertEquals("file-parser", plugin.getString("id"));
    assertEquals("pdf-text", plugin.getJSONObject("pdf").getString("engine"));
  }

  @Test
  public void aMissingCostIsUnknownNotFree() throws Exception {
    assertEquals(
        new BigDecimal("0.00042"),
        OpenRouter.cost(new JSONObject("{\"usage\": {\"cost\": 0.00042}}")));
    assertNull(OpenRouter.cost(new JSONObject("{\"usage\": {}}")));
    assertNull(OpenRouter.cost(new JSONObject("{}")));
    assertNull(OpenRouter.cost(new JSONObject("{\"usage\": {\"cost\": \"n/a\"}}")));
    assertNull(OpenRouter.cost(new JSONObject("{\"usage\": {\"cost\": true}}")));
  }

  @Test
  public void onlyRequestsThatNeverReachedOpenRouterAreTriedAgain() {
    assertTrue(OpenRouter.unreached(new java.io.IOException("No connection", new java.net.UnknownHostException("openrouter.ai"))));
    assertTrue(OpenRouter.unreached(new java.io.IOException("x", new java.net.ConnectException("Connection refused"))));
    assertTrue(OpenRouter.unreached(new java.io.IOException("x", new java.net.SocketTimeoutException("failed to connect to openrouter.ai"))));
    // A read timeout may have run (and cost): not tried again by itself.
    assertFalse(OpenRouter.unreached(new java.io.IOException("x", new java.net.SocketTimeoutException("Read timed out"))));
    assertFalse(OpenRouter.unreached(new java.io.IOException("The model provider had a problem (HTTP 502).")));
  }
}
