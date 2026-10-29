# Porting conventions (Mac app)

The Mac app is an Electron app in `macos/`. Its logic is a port of the Android app's plain-Java
classes in `app/src/main/java/app/driftdictation/`; behaviour, texts, defaults, thresholds and
protocols stay the same unless the Mac needs otherwise (say so in a comment).

## Layout
- `src/core/` — pure Node (CommonJS, `'use strict'`), **no Electron imports**, so `node --test` runs
  it on Linux. One file per Java class, kebab-case (`HandsFreeSession.java` → `handsfree-session.js`).
- `src/main/` — Electron main process (hotkey, windows, insert, Keychain, wiring).
- `src/renderer/` — windows (panel, call bar, settings, the hidden audio window).
- `test/` — `node:test` + `node:assert/strict`, one `*.test.js` per Java test class, ported test by
  test with the same names (camelCase test names kept as the `test()` title). Run `npm test` in `macos/`.

## Mapping Java to JS
- Threads/executors → async functions. A single-thread executor → `SerialQueue` (`src/core/util.js`);
  a cached pool → just start the async call. `Future.get(ms)` → `withTimeout(promise, ms)`.
  `CountDownLatch` in tests → `deferred()`. `Thread.sleep` polling in tests → `await waitFor(...)`.
  `synchronized` is mostly unnecessary, but think about state that changes across an `await`.
- `BigDecimal` costs → `Number` (null = unknown cost, as in Java).
- `JSONObject` → plain objects. `String.format(Locale.ROOT, …)` → `format()` from util; `tr(…)` → `tr()`
  from util (English only for now).
- Time: keep the injectable clock where the Java has one (`clock = () => Date.now()`).
- HTTP: global `fetch` (Node 22+/Electron 45), injectable where tests need it; timeouts with
  `AbortSignal.timeout(ms)`. WebSockets: the `ws` package (supports custom headers).
- Settings: an object with `get(key, fallback)`, `set(key, value)`, `remove(key)` (`src/core/store.js`,
  `MemoryPrefs` in tests). **Use the Android SharedPreferences key names and defaults unchanged.**
- Secrets (API keys, bb tokens, ntfy topic): a vault with `get(name)` (null if none), `set(name, value)`,
  `remove(name)` (`MemoryVault` in tests). Use the Android `Vault` names unchanged.
- Android `Context` parameters disappear; pass `{ prefs, vault, fetch, log, … }` instead.
- Assets (skills, `models.json`): read from `../app/src/main/assets/` via `src/core/assets.js`
  (`assets.read('skills/chief-of-staff/SKILL.md')`), so both apps share one copy.
- Logging: an injectable `log(line)`; never log secrets.
- Exports: `module.exports = { … }` with the class/functions and the constants the tests use.

## Rules
- Only touch the files your task names (plus new test files); others are being written in parallel.
- Don't commit; the lead commits.
- No new runtime dependencies beyond `ws` and `koffi` without asking in your report.
- Keep comments like the Java: short, saying why.
