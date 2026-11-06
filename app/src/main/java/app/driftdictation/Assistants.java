package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;

/**
 * The assistants: up to two bbs, each with its own address, sign-in, chief of staff, ntfy topic
 * and skills (BbBridge with the assistant's number). The first keeps the settings it always had;
 * the second's settings and vault entries carry the prefix "a2.". Each has a name the user picks
 * ("Personal", "Work") and a colour, so the panel, calls and notes say where something goes.
 * Nothing is routed by what was said: the user picks the assistant on the panel, with the volume
 * key that started the dictation (down for the first, up for the second), or by the call they start.
 */
final class Assistants {
  private Assistants() {}

  static final int COUNT = 2;

  /** Settings, per assistant (key): its name. */
  static final String NAME = "assistantName";

  /** Settings: the other volume key (the one not set for the first) starts a dictation for the second. */
  static final String OTHER_KEY = "assistant2Key";

  /** The name of a setting or vault entry for an assistant: the first's as it always was. */
  static String key(int assistant, String name) {
    return assistant == 0 ? name : "a" + (assistant + 1) + "." + name;
  }

  /** Each assistant's colour on the app's light screens, and on the dark floating panels. */
  static final int[] COLOR = {0xff0b7a5e, 0xff5b47c7}, BRIGHT = {0xff28b89a, 0xff9d8cf5};

  static int color(int assistant) {
    return COLOR[clamp(assistant)];
  }

  static int bright(int assistant) {
    return BRIGHT[clamp(assistant)];
  }

  static int clamp(int assistant) {
    return Math.max(0, Math.min(COUNT - 1, assistant));
  }

  static String defaultName(int assistant) {
    return assistant == 0 ? tr("Personal") : tr("Work");
  }

  static String name(SharedPreferences prefs, int assistant) {
    String n = prefs.getString(key(assistant, NAME), "").trim();
    return n.isEmpty() ? defaultName(assistant) : n;
  }

  static String name(Context context, int assistant) {
    return name(context.getSharedPreferences("settings", Context.MODE_PRIVATE), assistant);
  }

  static void setName(Context context, int assistant, String name) {
    context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString(key(assistant, NAME), name.trim()).apply();
  }

  /** What the network log calls an assistant's bb: "bb" for the first, "bb2" for the second. */
  static String logName(int assistant) {
    return assistant == 0 ? "bb" : "bb" + (assistant + 1);
  }

  /** The assistants whose chief can get requests, in order. */
  static List<Integer> ready(Context context) {
    List<Integer> out = new ArrayList<>();
    for (int a = 0; a < COUNT; a++) if (BbBridge.ready(context, a)) out.add(a);
    return out;
  }

  /** The assistants with bb connected (a chief may still be missing). */
  static List<Integer> connected(Context context) {
    List<Integer> out = new ArrayList<>();
    for (int a = 0; a < COUNT; a++) if (new BbBridge(context, a).connected()) out.add(a);
    return out;
  }

  /** More than one assistant can get requests: the panel, calls and notes name them. */
  static boolean several(Context context) {
    return ready(context).size() > 1;
  }

  /**
   * The other assistant already uses this bb (the same bb Connect handle, or the same custom MCP
   * address): -1 if none does. Two assistants on one bb would share its skills, so one topic would
   * win and the other's replies and text to paste would go astray; it's refused.
   */
  static int sameBb(Context context, int assistant, String handle, String url) {
    for (int a = 0; a < COUNT; a++) {
      if (a == assistant) continue;
      BbBridge other = new BbBridge(context, a);
      if (!other.connected()) continue;
      if (handle != null && !handle.isEmpty() && other.mode().equals(BbBridge.CONNECT) && handle.equalsIgnoreCase(other.handle())) return a;
      if (url != null && !url.isEmpty() && other.mode().equals(BbBridge.CUSTOM) && sameAddress(url, other.url())) return a;
    }
    return -1;
  }

  /**
   * Removes an assistant (Settings → bb → Remove this assistant): signs out of its bb (revoking in
   * the background), forgets its chief, topic and settings; its notes still waiting stop being
   * tried (they stay, "not sent"), and its failures aren't reported. Network: not on the main thread.
   */
  static void remove(Context context, int assistant) {
    BbBridge bb = new BbBridge(context, assistant);
    bb.disconnect();
    bb.forgetChief();
    SharedPreferences.Editor e = context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit();
    for (String k :
        new String[] {
          BbBridge.MODE, BbBridge.HANDLE, BbBridge.URL, BbBridge.LINK_BASE, BbBridge.CHIEF_ID, BbBridge.CHIEF_NAME,
          BbBridge.TALKER_ID, BbBridge.TALKER_ON, BbBridge.NTFY_SERVER, ChiefSkills.INSTALLED, ChiefSkills.CHECKED_VERSION,
          ChiefSkills.CHIEF_TOLD, ChiefSkills.TALKER_TOLD, NAME
        })
      e.remove(key(assistant, k));
    e.apply();
    Vault v = new Vault(context);
    v.remove(key(assistant, BbBridge.TOKEN));
    v.remove(key(assistant, BbBridge.NTFY_TOPIC));
    Outbox.forget(context, assistant);
  }

  /** Two MCP addresses for the same server: equal apart from case and a trailing slash. */
  static boolean sameAddress(String a, String b) {
    return a.trim().replaceAll("/+$", "").equalsIgnoreCase(b.trim().replaceAll("/+$", ""));
  }

  /** The assistant a note went to (or goes to): its "assistant" field, the first for older notes. */
  static int of(org.json.JSONObject note) {
    return clamp(note.optInt("assistant", 0));
  }
}
