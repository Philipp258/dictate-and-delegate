'use strict';
// The calls themselves, against scripts/fakes/fake_openrouter.py (no provider, no money):
// transcription, Jev's decisions and the hands-free judge, Refine through OpenRouter and Anthropic,
// and Anthropic's fallback to OpenRouter.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { MemoryPrefs, MemoryVault } = require('../src/core/store');
const { waitFor, sleep } = require('../src/core/util');
const OpenRouter = require('../src/core/openrouter');
const Anthropic = require('../src/core/anthropic');
const Jev = require('../src/core/jev');
const TextModel = require('../src/core/text-model');
const AudioFiles = require('../src/core/audio-files');

const FAKE = path.join(__dirname, '..', '..', 'scripts', 'fakes', 'fake_openrouter.py');

let fake, root, orUrl;

// The fake needs python3 (macOS has it with the developer tools); without it these are skipped.
const skip = spawnSync('python3', ['--version']).status === 0 ? false : 'needs python3 for the fake OpenRouter';
const it = (name, fn) => test(name, { skip }, fn);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function control(method, p, body) {
  const res = await fetch(root + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const script = (items) => control('POST', '/test/script', items);
const requests = async () => (await control('GET', '/test/requests')).requests;

test.before(async () => {
  if (skip) return;
  const port = await freePort();
  root = `http://127.0.0.1:${port}`;
  orUrl = root + '/api/v1';
  fake = spawn('python3', [FAKE, '--port', String(port)], { stdio: 'ignore' });
  const until = Date.now() + 10000;
  for (;;) {
    try {
      await control('GET', '/test/requests');
      return;
    } catch (ex) {
      if (Date.now() > until) throw new Error('the fake OpenRouter did not start: ' + ex.message);
      await sleep(50);
    }
  }
});

test.after(() => {
  if (fake) fake.kill();
});

test.beforeEach(() => (skip ? undefined : control('POST', '/test/reset', {})));

const vault = (values = { openrouterKey: 'sk-or-fake' }) => new MemoryVault(values);
const client = (v = vault()) => new OpenRouter.OpenRouter({ vault: v, baseUrl: orUrl, retryMs: 1 });

it('transcribeSendsTheWavWithWordHintsAndReadsTheCost', async () => {
  await script({ transcribe: [{ text: '  Hello there.  ', cost: 0.0012 }, { text: 'No price.', cost: null }] });
  const wav = AudioFiles.wav(Buffer.alloc(3200, 7));
  const r = await client().transcribe(wav, 'microsoft/mai-transcribe-2', ['Kubernetes', ' ']);
  assert.deepEqual(r, { text: 'Hello there.', cost: 0.0012 });
  const unpriced = await client().transcribe(wav, 'deepgram/nova-3', ['Kubernetes']);
  assert.deepEqual(unpriced, { text: 'No price.', cost: null });
  const [first, second] = await requests();
  assert.equal(first.kind, 'transcribe');
  assert.equal(first.body.model, 'microsoft/mai-transcribe-2');
  assert.equal(first.body.input_audio.format, 'wav');
  assert.equal(first.body.input_audio.bytes, wav.toString('base64').length);
  assert.deepEqual(first.body.provider.options.azure.phraseList.phrases, ['Kubernetes']);
  assert.ok(!('provider' in second.body));
});

it('theBaseUrlComesFromTheEnvironment', async () => {
  const saved = process.env.DD_OPENROUTER_URL;
  process.env.DD_OPENROUTER_URL = orUrl;
  try {
    const r = await new OpenRouter.OpenRouter({ vault: vault() }).transcribe(AudioFiles.wav(Buffer.alloc(320)), 'openai/whisper-1');
    assert.equal(r.text, 'Fake transcript.');
    await OpenRouter.check('good');
  } finally {
    if (saved === undefined) delete process.env.DD_OPENROUTER_URL;
    else process.env.DD_OPENROUTER_URL = saved;
  }
});

it('failuresSayWhatToDo', async () => {
  const wav = AudioFiles.wav(Buffer.alloc(320));
  await script({ transcribe: [{ error: 'credits' }] });
  await assert.rejects(client().transcribe(wav, 'openai/whisper-1'), /credits are used up/);
  await script({ transcribe: [{ error: 'provider' }] });
  await assert.rejects(client().transcribe(wav, 'openai/whisper-1'), /The model provider had a problem \(HTTP 502\)/);
  await script({ transcribe: [{ error: 'invalid' }] });
  await assert.rejects(client().transcribe(wav, 'openai/whisper-1'), /HTTP 400\): Fake invalid request/);
  // 429 is retried twice, then it's busy.
  await script({ transcribe: [{ error: 'busy' }, { text: 'second try' }] });
  assert.equal((await client().transcribe(wav, 'openai/whisper-1')).text, 'second try');
  await control('POST', '/test/reset', {});
  await script({ transcribe: [{ error: 'busy' }, { error: 'busy' }, { error: 'busy' }, { text: 'too late' }] });
  await assert.rejects(client().transcribe(wav, 'openai/whisper-1'), /busy right now/);
  assert.equal((await requests()).length, 3);
  await assert.rejects(client(vault({ openrouterKey: 'bad' })).transcribe(wav, 'openai/whisper-1'), /isn't valid anymore/);
  await assert.rejects(client(vault({})).transcribe(wav, 'openai/whisper-1'), /Add your OpenRouter key/);
  await assert.rejects(
    new OpenRouter.OpenRouter({ vault: vault(), baseUrl: 'http://127.0.0.1:9/api/v1' }).transcribe(wav, 'openai/whisper-1'),
    /No connection to OpenRouter/,
  );
  // Keys are checked before they are saved.
  await OpenRouter.check(' good ', { baseUrl: orUrl });
  await assert.rejects(OpenRouter.check('bad', { baseUrl: orUrl }), /This key isn't valid/);
});

it('theRefinePickerReadsTheCatalog', async () => {
  const list = TextModel.catalog(await OpenRouter.models({ baseUrl: orUrl }));
  assert.deepEqual(
    list.map((m) => m.id),
    ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-fake'],
  );
  assert.equal(TextModel.price(list[0]), '$2.00 / $10.00');
});

it('jevNamesTheTemplate', async () => {
  await script({ decide: [{ template: 'Weekly update', cost: 0.00002 }] });
  const templates = ['Apartment application', 'Weekly update'];
  const a = await Jev.ask(client(), 'use my weekly update', templates);
  assert.deepEqual(a, { template: 'Weekly update', cost: 0.00002 });
  const [r] = await requests();
  assert.equal(r.kind, 'decide');
  assert.equal(r.body.model, Jev.MODEL);
  assert.deepEqual(Object.keys(r.body.questions), ['template']);
});

it('jevThatIsTooSlowIsGivenUp', async () => {
  await script({ decide: [{ delay: 1 }] });
  const started = Date.now();
  await assert.rejects(Jev.ask(client(), 'x', ['T'], { timeoutMs: 200 }), /took too long/);
  assert.ok(Date.now() - started < 900);
  await script({ decide: [{ error: 'busy' }] });
  // No retries for Jev: nothing waits for it.
  await assert.rejects(Jev.ask(client(), 'x', ['T']), /busy right now/);
});

it('theHandsFreeJudgeSaysWhetherTheTurnIsDone', async () => {
  await script({ decide: [{ turn: 'over', cost: 0.00002 }, { turn: 'end' }, { turn: 'unfinished', cost: null }] });
  const costs = [];
  const judge = Jev.makeJudge({ openRouter: client(), sendWords: ['over and out'], endWords: ['end the call'], onCost: (c) => costs.push(c) });
  const over = await judge('book the table over and out');
  assert.equal(over.choice, 'over');
  assert.ok(Math.abs(over.send - 0.97) < 1e-9); // 0.95 + 0.01 + 0.01
  assert.ok(over.end < 0.02);
  const end = await judge('thanks, end the call');
  assert.equal(end.choice, 'end');
  assert.equal(end.end, 0.95);
  const unfinished = await judge('and then I');
  assert.equal(unfinished.choice, 'unfinished');
  assert.equal(unfinished.cost, null);
  assert.deepEqual(costs, [0.00002, 0.00002]);
  const r = (await requests())[0].body;
  assert.equal(r.state.said, 'book the table over and out');
  assert.ok(r.questions.turn.criteria.over.includes('"over and out"'));
});

const deps = (values, prefs = new MemoryPrefs()) => {
  const v = vault(values);
  return {
    prefs,
    vault: v,
    openRouter: new OpenRouter.OpenRouter({ vault: v, baseUrl: orUrl, retryMs: 1 }),
    anthropic: new Anthropic.Anthropic({ vault: v, baseUrl: root, retryMs: 1 }),
  };
};

it('refineGoesThroughOpenRouterWithoutAnAnthropicKey', async () => {
  await script({ text: [{ text: 'Dear Jana, …', cost: 0.0003 }] });
  const pdf = { type: 'file', file: { filename: 'offer.pdf', file_data: 'data:application/pdf;base64,JVBER' } };
  const r = await TextModel.process(deps({ openrouterKey: 'k' }), 'reply to jana', [pdf], 'PROMPT', '', 'Usually dictates: Emails.');
  assert.deepEqual(r, { text: 'Dear Jana, …', cost: 0.0003, anthropic: false, fallback: null, keyProblem: false, model: TextModel.MODEL });
  const [req] = await requests();
  assert.equal(req.kind, 'text');
  assert.equal(req.body.model, TextModel.MODEL);
  assert.equal(req.body.max_tokens, TextModel.MAX_TOKENS);
  assert.equal(req.body.messages[0].content, TextModel.system('PROMPT', '', true, 'Usually dictates: Emails.'));
  assert.deepEqual(req.body.messages[1].content, [{ type: 'text', text: 'reply to jana' }, pdf]);
  assert.equal(req.body.plugins[0].id, 'file-parser');
  // The user's own model.
  await TextModel.process(deps({ openrouterKey: 'k' }, new MemoryPrefs({ refineModel: 'openai/gpt-fake' })), 'x', [], 'P', '', '');
  assert.equal((await requests())[1].body.model, 'openai/gpt-fake');
});

it('refineGoesToAnthropicWithAnAnthropicKey', async () => {
  await script({ anthropic: [{ text: 'Refined.' }] });
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } };
  const r = await TextModel.process(deps({ openrouterKey: 'k', anthropicKey: 'sk-ant-good' }), 'tidy this', [image], 'PROMPT', '', '');
  assert.deepEqual(r, { text: 'Refined.', cost: 0.003, anthropic: true, fallback: null, keyProblem: false, model: 'claude-sonnet-5-5' });
  const [req] = await requests();
  assert.equal(req.kind, 'anthropic');
  assert.equal(req.body.thinking.type, 'between_tools');
  assert.equal(req.body.system, TextModel.system('PROMPT', '', true, ''));
  assert.deepEqual(req.body.messages[0].content.map((b) => b.type), ['image', 'text']);
  // Another Claude model picked: no between_tools.
  await TextModel.process(deps({ anthropicKey: 'sk-ant-good' }, new MemoryPrefs({ refineClaude: 'claude-opus-5-5' })), 'x', [], 'P', '', '');
  const opus = (await requests())[1].body;
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.ok(!('thinking' in opus));
  assert.equal(TextModel.name(new MemoryPrefs(), vault({ anthropicKey: 'sk-ant-good' })), 'Claude Sonnet 5.5');
});

it('anthropicFailingFallsBackToOpenRouter', async () => {
  const both = { openrouterKey: 'k', anthropicKey: 'sk-ant-good' };
  await script({ anthropic: [{ error: 'key' }], text: [{ text: 'From OpenRouter.' }] });
  let r = await TextModel.process(deps(both), 'x', [], 'P', '', '');
  assert.equal(r.text, 'From OpenRouter.');
  assert.equal(r.anthropic, false);
  assert.equal(r.model, TextModel.MODEL);
  assert.match(r.fallback, /Anthropic key isn't valid/);
  assert.equal(r.keyProblem, true);

  await script({ anthropic: [{ error: 'credits' }] });
  r = await TextModel.process(deps(both), 'echo me', [], 'P', '', '');
  assert.equal(r.text, 'echo me');
  assert.equal(r.fallback, 'Your Anthropic credits are used up.');
  assert.equal(r.keyProblem, true);

  await control('POST', '/test/reset', {});
  await script({ anthropic: [{ error: 'overloaded' }, { error: 'busy' }, { error: 'overloaded' }] });
  r = await TextModel.process(deps(both), 'x', [], 'P', '', '');
  assert.equal(r.fallback, 'Anthropic is busy right now.');
  assert.equal(r.keyProblem, false);
  assert.deepEqual((await requests()).map((q) => q.kind), ['anthropic', 'anthropic', 'anthropic', 'text']);

  await script({ anthropic: [{ error: 'provider' }] });
  r = await TextModel.process(deps(both), 'x', [], 'P', '', '');
  assert.equal(r.fallback, 'Anthropic had a problem (HTTP 500).');
  assert.equal(r.keyProblem, false);

  // A key Anthropic refuses, without anything queued.
  r = await TextModel.process(deps({ openrouterKey: 'k', anthropicKey: 'sk-ant-bad' }), 'x', [], 'P', '', '');
  assert.equal(r.keyProblem, true);
  await Anthropic.check('sk-ant-good', { baseUrl: root });
  await assert.rejects(Anthropic.check('sk-ant-bad', { baseUrl: root }), (f) => f.problem === Anthropic.Problem.KEY);
});
