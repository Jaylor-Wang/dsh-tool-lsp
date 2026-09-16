/**
 * Read the language-server table from the profile patch layer.
 *
 * Hot-mount writes `- id: 'mkt-lsp'` so a patch row `- id: lsp / config:` never
 * binds to the live entry. The plugin therefore reads the same YAML the user
 * edits, and only uses it when the loader config did not already supply
 * `servers`.
 *
 * @module dsh-tool-lsp/patch-config
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_ID = 'lsp';

/** Directory that contains this plugin's own `package.json`. */
function pluginRoot(fromUrl) {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(fileURLToPath(fromUrl));
}

/** Walk from this module looking for a profile that owns `cordis.patch.yml`. */
export function findProfilePatchPath(fromUrl = import.meta.url) {
  const seen = new Set();
  const ownRoot = pluginRoot(fromUrl);
  const ownPatch = join(ownRoot, 'cordis.patch.yml');
  const candidates = [];
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 10; i += 1) {
    if (basename(dir) === 'node_modules') {
      candidates.push(join(dirname(dir), 'cordis.patch.yml'));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'web';
  candidates.push(join(home, 'profiles', profile, 'cordis.patch.yml'));
  for (const path of candidates) {
    if (seen.has(path) || path === ownPatch) continue;
    seen.add(path);
    if (existsSync(path)) return path;
  }
  return null;
}

function yamlLoad(patchPath) {
  const text = readFileSync(patchPath, 'utf8');
  const anchors = [
    join(dirname(patchPath), 'package.json'),
    fileURLToPath(new URL('../package.json', import.meta.url)),
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'web', 'package.json'),
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)('js-yaml').load(text);
    } catch {
      /* try the next resolver */
    }
  }
  return null;
}

/**
 * Merge every `- id: lsp` row in a profile patch, the same way the loader
 * does (later keys overwrite). `disabled` is ignored: if `apply()` is running,
 * the plugin is already mounted.
 *
 * @returns {object | null} the merged `config` object, or null when absent.
 */
export function loadPatchLayerLspConfig(patchPath = findProfilePatchPath()) {
  if (patchPath === null || !existsSync(patchPath)) return null;
  let rows;
  try {
    rows = yamlLoad(patchPath);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const merged = {};
  let found = false;
  for (const row of rows) {
    if (row == null || typeof row !== 'object' || row.id !== ENTRY_ID) continue;
    found = true;
    const config = row.config;
    if (config != null && typeof config === 'object' && !Array.isArray(config)) {
      const { servers, ...rest } = config;
      Object.assign(merged, rest);
      if (servers != null && typeof servers === 'object' && !Array.isArray(servers)) {
        merged.servers = { ...(merged.servers ?? {}), ...servers };
      }
    }
  }
  return found ? merged : null;
}
