'use strict';
// Mac: the settings profile and templates on the shared prefs (no Java test class).
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPrefs } = require('../src/core/store');
const { Profile, DEFAULT_MODEL } = require('../src/core/profile');
const { Templates, INSTRUCTIONS, MAX_TEXT } = require('../src/core/templates');
const TextModel = require('../src/core/text-model');

test('theProfileKeepsAndroidsKeysAndDefaults', () => {
  const prefs = new MemoryPrefs({ model: 'deepgram/nova-3', processing: false, consent: true, autoRefine: true, chiefName: 'Henry' });
  const p = new Profile(prefs);
  assert.equal(p.fixedModel(), DEFAULT_MODEL);
  assert.equal(p.refinePrompt(), TextModel.DEFAULT_PROMPT);
  p.forgetRetired();
  assert.equal(prefs.has('processing'), false);
  assert.equal(prefs.has('consent'), false);
  // What used to route by content is gone, its settings too.
  for (const k of ['autoRefine', 'chiefName']) assert.equal(prefs.has(k), false, k);
  assert.equal(typeof p.autoRefine, 'undefined');
  assert.equal(typeof p.chiefName, 'undefined');
  p.addWord(' Kubernetes ');
  p.addWord('kubernetes');
  p.addWord('Ljubljana');
  p.removeWord('LJUBLJANA');
  assert.equal(prefs.get('profileWords'), '["Kubernetes"]'); // A JSON string, as on Android.
  p.setTopics(['Emails']);
  p.setAbout(' Product manager. ');
  assert.equal(p.context(), 'Usually dictates: Emails.\nProduct manager.\nSpell these as written: Kubernetes.');
  prefs.set('profileTopics', '{broken');
  assert.deepEqual(p.topics(), []);
});

test('templatesAreSavedPlainAndOnlyTheNamedOneGoesToTheModel', () => {
  const prefs = new MemoryPrefs();
  const t = new Templates({ prefs });
  const id = t.save(null, ' Weekly update ', ' Done: …\nNext: … ');
  const empty = t.save(null, 'Empty', '   ');
  assert.equal(t.get(id).name, 'Weekly update');
  assert.deepEqual(t.names(), ['Weekly update']);
  assert.equal(
    t.prompt('weekly UPDATE'),
    '\n\n' + INSTRUCTIONS + '\n\n<template name="Weekly update">\nDone: …\nNext: …\n</template>',
  );
  assert.equal(t.prompt(''), '');
  assert.equal(t.prompt('Empty'), '');
  t.save(id, 'Say "hi"', 'x'.repeat(MAX_TEXT + 10));
  assert.equal(t.get(id).text.length, MAX_TEXT);
  assert.ok(t.prompt('Say "hi"').includes('<template name="Say \'hi\'">'));
  t.delete(empty);
  assert.equal(t.all().length, 1);
  // Stored as Android stores it: a JSON string under "templates".
  assert.deepEqual(JSON.parse(prefs.get('templates')), [{ id, name: 'Say "hi"', text: 'x'.repeat(MAX_TEXT) }]);
  prefs.set('templates', '[{"name": "no id"}]');
  assert.deepEqual(t.all(), []);
});
