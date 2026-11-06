'use strict';
// JevTest.java, and the hands-free judge (Jev.turnBody/turnVerdict).
const test = require('node:test');
const assert = require('node:assert/strict');
const Jev = require('../src/core/jev');

const templates = ['Apartment application', 'Weekly update'];

test('theRequestAsksOnlyWhatMatters', () => {
  const all = Jev.body('Henry, book a table', templates, true, 'Henry');
  assert.equal(all.model, Jev.MODEL);
  assert.equal(all.state.dictation, 'Henry, book a table');
  const q = all.questions;
  assert.equal(q.refine.type, 'noul');
  assert.equal(q.refine.instructions, Jev.REFINE);
  // The chief question carries the chief's name.
  assert.ok(q.chief.instructions.includes('is called Henry.'));
  assert.ok(!q.chief.instructions.includes('%1$s'));
  const yesNo = q.chief.criteria;
  assert.ok(yesNo.true.startsWith('The speaker addresses Henry directly'));
  assert.ok(yesNo.false.startsWith('Henry only comes up'));
  // The template is a choice over "none" and the user's template names.
  const options = q.template.criteria;
  assert.equal(q.template.type, 'choice');
  assert.equal(Object.keys(options).length, 3);
  assert.equal(options.none, Jev.TEMPLATE_NONE);
  assert.ok(options['Weekly update'].includes('"Weekly update"'));

  // Auto-refine off, no name: only the template; no templates either: nothing.
  const some = Jev.body('x', templates, false, '').questions;
  assert.equal(Object.keys(some).length, 1);
  assert.ok('template' in some);
  assert.equal(Object.keys(Jev.body('x', [], false, '').questions).length, 0);
  assert.ok(!('template' in Jev.body('x', [], true, '').questions));
});

test('answersAreReadAndUnknownsIgnored', () => {
  const r = JSON.parse(
    '{"answers": {"refine": {"type": "noul", "noul": 0.82},' +
      ' "template": {"type": "choice", "choice": "Weekly update", "confidence": 0.9},' +
      ' "chief": {"type": "noul", "noul": 0.03}}, "usage": {"cost": 1.9404e-05}}',
  );
  const a = Jev.parse(r, templates);
  assert.ok(Math.abs(a.refine - 0.82) < 1e-9);
  assert.ok(Math.abs(a.chief - 0.03) < 1e-9);
  assert.equal(a.template, 'Weekly update');
  assert.equal(a.cost, 0.000019404);
  assert.equal(Jev.detail(a), 'refine 0.82 · chief 0.03 · Weekly update');

  // "none", a name the user doesn't have, a missing answer, nonsense: nothing.
  const b = Jev.parse(JSON.parse('{"answers": {"template": {"choice": "Invoice"}, "refine": {"noul": "high"}}}'), templates);
  assert.equal(b.refine, null);
  assert.equal(b.chief, null);
  assert.equal(b.template, '');
  assert.equal(b.cost, null);
  assert.equal(Jev.detail(b), '');
  assert.equal(Jev.parse(JSON.parse('{"answers": {"chief": {"noul": 1.7}}}'), templates).chief, 1.0);
});

const a = (refine, template, chief) => ({ refine, template, chief, cost: null });

test('refineStartsByItselfAboveItsThresholdOrForATemplate', () => {
  assert.ok(Jev.decide(a(Jev.REFINE_AT, '', 0.0), true, true, true, false).refine);
  assert.ok(!Jev.decide(a(Jev.REFINE_AT - 0.01, '', 0.0), true, true, true, false).refine);
  const t = Jev.decide(a(0.1, 'Weekly update', 0.0), true, true, true, false);
  assert.ok(t.refine);
  assert.equal(t.template, 'Weekly update');
  // Switched off: nothing starts, but a tapped Refine still uses the template.
  const off = Jev.decide(a(0.99, 'Weekly update', 0.0), false, true, true, false);
  assert.ok(!off.refine);
  assert.equal(off.template, 'Weekly update');
});

test('theChiefGetsItOnlyWhenNamedAndJevIsSure', () => {
  const sure = Jev.CHIEF_AT;
  const unsureAt = (Jev.HINT_AT + Jev.CHIEF_AT) / 2;
  const d = Jev.decide(a(0.95, '', sure), true, true, true, true);
  assert.ok(d.chief);
  // What goes to the chief isn't refined by itself.
  assert.ok(!d.refine);
  assert.ok(!d.hint);
  // Unsure: nothing sent, 🧑‍💼 highlighted, Refine as Jev says.
  const unsure = Jev.decide(a(0.95, '', unsureAt), true, true, true, true);
  assert.ok(!unsure.chief);
  assert.ok(unsure.hint);
  assert.ok(unsure.refine);
  const no = Jev.decide(a(0.0, '', Jev.HINT_AT - 0.01), true, true, true, true);
  assert.ok(!no.chief);
  assert.ok(!no.hint);
  // The name didn't come up: never sent, no hint, whatever the answer.
  const unnamed = Jev.decide(a(0.0, '', 0.99), true, true, true, false);
  assert.ok(!unnamed.chief);
  assert.ok(!unnamed.hint);
  // Switched off: never sent, but highlighted; no chief set up: neither.
  const off = Jev.decide(a(0.0, '', 0.99), true, false, true, true);
  assert.ok(!off.chief);
  assert.ok(off.hint);
  const none = Jev.decide(a(0.0, '', 0.99), true, true, false, true);
  assert.ok(!none.chief);
  assert.ok(!none.hint);
});

test('withoutAnAnswerNothingHappensByItself', () => {
  const d = Jev.decide(null, true, true, true, false);
  assert.ok(!d.refine);
  assert.ok(!d.chief);
  assert.ok(!d.hint);
  assert.equal(d.template, '');
  // The name came up but Jev failed: not sent, only highlighted.
  const named = Jev.decide(null, true, true, true, true);
  assert.ok(!named.chief);
  assert.ok(named.hint);
  assert.ok(!Jev.decide(a(0.9, '', null), true, true, true, true).chief);
});

test('theNameIsFoundAsAWholeWordWithItsMishearings', () => {
  const yes = [
    'Okay, so I want to talk to Henry about the invoices',
    'this time it should go to Henry as well',
    'Henry, book the train',
    'hey henry find the cheapest flight',
    'this is for Henri',
    'Henrie should look at it',
    "that's Henry's job",
    'Das soll an Henrys Liste',
    'HENRY, remind me tomorrow',
  ];
  for (const said of yes) assert.ok(Jev.mentions(said, 'Henry'), said);
  const no = ['Henryk called', 'tidy this up into an email for Jana', 'the chief of staff', ''];
  for (const said of no) assert.ok(!Jev.mentions(said, 'Henry'), said);
  // No name, no chief.
  assert.ok(!Jev.mentions('Henry, book the train', ''));
  assert.ok(!Jev.mentions('Henry, book the train', '  '));
  // Names with spaces, and names that end in -i or -ie.
  assert.ok(Jev.mentions('send it to the chief-of-staff', 'chief of staff'));
  assert.ok(Jev.mentions('Jenny, look', 'Jenni'));
  assert.ok(Jev.mentions('Josy, look', 'Josie'));
  assert.ok(Jev.mentions('Zoë, schau mal', 'zoë'));
  assert.ok(!Jev.mentions('Zoëlle', 'Zoë'));
  // Alex: possessives yes; Alexa, Alexander and Alexandra are other names.
  for (const said of ['Alex, book a table', "this is Alex' job", 'Alexs Liste', "that's Alex's", 'hey alex'])
    assert.ok(Jev.mentions(said, 'Alex'), said);
  for (const said of ['Alexa, play music', 'Alexander called', 'ask Alexandra']) assert.ok(!Jev.mentions(said, 'Alex'), said);
  // Mac: regex characters in a name are taken literally.
  assert.ok(Jev.mentions('ask C.J. about it', 'C.J'));
  assert.ok(!Jev.mentions('CxJ look', 'C.J'));
});

// ------------------------------------------------------------------ hands-free (no Java test class)

test('theTurnQuestionNamesTheSendAndEndWords', () => {
  const b = Jev.turnBody('book a table over and out', ['over and out'], ['end the call', ' ']);
  assert.equal(b.model, Jev.MODEL);
  assert.equal(b.state.said, 'book a table over and out');
  const turn = b.questions.turn;
  assert.equal(turn.type, 'choice');
  assert.equal(turn.instructions, Jev.TURN);
  assert.deepEqual(Object.keys(turn.criteria), Jev.TURN_CHOICES);
  assert.equal(
    turn.criteria.over,
    'Ends with a cue that this turn is finished and can go: "over and out", "send it", "go ahead", "that\'s it", "that\'s all".' +
      ' The speaker says it on purpose to send, so it counts even when what came before rambles or trails off ("Well, over.").' +
      ' Said twice or more ("Over. Over.") it\'s emphasis: they\'re surely done.',
  );
  assert.equal(turn.criteria.end, 'Wants to end the whole call: "end the call", "hang up", "bye", "talk later".');
  // Without words, the defaults.
  const none = Jev.turnBody('x', [], []).questions.turn.criteria;
  assert.ok(none.over.includes(': "over", "send it"'));
  assert.ok(none.end.includes(': "end the call", "hang up"'));
});

test('theVerdictAddsUpTheDoneChoices', () => {
  const v = Jev.turnVerdict({
    answers: { turn: { choice: 'question', probabilities: { over: 0.2, question: 0.5, request: 0.2, end: 0.05, more: 0.05 } } },
    usage: { cost: 0.00002 },
  });
  assert.equal(v.choice, 'question');
  assert.ok(Math.abs(v.send - 0.9) < 1e-9);
  assert.equal(v.end, 0.05);
  assert.equal(v.cost, 0.00002);
  // Never above 1; only the choice: as sure as it says.
  assert.equal(Jev.turnVerdict({ answers: { turn: { choice: 'over', probabilities: { over: 0.7, request: 0.6 } } } }).send, 1);
  const only = Jev.turnVerdict({ answers: { turn: { choice: 'end', confidence: 0.85 } } });
  assert.deepEqual(only, { choice: 'end', send: 0, end: 0.85, cost: null });
  assert.equal(Jev.turnVerdict({ answers: { turn: { choice: 'request' } } }).send, 1);
  assert.throws(() => Jev.turnVerdict({ answers: {} }), /Jev gave no answer/);
});

test('theJudgeAsksJevAndReportsTheCost', async () => {
  const bodies = [];
  const openRouter = {
    async decide(body, timeoutMs) {
      bodies.push({ body, timeoutMs });
      return { answers: { turn: { choice: 'over', probabilities: { over: 0.9 } } }, usage: { cost: 0.00002 } };
    },
  };
  const costs = [];
  const judge = Jev.makeJudge({ openRouter, sendWords: ['over and out'], endWords: ['end the call'], onCost: (c) => costs.push(c) });
  const v = await judge('that is all over and out');
  assert.deepEqual(v, { choice: 'over', send: 0.9, end: 0, cost: 0.00002 });
  assert.deepEqual(costs, [0.00002]);
  assert.equal(bodies[0].timeoutMs, Jev.TIMEOUT_MS);
  assert.equal(bodies[0].body.state.said, 'that is all over and out');
});
