// A minimal LSP server for tests: Content-Length framing over stdio.
// Answers `initialize`, echoes `echo/*` requests, emits one notification, and
// honours `shutdown`/`exit`. No dependencies — it exists so the connection
// layer can be tested without a real language server.
//
// Stage 4 extends it into a small but real document server: it tracks opened
// documents, answers `documentSymbol`, `diagnostic`, `formatting`, `rename`,
// `codeAction` and `workspace/symbol` from scripted fixtures, and reports the
// position encoding selected by `LSP_FAKE_ENCODING`. The scripted responses are
// deliberately expressed in UTF-16 offsets and converted on the way out, so a
// test can assert that the client decoded them correctly for each encoding.
const HEADER = '\r\n\r\n';
let buffer = Buffer.alloc(0);
/** Pending `server/ask` caller id, so the client's answer can unblock it. */
let pendingAsk = null;
/** The `FormattingOptions` of the most recent formatting request, reported through `server/ask`. */
let lastFormattingOptions = null;
/** Documents the client has opened, keyed by URI: { text, languageId, version }. */
const documents = new Map();
/** The position encoding this instance advertises. */
const ENCODING = process.env.LSP_FAKE_ENCODING || 'utf-16';
/** How many `diagnostic` requests to reject with ServerCancelled before answering. */
let retriggersLeft = Number(process.env.LSP_FAKE_RETRIGGER ?? 0);
/** Whether `textDocument/diagnostic` is advertised at all. */
const PULL = process.env.LSP_FAKE_PULL !== '0';
/**
 * Sections the fake server asks for in `server/ask`. A `null` entry makes it ask
 * with an item that carries no section, which is how a server requests "the whole
 * settings object" rather than one named section.
 */
const ASK_SECTIONS = process.env.LSP_FAKE_ASK_SECTIONS === undefined
  ? ['x']
  : process.env.LSP_FAKE_ASK_SECTIONS.split(',').map((value) => (value === '' ? null : value));
/**
 * Formatting-answer override, so both halves of the protocol's `TextEdit[] | null`
 * return type are covered: `'null'` is the legal "nothing to change" branch, and
 * `'broken'` is a value no server may send.
 */
const FORMAT_MODE = process.env.LSP_FAKE_FORMAT_NULL === '1'
  ? 'null'
  : process.env.LSP_FAKE_FORMAT_NULL === '2'
    ? 'broken'
    : null;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf(HEADER);
    if (end < 0) break;
    const len = Number(/^Content-Length: (\d+)/m.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
    const start = end + HEADER.length;
    if (buffer.length < start + len) break;
    const msg = JSON.parse(buffer.subarray(start, start + len).toString('utf8'));
    buffer = buffer.subarray(start + len);
    handle(msg);
  }
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER}`, 'ascii'), body]));
}

/** Convert a UTF-16 character offset within one line to the advertised encoding. */
function encodeChar(text, line, character) {
  if (ENCODING === 'utf-16') return character;
  const lines = text.split('\n');
  const content = lines[line] ?? '';
  const slice = content.slice(0, character);
  if (ENCODING === 'utf-8') return Buffer.byteLength(slice, 'utf8');
  return [...slice].length;
}

/** Build a wire position from a UTF-16 one, in the advertised encoding. */
function pos(text, line, character) {
  return { line, character: encodeChar(text, line, character) };
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          documentSymbolProvider: true,
          renameProvider: true,
          codeActionProvider: true,
          documentFormattingProvider: true,
          workspaceSymbolProvider: true,
          ...(PULL ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
          positionEncoding: ENCODING,
        },
        serverInfo: { name: 'fake', version: '4.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'initialized') {
    send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'fake ready' } });
    return;
  }

  // ── document lifecycle ────────────────────────────────────────────────────
  if (msg.method === 'textDocument/didOpen') {
    const { uri, text, languageId, version } = msg.params.textDocument;
    documents.set(uri, { text, languageId, version });
    // A lint-style diagnostic that only ever arrives by push, mirroring how
    // rust-analyzer reports `unused_variables`: the pull channel stays empty.
    if (process.env.LSP_FAKE_PUSH === '1') {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
              severity: 2,
              source: 'fake-lint',
              code: 'W0001',
              message: 'pushed only: unused variable',
            },
          ],
        },
      });
    }
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const doc = documents.get(msg.params.textDocument.uri);
    if (doc !== undefined) {
      doc.text = msg.params.contentChanges[0].text;
      doc.version = msg.params.textDocument.version;
    }
    return;
  }
  if (msg.method === 'textDocument/didClose') {
    documents.delete(msg.params.textDocument.uri);
    return;
  }

  // ── LSP methods ───────────────────────────────────────────────────────────
  if (msg.method === 'textDocument/documentSymbol') {
    const doc = documents.get(msg.params.textDocument.uri);
    if (doc === undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'document not open' } });
      return;
    }
    const text = doc.text;
    // Fixture: a function `main` on the first line, and a nested struct.
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          name: 'main',
          kind: 12,
          range: { start: pos(text, 0, 0), end: pos(text, 0, 10) },
          selectionRange: { start: pos(text, 0, 3), end: pos(text, 0, 7) },
          children: [
            {
              name: 'Inner',
              kind: 23,
              range: { start: pos(text, 1, 0), end: pos(text, 1, 5) },
              selectionRange: { start: pos(text, 1, 0), end: pos(text, 1, 5) },
            },
          ],
        },
      ],
    });
    return;
  }
  if (msg.method === 'workspace/symbol') {
    const first = [...documents.values()][0];
    const text = first?.text ?? '';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          name: `found_${msg.params.query}`,
          kind: 12,
          location: {
            uri: [...documents.keys()][0] ?? 'file:///none',
            range: { start: pos(text, 0, 0), end: pos(text, 0, 4) },
          },
        },
      ],
    });
    return;
  }
  if (msg.method === 'textDocument/diagnostic') {
    if (retriggersLeft > 0) {
      retriggersLeft -= 1;
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32802, message: 'server cancelled the request', data: { retriggerRequest: true } },
      });
      return;
    }
    const doc = documents.get(msg.params.textDocument.uri);
    if (doc === undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'document not open' } });
      return;
    }
    const text = doc.text;
    // Report a diagnostic on each of the first three non-empty lines, spanning
    // the line's first three UTF-16 columns.
    const results = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      results.push({
        range: { start: pos(text, i, 0), end: pos(text, i, Math.min(3, lines[i].length)) },
        severity: 1,
        source: 'fake',
        code: 'E0001',
        message: `something is wrong on line ${i + 1}`,
      });
      if (results.length >= 3) break;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { kind: 'full', items: results } });
    return;
  }
  if (msg.method === 'textDocument/formatting' || msg.method === 'textDocument/rangeFormatting') {
    const doc = documents.get(msg.params.textDocument.uri);
    if (doc === undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'document not open' } });
      return;
    }
    // Fixture: delete every run of trailing whitespace, one edit per line, using
    // UTF-16 columns converted to the advertised encoding.
    lastFormattingOptions = msg.params.options ?? null;
    // The protocol's return type is `TextEdit[] | null`, and real servers use the
    // null branch for "nothing to change" (rust-analyzer does). `LSP_FAKE_FORMAT_NULL`
    // makes this server answer that way so the client's handling of it is covered.
    if (FORMAT_MODE !== null) {
      send({ jsonrpc: '2.0', id: msg.id, result: FORMAT_MODE === 'null' ? null : 'not-an-edit-list' });
      return;
    }
    const edits = [];
    const lines = doc.text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.length === line.length) continue;
      edits.push({
        range: {
          start: { line: i, character: encodeChar(doc.text, i, trimmed.length) },
          end: { line: i, character: encodeChar(doc.text, i, line.length) },
        },
        newText: '',
      });
    }
    send({ jsonrpc: '2.0', id: msg.id, result: edits });
    return;
  }
  if (msg.method === 'textDocument/rename') {
    const doc = documents.get(msg.params.textDocument.uri);
    if (doc === undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'document not open' } });
      return;
    }
    const { position, newName } = msg.params;
    // Fixture: rename the first identifier-like token on the requested line of
    // the origin file, and the first token of a sibling file, to exercise
    // multi-file edits. The sibling's range is computed from ITS OWN text, as a
    // real server would — reusing the origin's match length would splice at the
    // wrong offset.
    const lines = doc.text.split('\n');
    const lineText = lines[position.line] ?? '';
    const match = /[A-Za-z_][A-Za-z0-9_]*/.exec(lineText);
    if (match === null) {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    const uri = msg.params.textDocument.uri;
    const sibling = uri.replace(/\.([a-z]+)$/, `.renamed.$1`);
    const siblingDoc = documents.get(sibling);
    const siblingText = siblingDoc?.text ?? 'main calls\n';
    const siblingMatch = /[A-Za-z_][A-Za-z0-9_]*/.exec(siblingText.split('\n')[0] ?? '');
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        changes: {
          [uri]: [
            {
              range: {
                start: { line: position.line, character: encodeChar(doc.text, position.line, match.index) },
                end: { line: position.line, character: encodeChar(doc.text, position.line, match.index + match[0].length) },
              },
              newText: newName,
            },
          ],
          [sibling]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: encodeChar(siblingText, 0, siblingMatch ? siblingMatch[0].length : 4) },
              },
              newText: newName,
            },
          ],
        },
      },
    });
    return;
  }
  if (msg.method === 'textDocument/codeAction') {
    const { range } = msg.params;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          title: 'Fix the thing',
          kind: 'quickfix',
          isPreferred: true,
          edit: { changes: { [msg.params.textDocument.uri]: [] } },
        },
        { title: 'Refactor the other thing', kind: 'refactor' },
        { title: 'Server-only command', command: 'fake.doThing' },
      ],
    });
    return;
  }

  // ── scripted transport behaviour ──────────────────────────────────────────
  if (msg.method === 'echo/ok') { send({ jsonrpc: '2.0', id: msg.id, result: msg.params ?? { echoed: true } }); return; }
  if (msg.method === 'echo/error') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } }); return; }
  if (msg.method === 'echo/server-cancelled') {
    // LSP 3.17 ServerCancelled: "no answer ready, retry" — not a failure.
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32802, message: 'server cancelled the request', data: { retriggerRequest: true } } });
    return;
  }
  if (msg.method === 'echo/conflict') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32801, message: 'content modified' } });
    return;
  }
  if (msg.method === 'server/ask') {
    // Server→client request: the peer must answer or this hangs. The answer
    // arrives as a message with an id and no method; echoing a marker back lets
    // the test observe that the client really answered. The requested sections
    // are fixed so the answer can be asserted key by key.
    // A `null` entry means "ask with no section at all" — the shape a server uses
    // when it wants one unnamed settings blob.
    const items = ASK_SECTIONS.includes(null) ? [{}] : ASK_SECTIONS.map((section) => ({ section }));
    send({ jsonrpc: '2.0', id: 9001, method: 'workspace/configuration', params: { items } });
    pendingAsk = msg.id;
    return;
  }
  if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: null }); return; }
  if (msg.id !== undefined && msg.method === undefined) {
    // A client answer to our request: unblock the original caller, and report the
    // answer itself through the pending caller's result so a test can assert it.
    if (msg.id === 9001 && pendingAsk !== null) {
      send({ jsonrpc: '2.0', id: pendingAsk, result: { answered: true, configuration: msg.result, error: msg.error, formattingOptions: lastFormattingOptions } });
      pendingAsk = null;
    }
    return;
  }
  if (msg.method === 'exit') { process.exit(0); return; }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
}
