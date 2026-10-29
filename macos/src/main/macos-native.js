'use strict';
// The few macOS calls Electron doesn't offer, through koffi (a prebuilt FFI, so nothing is
// compiled): synthetic ⌘V (CoreGraphics events), the focused text field (Accessibility API), and
// the whole pasteboard saved and put back (AppKit through the Objective-C runtime), so a paste
// leaves the user's clipboard as it was, with every type on it (text, rich text, images, files).
//
// Everything here needs the Accessibility permission except the pasteboard. Off macOS (tests on
// Linux) load() returns null and callers fall back.

let native; // undefined: not tried; null: unavailable.

function load() {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== 'darwin') return native;
  try {
    native = bind(require('koffi'));
  } catch (e) {
    native = null;
    module.exports.loadError = String(e && e.message ? e.message : e);
  }
  return native;
}

function bind(koffi) {
  const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const AS = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const OBJC = koffi.load('/usr/lib/libobjc.A.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit'); // Registers NSPasteboard.

  const CFRange = koffi.struct('DDCFRange', { location: 'long', length: 'long' });

  const cf = {
    release: CF.func('void CFRelease(void *cf)'),
    getTypeID: CF.func('unsigned long CFGetTypeID(void *cf)'),
    stringTypeID: CF.func('unsigned long CFStringGetTypeID()'),
    booleanTypeID: CF.func('unsigned long CFBooleanGetTypeID()'),
    booleanValue: CF.func('bool CFBooleanGetValue(void *b)'),
    stringCreate: CF.func('void *CFStringCreateWithCharacters(void *alloc, void *chars, long n)'),
    stringLength: CF.func('long CFStringGetLength(void *s)'),
    stringChars: CF.func('void CFStringGetCharacters(void *s, DDCFRange range, void *buffer)'),
  };
  const cg = {
    sourceCreate: AS.func('void *CGEventSourceCreate(int32_t state)'),
    flagsState: AS.func('uint64_t CGEventSourceFlagsState(int32_t state)'),
    keyEvent: AS.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)'),
    setFlags: AS.func('void CGEventSetFlags(void *event, uint64_t flags)'),
    post: AS.func('void CGEventPost(uint32_t tap, void *event)'),
  };
  const ax = {
    trusted: AS.func('bool AXIsProcessTrusted()'),
    systemWide: AS.func('void *AXUIElementCreateSystemWide()'),
    copy: AS.func('int32_t AXUIElementCopyAttributeValue(void *el, void *attr, _Out_ void **value)'),
    set: AS.func('int32_t AXUIElementSetAttributeValue(void *el, void *attr, void *value)'),
    settable: AS.func('int32_t AXUIElementIsAttributeSettable(void *el, void *attr, _Out_ bool *settable)'),
    timeout: AS.func('int32_t AXUIElementSetMessagingTimeout(void *el, float seconds)'),
    valueCreate: AS.func('void *AXValueCreate(uint32_t type, void *value)'),
    valueGet: AS.func('bool AXValueGetValue(void *value, uint32_t type, void *out)'),
  };
  const objc = {
    getClass: OBJC.func('void *objc_getClass(const char *name)'),
    sel: OBJC.func('void *sel_registerName(const char *name)'),
    poolPush: OBJC.func('void *objc_autoreleasePoolPush()'),
    poolPop: OBJC.func('void objc_autoreleasePoolPop(void *pool)'),
    // objc_msgSend has to be called with the exact prototype of each method (arm64).
    id: OBJC.func('void *objc_msgSend(void *self, void *sel)'),
    void: OBJC.func('void objc_msgSend(void *self, void *sel)'),
    voidId: OBJC.func('void objc_msgSend(void *self, void *sel, void *a)'),
    idId: OBJC.func('void *objc_msgSend(void *self, void *sel, void *a)'),
    idULong: OBJC.func('void *objc_msgSend(void *self, void *sel, unsigned long a)'),
    idPtrULong: OBJC.func('void *objc_msgSend(void *self, void *sel, void *bytes, unsigned long n)'),
    idStr: OBJC.func('void *objc_msgSend(void *self, void *sel, const char *s)'),
    long: OBJC.func('long objc_msgSend(void *self, void *sel)'),
    bool: OBJC.func('bool objc_msgSend(void *self, void *sel)'),
    str: OBJC.func('const char *objc_msgSend(void *self, void *sel)'),
    boolId: OBJC.func('bool objc_msgSend(void *self, void *sel, void *a)'),
    boolIdId: OBJC.func('bool objc_msgSend(void *self, void *sel, void *a, void *b)'),
  };

  const sels = {};
  const S = (name) => sels[name] || (sels[name] = objc.sel(name));

  function cfString(text) {
    const chars = Buffer.from(text, 'utf16le');
    return cf.stringCreate(null, chars, chars.length / 2);
  }

  function jsString(ref) {
    if (!ref || cf.getTypeID(ref) !== cf.stringTypeID()) return null;
    const n = cf.stringLength(ref);
    const buf = Buffer.alloc(n * 2);
    if (n > 0) cf.stringChars(ref, { location: 0, length: n }, buf);
    return buf.toString('utf16le');
  }

  const attrs = {};
  const A = (name) => attrs[name] || (attrs[name] = cfString(name));

  let system = null;
  function systemWide() {
    if (!system) {
      system = ax.systemWide();
      ax.timeout(system, 0.6); // A hung app mustn't hang us.
    }
    return system;
  }

  /** An attribute's value (caller releases), or {error} with the AXError. */
  function copyAttr(el, name) {
    const out = [null];
    const err = ax.copy(el, A(name), out);
    return err === 0 ? { value: out[0] } : { error: err };
  }

  const NO_VALUE = -25212, CANNOT_COMPLETE = -25204, API_DISABLED = -25211;

  /** The focused element (caller releases .element), or {error: 'no-focus'|'not-trusted'|code}. */
  function focused() {
    const r = copyAttr(systemWide(), 'AXFocusedUIElement');
    if (r.error !== undefined)
      return { error: r.error === NO_VALUE ? 'no-focus' : r.error === API_DISABLED ? 'not-trusted' : r.error };
    return { element: r.value };
  }

  function stringAttr(el, name) {
    const r = copyAttr(el, name);
    if (r.error !== undefined) return null;
    try {
      return jsString(r.value);
    } finally {
      cf.release(r.value);
    }
  }

  function rangeAttr(el, name) {
    const r = copyAttr(el, name);
    if (r.error !== undefined) return null;
    try {
      const buf = Buffer.alloc(16);
      if (!ax.valueGet(r.value, 4 /* kAXValueCFRangeType */, buf)) return null;
      return { location: Number(buf.readBigInt64LE(0)), length: Number(buf.readBigInt64LE(8)) };
    } finally {
      cf.release(r.value);
    }
  }

  return {
    trusted: () => ax.trusted(),

    /**
     * What has the keyboard focus: {role, editable, value, selection} or {error}. full false: role
     * and editable only (a terminal's or editor's whole text is slow to read).
     */
    focus(full = true) {
      const f = focused();
      if (f.error !== undefined) return { error: f.error };
      try {
        const role = stringAttr(f.element, 'AXRole');
        const out = [false];
        const editable = ax.settable(f.element, A('AXValue'), out) === 0 && out[0];
        if (!full) return { role, editable };
        return { role, editable, value: stringAttr(f.element, 'AXValue'), selection: rangeAttr(f.element, 'AXSelectedTextRange') };
      } finally {
        cf.release(f.element);
      }
    },

    /** Sets the focused field's selected text (inserts at the cursor). Returns the AXError (0 = ok). */
    setSelectedText(text) {
      const f = focused();
      if (f.error !== undefined) return f.error;
      const s = cfString(text);
      try {
        return ax.set(f.element, A('AXSelectedText'), s);
      } finally {
        cf.release(s);
        cf.release(f.element);
      }
    },

    /** Selects a range in the focused field. Returns the AXError (0 = ok). */
    select(range) {
      const f = focused();
      if (f.error !== undefined) return f.error;
      const buf = Buffer.alloc(16);
      buf.writeBigInt64LE(BigInt(range.location), 0);
      buf.writeBigInt64LE(BigInt(range.length), 8);
      const v = ax.valueCreate(4, buf);
      try {
        return v ? ax.set(f.element, A('AXSelectedTextRange'), v) : CANNOT_COMPLETE;
      } finally {
        if (v) cf.release(v);
        cf.release(f.element);
      }
    },

    /** Modifier keys held right now (⌘ ⌥ ⌃ ⇧ fn), as CGEventFlags. */
    modifiersHeld() {
      // Shift, Control, Option, Command (not Caps Lock).
      return Number(BigInt(cg.flagsState(1 /* HIDSystemState */)) & 0x001e0000n);
    },

    /** Is this app the active one? A click on the floating panel or on a notification makes it so. */
    appActive() {
      const pool = objc.poolPush();
      try {
        return objc.bool(objc.id(objc.getClass('NSApplication'), S('sharedApplication')), S('isActive'));
      } finally {
        objc.poolPop(pool);
      }
    },

    /** Gives the focus back to the app that was in front before, without hiding the panel. */
    deactivate() {
      const pool = objc.poolPush();
      try {
        objc.void(objc.id(objc.getClass('NSApplication'), S('sharedApplication')), S('deactivate'));
      } finally {
        objc.poolPop(pool);
      }
    },

    /** ⌘V to the frontmost app, from a private source so held keys don't mix in. */
    pressPaste() {
      const source = cg.sourceCreate(-1 /* kCGEventSourceStatePrivate */);
      const down = cg.keyEvent(source, 9 /* kVK_ANSI_V */, true);
      const up = cg.keyEvent(source, 9, false);
      try {
        cg.setFlags(down, 0x00100000 /* kCGEventFlagMaskCommand */);
        cg.setFlags(up, 0x00100000);
        cg.post(0 /* kCGHIDEventTap */, down);
        cg.post(0, up);
      } finally {
        cf.release(down);
        cf.release(up);
        if (source) cf.release(source);
      }
    },

    pasteboard: {
      changeCount() {
        const pool = objc.poolPush();
        try {
          return objc.long(objc.id(objc.getClass('NSPasteboard'), S('generalPasteboard')), S('changeCount'));
        } finally {
          objc.poolPop(pool);
        }
      },

      /** Everything on the general pasteboard: [[{type, data: Buffer}…] per item]. */
      save() {
        const pool = objc.poolPush();
        try {
          const pb = objc.id(objc.getClass('NSPasteboard'), S('generalPasteboard'));
          const items = objc.id(pb, S('pasteboardItems'));
          const saved = [];
          if (!items) return saved;
          const n = objc.long(items, S('count'));
          for (let i = 0; i < n; i++) {
            const item = objc.idULong(items, S('objectAtIndex:'), i);
            const types = objc.id(item, S('types'));
            const m = types ? objc.long(types, S('count')) : 0;
            const entry = [];
            for (let j = 0; j < m; j++) {
              const type = objc.idULong(types, S('objectAtIndex:'), j);
              const data = objc.idId(item, S('dataForType:'), type);
              if (!data) continue;
              const len = objc.long(data, S('length'));
              const bytes = len > 0 ? Buffer.from(koffi.decode(objc.id(data, S('bytes')), koffi.array('uint8_t', len, 'Typed'))) : Buffer.alloc(0);
              entry.push({ type: objc.str(type, S('UTF8String')), data: bytes });
            }
            if (entry.length) saved.push(entry);
          }
          return saved;
        } finally {
          objc.poolPop(pool);
        }
      },

      /** Replaces the pasteboard's contents with these items. Returns the new changeCount. */
      write(items) {
        const pool = objc.poolPush();
        try {
          const pb = objc.id(objc.getClass('NSPasteboard'), S('generalPasteboard'));
          objc.long(pb, S('clearContents'));
          if (items.length) {
            const array = objc.id(objc.getClass('NSMutableArray'), S('array'));
            for (const entry of items) {
              const item = objc.id(objc.id(objc.getClass('NSPasteboardItem'), S('alloc')), S('init'));
              for (const { type, data } of entry) {
                const nsType = objc.idStr(objc.getClass('NSString'), S('stringWithUTF8String:'), type);
                const nsData = objc.idPtrULong(objc.getClass('NSData'), S('dataWithBytes:length:'), data.length ? data : null, data.length);
                objc.boolIdId(item, S('setData:forType:'), nsData, nsType);
              }
              objc.voidId(array, S('addObject:'), item);
              objc.void(item, S('release'));
            }
            objc.boolId(pb, S('writeObjects:'), array);
          }
          return objc.long(pb, S('changeCount'));
        } finally {
          objc.poolPop(pool);
        }
      },
    },
  };
}

module.exports = { load, loadError: null };
