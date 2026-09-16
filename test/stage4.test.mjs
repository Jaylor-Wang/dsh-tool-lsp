/**
 * Stage-4 execution tests: the tool surface, edit application, and the write path.
 *
 * These run the real executor and tool definitions against the fake LSP server
 * over a real child process and a real filesystem, so the tests exercise the
 * whole path a live call takes. The two seams the harness provides at runtime are
 * stubbed faithfully rather than mocked away:
 *
 *  - `ctx.subprocess`, shaped like stage 1's spawner.
 *  - `ctx.fs`, a minimal implementation of the documented `FileSystem` contract
 *    **including the observation policy's semantics** — a write carries a guard
 *    derived from whether this owner previously read the target, so a stale file
 *    really does fail with `FS_STALE_VERSION`. Stubbing that out would make the
 *    write-conflict tests assert nothing.
 *
 * Run: node --test test/stage4.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { createTools, mergeDiagnostics } from '../lib/tools.js';
import { applyTextEdits, toUtf16Edits, lineDiff, openForCall, resolveRoot } from '../lib/executor.js';
import { LspSession } from '../lib/runner.js';
import { LSP_ERROR, DEFAULTS } from '../lib/vocabulary.js';
import { PositionCodec } from '../lib/translate.js';
import { displayPath, formatRange } from '../lib/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-server.mjs');

// ── seams ───────────────────────────────────────────────────────────────────

/** A `ctx.subprocess`-shaped spawner over `node:child_process`. */
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

/**
 * A minimal `FileSystem` over the real disk.
 *
 * Implements the parts the plugin uses, with the observation policy's rule: an
 * owner that has read a target may replace it at the version it saw, and a file
 * that changed underneath that read is refused. This is what makes the
 * write-conflict tests meaningful.
 */
class TestFs {
  /** Observed versions per owner, keyed like the real policy: owner → targetKey → version. */
  observed = new WeakMap();

  /** The actor whose reads are recorded; stands in for the tool execution context. */
  currentActor = undefined;

  /** One-shot hook run after a read, to simulate an external writer. */
  afterRead = undefined;

  #owner(actor) {
    return actor?.agent?.session;
  }

  #record(actor, target, version) {
    const owner = this.#owner(actor);
    if (owner === undefined) return;
    let byTarget = this.observed.get(owner);
    if (byTarget === undefined) {
      byTarget = new Map();
      this.observed.set(owner, byTarget);
    }
    byTarget.set(target.targetKey, version);
  }

  async resolve(path, opts = {}) {
    const { resolve } = await import('node:path');
    const absolute = resolve(opts.cwd ?? process.cwd(), path);
    return { targetKey: absolute, displayPath: absolute };
  }

  processPath(target) {
    return target.targetKey;
  }

  fileUrl(target) {
    return pathToFileURL(target.targetKey).href;
  }

  contains(parent, child) {
    return child.targetKey.startsWith(parent.targetKey);
  }

  async stat(target) {
    const { stat } = await import('node:fs/promises');
    try {
      const info = await stat(target.targetKey);
      if (!info.isFile()) return { version: `${info.mtimeMs}:${info.size}`, type: 'directory' };
      return { version: `${info.mtimeMs}:${info.size}`, type: 'file', size: info.size };
    } catch {
      return undefined;
    }
  }

  async lstat(path, opts = {}) {
    const target = await this.resolve(path, opts);
    return this.stat(target);
  }

  async readText(target) {
    const text = await readFile(target.targetKey, 'utf8');
    const info = await this.stat(target);
    this.#record(this.currentActor, target, info?.version);
    // Test hook: lets a case simulate an external writer landing between the
    // read a call performs and the write it later issues.
    if (this.afterRead !== undefined) {
      const hook = this.afterRead;
      this.afterRead = undefined;
      await hook(target);
    }
    return text;
  }

  /**
   * Write with the observation policy's guard.
   *
   * `actor` is supplied by the test through {@link TestFs#currentActor}, standing
   * in for the tool execution context the real waterfall receives.
   */
  async writeText(target, content, expected) {
    const prior = (() => {
      const owner = this.#owner(this.currentActor);
      return owner === undefined ? undefined : this.observed.get(owner)?.get(target.targetKey);
    })();

    const info = await this.stat(target);
    if (prior !== undefined && info !== undefined && prior !== info.version) {
      const error = new Error(`stale: ${target.displayPath}`);
      error.code = 'FS_STALE_VERSION';
      throw error;
    }
    if (expected?.kind === 'createIfAbsent' && info !== undefined) {
      const error = new Error(`exists: ${target.displayPath}`);
      error.code = 'FS_NOT_OBSERVED';
      throw error;
    }

    const before = info === undefined ? null : await readFile(target.targetKey, 'utf8');
    await writeFile(target.targetKey, content, 'utf8');
    const after = await this.stat(target);
    this.#record(this.currentActor, target, after?.version);
    return { operation: before === null ? 'create' : 'update', version: after?.version, before, after: content };
  }

  async editText(target, edit) {
    const before = await readFile(target.targetKey, 'utf8');
    const after = before.replace(edit.oldString, edit.newString);
    await writeFile(target.targetKey, after, 'utf8');
    return { version: 'x', before, after };
  }
}

// ── harness ─────────────────────────────────────────────────────────────────

/** A workspace: a temp directory with a file, plus the tool context over it. */
async function makeWorkspace(text, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lsp-4-'));
  const file = join(dir, options.name ?? 'main.rs');
  await writeFile(file, text, 'utf8');
  const root = await resolveRoot(new TestFs(), dir);

  const fs = options.fs ?? new TestFs();
  const actor = { agent: { session: {} } };
  fs.currentActor = actor;

  const sessions = new Map();
  const sessionFor = async (server, resolvedRoot, signal) => {
    let session = sessions.get(server.serverId);
    if (session === undefined) {
      session = new LspSession(
        {
          serverId: server.serverId,
          command: process.execPath,
          args: [FAKE],
          cwd: resolvedRoot.path,
          env: options.env ?? {},
          initializationOptions: null,
          configuration: options.configuration ?? null,
          maxMessageBytes: DEFAULTS.MAX_MESSAGE_BYTES,
          maxStderrBytes: DEFAULTS.MAX_STDERR_BYTES,
          killGraceMs: DEFAULTS.KILL_GRACE_MS,
          shutdownTimeoutMs: DEFAULTS.SHUTDOWN_TIMEOUT_MS,
        },
        testSpawner,
        resolvedRoot.uri,
        options.timeoutMs ?? 20000,
      );
      sessions.set(server.serverId, session);
    }
    await session.start(signal);
    return session;
  };

  const limits = {
    maxDiagnostics: options.maxDiagnostics ?? 200,
    maxSymbols: options.maxSymbols ?? 100,
    maxCodeActions: options.maxCodeActions ?? 50,
    maxResultChars: options.maxResultChars ?? 16000,
    maxDiffLines: options.maxDiffLines ?? 60,
  };

  const ctx = {
    fs,
    servers: [
      {
        serverId: 'fake',
        executable: process.execPath,
        entry: {
          extensionToLanguage: { '.rs': 'rust' },
          fileGlobs: [],
          projectMarkers: [],
          args: [],
          formattingOptions: options.serverFormattingOptions ?? null,
        },
      },
    ],
    sessions,
    rootFor: async () => root,
    sessionFor,
    formattingOptions: { tabSize: 2, insertSpaces: true },
    maxDocumentBytes: 8 * 1024 * 1024,
    limits,
  };

  const tools = new Map(createTools(ctx).map((tool) => [tool.name, tool]));
  const exec = { signal: new AbortController().signal, agent: actor.agent };
  const run = (name, args) => tools.get(name).execute(args, exec);

  return {
    dir,
    file,
    root,
    fs,
    ctx,
    tools,
    exec,
    run,
    actor,
    async cleanup() {
      // `dispose` asks the server to exit; the child may still hold a handle on
      // the temp directory for a moment afterwards, which makes `rm` fail with
      // EBUSY on Windows. Capture the connection first (dispose clears it), then
      // wait for the process to actually go away before deleting.
      const closing = [...sessions.values()];
      const connections = closing.map((session) => session.connection);
      await Promise.all(closing.map((session) => session.dispose().catch(() => {})));
      await Promise.all(connections.map((connection) => connection?.closed?.catch(() => {})));
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

// ── edit application ────────────────────────────────────────────────────────

test('applyTextEdits applies multiple edits without shifting offsets', () => {
  // Two edits on the same line: applying the earlier one first would move the
  // later one's target, which is exactly the bug back-to-front order prevents.
  // The trailing character stays, so the result keeps the tail of the line.
  const text = 'aaaaaaaaaa';
  const result = applyTextEdits(text, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'X' },
    { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'Y' },
  ]);
  assert.equal(result, 'XaaaYa');
});

test('applyTextEdits handles edits spanning lines', () => {
  const text = 'one\ntwo\nthree\n';
  const result = applyTextEdits(text, [
    {
      range: { start: { line: 1, character: 1 }, end: { line: 2, character: 2 } },
      newText: 'X',
    },
  ]);
  assert.equal(result, 'one\ntXree\n');
});

test('applyTextEdits refuses overlapping edits rather than picking one', () => {
  const text = 'abcdefgh';
  assert.throws(
    () =>
      applyTextEdits(text, [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'X' },
        { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } }, newText: 'Y' },
      ]),
    (error) => error.code === LSP_ERROR.SERVER_ERROR && /overlapping/.test(error.message),
  );
});

test('applyTextEdits clamps a column past the end of its line', () => {
  const text = 'ab\ncd\n';
  // A line's range includes its own newline, so clamping to the end of line 0
  // replaces up to and including the "\n" — it must not bleed into line 1's text.
  const result = applyTextEdits(text, [
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 99 } }, newText: 'X' },
  ]);
  assert.equal(result, 'aXcd\n');
});

test('toUtf16Edits converts a utf-8 server offset back to a UTF-16 index', () => {
  // "日本語" is 3 UTF-16 units but 9 UTF-8 bytes. An edit expressed as byte
  // offset 6..9 must land on the third character, not at index 6.
  const text = '日本語x';
  const codec = new PositionCodec(text);
  const converted = toUtf16Edits(
    [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'Z' }],
    codec,
    'utf-8',
  );
  assert.deepEqual(converted[0].range, {
    start: { line: 0, character: 2 },
    end: { line: 0, character: 3 },
  });
  assert.equal(applyTextEdits(text, converted), '日本Zx');
});

test('toUtf16Edits is a no-op for a utf-16 server', () => {
  const edits = [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: 'x' }];
  assert.equal(toUtf16Edits(edits, new PositionCodec('abc'), 'utf-16'), edits);
});

// ── rendering ───────────────────────────────────────────────────────────────

test('displayPath relativizes paths under the root', () => {
  const root = process.platform === 'win32' ? 'C:\\work' : '/work';
  const inside = process.platform === 'win32' ? 'C:\\work\\sub\\a.rs' : '/work/sub/a.rs';
  const outside = process.platform === 'win32' ? 'C:\\other\\a.rs' : '/other/a.rs';
  assert.equal(displayPath(inside, root), 'sub/a.rs');
  assert.equal(displayPath(outside, root), outside);
});

test('formatRange collapses an empty and a same-line range', () => {
  const at = { line: 3, character: 5 };
  assert.equal(formatRange(at, at), '3:5');
  assert.equal(formatRange({ line: 3, character: 5 }, { line: 3, character: 9 }), '3:5-9');
  assert.equal(formatRange({ line: 3, character: 5 }, { line: 7, character: 1 }), '3:5-7:1');
});

test('lineDiff shows only the changed window with context counts', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nb\nX\nd\n';
  const { lines } = lineDiff(before, after, 50);
  // Counting is over split lines, and the trailing "\n" yields a final empty
  // line: '' and 'd' are both shared, so two lines follow the change.
  assert.deepEqual(lines, ['  2 unchanged lines before', '- c', '+ X', '  2 unchanged lines after']);
});

test('lineDiff truncates at the configured line cap', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'v\nw\nx\ny\nz\n';
  const { lines, truncated } = lineDiff(before, after, 2);
  assert.equal(lines.length, 2);
  assert.equal(truncated, true);
});

// ── tools over the fake server ──────────────────────────────────────────────

test('lsp_symbols returns a nested outline with one-based positions', async () => {
  const ws = await makeWorkspace('fn main() {}\nstruct Inner;\n');
  try {
    const { text } = await ws.run('lsp_symbols', { file_path: ws.file });
    assert.match(text, /2 symbols/);
    assert.match(text, /function main 1:4/);
    // The child symbol is nested one level deeper and reported on line 2.
    assert.match(text, /  struct Inner 2:1/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_symbols searches the workspace when query is given', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    const { text } = await ws.run('lsp_symbols', { file_path: ws.file, query: 'needle' });
    assert.match(text, /"needle" in workspace/);
    assert.match(text, /found_needle/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_diagnostics reports severity, locator, source and code', async () => {
  const ws = await makeWorkspace('fn main() {}\nlet x = 1;\n');
  try {
    const { text } = await ws.run('lsp_diagnostics', { file_path: ws.file });
    assert.match(text, /2 error/);
    assert.match(text, /error 1:1-4 \[fake\] \(E0001\): something is wrong on line 1/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_diagnostics merges a push-only diagnostic the pull channel omits', async () => {
  // rust-analyzer reports lints such as `unused_variables` only through
  // `publishDiagnostics`, while answering a pull request with an empty list.
  // Trusting the pull result alone would report "no diagnostics" for a file the
  // server has already flagged, which is a false negative — worse than an error.
  const ws = await makeWorkspace('fn main() {}\n', { env: { LSP_FAKE_PUSH: '1' } });
  try {
    const { text } = await ws.run('lsp_diagnostics', { file_path: ws.file });
    assert.match(text, /warning 1:1-3 \[fake-lint\] \(W0001\): pushed only: unused variable/);
    // The pull channel's own diagnostics are still present.
    assert.match(text, /error 1:1-4 \[fake\] \(E0001\)/);
    assert.match(text, /1 error, 1 warning/);
  } finally {
    await ws.cleanup();
  }
});

test('mergeDiagnostics drops a diagnostic both channels reported', () => {
  const shared = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    severity: 1,
    message: 'same',
    code: 'E1',
  };
  const merged = mergeDiagnostics([shared], [{ ...shared }]);
  assert.equal(merged.length, 1);
});

test('mergeDiagnostics keeps entries that differ in any identifying field', () => {
  const base = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    severity: 1,
    message: 'same',
  };
  const merged = mergeDiagnostics(
    [base],
    [{ ...base, severity: 2 }, { ...base, message: 'other' }],
  );
  assert.equal(merged.length, 3);
});

test('lsp_diagnostics retries a ServerCancelled answer instead of failing', async () => {
  // rust-analyzer answers pull-diagnostics this way until its index is warm.
  const ws = await makeWorkspace('fn main() {}\n', { env: { LSP_FAKE_RETRIGGER: '2' } });
  try {
    const { text } = await ws.run('lsp_diagnostics', { file_path: ws.file });
    assert.match(text, /1 error/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_diagnostics gives up after exhausting retries', async () => {
  const ws = await makeWorkspace('fn main() {}\n', { env: { LSP_FAKE_RETRIGGER: '99' } });
  try {
    await assert.rejects(
      () => ws.run('lsp_diagnostics', { file_path: ws.file }),
      (error) => error.code === LSP_ERROR.REQUEST_CANCELLED,
    );
  } finally {
    await ws.cleanup();
  }
});

test('lsp_code_action anchors on the first diagnostic when no range is given', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    const { text } = await ws.run('lsp_code_action', { file_path: ws.file });
    assert.match(text, /3 actions/);
    assert.match(text, /1\. Fix the thing \[quickfix\] \(preferred\) — edits 1 file/);
    // A command-only action carries no edit and must be reported as such.
    assert.match(text, /3\. Server-only command/);
    assert.doesNotMatch(text, /3\. Server-only command.*edits/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_format writes the formatted text and reports the diff', async () => {
  const ws = await makeWorkspace('fn main() {}  \nlet x = 1;\t\n');
  try {
    const { text } = await ws.run('lsp_format', { file_path: ws.file });
    assert.match(text, /formatted \(2 edits\)/);
    // Trailing whitespace is gone on disk, and the CRLF/tab are preserved as-is
    // apart from the removed runs.
    const onDisk = await readFile(ws.file, 'utf8');
    assert.equal(onDisk, 'fn main() {}\nlet x = 1;\n');
    // Diff lines carry the renderer's indentation, so the markers are anchored
    // with a trailing newline rather than at column 0.
    assert.match(text, /- fn main\(\) \{\}  \n/);
    assert.match(text, /\+ fn main\(\) \{\}\n/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_format is a no-op when the file is already formatted', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    const { text } = await ws.run('lsp_format', { file_path: ws.file });
    assert.match(text, /already formatted, no changes/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_format accepts the protocol\'s null answer as "nothing to change"', async () => {
  // `TextEdit[] | null` is the declared return type and real servers use the null
  // branch for a clean file — rust-analyzer does. Treating it as malformed made
  // `lsp_format` fail on exactly the files that needed no work.
  const ws = await makeWorkspace('fn main() {}\n', { env: { LSP_FAKE_FORMAT_NULL: '1' } });
  try {
    const { text } = await ws.run('lsp_format', { file_path: ws.file });
    assert.match(text, /already formatted, no changes/);
    // Nothing may be written: a null answer is not an empty edit list to apply.
    assert.equal(await readFile(ws.file, 'utf8'), 'fn main() {}\n');
  } finally {
    await ws.cleanup();
  }
});

test('lsp_format still rejects a genuinely malformed formatting result', async () => {
  // The null branch is the only non-array answer that is legal; a string or an
  // object is a broken server and must not be silently read as "no changes".
  const ws = await makeWorkspace('fn main() {}\n', { env: { LSP_FAKE_FORMAT_NULL: '2' } });
  try {
    await assert.rejects(
      () => ws.run('lsp_format', { file_path: ws.file }),
      (error) => error.code === LSP_ERROR.SERVER_ERROR && /malformed formatting result/.test(error.message),
    );
  } finally {
    await ws.cleanup();
  }
});

test('lsp_rename applies edits to every file the server touched', async () => {
  const ws = await makeWorkspace('fn main() {}\n', { name: 'main.rs' });
  try {
    const sibling = join(ws.dir, 'main.renamed.rs');
    await writeFile(sibling, 'main calls\n', 'utf8');

    const { text } = await ws.run('lsp_rename', {
      file_path: ws.file,
      line: 1,
      character: 4,
      new_name: 'entry',
    });

    assert.match(text, /renamed to "entry" in 2 files/);
    assert.equal(await readFile(ws.file, 'utf8'), 'entry main() {}\n');
    assert.equal(await readFile(sibling, 'utf8'), 'entry calls\n');
  } finally {
    await ws.cleanup();
  }
});

test('lsp_rename reports nothing to rename when the server returns null', async () => {
  const ws = await makeWorkspace('    \n');
  try {
    const { text } = await ws.run('lsp_rename', {
      file_path: ws.file,
      line: 1,
      character: 1,
      new_name: 'x',
    });
    assert.match(text, /nothing to rename/);
  } finally {
    await ws.cleanup();
  }
});

test('lsp_rename rejects an empty new_name before touching the server', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    await assert.rejects(
      () => ws.run('lsp_rename', { file_path: ws.file, line: 1, character: 4, new_name: '  ' }),
      (error) => error.code === LSP_ERROR.UNSUPPORTED,
    );
  } finally {
    await ws.cleanup();
  }
});

test('a path no server claims fails with LSP_NO_SERVER', async () => {
  const ws = await makeWorkspace('fn main() {}\n', { name: 'notes.txt' });
  try {
    await assert.rejects(
      () => ws.run('lsp_diagnostics', { file_path: ws.file }),
      (error) => error.code === LSP_ERROR.NO_SERVER && /no configured language server/.test(error.message),
    );
  } finally {
    await ws.cleanup();
  }
});

test('a missing file fails before any server is started', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    await assert.rejects(
      () => ws.run('lsp_diagnostics', { file_path: join(ws.dir, 'absent.rs') }),
      (error) => error.code === LSP_ERROR.NO_SERVER && /does not exist/.test(error.message),
    );
  } finally {
    await ws.cleanup();
  }
});

// ── write conflicts ─────────────────────────────────────────────────────────

test('a file changed after it was read is refused with LSP_WRITE_CONFLICT', async () => {
  const ws = await makeWorkspace('fn main() {}  \n');
  try {
    // Simulate a second writer landing in the window between the read this call
    // performs and the write it issues — the exact race the guard exists for.
    ws.fs.afterRead = async () => {
      await writeFile(ws.file, 'externally rewritten\n', 'utf8');
    };

    await assert.rejects(
      () => ws.run('lsp_format', { file_path: ws.file }),
      (error) => error.code === LSP_ERROR.WRITE_CONFLICT && /changed since it was read/.test(error.message),
    );
    // The external content must survive: nothing was overwritten.
    assert.equal(await readFile(ws.file, 'utf8'), 'externally rewritten\n');
  } finally {
    await ws.cleanup();
  }
});

// ── workspace configuration ─────────────────────────────────────────────────

/** Drive one `workspace/configuration` round trip and return the server's view of the answer. */
async function askConfiguration(ws) {
  const session = await ws.ctx.sessionFor(ws.ctx.servers[0], ws.root, undefined);
  const result = await session.request('server/ask', {}, undefined);
  return result.configuration;
}

test('a configured section is answered per requested item, in order', async () => {
  // The protocol wants one reply element per item: a server asking for
  // `typescript` and `javascript` must not be handed one flattened blob.
  const ws = await makeWorkspace('fn main() {}\n', {
    env: { LSP_FAKE_ASK_SECTIONS: 'typescript,javascript' },
    configuration: {
      typescript: { tsserver: { maxTsServerMemory: 3072 } },
      javascript: { preferences: { includePackageJsonAutoImports: 'on' } },
    },
  });
  try {
    assert.deepEqual(await askConfiguration(ws), [
      { tsserver: { maxTsServerMemory: 3072 } },
      { preferences: { includePackageJsonAutoImports: 'on' } },
    ]);
  } finally {
    await ws.cleanup();
  }
});

test('a section the entry does not define answers null rather than the whole object', async () => {
  const ws = await makeWorkspace('fn main() {}\n', {
    env: { LSP_FAKE_ASK_SECTIONS: 'rust-analyzer,missing' },
    configuration: { 'rust-analyzer': { checkOnSave: true } },
  });
  try {
    assert.deepEqual(await askConfiguration(ws), [{ checkOnSave: true }, null]);
  } finally {
    await ws.cleanup();
  }
});

test('a section-less request answers the whole configuration object', async () => {
  const ws = await makeWorkspace('fn main() {}\n', {
    env: { LSP_FAKE_ASK_SECTIONS: '' },
    configuration: { tabSize: 4 },
  });
  try {
    assert.deepEqual(await askConfiguration(ws), [{ tabSize: 4 }]);
  } finally {
    await ws.cleanup();
  }
});

test('an entry with no configuration answers one null per item, not an empty array', async () => {
  // `[]` is shape-invalid for a two-item request; a server that indexes the reply
  // would read `undefined`.
  const ws = await makeWorkspace('fn main() {}\n', { env: { LSP_FAKE_ASK_SECTIONS: 'a,b' } });
  try {
    assert.deepEqual(await askConfiguration(ws), [null, null]);
  } finally {
    await ws.cleanup();
  }
});

test("an entry's own formattingOptions reaches the server, overriding the plugin default", async () => {
  const ws = await makeWorkspace('fn main() {}  \n', {
    env: { LSP_FAKE_ASK_SECTIONS: 'x' },
    serverFormattingOptions: { tabSize: 4, insertSpaces: false },
  });
  try {
    await ws.run('lsp_format', { file_path: ws.file });
    const session = await ws.ctx.sessionFor(ws.ctx.servers[0], ws.root, undefined);
    const asked = await session.request('server/ask', {}, undefined);
    assert.deepEqual(asked.formattingOptions, { tabSize: 4, insertSpaces: false });
  } finally {
    await ws.cleanup();
  }
});

test('an entry without formattingOptions sends the plugin default', async () => {
  const ws = await makeWorkspace('fn main() {}  \n', { env: { LSP_FAKE_ASK_SECTIONS: 'x' } });
  try {
    await ws.run('lsp_format', { file_path: ws.file });
    const session = await ws.ctx.sessionFor(ws.ctx.servers[0], ws.root, undefined);
    const asked = await session.request('server/ask', {}, undefined);
    assert.deepEqual(asked.formattingOptions, { tabSize: 2, insertSpaces: true });
  } finally {
    await ws.cleanup();
  }
});

// ── position encoding ───────────────────────────────────────────────────────

test('a utf-8 server position is decoded against the document text', async () => {
  // The fake server reports symbol ranges in the encoding it advertises, so a
  // non-ASCII document proves the client converted them back correctly.
  const ws = await makeWorkspace('// 日本語\nfn main() {}\n', { env: { LSP_FAKE_ENCODING: 'utf-8' } });
  try {
    const { text } = await ws.run('lsp_diagnostics', { file_path: ws.file });
    // Line 1 is "// 日本語": its first three UTF-16 units are "// ".
    assert.match(text, /error 1:1-4/);
  } finally {
    await ws.cleanup();
  }
});

test('a utf-32 server position is decoded against the document text', async () => {
  const ws = await makeWorkspace('// 日本語\nfn main() {}\n', { env: { LSP_FAKE_ENCODING: 'utf-32' } });
  try {
    const { text } = await ws.run('lsp_diagnostics', { file_path: ws.file });
    assert.match(text, /error 1:1-4/);
  } finally {
    await ws.cleanup();
  }
});

test('an emoji document keeps symbol positions aligned', async () => {
  // An astral character is 2 UTF-16 units, 4 UTF-8 bytes and 1 code point, so it
  // separates all three encodings at once.
  const ws = await makeWorkspace('// 🎯\nfn main() {}\n', { env: { LSP_FAKE_ENCODING: 'utf-8' } });
  try {
    const { text } = await ws.run('lsp_symbols', { file_path: ws.file });
    assert.match(text, /function main 1:4/);
  } finally {
    await ws.cleanup();
  }
});

// ── session lifecycle ───────────────────────────────────────────────────────

test('one session serves many calls without respawning the server', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    await ws.run('lsp_symbols', { file_path: ws.file });
    const session = [...ws.ctx.sessions.values()][0];
    const connection = session.connection;
    await ws.run('lsp_diagnostics', { file_path: ws.file });
    assert.equal([...ws.ctx.sessions.values()][0].connection, connection, 'the server was not restarted');
    assert.equal(ws.ctx.sessions.size, 1);
  } finally {
    await ws.cleanup();
  }
});

test('concurrent cold calls share one server start', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    await Promise.all([
      ws.run('lsp_symbols', { file_path: ws.file }),
      ws.run('lsp_diagnostics', { file_path: ws.file }),
      ws.run('lsp_code_action', { file_path: ws.file }),
    ]);
    assert.equal(ws.ctx.sessions.size, 1);
  } finally {
    await ws.cleanup();
  }
});

test('a formatted file is re-opened so the next call sees the new text', async () => {
  const ws = await makeWorkspace('fn main() {}  \n');
  try {
    await ws.run('lsp_format', { file_path: ws.file });
    const session = [...ws.ctx.sessions.values()][0];
    // The document was closed after the write, so no stale text is cached.
    const uri = ws.fs.fileUrl(await ws.fs.resolve(ws.file));
    assert.equal(session.document(uri), undefined);
  } finally {
    await ws.cleanup();
  }
});

test('dispose shuts the server down and is idempotent', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    await ws.run('lsp_symbols', { file_path: ws.file });
    const session = [...ws.ctx.sessions.values()][0];
    await session.dispose();
    await session.dispose();
    assert.equal(session.alive, false);
  } finally {
    await ws.cleanup();
  }
});

test('a request after dispose fails rather than hanging', async () => {
  const ws = await makeWorkspace('fn main() {}\n');
  try {
    await ws.run('lsp_symbols', { file_path: ws.file });
    const session = [...ws.ctx.sessions.values()][0];
    await session.dispose();
    await assert.rejects(() => session.request('textDocument/documentSymbol', {}, undefined));
  } finally {
    await ws.cleanup();
  }
});

// ── timeouts ────────────────────────────────────────────────────────────────

test('a request that outlives the budget fails with LSP_TIMEOUT', async () => {
  const ws = await makeWorkspace('fn main() {}\n', { timeoutMs: 1 });
  try {
    await assert.rejects(
      () => ws.run('lsp_symbols', { file_path: ws.file }),
      (error) => error.code === LSP_ERROR.TIMEOUT,
    );
  } finally {
    await ws.cleanup();
  }
});
