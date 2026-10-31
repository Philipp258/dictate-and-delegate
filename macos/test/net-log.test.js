'use strict';
// The network log (NetLog.java's port): the line, redaction, bounds across a restart, the kinds
// of failure, Copy last call's slice, the Mac's network description, and the bb and ntfy wiring
// through fake fetches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NetLog = require('../src/core/net-log');
const NetState = require('../src/core/net-state');
const BbBridge = require('../src/core/bb-bridge');
const ChiefText = require('../src/core/chief-text');
const { MemoryPrefs, MemoryVault } = require('../src/core/store');

const T0 = Date.UTC(2026, 9, 29, 19, 15, 3, 123); // 20:15:03.123 in UTC+01:00
let now = T0;

/** A fresh log file, a fixed clock in UTC+01:00, and a fixed network. */
function fresh(network = () => 'wifi (en0), v4+v6') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-netlog-'));
  const file = path.join(dir, 'network.log');
  now = T0;
  NetLog.configure({ clock: () => now, offset: () => 60, zone: () => 'Europe/Berlin' });
  NetLog.init(file, network);
  return file;
}

const lines = () => NetLog.read().split('\n').filter((l) => l);

test.after(() => NetLog.init(null));

test('aRequestIsOneLineWithEverythingButContent', async () => {
  fresh();
  await NetLog.request('bb tell chief', 'POST', 'https://someone.getbb.app/api/v1/plugins/bb--mcp/http/mcp', async (net) => {
    net.request('abc123').sent(1234).status(200).received(310).note('tools/call run');
  }, { retry: 1 });
  const [l] = lines();
  assert.match(
    l,
    /^2026-10-29T20:15:03\.123\+01:00 \| bb tell chief \| req abc123 \| POST someone\.getbb\.app\/api\/v1\/plugins\/bb--mcp\/http\/mcp \| HTTP 200 \| \d+ ms \| retry 1 \| ↑1\.2 kB ↓310 B \| wifi \(en0\), v4\+v6 \| tools\/call run$/,
  );
  assert.equal(NetLog.time(l), T0);
});

test('theNetworkIsSaidAtTheStartAndAtTheEndWhenItChanged', async () => {
  let n = 'wifi (en0), v4+v6';
  fresh(() => n);
  await NetLog.request('ntfy test', 'POST', 'https://ntfy.sh/x', async (net) => {
    n = 'offline';
    net.fail(Object.assign(new Error('getaddrinfo ENOTFOUND ntfy.sh'), { code: 'ENOTFOUND' }));
  });
  assert.ok(lines()[0].includes(' | DNS failure | '), lines()[0]);
  assert.ok(lines()[0].includes(' | wifi (en0), v4+v6 → offline'), lines()[0]);
});

test('aThrownFailureIsLoggedAndPassedOn', async () => {
  fresh();
  const err = new Error('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  await assert.rejects(NetLog.request('OpenRouter chat x', 'POST', 'https://openrouter.ai/api/v1/chat/completions', async () => { throw err; }), err);
  assert.ok(lines()[0].includes(' | connection reset | '), lines()[0]);
});

test('secretsNeverReachTheLog', async () => {
  fresh();
  const topic = 'talkrouter-Zq8_kLmNpQrs_tUvW5xYz_aB1c';
  assert.equal(
    NetLog.target('https://user:pass@ntfy.sh/' + topic + '/json?since=1761768000&poll=1&auth=c2VjcmV0', topic),
    'ntfy.sh/***/json?since=1761768000&poll=1&auth=***',
  );
  // A short topic only the caller knows is secret; a token-like path segment always is.
  assert.equal(NetLog.target('https://ntfy.mine.example:8443/myowntopic/json?since=Kx2b', 'myowntopic'), 'ntfy.mine.example:8443/***/json?since=Kx2b');
  assert.equal(NetLog.target('https://api.example.com/v1/keys/sk-or-v1-0123456789abcdef0123456789/usage'), 'api.example.com/v1/keys/***/usage');
  assert.equal(NetLog.target('wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=eyJhbGciOi&encoding=pcm_s16le'), 'streaming.assemblyai.com/v3/ws?sample_rate=16000&token=***&encoding=pcm_s16le');
  assert.equal(NetLog.target('not a url'), '(unreadable address)');

  // Through the wiring: a bearer token and the message of a tell never appear, only the request ID.
  const prefs = new MemoryPrefs({ chiefId: 'thr_chief' });
  const b = new BbBridge.BbBridge({ prefs, vault: new MemoryVault(), fetch: fakeBb() });
  b.useCustom('https://bb.example/mcp', 'tok-SECRET-1234567890abcdef', '');
  await b.send('thr_chief', BbBridge.handsFreeMessage('my secret plans for Lisbon', 'k3x9qa'));
  const log = NetLog.read();
  assert.ok(!log.includes('tok-SECRET'), log);
  assert.ok(!log.includes('Lisbon'), log);
  assert.ok(!log.includes('Bearer'), log);
  assert.ok(log.includes(' | req k3x9qa | '), log);
});

test('theLogKeepsAThousandEntriesOfSevenDaysAcrossARestart', () => {
  const file = fresh();
  now = T0 - 8 * 24 * 3600 * 1000;
  NetLog.event('ntfy subscription message', '', 'id old', '', 'notification');
  now = T0;
  for (let i = 0; i < NetLog.KEEP + 100; i++) NetLog.event('ntfy subscription message', '', 'id m' + i, '', 'notification');
  let kept = lines();
  assert.equal(kept.length, NetLog.KEEP);
  assert.ok(kept[0].includes('id m100'), kept[0]);
  assert.ok(!NetLog.read().includes('id old'));
  // The file itself is trimmed too: never far past the bounds.
  assert.ok(fs.readFileSync(file, 'utf8').split('\n').length <= NetLog.KEEP + NetLog.TRIM_EVERY + 1);
  // A restart: the same file, read again.
  NetLog.init(null);
  assert.equal(NetLog.read(), '');
  NetLog.init(file, () => '');
  kept = lines();
  assert.equal(kept.length, NetLog.KEEP);
  assert.ok(kept[kept.length - 1].includes('id m' + (NetLog.KEEP + 99)));
  // A week later they're all too old.
  now = T0 + NetLog.KEEP_MS + 1;
  assert.equal(NetLog.read(), '');
});

test('failuresAreSaidByKindNeverByTheirText', () => {
  const coded = (code, message = 'secret answer text') => Object.assign(new Error(message), { code });
  const named = (name) => Object.assign(new Error('x'), { name });
  const cases = [
    [coded('ENOTFOUND'), 'DNS failure'],
    [coded('EAI_AGAIN'), 'DNS failure'],
    [coded('UND_ERR_CONNECT_TIMEOUT'), 'connect timeout'],
    [coded('ETIMEDOUT'), 'connect timeout'],
    [coded('UND_ERR_HEADERS_TIMEOUT'), 'read timeout'],
    [coded('UND_ERR_BODY_TIMEOUT'), 'read timeout'],
    [named('TimeoutError'), 'timeout'],
    [named('AbortError'), 'cancelled'],
    [coded('ECONNREFUSED'), 'connection refused'],
    [coded('ECONNRESET'), 'connection reset'],
    [coded('EPIPE'), 'broken pipe'],
    [coded('ENETUNREACH'), 'network unreachable'],
    [coded('EHOSTUNREACH'), 'no route to host'],
    [coded('UND_ERR_SOCKET'), 'connection closed early'],
    [new Error('other side closed'), 'connection closed early'],
    [coded('CERT_HAS_EXPIRED'), 'TLS certificate error'],
    [coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'TLS certificate error'],
    [coded('DEPTH_ZERO_SELF_SIGNED_CERT'), 'TLS certificate error'],
    [coded('ERR_TLS_CERT_ALTNAME_INVALID'), 'TLS certificate error'],
    [coded('ERR_SSL_WRONG_VERSION_NUMBER'), 'TLS error'],
    [new Error('Opening handshake has timed out'), 'connect timeout'],
    [new TypeError('fetch failed'), 'network error'],
    [new RangeError('secret answer text'), 'app error (RangeError)'],
  ];
  for (const [err, kind] of cases) assert.equal(NetLog.classify(err), kind, String(err.code || err.name || err.message));
  // fetch's wrapper, its cause, and happy eyeballs' AggregateError.
  assert.equal(NetLog.classify(new TypeError('fetch failed', { cause: coded('ECONNREFUSED') })), 'connection refused');
  assert.equal(NetLog.classify(new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')], 'x')), 'connection refused');
  assert.ok(!NetLog.classify(new RangeError('secret answer text')).includes('secret'));
});

test('theResultSaysTheStatusAndWhatFollowed', () => {
  assert.equal(NetLog.result(200, null), 'HTTP 200');
  assert.equal(NetLog.result(502, new Error('the app said so')), 'HTTP 502 bad gateway');
  assert.equal(NetLog.result(504, null), 'HTTP 504 gateway timeout');
  assert.equal(NetLog.result(429, null), 'HTTP 429 too many requests');
  assert.equal(NetLog.result(200, Object.assign(new Error('x'), { name: 'TimeoutError' })), 'HTTP 200, then read timeout');
  assert.equal(NetLog.result(200, Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'HTTP 200, then connection reset');
  assert.equal(NetLog.result(0, null), 'no answer');
  assert.equal(NetLog.result(0, Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'DNS failure');
});

test('copyLastCallTakesTheEntriesSinceThoseCallsStarted', () => {
  fresh();
  NetLog.event('before', '', 'x', '', '');
  NetLog.callStarted();
  NetLog.event('first call', '', 'x', '', '');
  NetLog.callStarted();
  NetLog.event('second call', '', 'x', '', '');
  const log = NetLog.read();
  const last = NetLog.lastCalls(log, 1);
  assert.ok(last.startsWith('2026-10-29T20:15:03.123+01:00 | ' + NetLog.CALL_STARTED), last);
  assert.ok(last.includes('second call') && !last.includes('first call'));
  assert.ok(NetLog.lastCalls(log, 2).includes('first call') && !NetLog.lastCalls(log, 2).includes('before'));
  assert.equal(NetLog.lastCalls(log, 3), log);
  assert.equal(NetLog.lastCalls('', 1), '');
});

test('theReportSaysHowToReadTheTimes', () => {
  fresh();
  NetLog.event('ntfy replies closed', '', 'ended by the server', '', '');
  const r = NetLog.report('Dictate & Delegate 0.1.1 for macOS', NetLog.read());
  assert.ok(r.startsWith('Network log · Dictate & Delegate 0.1.1 for macOS · copied 2026-10-29T20:15:03.123+01:00 · 1 entry\n'), r);
  assert.ok(r.includes('Times: local (Europe/Berlin, UTC+01:00), when each request started'), r);
  assert.ok(NetLog.report('x', '').endsWith('(no entries yet)\n'));
});

test('aNetworkChangeIsLoggedOnce', () => {
  fresh();
  NetLog.networkChanged('wifi (en0), v4+v6');
  NetLog.networkChanged('wifi (en0), v4+v6');
  NetLog.networkChanged('iPhone USB (en8), v4+v6');
  assert.deepEqual(lines().map((l) => l.split(' | ').slice(1).join(' | ')), ['network now | wifi (en0), v4+v6', 'network now | iPhone USB (en8), v4+v6']);
});

test('theMacsNetworkComesFromTheDefaultRoute', async () => {
  const ports = 'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa\n\nHardware Port: iPhone USB\nDevice: en8\n\nHardware Port: USB 10/100/1000 LAN\nDevice: en7\n';
  assert.deepEqual(NetState.parsePorts(ports), { en0: 'Wi-Fi', en8: 'iPhone USB', en7: 'USB 10/100/1000 LAN' });
  assert.equal(NetState.parseRoute('   route to: default\ndestination: default\n  gateway: 192.168.1.1\n  interface: en0\n'), 'en0');
  const v4 = { address: '192.168.1.20', family: 'IPv4', internal: false };
  const v6 = { address: '2a02:8109::1', family: 'IPv6', internal: false };
  const link = { address: 'fe80::1', family: 'IPv6', internal: false };
  assert.equal(NetState.describe('en0', NetState.parsePorts(ports), { en0: [v4, v6, link] }), 'wifi (en0), v4+v6');
  assert.equal(NetState.describe('en7', NetState.parsePorts(ports), { en7: [v4, link] }), 'ethernet (en7), v4 only');
  assert.equal(NetState.describe('en8', NetState.parsePorts(ports), { en8: [v6] }), 'iPhone USB (en8), v6 only');
  assert.equal(NetState.describe('utun4', {}, { utun4: [v4] }), 'vpn (utun4), v4 only');
  assert.equal(NetState.describe('', {}, {}), 'offline');

  let route = 'interface: en0\n';
  const changes = [];
  const exec = (cmd, args, opts, cb) => setImmediate(() => (cmd.endsWith('route') ? (route ? cb(null, route) : cb(new Error('not in table'))) : cb(null, ports)));
  const s = new NetState.NetState({ exec, interfaces: () => ({ en0: [v4, v6] }), onChange: (d) => changes.push(d) });
  assert.equal(s.describe(), '');
  await s.refresh();
  route = '';
  await s.refresh();
  await s.refresh();
  assert.deepEqual(changes, ['wifi (en0), v4+v6', 'offline']);
});

test('anMcpTellLogsWhoItWentToAndItsRequest', async () => {
  fresh();
  const prefs = new MemoryPrefs({ chiefId: 'thr_chief', talkerId: 'thr_talk', talkerOn2: true });
  const b = new BbBridge.BbBridge({ prefs, vault: new MemoryVault(), fetch: fakeBb() });
  b.useCustom('https://bb.example/mcp', '', '');
  await b.send('thr_chief', BbBridge.handsFreeMessage('hello', 'abc123'));
  await b.send('thr_talk', 'no request here');
  const l = lines();
  assert.equal(l.length, 6); // initialize, notifications/initialized, tools/call, twice
  assert.match(l[2], / \| bb tell chief \| req abc123 \| POST bb\.example\/mcp \| HTTP 200 \| \d+ ms \| ↑\d+ B ↓\d+ B \| wifi \(en0\), v4\+v6 \| tools\/call run$/);
  assert.match(l[0], / \| bb tell chief \| POST bb\.example\/mcp \| HTTP 200 \| .* \| initialize$/);
  assert.match(l[1], / \| bb tell chief \| POST bb\.example\/mcp \| HTTP 202 \| .* \| notifications\/initialized$/);
  assert.match(l[5], / \| bb tell talker \| POST bb\.example\/mcp \| HTTP 200 \| /);
  assert.equal(BbBridge.what('const l = await bb.json(["skill","list"]);', 'read', '', ''), 'check skills');
  assert.equal(BbBridge.what(BbBridge.tellSnippet('thr_other', 'x ["thread","spawn"]'), 'run', 'thr_chief', ''), 'tell thr_other');
});

test('aRefusedTokenIsRefreshedAndTheRetryCounted', async () => {
  fresh();
  const prefs = new MemoryPrefs({ chiefId: 'thr_chief' });
  let refused = 1;
  const b = new BbBridge.BbBridge({ prefs, vault: new MemoryVault(), fetch: fakeBb(() => (refused-- > 0 ? 401 : 0)) });
  b.mode = () => BbBridge.CONNECT;
  b.url = () => 'https://bb.example/mcp';
  b.connected = () => true;
  b.oauth = { accessToken: async () => 'tok' };
  await b.send('thr_chief', 'hi');
  const l = lines();
  assert.match(l[0], / \| bb tell chief \| POST bb\.example\/mcp \| HTTP 401 unauthorized \| \d+ ms \| /);
  assert.ok(l.slice(1).every((x) => x.includes(' | retry 1 | ')), l.join('\n'));
});

test('ntfyStreamsLogConnectEachMessageAndTheClose', async () => {
  fresh();
  now = T0;
  const topic = 'talkrouter-Zq8_kLmNpQrs_tUvW5xYz_aB1c';
  const body = [
    { event: 'open', id: 'o1' },
    { event: 'message', id: 'm1', time: Math.floor(T0 / 1000) - 2, tags: ['talkrouter-speak', 'req-k3x9qa'], message: 'the train leaves at nine' },
    { event: 'keepalive', id: 'k1' },
  ].map((m) => JSON.stringify(m) + '\n').join('');
  const fetch = async () => new Response(body, { status: 200 });
  await ChiefText.readStream(fetch, ChiefText.streamUrl('https://ntfy.sh', topic, 1761768000), { onLine: async () => false, what: 'ntfy replies', secret: topic, reconnect: 2 });
  const l = lines();
  assert.equal(l.length, 3, l.join('\n'));
  assert.match(l[0], / \| ntfy replies connect \| GET ntfy\.sh\/\*\*\*\/json\?since=1761768000 \| HTTP 200 \| \d+ ms \| retry 2 \| /);
  assert.match(l[1], / \| ntfy replies message \| req k3x9qa \| id m1 \| .* \| speak, \d+ ms after ntfy got it$/);
  assert.match(l[2], / \| ntfy replies closed \| ntfy\.sh\/\*\*\*\/json\?since=1761768000 \| ended by the server \| .* \| open \d+ s, 1 message$/);
  const log = NetLog.read();
  assert.ok(!log.includes(topic) && !log.includes('train'), log);
});

/**
 * A fake bb MCP server as a fetch: initialize, the initialized notification (202) and tools/call
 * (a tell's answer). status(message) may return an HTTP status to answer with instead.
 */
function fakeBb(status = () => 0) {
  return async (url, init) => {
    const m = JSON.parse(init.body);
    const s = status(m);
    if (s) return new Response('', { status: s });
    if (!('id' in m)) return new Response(null, { status: 202 });
    const result = m.method === 'tools/call' ? { content: [{ type: 'text', text: '{"threadId":"thr_x","delivery":"queued"}' }] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}
