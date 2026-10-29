# Dictate & Delegate for macOS

The Android app's features on the Mac: a Dock app with a global shortcut to dictate into any
app, Refine, hand-off to your chief of staff in bb, hands-free calls with the chief, and the
chief's notifications and text to paste. It uses the same providers, settings, bb skills and ntfy
topic as the phone, with your own keys and no server of its own.

Apple Silicon and Intel, macOS 12 or later.

## Install and first start

The app is signed with its own certificate, not Apple's, so macOS asks once before opening it:

1. Unzip `Dictate-and-Delegate-<version>-mac-arm64.zip` (Apple Silicon) or `…-x64.zip` (Intel), or
   open the `.dmg`, and drag **Dictate & Delegate** into **Applications**.
2. Open it. macOS says it can't check it for malicious software: click **Done**, then open
   **System Settings → Privacy & Security**, scroll to "Dictate & Delegate was blocked" and click
   **Open Anyway** (on macOS 14 and earlier, right-click the app → **Open** works too). Or in
   Terminal: `xattr -dr com.apple.quarantine "/Applications/Dictate & Delegate.app"`.
3. Setup walks you through the rest:
   - **OpenRouter key** (stored in the macOS Keychain).
   - **Microphone**: allow it when macOS asks.
   - **Accessibility** (System Settings → Privacy & Security → Accessibility → turn on
     Dictate & Delegate): lets Insert type into the app you're in with ⌘V. Without it, Insert
     copies and the panel says "Copied instead, paste with ⌘V".
   - **Notifications**: allow them when the chief's first message arrives, so you see its
     notifications and text to paste.
   - **bb**: sign in with bb Connect (your bb handle, the part before .getbb.app); the browser hands you back
     to the app. Then pick your chief (and, for calls, the talker).

Updates: replace the app in Applications with the new one. Every build is signed with the same
certificate, so macOS keeps the microphone and Accessibility permissions and the Keychain items.

## Use

- **⌃⇧Space** (Settings → Start) starts dictating, **⌃⇧Space** again stops: like the Android
  volume key. (Not ⌥Space: macOS 15 refuses global shortcuts with only ⌥ or ⌥⇧.) The floating panel then offers 📥 Insert, ✨ Refine, 🧑‍💼 Chief and ✕; tap ✨ or 🧑‍💼 while
  still talking to queue them. The panel never takes the focus, so Insert goes to the app you were
  typing in. **Insert automatically** (Settings → Start) inserts as soon as the text is ready.
- **⌃⌥⇧Space** starts or ends a **hands-free call** (or 📞 on the panel while dictating; pressed
  while dictating, the call takes the dictation over). The call bar shows the state, Send now and
  the red hang-up; during a call ⌃⇧Space and the headset's play/pause button send.
- The Dock icon opens the window with everything else: notes, settings, and the call.

## Differences from Android

- **Start**: a global shortcut (toggle) instead of holding a volume key; no Quick Settings tile.
- **Insert** pastes with ⌘V and then puts back everything that was on the clipboard (all types),
  unless something else changed it meanwhile; the text is marked transient so clipboard managers
  skip it. Android sets the field's text directly; on the Mac that only works in native text fields
  (not in browsers, Electron apps or terminals), so it's the optional "Type directly" method, which
  checks that it landed and pastes when it didn't. "Insert refined" replaces the transcript in
  place when Accessibility can find it unchanged before the cursor, else inserts at the cursor.
- **Notifications**: the Mac has no ntfy app, so Dictate & Delegate shows the chief's ntfy messages
  itself (Settings → bb → Notifications); text to paste comes with Insert and Copy.
- **The ntfy topic** is shared with the phone: "Take the topic and name from bb" (and a new Mac's
  first connection) reads them from the skills the phone installed, so both apps fill the skills
  the same way and don't reinstall them over each other.
- **Settings import**: Android has no settings export, so the Mac takes keys by hand (or from a Mac
  export file: Settings → Data). The topic and name come from bb as above.
- **Voices**: "Android's voice" is the Mac's own voice (pick one under Text-to-speech). There's no
  audio focus/ducking of other apps' sound and no call-audio routing: macOS plays on the current
  output.
- **Echo cancelling** during calls is Chromium's (the same engine as in browsers' calls), plus the
  app's own echo check, instead of Android's call audio mode.
- Insert presses the key in the ⌘V position of a US layout (fine for QWERTY and QWERTZ; Dvorak
  needs the "Dvorak – QWERTY ⌘" layout).
- English UI only for now (Android has eight languages); speech in any language as before.
- Not ported (Android only): the Quick Settings tile, the volume-key service.

## Build (on Linux or a Mac)

```sh
cd macos
npm install
npm test                                  # unit tests (the ported Java tests and the Mac's own)
scripts/e2e.sh dictation                  # the real app, headless, a WAV as microphone (Linux, Xvfb)
DD_WAV_PATTERN=call DD_WAV_SECONDS=7 scripts/e2e.sh handsfree
DD_SIGNING_PEM=<cert+key.pem> RCODESIGN=<rcodesign> node scripts/package.js --arch arm64,x64 --dmg
```

`package.js` wraps the app in Electron for macOS (@electron/packager), signs every binary with
rcodesign and the one self-made certificate (designated requirement: the bundle ID and that
certificate, so macOS treats each build as the same app), and writes zips (and dmgs, built in a
Docker container with libdmg-hfsplus) to `dist/`. The certificate is never committed.

How it's put together: `src/core/` is the Android app's logic ported to Node, file by file
(`CONVENTIONS.md`); `src/main/` is the Electron main process (shortcuts, windows,
Keychain, insert through koffi FFI); `src/renderer/` the windows, including a hidden audio window
for the microphone and replies.
