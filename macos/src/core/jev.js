'use strict';
// Jev, TypeSafe's decision model through OpenRouter (POST /api/alpha/decisions): after the
// transcript, it answers up to three questions about the dictation, each with a probability. Talk
// Router acts on its own only when the answer is clear; otherwise the panel's buttons are one tap
// away. Jev never sees question names, so the instructions and criteria carry all the meaning.
// The texts are the Android app's (Jev.java) word for word; scripts/qa/jev-check.py checks those.

const { format } = require('./util');
const openrouter = require('./openrouter');

const MODEL = '~typesafe/jev-latest';
const NAME = 'Jev';

/** Slower than this and nothing happens by itself; the buttons still work. */
const TIMEOUT_MS = 3000;

/** Refine starts by itself at this probability (or when a template is named). */
const REFINE_AT = 0.5;

/** Sent to the chief by itself only this sure that it is meant for it (its name came up first). */
const CHIEF_AT = 0.8;

/** Between this and CHIEF_AT the 🧑‍💼 button is highlighted as a hint, nothing is sent. */
const HINT_AT = 0.5;

const NONE = 'none';

const REFINE =
  'Does the speaker want this dictation turned into a finished text by an assistant, or' +
  ' does it clearly need that before anyone can read it?';
const REFINE_YES =
  'The speaker asks for a text to be written or changed (tidy this up, make it more formal,' +
  ' turn it into an email, a list or a reply, translate it, shorten it, fill in a' +
  ' template, draft something), or the dictation is a message, email or note so full of' +
  ' filler words, false starts and self-corrections ("no wait", "I mean") that it' +
  " can't be sent as it is.";
const REFINE_NO =
  'The speaker dictated something that reads fine as said: a message, note or to-do in' +
  ' plain sentences. Asking the reader to write something ("can you send me the' +
  ' report") is part of the message, and a task for someone else is not a request to' +
  ' write a text.';

const TEMPLATE =
  "Which of the speaker's saved templates does the dictation ask to use? The speaker names" +
  ' it, for example "use my apartment application".';
const TEMPLATE_NONE = "The dictation doesn't ask for any of the saved templates.";
const TEMPLATE_OPTION = 'The speaker asks to use their saved template "%s".';

const CHIEF =
  "The speaker's chief of staff, an AI agent, is called %1$s. Is the dictation, or part of" +
  ' it, meant for %1$s: does the speaker talk to %1$s or say that this should go to' +
  ' %1$s, for example "%1$s, …", "hey %1$s, …", "this is for %1$s", "send' +
  ' this to %1$s", "I want to talk to %1$s about …", "%1$s should look at this as' +
  ' well", in any language (German: "%1$s, …", "das ist für %1$s", "schick das' +
  ' an %1$s")?';
const CHIEF_YES =
  'The speaker addresses %1$s directly or says the dictation should go to %1$s or be handled' +
  ' by %1$s: an instruction about where this dictation goes.';
const CHIEF_NO =
  '%1$s only comes up in what the dictation says: a message to someone else that mentions' +
  ' %1$s ("I\'ll bring %1$s along", "%1$s and I met yesterday", "say hi to %1$s' +
  ' from me"), a text to be written for %1$s as its reader ("write a thank-you note to' +
  ' %1$s"), or a note about %1$s, without asking for this to go to %1$s.';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The name as a pattern: case-insensitive, as a whole word, also with a possessive ("Henry's",
 * "Henrys") and as speech models mishear it ("Henri", "Henrie").
 */
function namePattern(name) {
  const n = name.trim().toLowerCase();
  const forms = new Set([n]);
  if (n.endsWith('y')) {
    const stem = n.substring(0, n.length - 1);
    forms.add(stem + 'i');
    forms.add(stem + 'ie');
    forms.add(stem + 'ey');
  } else if (n.endsWith('ie')) forms.add(n.substring(0, n.length - 2) + 'y');
  else if (n.endsWith('i')) forms.add(n.substring(0, n.length - 1) + 'y');
  const alt = [];
  for (const f of forms) {
    // Spaces and hyphens in a name match either: "chief of staff", "chief-of-staff".
    const parts = f.split(/[\s-]+/);
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // as Java's split
    alt.push(parts.map(escapeRegex).join('[\\s\\-]+'));
  }
  return new RegExp('(?<![\\p{L}\\p{N}])(?:' + alt.join('|') + ")(?:'s|’s|s)?(?![\\p{L}\\p{N}])", 'iu');
}

/**
 * Whether the chief's name comes up in the dictation (namePattern). Only then is Jev asked whether
 * the dictation is meant for the chief. No name, no chief.
 */
function mentions(dictation, name) {
  if (dictation === null || dictation === undefined || name === null || name === undefined || name.trim() === '')
    return false;
  return namePattern(name).test(dictation);
}

function noul(instructions, yes, no) {
  return { type: 'noul', instructions, criteria: { true: yes, false: no } };
}

/**
 * The request: the dictation as state, and only the questions that matter now: refine when
 * Refine may start by itself, template when there are templates (a tapped Refine uses it too),
 * chief when there is a chief to send to and its name (chiefName, else empty) comes up.
 */
function body(dictation, templates, refine, chiefName) {
  const questions = {};
  if (refine) questions.refine = noul(REFINE, REFINE_YES, REFINE_NO);
  const options = { [NONE]: TEMPLATE_NONE };
  for (const name of templates)
    if (name.toLowerCase() !== NONE) options[name] = format(TEMPLATE_OPTION, name);
  if (Object.keys(options).length > 1)
    questions.template = { type: 'choice', instructions: TEMPLATE, criteria: options };
  if (chiefName)
    questions.chief = noul(format(CHIEF, chiefName), format(CHIEF_YES, chiefName), format(CHIEF_NO, chiefName));
  return { model: MODEL, state: { dictation }, questions };
}

const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);

function probability(answer) {
  if (!answer || typeof answer.noul !== 'number') return null;
  const p = answer.noul;
  return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : null;
}

/**
 * Reads the answers; anything missing or unreadable counts as not asked.
 * Returns { refine, template, chief, cost }: probabilities (null when not asked), the template
 * ("" for none), the cost (null unknown).
 */
function parse(response, templates) {
  const answers = obj(response && response.answers) || {};
  let template = '';
  const t = obj(answers.template);
  if (t) for (const name of templates) if (name === (t.choice === undefined || t.choice === null ? '' : String(t.choice))) template = name;
  return {
    refine: probability(obj(answers.refine)),
    template,
    chief: probability(obj(answers.chief)),
    cost: openrouter.cost(response),
  };
}

/**
 * autoRefine and autoChief are the two switches in Settings → Models & providers → Decisions;
 * chiefReady: bb is connected and a chief is set; named: the chief's name comes up (mentions).
 * Only then can it go to the chief, at CHIEF_AT; between HINT_AT and CHIEF_AT, or when Jev failed,
 * 🧑‍💼 is only highlighted. What goes to the chief isn't refined by itself.
 * Returns { refine, template, chief, hint }.
 */
function decide(a, autoRefine, autoChief, chiefReady, named) {
  const ask = chiefReady && named;
  if (!a) return { refine: false, template: '', chief: false, hint: ask };
  const c = a.chief;
  const chief = ask && autoChief && c !== null && c !== undefined && c >= CHIEF_AT;
  const hint = ask && !chief && (c === null || c === undefined || c >= HINT_AT);
  const template = a.template !== '';
  const refine = !chief && autoRefine && (template || (a.refine !== null && a.refine !== undefined && a.refine >= REFINE_AT));
  return { refine, template: a.template, chief, hint };
}

/** For Activity: "refine 0.82 · chief 0.03 · Apartment application". */
function detail(a) {
  const s = [];
  if (a.refine !== null && a.refine !== undefined) s.push(format('refine %.2f', a.refine));
  if (a.chief !== null && a.chief !== undefined) s.push(format('chief %.2f', a.chief));
  if (a.template) s.push(a.template);
  return s.join(' · ');
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

/** Asks Jev about a dictation; rejects when it fails or takes longer than TIMEOUT_MS. */
async function ask(openRouter, dictation, templates, refine, chiefName, { timeoutMs = TIMEOUT_MS } = {}) {
  const r = await openRouter.decide(body(dictation, templates, refine, chiefName), timeoutMs);
  return parse(r, templates);
}

module.exports = {
  MODEL,
  NAME,
  TIMEOUT_MS,
  REFINE_AT,
  CHIEF_AT,
  HINT_AT,
  NONE,
  REFINE,
  REFINE_YES,
  REFINE_NO,
  TEMPLATE,
  TEMPLATE_NONE,
  TEMPLATE_OPTION,
  CHIEF,
  CHIEF_YES,
  CHIEF_NO,
  TURN,
  TURN_CHOICES,
  mentions,
  namePattern,
  body,
  parse,
  decide,
  detail,
  turnCriterion,
  turnBody,
  turnVerdict,
  turn,
  makeJudge,
  ask,
};
