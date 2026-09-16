/**
 * Stage-2 tests: server schema/resolution and the three-tier file routing.
 *
 * Routing is the part most likely to be subtly wrong — a project marker that
 * silently widens a server's file types would send `.json` to a TypeScript
 * server — so the precedence rules and their negative cases are asserted
 * directly rather than inferred from a happy path.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Config,
  LspServerEntry,
  finalExtension,
  globToRegExp,
  resolveServers,
  routeFile,
} from '../lib/servers.js';
import { configuredProjectMarkers, findProjectMarker } from '../lib/project.js';
import { LSP_ERROR } from '../lib/vocabulary.js';

/** Build one resolved-server stand-in, bypassing executable resolution. */
function server(serverId, entry) {
  return {
    serverId,
    entry: { projectMarkers: [], fileGlobs: [], ...entry },
    executable: `/usr/bin/${entry.command}`,
  };
}

// ── extension + glob primitives ─────────────────────────────────────────────

test('finalExtension: takes the last dot, lowercased', () => {
  assert.equal(finalExtension('src/a.TS'), '.ts');
  assert.equal(finalExtension('src/a.test.mjs'), '.mjs');
  assert.equal(finalExtension('C:\\proj\\src\\a.rs'), '.rs');
});

test('finalExtension: rejects dotfiles and trailing dots', () => {
  assert.equal(finalExtension('.gitignore'), '');
  assert.equal(finalExtension('src/a.'), '');
  assert.equal(finalExtension('noext'), '');
});

test('globToRegExp: * stays within one segment, ** crosses segments', () => {
  const single = globToRegExp('src/*.ts');
  assert.equal(single.test('src/a.ts'), true);
  assert.equal(single.test('src/nested/a.ts'), false);

  const deep = globToRegExp('src/**/*.ts');
  assert.equal(deep.test('src/a.ts'), true, '**/ must also match zero directories');
  assert.equal(deep.test('src/nested/deep/a.ts'), true);
});

test('globToRegExp: ? matches exactly one non-separator character', () => {
  const re = globToRegExp('a?c.ts');
  assert.equal(re.test('abc.ts'), true);
  assert.equal(re.test('ac.ts'), false);
  assert.equal(re.test('a/c.ts'), false);
});

test('globToRegExp: rejects an unbalanced bracket', () => {
  assert.throws(() => globToRegExp('src/[abc.ts'), /unbalanced/);
});

// ── config schema ───────────────────────────────────────────────────────────

test('Config: an empty config is valid and yields zero servers', () => {
  const resolved = Config({});
  assert.deepEqual(resolved.servers, {});
  assert.equal(resolved.maxDiagnostics, 200);
  assert.equal(resolved.timeoutMs, 60000);
});

test('LspServerEntry: optional fields take defaults', () => {
  const entry = LspServerEntry({ command: 'x', extensionToLanguage: { '.ts': 'typescript' } });
  assert.deepEqual(entry.args, []);
  assert.deepEqual(entry.projectMarkers, []);
  assert.deepEqual(entry.env, {});
});

// ── resolveServers ──────────────────────────────────────────────────────────

const fakeCtx = {
  subprocess: {
    resolveExecutable: async (command) => {
      if (command === 'missing') throw new Error('ENOENT');
      return `/usr/bin/${command}`;
    },
  },
};

test('resolveServers: resolves each command and preserves config order', async () => {
  const resolved = await resolveServers(fakeCtx, {
    b: LspServerEntry({ command: 'second', extensionToLanguage: { '.rs': 'rust' } }),
    a: LspServerEntry({ command: 'first', extensionToLanguage: { '.ts': 'typescript' } }),
  });
  assert.deepEqual(
    resolved.map((s) => s.serverId),
    ['b', 'a'],
  );
  assert.equal(resolved[0].executable, '/usr/bin/second');
});

test('resolveServers: an unresolvable command fails loud with COMMAND_NOT_FOUND', async () => {
  await assert.rejects(
    resolveServers(fakeCtx, { bad: LspServerEntry({ command: 'missing', extensionToLanguage: { '.ts': 'typescript' } }) }),
    (error) => error.code === LSP_ERROR.COMMAND_NOT_FOUND && /missing/.test(error.message),
  );
});

test('resolveServers: an entry mapping no extensions is refused', async () => {
  await assert.rejects(
    resolveServers(fakeCtx, { bad: { command: 'x', extensionToLanguage: {} } }),
    /maps no extensions/,
  );
});

test('resolveServers: an extension without a leading dot is refused', async () => {
  await assert.rejects(
    resolveServers(fakeCtx, { bad: { command: 'x', extensionToLanguage: { ts: 'typescript' } } }),
    /must start with/,
  );
});

test('resolveServers: a malformed glob throws at load, not at routing time', async () => {
  await assert.rejects(
    resolveServers(fakeCtx, {
      bad: { command: 'x', extensionToLanguage: { '.ts': 'typescript' }, fileGlobs: ['[oops'] },
    }),
    /unbalanced/,
  );
});

// ── routing precedence ──────────────────────────────────────────────────────

test('routeFile: extension default selects the mapping entry', () => {
  const servers = [server('ts', { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript' } })];
  const route = routeFile(servers, 'src/a.ts', undefined);
  assert.equal(route.server.serverId, 'ts');
  assert.equal(route.languageId, 'typescript');
});

test('routeFile: an unhandled extension routes nowhere', () => {
  const servers = [server('ts', { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript' } })];
  assert.equal(routeFile(servers, 'src/a.py', undefined), undefined);
});

test('routeFile: a glob wins over the extension default', () => {
  const servers = [
    server('ts', { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript' } }),
    server('special', {
      command: 'special',
      extensionToLanguage: { '.ts': 'special-ts' },
      fileGlobs: ['generated/**/*.ts'],
    }),
  ];
  assert.equal(routeFile(servers, 'generated/a.ts', undefined).server.serverId, 'special');
  assert.equal(routeFile(servers, 'src/a.ts', undefined).server.serverId, 'ts');
});

test('routeFile: a glob whose extension is unmapped falls back to the entry\'s first language id', () => {
  const servers = [
    server('any', { command: 'any', extensionToLanguage: { '.txt': 'plaintext' }, fileGlobs: ['notes/*'] }),
  ];
  const route = routeFile(servers, 'notes/a.weird', undefined);
  assert.equal(route.server.serverId, 'any');
  assert.equal(route.languageId, 'plaintext');
});

test('routeFile: a project marker selects among entries that map the extension', () => {
  const servers = [
    server('node', { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript' }, projectMarkers: ['package.json'] }),
    server('deno', { command: 'deno', extensionToLanguage: { '.ts': 'typescript' }, projectMarkers: ['deno.json'] }),
  ];
  assert.equal(routeFile(servers, 'src/a.ts', 'deno.json').server.serverId, 'deno');
  assert.equal(routeFile(servers, 'src/a.ts', 'package.json').server.serverId, 'node');
});

test('routeFile: a project marker must NOT widen a server\'s file types', () => {
  // The marker entry maps only `.rs`; a `.ts` file in a Cargo project must not
  // be sent to the Rust server just because the marker matched.
  const servers = [
    server('ts', { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript' } }),
    server('rust', { command: 'rust-analyzer', extensionToLanguage: { '.rs': 'rust' }, projectMarkers: ['Cargo.toml'] }),
  ];
  const route = routeFile(servers, 'src/a.ts', 'Cargo.toml');
  assert.equal(route.server.serverId, 'ts', 'the .ts default must win, not the marker entry');
});

test('routeFile: an unclaimed marker falls through to the extension default', () => {
  const servers = [server('ts', { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript' } })];
  assert.equal(routeFile(servers, 'src/a.ts', 'deno.json').server.serverId, 'ts');
});

test('routeFile: config order decides between equal candidates', () => {
  const servers = [
    server('first', { command: 'a', extensionToLanguage: { '.ts': 'typescript' } }),
    server('second', { command: 'b', extensionToLanguage: { '.ts': 'typescript' } }),
  ];
  assert.equal(routeFile(servers, 'a.ts', undefined).server.serverId, 'first');
});

test('routeFile: Windows separators normalize for glob matching', () => {
  const servers = [
    server('special', { command: 's', extensionToLanguage: { '.ts': 'typescript' }, fileGlobs: ['generated/**/*.ts'] }),
  ];
  const route = routeFile(servers, 'generated\\deep\\a.ts', undefined);
  assert.equal(route.server.serverId, 'special');
});

// ── project marker discovery ────────────────────────────────────────────────

test('configuredProjectMarkers: deduplicates in config order', () => {
  const servers = [
    server('a', { command: 'a', extensionToLanguage: { '.ts': 'typescript' }, projectMarkers: ['package.json', 'tsconfig.json'] }),
    server('b', { command: 'b', extensionToLanguage: { '.rs': 'rust' }, projectMarkers: ['tsconfig.json', 'Cargo.toml'] }),
  ];
  assert.deepEqual(configuredProjectMarkers(servers), ['package.json', 'tsconfig.json', 'Cargo.toml']);
});

/**
 * A minimal `ctx.fs` stand-in over the real filesystem.
 *
 * Models the parts `findProjectMarker` uses: `resolve` (returning an opaque
 * target carrying its path), `processPath`, `fileUrl`, and `lstat`.
 */
function fsOver(root) {
  const target = (path) => ({ path });
  return {
    async resolve(path, opts = {}) {
      const base = opts.cwd ?? root;
      const full = path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : join(base, path);
      return target(full);
    },
    processPath: (t) => t.path,
    fileUrl: (t) => pathToFileURL(t.path).href,
    async lstat(path, opts = {}) {
      const { stat } = await import('node:fs/promises');
      const base = opts.cwd ?? root;
      const full = path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : join(base, path);
      try {
        const info = await stat(full);
        return { type: info.isDirectory() ? 'directory' : 'file' };
      } catch {
        return undefined;
      }
    },
  };
}

test('findProjectMarker: returns the NEAREST ancestor marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lsp-proj-'));
  try {
    await writeFile(join(root, 'package.json'), '{}');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'deno.json'), '{}');
    const fs = fsOver(root);

    // `sub/a.ts` is governed by sub/deno.json, not the root package.json.
    const marker = await findProjectMarker(fs, ['package.json', 'deno.json'], 'sub/a.ts', root, undefined);
    assert.equal(marker, 'deno.json');

    // At the root level the root marker applies.
    assert.equal(await findProjectMarker(fs, ['package.json', 'deno.json'], 'a.ts', root, undefined), 'package.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findProjectMarker: a file outside the workspace has no project context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lsp-proj-'));
  const other = await mkdtemp(join(tmpdir(), 'lsp-outside-'));
  try {
    await writeFile(join(other, 'deno.json'), '{}');
    const fs = fsOver(root);
    assert.equal(await findProjectMarker(fs, ['deno.json'], join(other, 'a.ts'), root, undefined), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('findProjectMarker: no configured markers means no filesystem walk', async () => {
  let probed = false;
  const fs = {
    resolve: async () => {
      probed = true;
      return { path: '/' };
    },
    processPath: (t) => t.path,
    fileUrl: (t) => pathToFileURL(t.path).href,
    lstat: async () => {
      probed = true;
      return undefined;
    },
  };
  assert.equal(await findProjectMarker(fs, [], 'a.ts', '/', undefined), undefined);
  assert.equal(probed, false, 'an empty marker list must short-circuit before resolving paths');
});

test('findProjectMarker: a directory named like a marker does not count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lsp-proj-'));
  try {
    // A DIRECTORY called `deno.json` is not a project marker file.
    await mkdir(join(root, 'deno.json'), { recursive: true });
    const fs = fsOver(root);
    assert.equal(await findProjectMarker(fs, ['deno.json'], 'a.ts', root, undefined), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
