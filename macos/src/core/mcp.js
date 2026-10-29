'use strict';
// A small client for MCP servers over Streamable HTTP: initialize, list tools, call a tool. An
// optional token is sent as a bearer header. BbBridge uses it to talk to bb's MCP server.

const { tr } = require('./util');
const netLog = require('./net-log');

const PROTOCOL = '2025-06-18';

/** The Mac app's version, sent as clientInfo (BuildConfig.VERSION_NAME on Android). */
const VERSION = (() => {
  try {
    return require('../../package.json').version;
  } catch {
    return '0';
  }
})();

/**
 * Dictate & Delegate's own message about a server; anything else from the network gets one. status
 * is the HTTP status when the server answered with an error, otherwise 0.
 */
class McpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'McpError';
    this.status = status;
  }
}

/** Why fetch failed, from Node's error codes: refused, timed out, unknown host, or broke off. */
function networkKind(ex) {
  if (!ex) return 'broken';
  if (ex.name === 'TimeoutError' || ex.name === 'AbortError') return 'timeout';
  const codes = [];
  for (let e = ex; e; e = e.cause) {
    if (e.code) codes.push(e.code);
    if (e.name === 'TimeoutError') return 'timeout';
    if (e.cause === e) break;
  }
  if (codes.some((c) => c === 'ECONNREFUSED' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH')) return 'refused';
  if (codes.some((c) => c === 'ENOTFOUND' || c === 'EAI_AGAIN')) return 'unknown';
  if (codes.some((c) => c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'ETIMEDOUT' || c === 'UND_ERR_HEADERS_TIMEOUT')) return 'timeout';
  return 'broken';
}

/** One session with one server: { name, url, token }. */
class Connection {
  constructor(server, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    this.server = { name: server.name, url: server.url, token: server.token || '' };
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.nextId = 1;
    /** What this session is for, in the network log ("bb tell chief"), and which try it is. */
    this.what = 'MCP';
    this.retry = 0;
  }

  async open() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'Dictate & Delegate', version: VERSION },
    });
    await this.notify('notifications/initialized');
  }

  async tools() {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const params = {};
      if (cursor != null) params.cursor = cursor;
      const result = await this.request('tools/list', params);
      for (const t of Array.isArray(result.tools) ? result.tools : []) {
        out.push({ name: t.name, description: t.description || '', schema: t.inputSchema || { type: 'object' } });
      }
      cursor = result.nextCursor || null;
      if (!cursor) break;
    }
    return out;
  }

  /** The tool's text result; errors come back as text too, prefixed with "Error: ". */
  async call(tool, args) {
    const result = await this.callResult(tool, args);
    return (result.isError ? 'Error: ' : '') + Connection.text(result);
  }

  /** The raw result of tools/call: {"content": [...], "isError": …}. */
  callResult(tool, args) {
    return this.request('tools/call', { name: tool, arguments: args });
  }

  /** A tool result's content as text, parts joined by line breaks. */
  static text(result) {
    const parts = [];
    for (const part of Array.isArray(result.content) ? result.content : []) {
      switch (part.type) {
        case 'text':
          parts.push(part.text || '');
          break;
        case 'resource': {
          const r = part.resource;
          parts.push(r ? (r.text != null ? r.text : r.uri || '') : '');
          break;
        }
        default:
          parts.push('[' + (part.type || '') + ']');
      }
    }
    let s = parts.join('\n');
    if (!s && result.structuredContent !== undefined) s = JSON.stringify(result.structuredContent);
    return s;
  }

  async notify(method) {
    await this.post({ jsonrpc: '2.0', method });
  }

  async request(method, params) {
    const id = this.nextId++;
    const reply = await this.post({ jsonrpc: '2.0', id, method, params });
    if (reply == null) throw new McpError(tr('%1$s didn\'t answer.', this.server.name));
    if (reply.error && typeof reply.error === 'object') {
      throw new McpError(this.server.name + ': ' + (reply.error.message || 'error'));
    }
    return reply.result && typeof reply.result === 'object' ? reply.result : {};
  }

  /**
   * One JSON-RPC message; the answer comes as JSON or as an event stream. A connection that broke
   * off (often a kept-alive one the server had closed) is tried once more, except for tools/call:
   * that one may have run already.
   */
  async post(message) {
    try {
      try {
        return await this.send(message, this.retry);
      } catch (ex) {
        if (ex instanceof McpError) throw ex;
        if (message.method === 'tools/call' || networkKind(ex) !== 'broken') throw ex;
        return await this.send(message, this.retry + 1);
      }
    } catch (ex) {
      if (ex instanceof McpError) throw ex;
      const kind = networkKind(ex);
      const why =
        kind === 'refused'
          ? tr('nothing answers at this address')
          : kind === 'timeout'
            ? tr('no answer in time')
            : kind === 'unknown'
              ? tr('unknown address')
              : tr('the connection broke off; is it an MCP server (Streamable HTTP)?');
      const e = new McpError(tr('Could not reach %1$s at %2$s: %3$s.', this.server.name, this.server.url, why));
      e.cause = ex;
      throw e;
    }
  }

  /** One POST, in the network log as what this session is for, with the JSON-RPC method (and tool). */
  send(message, retry = 0) {
    const tool = message.method === 'tools/call' && message.params ? ' ' + (message.params.name || '') : '';
    return netLog.request(this.what, 'POST', this.server.url, (net) => this.sendLogged(message, net.note(message.method + tool)), { retry });
  }

  async sendLogged(message, net) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
    };
    if (this.session != null) headers['Mcp-Session-Id'] = this.session;
    if (this.server.token.trim()) headers.Authorization = 'Bearer ' + this.server.token.trim();
    const body = JSON.stringify(message);
    net.request(netLog.requestIn(body)).sent(Buffer.byteLength(body, 'utf8'));
    const res = await this.fetch(this.server.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const status = res.status;
    net.status(status);
    const id = res.headers.get('Mcp-Session-Id');
    if (id && id.trim()) this.session = id;
    if (status === 202 || status === 204) {
      await drain(res);
      return null;
    }
    if (status >= 300 && status < 400) {
      await drain(res);
      throw new McpError(tr('%1$s answered with a redirect (HTTP %2$d). Check the address.', this.server.name, status), status);
    }
    if (status >= 400) {
      await drain(res);
      throw new McpError(tr('%1$s answered with HTTP %2$d.', this.server.name, status), status);
    }
    const type = String(res.headers.get('Content-Type'));
    const answer = await readLimited(res, 4_000_000);
    net.received(Buffer.byteLength(answer, 'utf8'));
    if (type.includes('text/event-stream')) return Connection.fromStream(answer, message.id);
    if (!answer.trim()) return null;
    try {
      return JSON.parse(answer);
    } catch {
      throw new McpError(tr('%1$s sent something unexpected.', this.server.name));
    }
  }

  /**
   * The event that answers this request; servers may send notifications before it. Events end
   * with a blank line.
   */
  static fromStream(stream, id) {
    let last = null;
    let data = '';
    for (const line of (stream.replace(/\r\n/g, '\n') + '\n\n').split('\n')) {
      if (line.startsWith('data:')) data += line.substring(5).trim();
      else if (!line.trim() && data) {
        const event = JSON.parse(data);
        data = '';
        if (id != null && String(id) === String(event.id)) return event;
        if ('result' in event || 'error' in event) last = event;
      }
    }
    return last;
  }
}

async function drain(res) {
  try {
    await res.arrayBuffer();
  } catch {
    /* Nothing to read. */
  }
}

async function readLimited(res, max) {
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new McpError('The MCP answer is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { PROTOCOL, VERSION, McpError, Connection, networkKind };
