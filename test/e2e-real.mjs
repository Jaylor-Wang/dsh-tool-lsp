// End-to-end verification of the stage-4 tool surface against REAL language
// servers, driven through createTools() exactly as index.js assembles it.
//
// The fake server in test/ was written by the same author as the client, so it
// can share the client's misconceptions. This harness is the antidote: it runs
// the real five tools over real files and a real language server, and prints
// what each one produced.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createTools } from 'file:///E:/Github/dsh-tool-lsp/lib/tools.js';
import { resolveRoot } from 'file:///E:/Github/dsh-tool-lsp/lib/executor.js';
import { LspSession } from 'file:///E:/Github/dsh-tool-lsp/lib/runner.js';
import { DEFAULTS } from 'file:///E:/Github/dsh-tool-lsp/lib/vocabulary.js';

const ROOT = process.argv[2];
const FILE = process.argv[3] ?? 'src/main.rs';
const SERVER = process.argv[4] ?? 'rust';

// ── the two seams, over the real world ──────────────────────────────────────

const spawner = (spec) => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...spec.env },
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    collected: { stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length }) } },
    done,
    get exitCode() {
      return child.exitCode;
    },
  };
};

/** Real filesystem with the observation policy's staleness guard. */
class RealFs {
  observed = new WeakMap();
  currentActor = undefined;
  #owner(actor) {
    return actor?.agent?.session;
  }
  #record(actor, target, version) {
    const owner = this.#owner(actor);
    if (owner === undefined) return;
    let m = this.observed.get(owner);
    if (m === undefined) {
      m = new Map();
      this.observed.set(owner, m);
    }
    m.set(target.targetKey, version);
  }
  async resolve(path, opts = {}) {
    const { resolve } = await import('node:path');
    const abs = resolve(opts.cwd ?? process.cwd(), path);
    return { targetKey: abs, displayPath: abs };
  }
  processPath(target) {
    return target.targetKey;
  }
  fileUrl(target) {
    return pathToFileURL(target.targetKey).href;
  }
  async stat(target) {
    const { stat } = await import('node:fs/promises');
    try {
      const i = await stat(target.targetKey);
      if (!i.isFile()) return { version: String(i.mtimeMs), type: 'directory' };
      return { version: `${i.mtimeMs}:${i.size}`, type: 'file', size: i.size };
    } catch {
      return undefined;
    }
  }
  async lstat(path, opts = {}) {
    return this.stat(await this.resolve(path, opts));
  }
  async readText(target) {
    const text = await readFile(target.targetKey, 'utf8');
    const info = await this.stat(target);
    this.#record(this.currentActor, target, info?.version);
    return text;
  }
  async writeText(target, content) {
    const owner = this.#owner(this.currentActor);
    const prior = owner === undefined ? undefined : this.observed.get(owner)?.get(target.targetKey);
    const info = await this.stat(target);
    if (prior !== undefined && info !== undefined && prior !== info.version) {
      const e = new Error(`stale: ${target.displayPath}`);
      e.code = 'FS_STALE_VERSION';
      throw e;
    }
    const before = info === undefined ? null : await readFile(target.targetKey, 'utf8');
    await writeFile(target.targetKey, content, 'utf8');
    const after = await this.stat(target);
    this.#record(this.currentActor, target, after?.version);
    return { operation: before === null ? 'create' : 'update', version: after?.version, before, after: content };
  }
  async editText() {
    throw new Error('unused');
  }
}

// ── assembly, mirroring index.js ────────────────────────────────────────────

const sr = { rust: { command: 'rust-analyzer', ext: { '.rs': 'rust' } }, ts: { command: 'node', args: ['D:/nodejs/node_global/node_modules/@vtsls/language-server/bin/vtsls.js', '--stdio'], ext: { '.ts': 'typescript', '.js': 'javascript' } } }[SERVER];
const fs = new RealFs();
const actor = { agent: { session: {} } };
fs.currentActor = actor;

const servers = [
  {
    serverId: SERVER,
    executable: sr.command,
    entry: {
      extensionToLanguage: sr.ext,
      fileGlobs: [],
      projectMarkers: [],
      args: sr.args ?? [],
      initializationOptions: null,
      maxMessageBytes: DEFAULTS.MAX_MESSAGE_BYTES,
      maxStderrBytes: DEFAULTS.MAX_STDERR_BYTES,
      killGraceMs: DEFAULTS.KILL_GRACE_MS,
      shutdownTimeoutMs: 10000,
      env: {},
    },
  },
];

const root = await resolveRoot(fs, ROOT);
const sessions = new Map();
const sessionFor = async (server, r, signal) => {
  let s = sessions.get(server.serverId);
  if (s === undefined) {
    s = new LspSession(
      {
        serverId: server.serverId,
        command: server.executable,
        args: sr.args ?? [],
        cwd: r.path,
        env: {},
        initializationOptions: null,
        maxMessageBytes: DEFAULTS.MAX_MESSAGE_BYTES,
        maxStderrBytes: DEFAULTS.MAX_STDERR_BYTES,
        killGraceMs: DEFAULTS.KILL_GRACE_MS,
        shutdownTimeoutMs: 10000,
      },
      spawner,
      r.uri,
      120000,
    );
    sessions.set(server.serverId, s);
  }
  await s.start(signal);
  return s;
};

const ctx = {
  fs,
  servers,
  sessions,
  rootFor: async () => root,
  sessionFor,
  formattingOptions: { tabSize: 4, insertSpaces: true },
  maxDocumentBytes: 8 << 20,
  limits: { maxDiagnostics: 200, maxSymbols: 100, maxCodeActions: 50, maxResultChars: 16000, maxDiffLines: 60 },
};

const tools = new Map(createTools(ctx).map((t) => [t.name, t]));
const exec = { signal: new AbortController().signal, agent: actor.agent };
const run = (name, args) => tools.get(name).execute(args, exec);

const show = (label, outcome) => {
  console.log(`\n${'═'.repeat(72)}\n${label}\n${'─'.repeat(72)}`);
  if (outcome.ok) console.log(outcome.text);
  else console.log(`FAILED [${outcome.code ?? 'no-code'}] ${outcome.message}`);
};

const attempt = async (label, fn) => {
  try {
    const { text } = await fn();
    show(label, { ok: true, text });
  } catch (error) {
    show(label, { ok: false, code: error?.code, message: error.message });
  }
};

const FILE_ABS = `${ROOT}/${FILE}`;

console.log(`root: ${ROOT}\nfile: ${FILE}\nserver: ${sr.command}`);

await attempt('lsp_symbols (document outline)', () => run('lsp_symbols', { file_path: FILE_ABS }));
await attempt('lsp_diagnostics (pull, cold index)', () => run('lsp_diagnostics', { file_path: FILE_ABS }));
await attempt('lsp_code_action (anchored on first diagnostic)', () => run('lsp_code_action', { file_path: FILE_ABS }));

// The cursor is placed on `Point` in the struct declaration (line 6, column 8).
await attempt('lsp_rename Point -> Vertex (multi-file write)', () =>
  run('lsp_rename', { file_path: FILE_ABS, line: 6, character: 8, new_name: 'Vertex' }),
);

console.log('\nfile after rename:\n');
console.log(await readFile(FILE_ABS, 'utf8'));

await attempt('lsp_format (whole file)', () => run('lsp_format', { file_path: FILE_ABS }));
console.log('\nfile after format:\n');
console.log(await readFile(FILE_ABS, 'utf8'));

// A deliberately messy file, to prove formatting actually changes something.
await writeFile(FILE_ABS, 'fn  main( )  {\n        let  x=1;\n}\n', 'utf8');
await attempt('lsp_format (messy input)', () => run('lsp_format', { file_path: FILE_ABS }));
console.log('\nfile after formatting the messy input:\n');
console.log(await readFile(FILE_ABS, 'utf8'));

for (const s of sessions.values()) await s.dispose();
console.log('\nsessions disposed');
process.exit(0);
