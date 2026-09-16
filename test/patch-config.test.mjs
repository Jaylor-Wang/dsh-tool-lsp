import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findProfilePatchPath, loadPatchLayerLspConfig } from '../lib/patch-config.js';

test('loadPatchLayerLspConfig merges - id: lsp config rows and ignores disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-patch-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"tmp-profile"}\n');
    await writeFile(join(dir, 'cordis.patch.yml'), [
      '- id: other',
      '  config:',
      '    servers:',
      '      ignored:',
      '        command: no',
      '- id: lsp',
      '  config:',
      '    servers:',
      '      rust:',
      '        command: rust-analyzer',
      '- id: lsp',
      '  disabled: true',
      '- id: lsp',
      '  config:',
      '    timeoutMs: 12',
      '    servers:',
      '      ruff:',
      '        command: ruff',
      '',
    ].join('\n'));
    const config = loadPatchLayerLspConfig(join(dir, 'cordis.patch.yml'));
    assert.ok(config);
    assert.equal(config.timeoutMs, 12);
    assert.deepEqual(Object.keys(config.servers), ['rust', 'ruff']);
    assert.equal(config.servers.rust.command, 'rust-analyzer');
    assert.equal(config.servers.ruff.command, 'ruff');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findProfilePatchPath skips the plugin package patch', () => {
  const found = findProfilePatchPath();
  assert.notEqual(found, join(process.cwd(), 'cordis.patch.yml'));
});

test('loadPatchLayerLspConfig returns null when the file has no lsp row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-patch-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"tmp-profile"}\n');
    await writeFile(join(dir, 'cordis.patch.yml'), '- id: other\n  disabled: true\n');
    assert.equal(loadPatchLayerLspConfig(join(dir, 'cordis.patch.yml')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
