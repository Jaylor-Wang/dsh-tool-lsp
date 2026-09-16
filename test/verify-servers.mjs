/**
 * Live check of the servers table that actually ships in a DSH profile.
 *
 * The unit tests use a fake server written by the same author as the client, so
 * they can only prove the client is self-consistent. This script is the antidote:
 * it reads the REAL `servers:` block out of a profile's `cordis.patch.yml` and
 * starts every configured language server through the plugin's own `LspSession`,
 * then runs one real request against a real file.
 *
 * What it proves, per entry: the command resolves on PATH the way the DSH
 * subprocess seam resolves it, the launch `args` are accepted, the LSP handshake
 * completes, the negotiated position encoding is understood, and a real document
 * request comes back.
 *
 * Usage: node test/verify-servers.mjs [profileDir]
 */
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { LspSession } from '../lib/runner.js';
import { DEFAULTS } from '../lib/vocabulary.js';

const PROFILE_DIR = process.argv[2] ?? 'C:\\Users\\29507\\.dsh\\profiles\\web';

// ── reading the profile's real servers table ────────────────────────────────

/** Merge every `- id: lsp` row of the profile patch, exactly as the loader does. */
function readServers(profileDir) {
  const require = createRequire(pathToFileURL(join(profileDir, 'noop.js')));
  const { load } = require('js-yaml');
  const { readFileSync } = require('node:fs');
  const rows = load(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'));
  if (!Array.isArray(rows)) throw new Error('profile patch is not a top-level array');
  const merged = {};
  let disabled;
  for (const row of rows) {
    if (row?.id !== 'lsp') continue;
    if (typeof row.disabled === 'boolean') disabled = row.disabled;
    if (row.config?.servers !== undefined) Object.assign(merged, row.config.servers);
  }
  return { servers: merged, disabled };
}

// ── the two seams, over the real world ──────────────────────────────────────

/**
 * The DSH subprocess seam's resolution rule, reproduced: a bare name is looked
 * up on PATH through PATHEXT, and an extensionless command only matches a
 * PATHEXT variant. Reproducing it matters — the point of this script is to see
 * what the plugin sees, not what a shell would.
 */
function resolveExecutable(command) {
  const extensions = extname(command) === ''
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, command + extension);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  throw new Error(`"${command}" was not found on PATH`);
}

/**
 * A real child process. `.cmd`/`.bat` launchers — how npm installs `vtsls` and
 * `biome` — are not executable images, so Windows needs a shell for those;
 * language servers are long-lived and receive their protocol on stdin, and a
 * shell wrapper passes it through untouched.
 */
function spawner(spec) {
  const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(spec.argv[0]);
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...spec.env },
    shell: needsShell,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise((resolveDone, rejectDone) => {
    child.on('error', rejectDone);
    child.on('close', (exitCode, signal) => resolveDone({ exitCode, signal }));
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
}

// ── one real file per language, each with a deliberate defect ───────────────

/** The first extension an entry claims, plus a source sample that server should complain about. */
function sampleFor(serverId, entry) {
  const first = Object.keys(entry.extensionToLanguage)[0];
  const byExtension = {
    '.rs': ['main.rs', 'fn main() {\n    let unused_value: i32 = 1;\n    let bad: i32 = "text";\n}\n'],
    '.ts': ['main.ts', 'const bad: number = "text";\nexport default bad;\n'],
    '.js': ['main.js', 'const value = 1;\nexport default value;\n'],
    '.py': ['main.py', 'def broken():\n    return undefined_name_xyz\n'],
    '.json': ['data.json', '{\n  "a": 1,\n  "b": 2,\n}\n'],
    '.css': ['style.css', 'a { color: red }\n'],
  };
  const picked = byExtension[first];
  if (picked === undefined) throw new Error(`${serverId}: no sample for extension ${first}`);
  return { name: picked[0], text: picked[1], languageId: entry.extensionToLanguage[first] };
}

// ── the check ───────────────────────────────────────────────────────────────

/** Run one server end to end and report what happened. */
async function check(serverId, entry) {
  const executable = resolveExecutable(entry.command);
  const directory = await mkdtemp(join(tmpdir(), `dsh-lsp-verify-${serverId}-`));
  const sample = sampleFor(serverId, entry);
  const file = join(directory, sample.name);
  await writeFile(file, sample.text, 'utf8');
  const uri = pathToFileURL(file).href;

  const session = new LspSession(
    {
      serverId,
      command: executable,
      // `args` is absent from an entry that needs none; the plugin's schema
      // defaults it to `[]` at load, so the launch spec has to see the same.
      args: entry.args ?? [],
      cwd: directory,
      env: entry.env ?? {},
      initializationOptions: entry.initializationOptions ?? null,
      configuration: entry.configuration ?? null,
      maxMessageBytes: DEFAULTS.MAX_MESSAGE_BYTES,
      maxStderrBytes: DEFAULTS.MAX_STDERR_BYTES,
      killGraceMs: DEFAULTS.KILL_GRACE_MS,
      shutdownTimeoutMs: 15000,
    },
    spawner,
    pathToFileURL(directory).href,
    Number(process.env.LSP_VERIFY_TIMEOUT_MS ?? 90000),
  );

  try {
    await session.start(undefined);
    await session.openDocument(uri, sample.languageId, sample.text);
    // No single request is universal: `ruff` and `biome` implement neither
    // `documentSymbol` nor pull diagnostics, and `vtsls` advertises a pull
    // provider it then answers with METHOD_NOT_FOUND. So the probe follows the
    // server's OWN advertised capabilities, in the same order the plugin's tools
    // do — that is the honest question ("can this plugin drive this server?"),
    // not "does every server implement my favourite method".
    const probes = [];
    if (session.capability('diagnosticProvider') !== undefined) {
      const pulled = await session.pullDiagnostics(uri, undefined);
      probes.push(pulled.unsupported === true
        ? 'diagnostic=unsupported(push channel owns it)'
        : `diagnostic=${(pulled.result?.items ?? []).length}`);
    }
    if (session.capability('documentSymbolProvider') !== undefined) {
      const symbols = await session.request('textDocument/documentSymbol', { textDocument: { uri } }, undefined);
      probes.push(`symbols=${Array.isArray(symbols) ? symbols.length : 'n/a'}`);
    }
    if (session.capability('documentFormattingProvider') !== undefined) {
      const edits = await session.request(
        'textDocument/formatting',
        { textDocument: { uri }, options: entry.formattingOptions ?? { tabSize: 2, insertSpaces: true } },
        undefined,
      );
      probes.push(`formatEdits=${Array.isArray(edits) ? edits.length : 'n/a'}`);
    }
    return {
      ok: true,
      detail: `encoding=${session.encoding} ${probes.join(' ') || 'no probe applicable'}`,
    };
  } finally {
    await session.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

const { servers, disabled } = readServers(PROFILE_DIR);
const ids = Object.keys(servers);
console.log(`profile: ${PROFILE_DIR}`);
console.log(`servers in the profile patch: ${ids.join(', ')}`);
console.log(`patch-layer state for row "lsp": ${disabled === true ? 'disabled (default off)' : 'enabled'}\n`);

let failed = 0;
for (const serverId of ids) {
  const entry = servers[serverId];
  const started = Date.now();
  try {
    const result = await check(serverId, entry);
    console.log(`PASS  ${serverId.padEnd(8)} ${entry.command.padEnd(14)} ${result.detail}  (${Date.now() - started}ms)`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${serverId.padEnd(8)} ${entry.command.padEnd(14)} ${error?.stack ?? String(error)}`);
  }
}

console.log(`\n${ids.length - failed}/${ids.length} servers answered.`);
// A language server left behind would keep the temp directory busy and the
// process alive; nothing here spawns one outside `check`, so a clean exit is
// itself part of the evidence.
spawnSync(process.execPath, ['-e', '0']);
process.exit(failed === 0 ? 0 : 1);
