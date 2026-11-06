package app.driftdictation;

import static org.junit.Assert.*;

import org.junit.Test;

public class TalkAccessibilityTest {
  @Test
  public void textGoesAtTheCursorOrReplacesTheSelection() {
    assertEquals("Dear Jana, see you thanks.", TalkAccessibility.spliced("Dear Jana, thanks.", 11, 11, "see you "));
    assertEquals("Dear Tom, thanks.", TalkAccessibility.spliced("Dear Jana, thanks.", 5, 9, "Tom"));
    assertEquals("hi", TalkAccessibility.spliced("", 0, 0, "hi"));
  }

  @Test
  public void insertedTextIsFoundWhereItWasOrWhereItMovedIfItIsUnique() {
    assertEquals(11, TalkAccessibility.locate("Dear Jana, um see you thanks.", "um see you", 11));
    // Typed before it: it moved, and it's the only one.
    assertEquals(17, TalkAccessibility.locate("Hello Dear Jana, um see you", "um see you", 11));
    // Changed, or there twice: not replaced.
    assertEquals(-1, TalkAccessibility.locate("Dear Jana, um see you soon", "um see you there", 11));
    assertEquals(-1, TalkAccessibility.locate("ab ab", "ab", 7));
    // Web editors turn edge spaces into non-breaking ones.
    assertEquals(9, TalkAccessibility.locate("Rich text PASTED", " PASTED", 9));
  }

  @Test
  public void aPlaceholderReportedAsTheFieldsTextCountsAsEmpty() {
    String bb = "Ask for a follow-up. @ to mention files, folders, sections, or threads";
    // The bb app's editor in Chrome: its placeholder comes as the text, and as its label.
    assertEquals("", TalkAccessibility.own(bb, false, "", bb));
    assertEquals("", TalkAccessibility.own(bb + "\u200b", false, bb, ""));
    assertEquals("", TalkAccessibility.own("Message…", false, "Message", ""));
    assertEquals("", TalkAccessibility.own("anything", true));
    // Real text stays, also with a placeholder around.
    assertEquals("I mean, I don't know", TalkAccessibility.own("I mean, I don't know", false, bb, bb));
    assertEquals("Dear Jana,", TalkAccessibility.own("Dear Jana,", false, "", ""));
    assertEquals("", TalkAccessibility.own("", false, bb));
  }

  @Test
  public void refinedTextOnlyPastesOverAConfirmedSelectionOfTheEarlierText() {
    String field = "Dear Jana, um see you thanks.";
    assertTrue(TalkAccessibility.selects(field, 11, 21, 11, 21, "um see you"));
    // The app moved or ignored the selection, or reports other text there: don't paste over it.
    assertFalse(TalkAccessibility.selects(field, 0, 0, 11, 21, "um see you"));
    assertFalse(TalkAccessibility.selects("Ask for a follow-up. " + field, 11, 21, 11, 21, "um see you"));
    assertFalse(TalkAccessibility.selects("short", 11, 21, 11, 21, "um see you"));
    // Web editors turn edge spaces into non-breaking ones.
    assertTrue(TalkAccessibility.selects("Hi\u00a0there", 2, 8, 2, 8, " there"));
  }

  @Test
  public void theChosenKeyIsTheFirstAssistantsAndTheOtherTheSeconds() {
    int down = android.view.KeyEvent.KEYCODE_VOLUME_DOWN, up = android.view.KeyEvent.KEYCODE_VOLUME_UP;
    // Volume down chosen: down for the first; up for the second once it has a chief.
    assertEquals(0, TalkAccessibility.assistantFor(down, down, true));
    assertEquals(1, TalkAccessibility.assistantFor(up, down, true));
    assertEquals(-1, TalkAccessibility.assistantFor(up, down, false));
    // Volume up chosen: the other way round.
    assertEquals(0, TalkAccessibility.assistantFor(up, up, true));
    assertEquals(1, TalkAccessibility.assistantFor(down, up, true));
    // Keys off: neither, also not for the second.
    assertEquals(-1, TalkAccessibility.assistantFor(down, 0, true));
    assertEquals(-1, TalkAccessibility.assistantFor(up, 0, true));
    assertEquals(0, TalkAccessibility.secondKey(0, true));
    // Other keys are never ours.
    assertEquals(-1, TalkAccessibility.assistantFor(android.view.KeyEvent.KEYCODE_ENTER, down, true));
  }
}
