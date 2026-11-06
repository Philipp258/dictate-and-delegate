'use strict';
// Jev, TypeSafe's decision model through OpenRouter (POST /api/alpha/decisions). After a dictation,
// when there are templates, it says which one the dictation names, so a tapped ✨ Refine uses it;
// in hands-free calls it says whether the turn is done. Nothing starts by itself after a dictation:
// you choose Insert, Refine or Chief on the panel. Jev never sees question names, so the
// instructions and criteria carry all the meaning. The texts are the Android app's (Jev.java).

const { format } = require('./util');
const openrouter = require('./openrouter');

const MODEL = '~typesafe/jev-latest';
const NAME = 'Jev';

/** Slower than this and no template is used; the buttons still work. */
const TIMEOUT_MS = 3000;

const NONE = 'none';

const TEMPLATE =
  "Which of the speaker's saved templates does the dictation ask to use? The speaker names" +
  ' it, for example "use my apartment application".';
const TEMPLATE_NONE = "The dictation doesn't ask for any of the saved templates.";
const TEMPLATE_OPTION = 'The speaker asks to use their saved template "%s".';

/**
 * The request: the dictation as state, and the template question: a choice over "none" and the
 * template names. No templates (or only one called "none"): no question; then Jev isn't asked.
 */
function body(dictation, templates) {
  const questions = {};
  const options = { [NONE]: TEMPLATE_NONE };
  for (const name of templates)
    if (name.toLowerCase() !== NONE) options[name] = format(TEMPLATE_OPTION, name);
  if (Object.keys(options).length > 1)
    questions.template = { type: 'choice', instructions: TEMPLATE, criteria: options };
  return { model: MODEL, state: { dictation }, questions };
}

const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * Reads the answer; anything missing or unreadable counts as no template.
 * Returns { template, cost }: the template ("" for none), the cost (null unknown).
 */
function parse(response, templates) {
  const answers = obj(response && response.answers) || {};
  let template = '';
  const t = obj(answers.template);
  if (t) for (const name of templates) if (name === (t.choice === undefined || t.choice === null ? '' : String(t.choice))) template = name;
  return { template, cost: openrouter.cost(response) };
}

// ------------------------------------------------------------------ hands-free: is the turn done?

/** The hands-free question: where the speaker is at a pause, one choice with its reason. */
const TURN =
  "The speaker talks to their AI chief of staff on a hands-free phone call. This is everything" +
  " they've said in this turn so far, and they just paused. Which describes where they are?";

/** The choices, in this order: the first ones mean the turn is done. */
const TURN_CHOICES = ['over', 'question', 'request', 'end', 'unfinished', 'more'];

function quoted(words, fallback) {
  const s = [];
  for (const w of words || []) if (w.trim() !== '') s.push('"' + w.trim() + '"');
  return s.length === 0 ? fallback : s.join(', ');
}

function turnCriterion(choice, sendWords, endWords) {
  switch (choice) {
    case 'over':
      return (
        'Ends with a cue that this turn is finished and can go: ' +
        quoted(sendWords, '"over"') +
        ', "send it", "go ahead", "that\'s it", "that\'s all". The speaker says it on purpose to' +
        ' send, so it counts even when what came before rambles or trails off ("Well, over.").' +
        ' Said twice or more ("Over. Over.") it\'s emphasis: they\'re surely done.'
      );
    case 'question':
      return 'Has fully asked a question and is now waiting for the answer.';
    case 'request':
      return 'Has said a complete request, instruction or statement and is clearly finished with it.';
    case 'end':
      return 'Wants to end the whole call: ' + quoted(endWords, '"end the call"') + ', "hang up", "bye", "talk later".';
    case 'unfinished':
      return 'Stopped in the middle of a sentence or thought: the last sentence is cut off.';
    default:
      return (
        'Is still thinking aloud, listing, or has announced more to come ("and also", "first",' +
        ' "wait", "let me think").'
      );
  }
}

function turnBody(said, sendWords, endWords) {
  const criteria = {};
  for (const c of TURN_CHOICES) criteria[c] = turnCriterion(c, sendWords, endWords);
  return {
    model: MODEL,
    state: { said },
    questions: { turn: { type: 'choice', instructions: TURN, criteria } },
  };
}

/** org.json's optDouble: a number, or a numeric string; else the fallback. */
function optDouble(o, key, fallback) {
  const v = o[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return fallback;
}

/**
 * Jev's answer: { choice, send, end, cost }: its choice, the probability the turn is done (over,
 * question and request together) and that the call should end (HandsFreeSession.Verdict).
 */
function turnVerdict(response) {
  const answers = obj(response && response.answers);
  const turn = answers ? obj(answers.turn) : null;
  if (!turn) throw new Error('Jev gave no answer');
  const p = obj(turn.probabilities);
  const choice = turn.choice === undefined || turn.choice === null ? '' : String(turn.choice);
  let send, end;
  if (p) {
    send = optDouble(p, 'over', 0) + optDouble(p, 'question', 0) + optDouble(p, 'request', 0);
    end = optDouble(p, 'end', 0);
  } else {
    // Only the choice: as sure as it says.
    const c = optDouble(turn, 'confidence', 1);
    send = choice === 'over' || choice === 'question' || choice === 'request' ? c : 0;
    end = choice === 'end' ? c : 0;
  }
  return { choice, send: Math.min(1, send), end, cost: openrouter.cost(response) };
}

/**
 * Hands-free: asks Jev whether the turn is done; rejects when it fails or is slower than
 * TIMEOUT_MS. openRouter: an OpenRouter client.
 */
async function turn(openRouter, said, sendWords, endWords, { timeoutMs = TIMEOUT_MS } = {}) {
  return turnVerdict(await openRouter.decide(turnBody(said, sendWords, endWords), timeoutMs));
}

/**
 * The hands-free session's judge, as HandsFreeService builds it: judge(said) → Promise<{choice,
 * send, end, cost}>. The session asks it at each longer pause and, in the background, on a send or
 * end phrase ("over and out"): the phrase check is the same question, so the same judge. onCost
 * gets each known cost (the service adds it to the call's total).
 */
function makeJudge({ openRouter, sendWords, endWords, onCost, timeoutMs = TIMEOUT_MS }) {
  return async (said) => {
    const v = await turn(openRouter, said, sendWords, endWords, { timeoutMs });
    if (v.cost !== null && onCost) onCost(v.cost);
    return v;
  };
}

/** Asks Jev which template a dictation names; rejects when it fails or takes longer than TIMEOUT_MS. */
async function ask(openRouter, dictation, templates, { timeoutMs = TIMEOUT_MS } = {}) {
  const r = await openRouter.decide(body(dictation, templates), timeoutMs);
  return parse(r, templates);
}

module.exports = {
  MODEL,
  NAME,
  TIMEOUT_MS,
  NONE,
  TEMPLATE,
  TEMPLATE_NONE,
  TEMPLATE_OPTION,
  TURN,
  TURN_CHOICES,
  body,
  parse,
  turnCriterion,
  turnBody,
  turnVerdict,
  turn,
  makeJudge,
  ask,
};
