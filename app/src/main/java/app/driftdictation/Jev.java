package app.driftdictation;

import android.content.Context;
import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;
import org.json.JSONObject;

/**
 * Jev, TypeSafe's decision model through OpenRouter (POST /api/alpha/decisions). After a
 * dictation it answers one question, only when there are saved templates: which one the dictation
 * names, for a Refine the user taps. It never decides where a dictation goes or that Refine starts:
 * the user does, on the panel. In hands-free calls it says whether a turn is done. Jev never sees
 * question names, so the instructions and criteria carry all the meaning; scripts/qa/jev-check.py
 * checks them on labelled examples and reads them from this file.
 */
final class Jev {
  static final String MODEL = "~typesafe/jev-latest", NAME = "Jev";

  /** Slower than this and nothing is decided; the buttons still work. */
  static final int TIMEOUT_MS = 3000;

  static final String NONE = "none";

  static final String TEMPLATE =
      "Which of the speaker's saved templates does the dictation ask to use? The speaker names"
          + " it, for example \"use my apartment application\".";
  static final String TEMPLATE_NONE = "The dictation doesn't ask for any of the saved templates.";
  static final String TEMPLATE_OPTION = "The speaker asks to use their saved template \"%s\".";

  /** What Jev answered: the template the dictation names ("" for none), and the cost. */
  record Answers(String template, BigDecimal cost) {}

  /** The request: the dictation as state, and the template question over the template names. */
  static JSONObject body(String dictation, List<String> templates) throws Exception {
    JSONObject questions = new JSONObject();
    JSONObject options = new JSONObject().put(NONE, TEMPLATE_NONE);
    for (String name : templates)
      if (!name.equalsIgnoreCase(NONE)) options.put(name, String.format(Locale.ROOT, TEMPLATE_OPTION, name));
    if (options.length() > 1)
      questions.put(
          "template",
          new JSONObject().put("type", "choice").put("instructions", TEMPLATE).put("criteria", options));
    return new JSONObject()
        .put("model", MODEL)
        .put("state", new JSONObject().put("dictation", dictation))
        .put("questions", questions);
  }

  /** Reads the answer; anything missing or unreadable counts as no template. */
  static Answers parse(JSONObject response, List<String> templates) {
    JSONObject answers = response.optJSONObject("answers");
    if (answers == null) answers = new JSONObject();
    String template = "";
    JSONObject t = answers.optJSONObject("template");
    if (t != null)
      for (String name : templates)
        if (name.equals(t.optString("choice"))) template = name;
    return new Answers(template, OpenRouter.cost(response));
  }

  /** For Activity: the template it named, "" for none. */
  static String detail(Answers a) {
    return a.template();
  }

  // ------------------------------------------------------------------ hands-free: is the turn done?

  /** The hands-free question: where the speaker is at a pause, one choice with its reason. */
  static final String TURN =
      "The speaker talks to their AI chief of staff on a hands-free phone call. This is everything"
          + " they've said in this turn so far, and they just paused. Which describes where they are?";

  /** The choices, in this order: the first ones mean the turn is done. */
  static final String[] TURN_CHOICES = {"over", "question", "request", "end", "unfinished", "more"};

  static String turnCriterion(String choice, List<String> sendWords, List<String> endWords) {
    return switch (choice) {
      case "over" ->
          "Ends with a cue that this turn is finished and can go: " + quoted(sendWords, "\"over\"")
              + ", \"send it\", \"go ahead\", \"that's it\", \"that's all\". The speaker says it on purpose to"
              + " send, so it counts even when what came before rambles or trails off (\"Well, over.\")."
              + " Said twice or more (\"Over. Over.\") it's emphasis: they're surely done.";
      case "question" -> "Has fully asked a question and is now waiting for the answer.";
      case "request" -> "Has said a complete request, instruction or statement and is clearly finished with it.";
      case "end" ->
          "Wants to end the whole call: " + quoted(endWords, "\"end the call\"") + ", \"hang up\", \"bye\", \"talk later\".";
      case "unfinished" -> "Stopped in the middle of a sentence or thought: the last sentence is cut off.";
      default ->
          "Is still thinking aloud, listing, or has announced more to come (\"and also\", \"first\","
              + " \"wait\", \"let me think\").";
    };
  }

  private static String quoted(List<String> words, String fallback) {
    StringBuilder s = new StringBuilder();
    for (String w : words) if (!w.isBlank()) s.append(s.length() == 0 ? "" : ", ").append('"').append(w.trim()).append('"');
    return s.length() == 0 ? fallback : s.toString();
  }

  static JSONObject turnBody(String said, List<String> sendWords, List<String> endWords) throws Exception {
    JSONObject criteria = new JSONObject();
    for (String c : TURN_CHOICES) criteria.put(c, turnCriterion(c, sendWords, endWords));
    return new JSONObject()
        .put("model", MODEL)
        .put("state", new JSONObject().put("said", said))
        .put(
            "questions",
            new JSONObject().put("turn", new JSONObject().put("type", "choice").put("instructions", TURN).put("criteria", criteria)));
  }

  /**
   * Jev's answer: its choice, the probability the turn is done (over, question and request
   * together) and that the call should end.
   */
  static HandsFreeSession.Verdict turnVerdict(JSONObject response) {
    JSONObject answers = response.optJSONObject("answers");
    JSONObject turn = answers == null ? null : answers.optJSONObject("turn");
    if (turn == null) throw new IllegalStateException("Jev gave no answer");
    JSONObject p = turn.optJSONObject("probabilities");
    String choice = turn.optString("choice");
    double send, end;
    if (p != null) {
      send = p.optDouble("over", 0) + p.optDouble("question", 0) + p.optDouble("request", 0);
      end = p.optDouble("end", 0);
    } else { // Only the choice: as sure as it says.
      double c = turn.optDouble("confidence", 1);
      send = choice.equals("over") || choice.equals("question") || choice.equals("request") ? c : 0;
      end = choice.equals("end") ? c : 0;
    }
    return new HandsFreeSession.Verdict(choice, Math.min(1, send), end, OpenRouter.cost(response));
  }

  /** Hands-free: asks Jev whether the turn is done; throws when it fails or is slower than TIMEOUT_MS. */
  static HandsFreeSession.Verdict turn(Context context, String said, List<String> sendWords, List<String> endWords) throws Exception {
    return turnVerdict(new OpenRouter(context).decide(turnBody(said, sendWords, endWords), TIMEOUT_MS));
  }

  /** Asks Jev which template the dictation names; throws when it fails or takes longer than TIMEOUT_MS. */
  static Answers ask(Context context, String dictation, List<String> templates) throws Exception {
    JSONObject r = new OpenRouter(context).decide(body(dictation, templates), TIMEOUT_MS);
    return parse(r, templates);
  }
}
