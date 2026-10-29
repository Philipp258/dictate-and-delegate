'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ChiefSkills = require('../src/core/chief-skills');

const COPY_ACTION = 'app.driftdictation.COPY_CHIEF_TEXT'; // TalkAccessibility.COPY_ACTION on Android

function handsFree() {
  try {
    return require('../src/core/hands-free');
  } catch {
    return null;
  }
}

const template = (name) => ChiefSkills.template(name);
const router = (name, topic, link) => ChiefSkills.fill(ChiefSkills.ROUTER, template(ChiefSkills.ROUTER), name, 'https://ntfy.sh', topic, link);
const talker = (name, server, topic) => ChiefSkills.fill(ChiefSkills.TALKER, template(ChiefSkills.TALKER), name, server, topic, 'https://x.getbb.app');

test('theTemplatesAreFilledIn', () => {
  const r = router('Alex', 'talkrouter-abc', 'https://someone.getbb.app');
  assert.ok(!r.includes('{{'), r);
  assert.ok(r.includes("the voice app on Alex's phone"));
  assert.ok(r.includes("--data-binary @- https://ntfy.sh/talkrouter-abc <<'TEXT'"));
  assert.ok(r.includes('-H "Click: https://someone.getbb.app/threads/$BB_THREAD_ID"'));
  // The paste flow: request ID, tags and the Copy broadcast.
  assert.ok(r.includes('[request: <id>]'));
  assert.ok(r.includes('Tags: talkrouter-paste,req-<id>'));
  assert.ok(r.includes('intent=' + COPY_ACTION + ', extras.request=<id>'));
  assert.ok(r.startsWith('---\nname: dictate-and-delegate\n'));
  const c = ChiefSkills.fill(ChiefSkills.CHIEF, template(ChiefSkills.CHIEF), 'Alex', 'https://ntfy.sh', 't', '');
  assert.ok(c.includes("You're Alex's chief of staff."));
  assert.ok(c.includes("When a decision is Alex's, ask."));
  assert.ok(!c.includes('{{'));
});

test('theTalkerSkillIsFilledInWithTheAppsNtfyAndNothingPersonal', () => {
  const t = talker('Alex', 'https://ntfy.example.org', 'talkrouter-abc');
  assert.ok(!t.includes('{{'), t);
  assert.ok(t.startsWith('---\nname: dictate-and-delegate-talker\n'));
  assert.ok(t.includes("the voice app on Alex's phone"));
  assert.ok(t.includes("--data-binary @- https://ntfy.example.org/talkrouter-abc <<'TEXT'"));
  assert.ok(t.includes('Tags: talkrouter-speak,req-<id>'));
  assert.ok(t.includes('use `Tags: talkrouter-speak` without `req-`'));
  // The rules it carries.
  assert.ok(t.includes('you never pass anything on and never say you will'));
  assert.ok(t.includes('use no tools except speaking'));
  assert.ok(t.includes('A briefing, background the chief sends you'));
  assert.ok(t.includes('Answer their new message first.'));
  assert.ok(t.includes('`[didn\'t hear your reply: "…"]`'));
  assert.ok(t.includes('`[heard up to: "…"]`'));
  assert.ok(t.includes('Never invent it.'));
  assert.ok(t.includes('say only a very short holding phrase: "Checking." / "One moment." / "On it."'));
  assert.ok(t.includes("don't explain what will be checked, don't guess, don't add advice or warnings of your own"));
  assert.ok(t.includes('Everything else, including general knowledge'));
  assert.ok(t.includes('as the answer itself (no "the chief says")'));
  assert.ok(t.includes("Use it only if Alex asks what's going on."));
  assert.ok(t.includes('[you are the talker]'));
  // Open source: no thread IDs, no topic, no person of its own.
  const tmpl = template(ChiefSkills.TALKER);
  assert.ok(!tmpl.includes('thr_'));
  assert.ok(!tmpl.includes('talkrouter-I'));
  assert.ok(!tmpl.includes('Philipp'));
  assert.ok(!tmpl.includes('Alex'));
  const hash = ChiefSkills.marker(t);
  assert.ok(t.endsWith('\n<!-- dictate-and-delegate-talker-skill: ' + hash + ' -->\n'));
  assert.notEqual(hash, ChiefSkills.marker(talker('Alex', 'https://ntfy.example.org', 'talkrouter-new')));
  assert.notEqual(hash, ChiefSkills.marker(talker('Alex', 'https://ntfy.sh', 'talkrouter-abc')));
  assert.ok(talker(' ', 'https://ntfy.sh', 't').includes("the voice app on the user's phone"));
});

test('aTalkerIsToldAgainOnlyWhenItOrItsSkillChanged', () => {
  const files = { [ChiefSkills.TALKER]: talker('Alex', 'https://ntfy.sh', 'a') };
  const told = ChiefSkills.talkerToldValue('thr_talk', files);
  assert.equal(told, 'thr_talk:' + ChiefSkills.marker(files[ChiefSkills.TALKER]));
  assert.equal(ChiefSkills.talkerToldValue('thr_talk', { [ChiefSkills.TALKER]: talker('Alex', 'https://ntfy.sh', 'a') }), told);
  assert.notEqual(ChiefSkills.talkerToldValue('thr_other', files), told);
  assert.notEqual(ChiefSkills.talkerToldValue('thr_talk', { [ChiefSkills.TALKER]: talker('Alex', 'https://ntfy.sh', 'b') }), told);
  assert.equal(ChiefSkills.talkerToldValue('', files), '', 'no talker, nothing to tell');
  assert.ok(ChiefSkills.TALKER_START.includes('Use the dictate-and-delegate-talker skill'));
  const HandsFree = handsFree();
  if (HandsFree) assert.equal(HandsFree.TALKER_CALL_STARTED, '[hands-free call started] [you are the talker]');
});

test('theChiefSkillStatesTheTalkerContractAndTheTurnRule', () => {
  const r = router('Alex', 't', '');
  assert.ok(r.includes('from the call start until `[hands-free call ended]` you post nothing to ntfy: no spoken replies and no notifications'));
  assert.ok(r.includes('bb thread tell <talker thread id> --mode queue --message-file -'));
  assert.ok(r.includes('[chief] <what Alex needs to know or decide'));
  assert.ok(r.includes("A reply never plays while it's Alex's turn"));
  assert.ok(!r.includes("plays at their next pause, even if they haven't sent"), 'the old pause rule is gone');
  assert.ok(r.includes('it was dropped because Alex had already sent a newer message'));
});

test('withoutANameItSaysTheUser', () => {
  const c = ChiefSkills.fill(ChiefSkills.CHIEF, template(ChiefSkills.CHIEF), '  ', 'https://ntfy.sh', 't', '');
  assert.ok(c.includes("Act as the user's chief of staff"));
  assert.ok(c.includes("You manage the user's tasks"));
  const r = router('', 't', '');
  assert.ok(r.includes('when you need the user,'));
  // Without a link base there's no Click header.
  assert.ok(!r.includes('Click:'));
  assert.ok(!r.includes('{{'));
});

test('theMarkerChangesWithTheTemplateAndThePlaceholdersOnly', () => {
  const a = router('Alex', 'talkrouter-abc', 'https://x.getbb.app');
  const hash = ChiefSkills.marker(a);
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.ok(a.endsWith('\n<!-- dictate-and-delegate-skill: ' + hash + ' -->\n'));
  assert.equal(ChiefSkills.marker(router('Alex', 'talkrouter-abc', 'https://x.getbb.app')), hash);
  assert.notEqual(ChiefSkills.marker(router('Alex', 'talkrouter-new', 'https://x.getbb.app')), hash);
  assert.notEqual(ChiefSkills.marker(router('Sam', 'talkrouter-abc', 'https://x.getbb.app')), hash);
  assert.notEqual(ChiefSkills.marker(router('Alex', 'talkrouter-abc', 'https://y.getbb.app')), hash);
  const changed = template(ChiefSkills.ROUTER).replace('odd misheard word', 'occasional misheard word');
  assert.notEqual(ChiefSkills.marker(ChiefSkills.fill(ChiefSkills.ROUTER, changed, 'Alex', 'https://ntfy.sh', 'talkrouter-abc', 'https://x.getbb.app')), hash);
  assert.equal(ChiefSkills.marker('no marker here'), '');
});

test('outdatedMeansMissingUnmarkedOrAnotherHash', () => {
  const files = {};
  files[ChiefSkills.CHIEF] = ChiefSkills.fill(ChiefSkills.CHIEF, template(ChiefSkills.CHIEF), '', 's', 't', '');
  files[ChiefSkills.ROUTER] = router('', 't', '');
  const c = ChiefSkills.marker(files[ChiefSkills.CHIEF]);
  const r = ChiefSkills.marker(files[ChiefSkills.ROUTER]);
  assert.deepEqual(ChiefSkills.outdated(files, { 'chief-of-staff': c, 'dictate-and-delegate': r }), []);
  assert.deepEqual(ChiefSkills.outdated(files, { 'chief-of-staff': c, 'dictate-and-delegate': 'old' }), ['dictate-and-delegate']);
  assert.deepEqual(ChiefSkills.outdated(files, {}), ['chief-of-staff', 'dictate-and-delegate']);
  // After the rename: the old talk-router skill still there counts as outdated, so it's removed.
  assert.deepEqual(ChiefSkills.outdated(files, { 'chief-of-staff': c, 'dictate-and-delegate': r, 'talk-router': 'abc' }), ['talk-router']);
  assert.equal(ChiefSkills.summary(files), 'chief-of-staff:' + c + ',dictate-and-delegate:' + r);
});

test('theInstallThreadGetsTheFilesVerbatim', () => {
  const files = { [ChiefSkills.CHIEF]: 'chief file\n', [ChiefSkills.ROUTER]: 'router file\n', [ChiefSkills.TALKER]: 'talker file\n' };
  const p = ChiefSkills.installPrompt(files);
  assert.ok(p.includes("`chief-of-staff` describes the role of the user's chief of staff"));
  assert.ok(p.includes('`dictate-and-delegate-talker` is for the talker'));
  assert.ok(p.includes('shows `chief-of-staff`, `dictate-and-delegate` and `dictate-and-delegate-talker` as user skills and no `talk-router`'));
  assert.ok(p.includes('===== ~/.bb/skills/dictate-and-delegate-talker/SKILL.md (begins on the next line) =====\ntalker file\n'));
  assert.ok(ChiefSkills.checkSnippet().includes('"dictate-and-delegate-talker"'));
  assert.ok(p.includes('===== ~/.bb/skills/dictate-and-delegate/SKILL.md (begins on the next line) =====\nrouter file\n===== end of dictate-and-delegate ====='));
  assert.ok(p.includes("remove `~/.bb/skills/talk-router` if it's there"));
  assert.ok(p.includes('so keep it as it is'));
  assert.ok(p.includes('fix it the way the author obviously meant'));
  assert.ok(!p.includes('byte for byte'));
  assert.ok(ChiefSkills.spawnSnippet(p).includes('"--title","Dictate & Delegate: install skills"'));
  assert.ok(ChiefSkills.checkSnippet().includes('x.scope === "bb-user"'));
});

/** The front matter between the --- lines as key → value, unquoting a double-quoted value. */
function frontMatter(file) {
  assert.ok(file.startsWith('---\n'));
  const end = file.indexOf('\n---\n', 4);
  assert.ok(end > 0);
  const out = {};
  for (const line of file.substring(4, end).split('\n')) {
    const colon = line.indexOf(': ');
    assert.ok(colon > 0 && /^[a-z-]+$/.test(line.substring(0, colon)), line);
    let value = line.substring(colon + 2);
    if (value.startsWith('"')) {
      // A closed double-quoted string: only \\ and \" escapes, nothing after the closing quote.
      let v = '';
      let i = 1;
      for (; i < value.length && value.charAt(i) !== '"'; i++) {
        const ch = value.charAt(i);
        if (ch === '\\') {
          const next = value.charAt(++i);
          assert.ok(next === '\\' || next === '"', line);
          v += next;
        } else v += ch;
      }
      assert.equal(i, value.length - 1, line);
      value = v;
    } else assert.ok(!value.includes(': ') && !value.includes('"'), line);
    out[line.substring(0, colon)] = value;
  }
  return out;
}

test('theFrontMatterStaysValidWithATrickyName', () => {
  const name = 'Ada "A." O\'Neil: Jr \\ x';
  for (const skill of ChiefSkills.NAMES) {
    const filled = ChiefSkills.fill(skill, template(skill), name, 'https://ntfy.sh', 't', 'https://x.getbb.app');
    const front = frontMatter(filled);
    assert.equal(front.name, skill);
    assert.ok(front.description.includes(name + "'s"), front.description);
    assert.equal(Object.keys(front).length, 2);
    // In the body the name stays as typed.
    assert.ok(filled.substring(filled.indexOf('\n---\n', 4)).includes(name));
  }
  // Without a name too.
  for (const skill of ChiefSkills.NAMES) {
    assert.ok(frontMatter(ChiefSkills.fill(skill, template(skill), '', 's', 't', '')).description.includes('the user'));
  }
});

// Mac: a name with $ patterns is put in as typed (String.replace would read $& and $').
test('aNameWithDollarSignsIsTakenLiterally', () => {
  const r = router("Jo $& $' $1", 't', '');
  assert.ok(r.includes("when you need Jo $& $' $1,"));
});

// Mac: what the phone filled an installed skill with, read back so the Mac fills it the same.
test('anInstalledSkillGivesBackWhatItWasFilledWith', () => {
  for (const [name, link] of [
    ['Alex', 'https://someone.getbb.app'],
    ['Ada "A." O\'Neil: Jr \\ x', ''],
    ['', 'https://x.getbb.app'],
  ]) {
    const filled = router(name, 'talkrouter-AbC_12-x', link);
    const p = ChiefSkills.parseInstalled(filled, template(ChiefSkills.ROUTER));
    assert.deepEqual(
      { server: p.server, topic: p.topic, linkBase: p.linkBase, name: p.name },
      { server: 'https://ntfy.sh', topic: 'talkrouter-AbC_12-x', linkBase: link, name },
    );
    assert.equal(p.marker, ChiefSkills.marker(filled));
  }
  const t = ChiefSkills.parseInstalled(talker('Sam', 'http://127.0.0.1:8799', 'tp'), template(ChiefSkills.TALKER));
  assert.deepEqual([t.server, t.topic, t.name, t.linkBase], ['http://127.0.0.1:8799', 'tp', 'Sam', null]);
  assert.equal(ChiefSkills.nameIn('nothing like it', template(ChiefSkills.ROUTER)), null);
});
