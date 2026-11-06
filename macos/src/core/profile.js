'use strict';
// What the user told Dictate & Delegate about themselves, and how it handles their dictations.
// Same SharedPreferences keys and defaults as Android; lists are kept as JSON strings like there.

const TOPICS = ['Messages', 'Work notes', 'Emails', 'Ideas & journaling', 'Code & tech', 'Studying', 'Medical', 'Legal'];

const DEFAULT_MODEL = 'microsoft/mai-transcribe-2';

/**
 * Speech models whose host demonstrably applies word hints through OpenRouter (tested October
 * 2026; assets/models.json lists the same). A model saved by an older version that is no longer
 * offered falls back to the default.
 */
const OFFERED = new Set([
  'openai/gpt-transcribe',
  'openai/gpt-4o-transcribe',
  'openai/gpt-4o-mini-transcribe',
  'openai/whisper-1',
  'assemblyai/universal-3-5-pro',
  'microsoft/mai-transcribe-2',
  'microsoft/mai-transcribe-1.5',
]);

class Profile {
  /** prefs: the settings store (get/set/remove). */
  constructor(prefs) {
    this.prefs = prefs;
  }

  topics() {
    return this.list('profileTopics');
  }

  about() {
    return this.prefs.get('profileAbout', '');
  }

  words() {
    return this.list('profileWords');
  }

  /**
   * Removes settings from earlier versions: spoken languages, words collected from fixes, the
   * Simple/Advanced mode, the text model choices, the account at Drift's former server, "Act on
   * requests", and what Jev did by itself (Refine, sending to the chief by its name), as on Android.
   * (forgetRetired isn't called on the Mac; there these keys are simply no longer read.)
   */
  forgetRetired() {
    const p = this.prefs;
    const has = (k) => (typeof p.has === 'function' ? p.has(k) : p.get(k, undefined) !== undefined);
    for (const k of [
      'processing',
      'autoRefine',
      'autoChief',
      'chiefName',
      'profileLanguages',
      'profileSuggestions',
      'profileDismissed',
      'modelMode',
      'mode',
      'textModel',
      'smartModel',
      'account',
      'ledgerCache',
      'consent',
    ])
      if (has(k)) p.remove(k);
  }

  fixedModel() {
    const id = this.prefs.get('model', DEFAULT_MODEL);
    return OFFERED.has(id) ? id : DEFAULT_MODEL;
  }

  hintWords() {
    return this.words();
  }

  /** Refine's instructions: the user's own, or the default. */
  refinePrompt() {
    const value = String(this.prefs.get('processingPrompt', '')).trim();
    return value === '' ? require('./text-model').DEFAULT_PROMPT : value;
  }

  setTopics(value) {
    this.putList('profileTopics', value);
  }

  setAbout(value) {
    this.prefs.set('profileAbout', value.trim());
  }

  addWord(word) {
    const clean = word.trim();
    if (clean === '') return;
    const words = this.words();
    if (!words.map((w) => w.toLowerCase()).includes(clean.toLowerCase())) words.push(clean);
    this.putList('profileWords', words);
  }

  removeWord(word) {
    const lower = word.toLowerCase();
    this.putList(
      'profileWords',
      this.words().filter((w) => w.toLowerCase() !== lower),
    );
  }

  /** Background for the text model; empty parts are left out. */
  context() {
    let s = '';
    if (this.topics().length) s += 'Usually dictates: ' + this.topics().join(', ') + '.\n';
    if (this.about() !== '') s += this.about() + '\n';
    if (this.words().length) s += 'Spell these as written: ' + this.words().join(', ') + '.\n';
    return s.trim();
  }

  list(key) {
    try {
      const saved = this.prefs.get(key, '[]');
      const array = Array.isArray(saved) ? saved : JSON.parse(saved);
      if (!Array.isArray(array)) return [];
      return array.map((v) => String(v));
    } catch {
      return []; // Treat a damaged list as empty.
    }
  }

  putList(key, value) {
    this.prefs.set(key, JSON.stringify(value));
  }
}

module.exports = { Profile, TOPICS, DEFAULT_MODEL, OFFERED };
