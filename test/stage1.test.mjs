/**
 * Stage-1 protocol tests.
 *
 * Runs the framing codec and the connection layer against a real child process
 * (test/fake-server.mjs) rather than a mock stream, so framing, the JSON-RPC
 * table, and process teardown are exercised together. The subprocess seam is
 * stubbed with a `node:child_process` spawner shaped like the harness service.
 *
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MessageDecoder, encodeMessage } from '../lib/framing.js';
import { LspConnection } from '../lib/connection.js';
import { LSP_ERROR, DEFAULTS } from '../lib/vocabulary.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-server.mjs');

/**
 * A `ctx.subprocess`-shaped spawner over `node:child_process`.
 *
 * Mirrors the parts the connection uses: piped stdio, `done`, `collected.stderr`
 * with `readFrom`, and `exitCode`.
 */
function testSpawner(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...spec.env },
  });
  let stderrText = '';
  child.stderr.on('data', (c) => {
    stderrText += c.toString('utf8');
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    collected: { stderr: { readFrom: () => ({ text: stderrText, nextOffset: stderrText.length }) } },
    done,
    get exitCode() {
      return child.exitCode;
    },
  };
}

function makeSpec(overrides = {}) {
  return {
    serverId: 'fake',
    command: process.execPath,
    args: [FAKE],
    cwd: here,
    env: {},
    maxMessageBytes: DEFAULTS.MAX_MESSAGE_BYTES,
    maxStderrBytes: DEFAULTS.MAX_STDERR_BYTES,
    killGraceMs: DEFAULTS.KILL_GRACE_MS,
    ...overrides,
  };
}

// ── framing ─────────────────────────────────────────────────────────────────

test('framing: encode produces a Content-Length header plus UTF-8 body', () => {
  const framed = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' }).toString('utf8');
  const [header, body] = framed.split('\r\n\r\n');
  assert.match(header, /^Content-Length: \d+$/);
  assert.equal(Number(header.slice('Content-Length: '.length)), Buffer.byteLength(body, 'utf8'));
  assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 1, method: 'x' });
});

test('framing: byte length counts UTF-8, not characters', () => {
  const framed = encodeMessage({ text: '中文内容' }).toString('utf8');
  const [header, body] = framed.split('\r\n\r\n');
  assert.equal(Number(header.slice('Content-Length: '.length)), Buffer.byteLength(body, 'utf8'));
  assert.notEqual(Buffer.byteLength('中文内容', 'utf8'), '中文内容'.length);
});

test('framing: decoder reassembles a message split across chunks', () => {
  const decoder = new MessageDecoder(1024);
  const bytes = encodeMessage({ hello: 'world' });
  assert.deepEqual(decoder.push(bytes.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(bytes.subarray(5)), [{ hello: 'world' }]);
});

test('framing: decoder drains several messages from one chunk', () => {
  const decoder = new MessageDecoder(1024);
  const combined = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 }), encodeMessage({ n: 3 })]);
  assert.deepEqual(decoder.push(combined), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('framing: decoder rejects an oversized frame', () => {
  const decoder = new MessageDecoder(8);
  assert.throws(() => decoder.push(encodeMessage({ big: 'x'.repeat(100) })), /exceeds the 8-byte limit/);
});

test('framing: decoder rejects a header without Content-Length', () => {
  const decoder = new MessageDecoder(1024);
  assert.throws(() => decoder.push(Buffer.from('X-Nope: 1\r\n\r\n{}', 'ascii')), /missing Content-Length/);
});

test('framing: decoder rejects a non-JSON body', () => {
  const decoder = new MessageDecoder(1024);
  const body = Buffer.from('not json', 'utf8');
  const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
  assert.throws(() => decoder.push(framed), /not valid JSON/);
});

// ── connection ──────────────────────────────────────────────────────────────

test('connection: initialize round-trips and result is returned', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  const result = await conn.initialize({ processId: process.pid, capabilities: {} });
  assert.equal(result.serverInfo.name, 'fake');
  assert.equal(result.capabilities.documentSymbolProvider, true);
  await conn.shutdown();
  await conn.closed;
});

test('connection: routes a request and returns its result', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  const echoed = await conn.request('echo/ok', { value: 42 });
  assert.deepEqual(echoed, { value: 42 });
  await conn.shutdown();
  await conn.closed;
});

test('connection: METHOD_NOT_FOUND maps to LSP_UNSUPPORTED', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  await assert.rejects(conn.request('echo/error', {}), (error) => error.code === LSP_ERROR.UNSUPPORTED);
  await conn.shutdown();
  await conn.closed;
});

test('connection: ServerCancelled (-32802) maps to a retryable REQUEST_CANCELLED', async () => {
  // rust-analyzer answers pull-diagnostics with this while indexing. Treating it
  // as a hard failure would report a healthy server as broken.
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  await assert.rejects(
    conn.request('echo/server-cancelled', {}),
    (error) => error.code === LSP_ERROR.REQUEST_CANCELLED && /retry/.test(error.message),
  );
  await conn.shutdown();
  await conn.closed;
});

test('connection: CONTENT_MODIFIED maps to WRITE_CONFLICT', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  await assert.rejects(conn.request('echo/conflict', {}), (error) => error.code === LSP_ERROR.WRITE_CONFLICT);
  await conn.shutdown();
  await conn.closed;
});

test('connection: delivers inbound notifications to observers', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  const seen = [];
  conn.onNotification((method, params) => seen.push([method, params]));
  await conn.initialize({ capabilities: {} });
  // `initialized` triggers the fake's window/logMessage; give the loop a turn.
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(
    seen.some(([m]) => m === 'window/logMessage'),
    `expected window/logMessage, saw ${JSON.stringify(seen)}`,
  );
  await conn.shutdown();
  await conn.closed;
});

test('connection: answers a server-initiated request', async () => {
  const asked = [];
  const conn = new LspConnection(makeSpec(), testSpawner, async (method, params) => {
    asked.push(method);
    return [{ setting: true }];
  });
  await conn.initialize({ capabilities: {} });
  await conn.request('server/ask', {});
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(asked, ['workspace/configuration']);
  await conn.shutdown();
  await conn.closed;
});

test('connection: shutdown closes the child and settles `closed`', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  await conn.shutdown();
  await conn.closed;
  assert.equal(conn.failed, false);
  assert.equal(conn.handle.exitCode, 0);
});

test('connection: a request after close rejects', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  await conn.shutdown();
  await conn.closed;
  await assert.rejects(conn.request('echo/ok', {}));
});

test('connection: a dead server fails the transport with stderr context', async () => {
  // A command that exits immediately: the connection must observe close.
  const conn = new LspConnection(makeSpec({ command: process.execPath, args: ['-e', 'process.exit(3)'] }), testSpawner);
  await conn.closed;
  assert.equal(conn.failed, true);
  assert.match(conn.closeReason.message, /exited \(code 3\)/);
});

test('connection: concurrent requests settle independently', async () => {
  const conn = new LspConnection(makeSpec(), testSpawner);
  await conn.initialize({ capabilities: {} });
  const results = await Promise.all([
    conn.request('echo/ok', { n: 1 }),
    conn.request('echo/ok', { n: 2 }),
    conn.request('echo/ok', { n: 3 }),
  ]);
  assert.deepEqual(results, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  await conn.shutdown();
  await conn.closed;
});
