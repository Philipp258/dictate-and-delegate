package app.driftdictation;

import android.content.Context;
import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Jev, TypeSafe's decision model through OpenRouter (POST /api/alpha/decisions): after the
 * transcript, it answers up to three questions about the dictation, each with a probability. Talk
 * Router acts on its own only when the answer is clear; otherwise the panel's buttons are one tap
 * away. Jev never sees question names, so the instructions and criteria carry all the meaning;
 * scripts/qa/jev-check.py checks them on labelled dictations and reads them from this file.
 */
final class Jev {
  static final String MODEL = "~typesafe/jev-latest", NAME = "Jev";

  /** Slower than this and nothing happens by itself; the buttons still work. */
  static final int TIMEOUT_MS = 3000;

  /** Refine starts by itself at this probability (or when a template is named). */
  static final double REFINE_AT = 0.5;

  /** Sent to the chief by itself only this sure that it is meant for it (its name came up first). */
  static final double CHIEF_AT = 0.8;

  /** Between this and CHIEF_AT the 🧑‍💼 button is highlighted as a hint, nothing is sent. */
  static final double HINT_AT = 0.5;

  static final String NONE = "none";

  static final String REFINE =
      "Does the speaker want this dictation turned into a finished text by an assistant, or"
          + " does it clearly need that before anyone can read it?";
  static final String REFINE_YES =
      "The speaker asks for a text to be written or changed (tidy this up, make it more formal,"
          + " turn it into an email, a list or a reply, translate it, shorten it, fill in a"
          + " template, draft something), or the dictation is a message, email or note so full of"
          + " filler words, false starts and self-corrections (\"no wait\", \"I mean\") that it"
          + " can't be sent as it is.";
  static final String REFINE_NO =
      "The speaker dictated something that reads fine as said: a message, note or to-do in"
          + " plain sentences. Asking the reader to write something (\"can you send me the"
          + " report\") is part of the message, and a task for someone else is not a request to"
          + " write a text.";

  static final String TEMPLATE =
      "Which of the speaker's saved templates does the dictation ask to use? The speaker names"
          + " it, for example \"use my apartment application\".";
  static final String TEMPLATE_NONE = "The dictation doesn't ask for any of the saved templates.";
  static final String TEMPLATE_OPTION = "The speaker asks to use their saved template \"%s\".";

  static final String CHIEF =
      "The speaker's chief of staff, an AI agent, is called %1$s. Is the dictation, or part of"
          + " it, meant for %1$s: does the speaker talk to %1$s or say that this should go to"
          + " %1$s, for example \"%1$s, …\", \"hey %1$s, …\", \"this is for %1$s\", \"send"
          + " this to %1$s\", \"I want to talk to %1$s about …\", \"%1$s should look at this as"
          + " well\", in any language (German: \"%1$s, …\", \"das ist für %1$s\", \"schick das"
          + " an %1$s\")?";
  static final String CHIEF_YES =
      "The speaker addresses %1$s directly or says the dictation should go to %1$s or be handled"
          + " by %1$s: an instruction about where this dictation goes.";
  static final String CHIEF_NO =
      "%1$s only comes up in what the dictation says: a message to someone else that mentions"
          + " %1$s (\"I'll bring %1$s along\", \"%1$s and I met yesterday\", \"say hi to %1$s"
          + " from me\"), a text to be written for %1$s as its reader (\"write a thank-you note to"
          + " %1$s\"), or a note about %1$s, without asking for this to go to %1$s.";

  /**
   * Whether the chief's name comes up in the dictation: case-insensitive, as a whole word, also
   * with a possessive ("Henry's", "Henrys") and as speech models mishear it ("Henri", "Henrie").
   * Only then is Jev asked whether the dictation is meant for the chief. No name, no chief.
   */
  static boolean mentions(String dictation, String name) {
    if (dictation == null || name == null || name.isBlank()) return false;
    return namePattern(name).matcher(dictation).find();
  }

  static Pattern namePattern(String name) {
    String n = name.trim().toLowerCase(Locale.ROOT);
    java.util.Set<String> forms = new java.util.LinkedHashSet<>();
    forms.add(n);
    if (n.endsWith("y")) {
      String stem = n.substring(0, n.length() - 1);
      forms.add(stem + "i");
      forms.add(stem + "ie");
      forms.add(stem + "ey");
    } else if (n.endsWith("ie")) forms.add(n.substring(0, n.length() - 2) + "y");
    else if (n.endsWith("i")) forms.add(n.substring(0, n.length() - 1) + "y");
    StringBuilder alt = new StringBuilder();
    for (String f : forms) {
      if (alt.length() > 0) alt.append('|');
      // Spaces and hyphens in a name match either: "chief of staff", "chief-of-staff".
      String[] parts = f.split("[\\s-]+");
      for (int i = 0; i < parts.length; i++) alt.append(i > 0 ? "[\\s-]+" : "").append(Pattern.quote(parts[i]));
    }
    return Pattern.compile(
        "(?<![\\p{L}\\p{N}])(?:" + alt + ")(?:'s|’s|s)?(?![\\p{L}\\p{N}])",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
  }

  /** What Jev answered: a probability per noul (null when not asked), the template, the cost. */
  record Answers(Double refine, String template, Double chief, BigDecimal cost) {}

  /** What happens by itself (refine, send to the chief), the template for Refine, the hint. */
  record Decision(boolean refine, String template, boolean chief, boolean hint) {}

  /**
   * The request: the dictation as state, and only the questions that matter now: refine when
   * Refine may start by itself, template when there are templates (a tapped Refine uses it too),
   * chief when there is a chief to send to and its name (chiefName, else empty) comes up.
   */
  static JSONObject body(String dictation, List<String> templates, boolean refine, String chiefName)
      throws Exception {
    JSONObject questions = new JSONObject();
    if (refine) questions.put("refine", noul(REFINE, REFINE_YES, REFINE_NO));
    JSONObject options = new JSONObject().put(NONE, TEMPLATE_NONE);
    for (String name : templates)
      if (!name.equalsIgnoreCase(NONE)) options.put(name, String.format(Locale.ROOT, TEMPLATE_OPTION, name));
    if (options.length() > 1)
      questions.put(
          "template",
          new JSONObject().put("type", "choice").put("instructions", TEMPLATE).put("criteria", options));
    if (!chiefName.isEmpty())
      questions.put(
          "chief",
          noul(
              String.format(Locale.ROOT, CHIEF, chiefName),
              String.format(Locale.ROOT, CHIEF_YES, chiefName),
              String.format(Locale.ROOT, CHIEF_NO, chiefName)));
    return new JSONObject()
        .put("model", MODEL)
        .put("state", new JSONObject().put("dictation", dictation))
        .put("questions", questions);
  }

  private static JSONObject noul(String instructions, String yes, String no) throws Exception {
    return new JSONObject()
        .put("type", "noul")
        .put("instructions", instructions)
        .put("criteria", new JSONObject().put("true", yes).put("false", no));
  }

  /** Reads the answers; anything missing or unreadable counts as not asked. */
  static Answers parse(JSONObject response, List<String> templates) {
    JSONObject answers = response.optJSONObject("answers");
    if (answers == null) answers = new JSONObject();
    String template = "";
    JSONObject t = answers.optJSONObject("template");
    if (t != null)
      for (String name : templates)
        if (name.equals(t.optString("choice"))) template = name;
    return new Answers(
        probability(answers.optJSONObject("refine")),
        template,
        probability(answers.optJSONObject("chief")),
        OpenRouter.cost(response));
  }

  private static Double probability(JSONObject answer) {
    if (answer == null || !(answer.opt("noul") instanceof Number n)) return null;
    double p = n.doubleValue();
    return Double.isFinite(p) ? Math.max(0, Math.min(1, p)) : null;
  }

  /**
   * autoRefine and autoChief are the two switches in Settings → Models & providers → Decisions; chiefReady: bb is
   * connected and a chief is set; named: the chief's name comes up (mentions). Only then can it go
   * to the chief, at CHIEF_AT; between HINT_AT and CHIEF_AT, or when Jev failed, 🧑‍💼 is only
   * highlighted. What goes to the chief isn't refined by itself.
   */
  static Decision decide(Answers a, boolean autoRefine, boolean autoChief, boolean chiefReady, boolean named) {
    boolean ask = chiefReady && named;
    if (a == null) return new Decision(false, "", false, ask);
    Double c = a.chief();
    boolean chief = ask && autoChief && c != null && c >= CHIEF_AT;
    boolean hint = ask && !chief && (c == null || c >= HINT_AT);
    boolean template = !a.template().isEmpty();
    boolean refine = !chief && autoRefine && (template || (a.refine() != null && a.refine() >= REFINE_AT));
    return new Decision(refine, a.template(), chief, hint);
  }

  /** For Activity: "refine 0.82 · chief 0.03 · Apartment application". */
  static String detail(Answers a) {
    StringBuilder s = new StringBuilder();
    if (a.refine() != null) s.append(String.format(Locale.ROOT, "refine %.2f", a.refine()));
    if (a.chief() != null)
      s.append(s.length() > 0 ? " · " : "").append(String.format(Locale.ROOT, "chief %.2f", a.chief()));
    if (!a.template().isEmpty()) s.append(s.length() > 0 ? " · " : "").append(a.template());
    return s.toString();
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

  /** Asks Jev; throws when it fails or takes longer than TIMEOUT_MS. */
  static Answers ask(Context context, String dictation, List<String> templates, boolean refine, String chiefName)
      throws Exception {
    JSONObject r = new OpenRouter(context).decide(body(dictation, templates, refine, chiefName), TIMEOUT_MS);
    return parse(r, templates);
  }
}
