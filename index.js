import z from '@deepseek-ai/schemastery';
import { resolveServers } from './lib/servers.js';
import { resolveRoot } from './lib/executor.js';
import { LspSession } from './lib/runner.js';
import { createTools } from './lib/tools.js';
import { loadPatchLayerLspConfig } from './lib/patch-config.js';

export const name = 'dsh-tool-lsp';

/**
 * Declared here, never in cordis.patch.yml: the bundle patch must stay plain
 * `insert`/`id`/`name` rows or dshmarket cannot hot-mount this plugin. See the
 * comment block at the top of cordis.patch.yml.
 *
 * `lsp` (the optional official seam) is deliberately NOT injected — this
 * deployment has no provider for it, so the plugin drives language servers over
 * `subprocess` itself. Consuming it structurally later stays possible.
 */
export const inject = ['tools', 'fs', 'subprocess'];

/**
 * Every key carries a default so the plugin is fully functional with an empty
 * config row — a hard requirement of the hot-mount contract (the bundle patch
 * cannot carry a `config:` block). Users add servers through the patch layer.
 */
export const Config = z.object({
  servers: z.dict(z.any()).default({}),
  maxDiagnostics: z.number().default(200),
  maxSymbols: z.number().default(100),
  maxCodeActions: z.number().default(50),
  maxResultChars: z.number().default(16000),
  maxDiffLines: z.number().default(60),
  maxDocumentBytes: z.number().default(8 * 1024 * 1024),
  timeoutMs: z.number().default(60000),
});

/**
 * Mount the LSP tool surface.
 *
 * Everything that can fail at load fails here, before a single tool is
 * registered: server entries are validated and their executables resolved, so a
 * typo in a command surfaces as a mount error rather than as a mysterious
 * failure on the model's first call.
 */
export async function apply(ctx, config = {}) {
  const resolved = { ...Config({}), ...config };

  // Hot-mount creates `mkt-lsp`, so a patch-layer `- id: lsp / config:` never
  // reaches this function. When the loader handed us an empty servers table,
  // read the same YAML the user edits.
  if (resolved.servers == null || Object.keys(resolved.servers).length === 0) {
    const fromPatch = loadPatchLayerLspConfig();
    if (fromPatch?.servers != null && Object.keys(fromPatch.servers).length > 0) {
      resolved.servers = fromPatch.servers;
    }
  }

  const servers = await resolveServers(ctx, resolved.servers);

  /** Live sessions, keyed by server id. Shared by every tool and every call. */
  const sessions = new Map();

  /**
   * Resolve the workspace root for one call.
   *
   * The session's own validated `cwd` is authoritative, read from the calling
   * agent rather than from the process: the plugin lives in a shared profile, so
   * the process directory is not the caller's workspace. The process cwd is only
   * a fallback for a call with no agent behind it.
   */
  const rootCache = new Map();
  const rootFor = async (exec, signal) => {
    const cwd = exec?.agent?.session?.header?.cwd;
    const key = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    let root = rootCache.get(key);
    if (root === undefined) {
      root = await resolveRoot(ctx.fs, key, signal);
      rootCache.set(key, root);
    }
    return root;
  };

  /** Get (or lazily start) the session for one configured entry. */
  const sessionFor = async (server, root, signal) => {
    let session = sessions.get(server.serverId);
    if (session === undefined) {
      session = new LspSession(
        {
          serverId: server.serverId,
          command: server.executable,
          args: server.entry.args,
          cwd: root.path,
          env: server.entry.env,
          initializationOptions: server.entry.initializationOptions,
          // Answer to `workspace/configuration`: without it every server is told
          // "no settings", silently discarding the entry's tuning.
          configuration: server.entry.configuration,
          maxMessageBytes: server.entry.maxMessageBytes,
          maxStderrBytes: server.entry.maxStderrBytes,
          killGraceMs: server.entry.killGraceMs,
          shutdownTimeoutMs: server.entry.shutdownTimeoutMs,
        },
        (spec) => ctx.subprocess.spawn(spec),
        root.uri,
        resolved.timeoutMs,
      );
      sessions.set(server.serverId, session);
    }
    await session.start(signal);
    return session;
  };

  const toolCtx = {
    fs: ctx.fs,
    servers,
    sessions,
    rootFor,
    sessionFor,
    // `FormattingOptions` sent with every formatting request. `tabSize` is a
    // protocol-required field; a server that reads the project's own config
    // overrides it, and one that does not still gets a sane value.
    formattingOptions: { tabSize: 2, insertSpaces: true },
    maxDocumentBytes: resolved.maxDocumentBytes,
    limits: {
      maxDiagnostics: resolved.maxDiagnostics,
      maxSymbols: resolved.maxSymbols,
      maxCodeActions: resolved.maxCodeActions,
      maxResultChars: resolved.maxResultChars,
      maxDiffLines: resolved.maxDiffLines,
    },
  };

  for (const tool of createTools(toolCtx)) ctx.tools.register(tool);

  // Disposal must reclaim every child process: a hot-unmount that leaked
  // language servers would leave them indexing forever.
  ctx.effect(() => () => {
    const closing = [...sessions.values()];
    sessions.clear();
    return Promise.all(closing.map((session) => session.dispose().catch(() => {})));
  }, 'dsh-tool-lsp session teardown');
}
