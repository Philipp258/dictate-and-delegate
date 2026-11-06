package app.driftdictation;

import static org.junit.Assert.*;

import java.math.BigDecimal;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class JevTest {
  final List<String> templates = List.of("Apartment application", "Weekly update");

  @Test
  public void theRequestOnlyAsksForTheTemplate() throws Exception {
    JSONObject all = Jev.body("Alex, use my weekly update", templates);
    assertEquals(Jev.MODEL, all.getString("model"));
    assertEquals("Alex, use my weekly update", all.getJSONObject("state").getString("dictation"));
    JSONObject q = all.getJSONObject("questions");
    // Nothing about refining by itself or who gets it: only which template it names.
    assertEquals(1, q.length());
    JSONObject options = q.getJSONObject("template").getJSONObject("criteria");
    assertEquals("choice", q.getJSONObject("template").getString("type"));
    assertEquals(3, options.length());
    assertEquals(Jev.TEMPLATE_NONE, options.getString("none"));
    assertTrue(options.getString("Weekly update").contains("\"Weekly update\""));
    // No templates: nothing to ask.
    assertEquals(0, Jev.body("x", List.of()).getJSONObject("questions").length());
  }

  @Test
  public void theTemplateIsReadAndUnknownsIgnored() throws Exception {
    JSONObject r =
        new JSONObject(
            "{\"answers\": {\"template\": {\"type\": \"choice\", \"choice\": \"Weekly update\", \"confidence\": 0.9},"
                + " \"chief\": {\"type\": \"noul\", \"noul\": 0.99}}, \"usage\": {\"cost\": 1.9404e-05}}");
    Jev.Answers a = Jev.parse(r, templates);
    assertEquals("Weekly update", a.template());
    assertEquals(0, new BigDecimal("0.000019404").compareTo(a.cost()));
    assertEquals("Weekly update", Jev.detail(a));

    // "none", a name the user doesn't have, a missing answer: no template.
    Jev.Answers b = Jev.parse(new JSONObject("{\"answers\": {\"template\": {\"choice\": \"Invoice\"}}}"), templates);
    assertEquals("", b.template());
    assertNull(b.cost());
    assertEquals("", Jev.detail(b));
    assertEquals("", Jev.parse(new JSONObject("{}"), templates).template());
  }
}
