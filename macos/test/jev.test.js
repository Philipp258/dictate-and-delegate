'use strict';
// JevTest.java, and the hands-free judge (Jev.turnBody/turnVerdict).
const test = require('node:test');
const assert = require('node:assert/strict');
const Jev = require('../src/core/jev');

const templates = ['Apartment application', 'Weekly update'];

test('theRequestAsksOnlyWhichTemplate', () => {
  const r = Jev.body('use my weekly update, shipped the panel', templates);
  assert.equal(r.model, Jev.MODEL);
  assert.equal(r.state.dictation, 'use my weekly update, shipped the panel');
  // Only the template, as a choice over "none" and the user's template names: nothing about
  // refining or the chief (you choose those on the panel).
  assert.deepEqual(Object.keys(r.questions), ['template']);
  const q = r.questions.template;
  assert.equal(q.type, 'choice');
  assert.equal(q.instructions, Jev.TEMPLATE);
  assert.deepEqual(Object.keys(q.criteria), ['none', 'Apartment application', 'Weekly update']);
  assert.equal(q.criteria.none, Jev.TEMPLATE_NONE);
  assert.ok(q.criteria['Weekly update'].includes('"Weekly update"'));
  // No templates (or only one called "none"): no question.
  assert.deepEqual(Jev.body('x', []).questions, {});
  assert.deepEqual(Jev.body('x', ['None']).questions, {});
});

test('theTemplateIsReadAndUnknownsIgnored', () => {
  const r = JSON.parse(
    '{"answers": {"template": {"type": "choice", "choice": "Weekly update", "confidence": 0.9}},' +
      ' "usage": {"cost": 1.9404e-05}}',
  );
  assert.deepEqual(Jev.parse(r, templates), { template: 'Weekly update', cost: 0.000019404 });
  // "none", a name the user doesn't have, a missing answer, nonsense: no template.
  assert.deepEqual(Jev.parse(JSON.parse('{"answers": {"template": {"choice": "Invoice"}}}'), templates), { template: '', cost: null });
  assert.equal(Jev.parse(JSON.parse('{"answers": {"template": {"choice": "none"}}}'), templates).template, '');
  assert.equal(Jev.parse(JSON.parse('{"answers": {"template": "Weekly update"}}'), templates).template, '');
  assert.equal(Jev.parse({}, templates).template, '');
  assert.equal(Jev.parse(null, templates).template, '');
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
