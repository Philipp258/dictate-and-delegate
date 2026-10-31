'use strict';
// The request bodies the app sends to OpenRouter (OpenRouterTest.java).
const test = require('node:test');
const assert = require('node:assert/strict');
const OpenRouter = require('../src/core/openrouter');
const TextModel = require('../src/core/text-model');

test('wordsReachEachHostInItsOwnFormat', () => {
  const words = ['Kubernetes', ' ', 'Ljubljana'];
  const mai = OpenRouter.transcriptionBody('microsoft/mai-transcribe-2', 'UklGRg==', words);
  assert.equal(mai.response_format, 'json');
  assert.equal(mai.input_audio.format, 'wav');
  assert.equal(mai.input_audio.data, 'UklGRg==');
  assert.equal(JSON.stringify(mai.provider.options.azure.phraseList.phrases), '["Kubernetes","Ljubljana"]');

  const openai = OpenRouter.providerOptions('openai/gpt-transcribe', words).options.openai;
  assert.equal(openai.prompt, 'Kubernetes, Ljubljana');
  assert.equal(openai.keywords.length, 2);
  assert.ok(!('keywords' in OpenRouter.providerOptions('openai/whisper-1', words).options.openai));
  assert.equal(OpenRouter.providerOptions('assemblyai/universal-3-5-pro', words).options.assemblyai.keyterms_prompt.length, 2);
});

test('noWordsOrAModelWithoutHintsSendNoProviderOptions', () => {
  assert.equal(OpenRouter.providerOptions('microsoft/mai-transcribe-2', []), null);
  assert.equal(OpenRouter.providerOptions('deepgram/nova-3', ['Drift']), null);
  assert.ok(!('provider' in OpenRouter.transcriptionBody('microsoft/mai-transcribe-2', 'x', [])));
  const many = [];
  for (let i = 0; i < 150; i++) many.push('w' + i);
  assert.equal(
    OpenRouter.providerOptions('assemblyai/universal-3-5-pro', many).options.assemblyai.keyterms_prompt.length,
    OpenRouter.MAX_WORDS,
  );
});

test('chatBodiesReportTheirCostAndReadPdfsAsText', () => {
  const plain = [{ role: 'user', content: 'hi' }];
  const check = OpenRouter.chatBody('fast/model', plain, 200, true);
  assert.equal(check.usage.include, true);
  assert.equal(check.max_tokens, 200);
  assert.equal(check.reasoning.enabled, false);
  assert.ok(!('plugins' in check));

  const parts = [
    { type: 'text', text: 'reply to this' },
    { type: 'file', file: { filename: 'offer.pdf' } },
  ];
  const text = OpenRouter.chatBody(TextModel.MODEL, [{ role: 'user', content: parts }], 4096, false);
  assert.ok(!('reasoning' in text));
  const plugin = text.plugins[0];
  assert.equal(plugin.id, 'file-parser');
  assert.equal(plugin.pdf.engine, 'pdf-text');
});

test('aMissingCostIsUnknownNotFree', () => {
  assert.equal(OpenRouter.cost({ usage: { cost: 0.00042 } }), 0.00042);
  assert.equal(OpenRouter.cost({ usage: {} }), null);
  assert.equal(OpenRouter.cost({}), null);
  assert.equal(OpenRouter.cost({ usage: { cost: 'n/a' } }), null);
  assert.equal(OpenRouter.cost({ usage: { cost: true } }), null);
  // Mac: "" isn't 0 (Number("") would be), and a negative cost is unknown.
  assert.equal(OpenRouter.cost({ usage: { cost: '' } }), null);
  assert.equal(OpenRouter.cost({ usage: { cost: -1 } }), null);
  assert.equal(OpenRouter.cost({ usage: { cost: '1.9404e-05' } }), 0.000019404);
});

test('errorsAreReadable', () => {
  assert.match(OpenRouter.error(402, ''), /credits are used up/);
  assert.equal(OpenRouter.error(400, ''), "OpenRouter couldn't run this request (HTTP 400).");
  assert.equal(OpenRouter.error(422, 'bad'), "OpenRouter couldn't run this request (HTTP 422): bad");
  assert.equal(OpenRouter.error(502, 'x'), 'The model provider had a problem (HTTP 502). The recording is kept; try again.');
  assert.ok(OpenRouter.error(400, 'x'.repeat(400)).endsWith('x…'));
  assert.equal(OpenRouter.decisionsUrl('http://127.0.0.1:1/api/v1'), 'http://127.0.0.1:1/api/alpha/decisions');
  assert.equal(OpenRouter.decisionsUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/alpha/decisions');
});

test('onlyRequestsThatNeverReachedOpenRouterAreTriedAgain', async () => {
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  assert.ok(OpenRouter.unreached(refused()));
  assert.ok(OpenRouter.unreached(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })));
  // A read timeout may have run (and cost): not tried again by itself.
  assert.ok(!OpenRouter.unreached(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })));
  assert.ok(!OpenRouter.unreached(new Error('The model provider had a problem (HTTP 502).')));
  // Two tries without a connection, then it goes through.
  let calls = 0;
  const { MemoryVault } = require('../src/core/store');
  const vault = new MemoryVault();
  vault.set(OpenRouter.KEY, 'sk-or-test');
  const waits = [];
  const client = new OpenRouter.OpenRouter({
    vault,
    fetch: async () => {
      if (++calls <= 2) throw refused();
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { cost: 0.0001 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    sleep: async (ms) => waits.push(ms),
  });
  await client.call('/chat/completions', { model: 'x' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 5000]);
});
