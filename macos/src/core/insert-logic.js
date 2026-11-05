'use strict';
// The decisions behind Insert on the Mac, without the Mac: which way text goes into the focused
// app, and where "Insert refined" replaces the transcript in place. src/main/insert.js does the
// macOS calls.

/** Roles of a focused element that take typed text. */
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXSecureTextField']);

/**
 * What the focused element says about pasting: 'text' (a text field) or 'unknown' (something
 * else, or Accessibility can't tell). Both get ⌘V: most apps take it somewhere, and Chromium-based
 * apps (bb's desktop app among them) often report no focused element while a text field has it.
 */
function target(focus) {
  if (!focus || focus.error !== undefined) return 'unknown';
  if (focus.role && TEXT_ROLES.has(focus.role)) return 'text';
  if (focus.editable) return 'text';
  return 'unknown';
}

/**
 * Where to replace `inserted` with refined text: the inserted transcript must still be there,
 * unchanged, right before the cursor (or selected), as Android's replace-in-place requires.
 * value: the field's whole text; selection: {location, length} in UTF-16 units (JS string indices).
 * Returns {location, length} to select, or null to insert at the cursor instead.
 */
function replaceRange(value, selection, inserted) {
  if (typeof value !== 'string' || !inserted || !selection) return null;
  const end = selection.location + selection.length;
  if (selection.location < 0 || end > value.length) return null;
  // The transcript selected as it is.
  if (selection.length === inserted.length && value.slice(selection.location, end) === inserted)
    return { location: selection.location, length: selection.length };
  // The cursor right after it (nothing selected); a space a paste may have added is fine.
  if (selection.length === 0) {
    for (const tail of ['', ' ']) {
      const start = end - tail.length - inserted.length;
      if (start >= 0 && value.slice(start, end) === inserted + tail) return { location: start, length: inserted.length };
    }
  }
  return null;
}

/** Did a direct (Accessibility) insert land? The field's text must have changed to contain it. */
function landed(before, after, text) {
  if (typeof after !== 'string') return false;
  if (typeof before === 'string' && before === after) return false;
  return after.includes(text);
}

module.exports = { TEXT_ROLES, target, replaceRange, landed };
