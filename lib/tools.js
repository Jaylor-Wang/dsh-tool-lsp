/**
 * The model-facing tool surface: five typed tools over the LSP client.
 *
 * Each definition is deliberately thin. It validates and normalizes its
 * arguments, calls one executor entry point, and hands the canonical result to a
 * renderer. Anything protocol-shaped lives below; anything presentation-shaped
 * lives in `render.js`.
 *
 * A note on coordinates, because it is the one convention a caller must get
 * right: every position this surface accepts or returns is **one-based** in both
 * line and column, counted in UTF-16 code units. That is the editor convention
 * and it matches what the model sees when it reads a file with line numbers.
 * The conversion to the server's zero-based negotiated encoding happens below
 * this layer and never leaks out.
 *
 * @module dsh-tool-lsp/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { applyEdits, applyWorkspaceEdit, lineDiff, openForCall } from './executor.js';
import { normalizeCodeActions, normalizeDiagnostics, normalizeSymbols, toWirePosition } from './translate.js';
import { LSP_ERROR, lspError } from './vocabulary.js';
import {
  renderApplied,
  renderCodeActions,
  renderDiagnostics,
  renderSymbols,
} from './render.js';

/** The shared outer properties of a tool result: rendered text only. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

/** The shared `file_path` parameter. */
const FILE_PATH = {
  type: 'string',
  required: true,
  description: 'Source file to act on: a workspace-relative or absolute path.',
};

/** A single one-based position, as a nested parameter object. */
const POSITION_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true, description: 'One-based line number.' },
    character: { type: 'integer', required: true, description: 'One-based UTF-16 column.' },
  },
};

/** The shared optional one-based range parameter. */
const RANGE_PARAM = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional one-based UTF-16 range. Omit to cover the whole file, or to anchor on the first reported diagnostic.',
  properties: { start: POSITION_PARAM, end: POSITION_PARAM },
};

/**
 * Build the tool definitions.
 *
 * @param ctx - the execution context shared by every tool: the filesystem seam,
 *   resolved servers, the workspace root, the session table, limits, and the
 *   renderer limits.
 * @returns the five tool definitions, ready to register.
 */
export function createTools(ctx) {
  return [
    diagnosticsTool(ctx),
    formatTool(ctx),
    renameTool(ctx),
    codeActionTool(ctx),
    symbolsTool(ctx),
  ];
}

/**
 * Normalize the caller's optional one-based range into a wire range.
 *
 * @param range - the caller's range, when supplied.
 * @returns the wire range, or `undefined`.
 * @throws `LSP_UNSUPPORTED` when the range is not a pair of positions.
 */
function requireRange(range) {
  if (range === undefined || range === null) return undefined;
  const { start, end } = range;
  if (!isPosition(start) || !isPosition(end)) {
    throw lspError(
      LSP_ERROR.UNSUPPORTED,
      'range must be {start:{line,character},end:{line,character}} with one-based line and character',
    );
  }
  return { start: toWirePosition(start.line, start.character), end: toWirePosition(end.line, end.character) };
}

/** Whether a value is a one-based line/character pair. */
function isPosition(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.character)
  );
}

/**
 * Merge pull and push diagnostics, dropping duplicates.
 *
 * A server may report the same problem through both channels; a stable key over
 * the range, message, severity and code collapses those into one entry while
 * keeping diagnostics that only one channel carried.
 *
 * @param pulled - the pull result's items.
 * @param pushed - the last `publishDiagnostics` payload.
 * @returns one entry per distinct diagnostic, pull results first.
 */
export function mergeDiagnostics(pulled, pushed) {
  const seen = new Set();
  const merged = [];
  for (const item of [...pulled, ...pushed]) {
    if (item === null || typeof item !== 'object') {
      // A malformed entry is passed through so the normalizer reports it.
      merged.push(item);
      continue;
    }
    const start = item.range?.start;
    const key = JSON.stringify([
      start?.line,
      start?.character,
      item.range?.end?.line,
      item.range?.end?.character,
      item.severity,
      item.message,
      item.code ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// ── lsp_diagnostics ─────────────────────────────────────────────────────────

function diagnosticsTool(ctx) {
  return defineTool({
    name: 'lsp_diagnostics',
    description:
      'Errors and warnings reported by the language server for one file. Read-only. Call this after editing a file to check the change compiled, instead of running a whole-project build.',
    parameters: { file_path: FILE_PATH },
    output: TEXT_OUTPUT,
    async execute({ file_path }, exec) {
      const opened = await openForCall(ctx, file_path, exec);
      const { session, document, uri } = opened;
      const decode = document.decoder(session.encoding);

      // Pull and push are not alternatives: rust-analyzer answers a pull request
      // with only the check-on-save diagnostics, while lint results such as
      // `unused_variables` arrive solely through `publishDiagnostics`. Trusting
      // the pull result alone reports "no diagnostics" for a file the server has
      // already flagged, so the two sources are merged.
      const collected = await collectDiagnostics(session, document, uri, exec.signal);
      const pushed = document.published !== undefined && document.published.length > 0;
      const source = collected.pullUsed && pushed ? 'pull+pushed' : pushed ? 'pushed' : 'pull';

      const all = normalizeDiagnostics(collected.items, decode);
      const diagnostics = all.slice(0, ctx.limits.maxDiagnostics);
      const text = renderDiagnostics(
        {
          file_path: opened.displayPath,
          diagnostics,
          truncated: all.length > diagnostics.length,
          total: all.length,
          source,
        },
        ctx.limits,
      );
      return { text };
    },
  });
}

// ── lsp_format ──────────────────────────────────────────────────────────────

function formatTool(ctx) {
  return defineTool({
    name: 'lsp_format',
    description:
      'Format a whole file (or a range) with the language server and write the result to disk. Returns the diff that was applied. Fails if the file changed since it was last read.',
    parameters: {
      file_path: FILE_PATH,
      range: {
        ...RANGE_PARAM,
        description:
          'Optional one-based UTF-16 range, {start:{line,character},end:{line,character}}. Omit to format the whole file.',
      },
    },
    output: TEXT_OUTPUT,
    async execute({ file_path, range }, exec) {
      const opened = await openForCall(ctx, file_path, exec);
      const { session, document, uri, target, text } = opened;

      if (session.capability('documentFormattingProvider') === undefined) {
        throw lspError(LSP_ERROR.UNSUPPORTED, `${opened.serverId} does not support formatting ${opened.displayPath}`);
      }

      const wireRange = requireRange(range);
      // A range request uses the range capability; a whole-file request uses the
      // document capability. Servers advertise these separately, so a server can
      // support one and not the other.
      const method = wireRange === undefined ? 'textDocument/formatting' : 'textDocument/rangeFormatting';
      if (wireRange !== undefined && session.capability('documentRangeFormattingProvider') === undefined) {
        throw lspError(
          LSP_ERROR.UNSUPPORTED,
          `${opened.serverId} does not support range formatting; omit range to format the whole file`,
        );
      }

      const params = {
        textDocument: { uri },
        // The entry's own `formattingOptions` wins when set: a project that wants
        // four-space tabs must not be reformatted to the plugin's defaults.
        options: opened.server.entry.formattingOptions ?? ctx.formattingOptions,
        ...(wireRange === undefined ? {} : { range: wireRange }),
      };
      const result = await session.request(method, params, exec.signal);
      // `TextEdit[] | null` is the protocol's return type, and `null` is its
      // documented "nothing to change" answer: rust-analyzer sends exactly that
      // for a file that is already formatted. Only a non-null, non-array value is
      // malformed — rejecting null turned a clean file into a hard error.
      if (result !== null && result !== undefined && !Array.isArray(result)) {
        throw lspError(LSP_ERROR.SERVER_ERROR, `${opened.serverId} returned a malformed formatting result`);
      }
      const edits = result ?? [];
      if (edits.length === 0) {
        return { text: `${opened.displayPath}: already formatted, no changes` };
      }

      const outcome = await applyEditsAndClose(ctx, opened, edits, exec.signal);
      return {
        text: renderApplied(
          {
            summary: `${opened.displayPath}: formatted (${edits.length} edit${edits.length === 1 ? '' : 's'})`,
            files: [
              {
                path: outcome.path,
                unchanged: outcome.operation === 'unchanged',
                diff: lineDiff(text, outcome.after, ctx.limits.maxDiffLines),
              },
            ],
          },
          ctx.limits,
        ),
      };
    },
  });
}

// ── lsp_rename ──────────────────────────────────────────────────────────────

function renameTool(ctx) {
  return defineTool({
    name: 'lsp_rename',
    description:
      'Rename the symbol at a position across the whole workspace and write every affected file to disk. Returns the diff for each. The line and character are one-based; the character counts UTF-16 code units as reported by the read tool.',
    parameters: {
      file_path: FILE_PATH,
      line: { type: 'integer', required: true, description: 'One-based line number of the symbol.' },
      character: {
        type: 'integer',
        required: true,
        description: 'One-based UTF-16 column of the symbol, as shown by the read tool.',
      },
      new_name: { type: 'string', required: true, description: 'The new symbol name.' },
    },
    output: TEXT_OUTPUT,
    async execute({ file_path, line, character, new_name }, exec) {
      if (typeof new_name !== 'string' || new_name.trim() === '') {
        throw lspError(LSP_ERROR.UNSUPPORTED, 'new_name must be a non-empty identifier');
      }
      const opened = await openForCall(ctx, file_path, exec);
      const { session, document, uri } = opened;

      if (session.capability('renameProvider') === undefined) {
        throw lspError(LSP_ERROR.UNSUPPORTED, `${opened.serverId} does not support rename`);
      }

      const position = document.toWire(line, character, session.encoding);
      const workspaceEdit = await session.request(
        'textDocument/rename',
        { textDocument: { uri }, position, newName: new_name },
        exec.signal,
      );
      if (workspaceEdit === null || workspaceEdit === undefined) {
        return { text: `${opened.displayPath} ${line}:${character}: nothing to rename at that position` };
      }

      const { files, unsupported } = await applyWorkspaceEdit(
        ctx,
        workspaceEdit,
        opened.root,
        exec.signal,
        session.encoding,
      );
      // Every file the server edited is now ahead of what it was told; dropping
      // the open documents makes the next call re-read the fresh bytes.
      await session.closeDocument(uri);
      for (const file of files) await closeIfOpen(ctx, session, file.path, opened.root);

      if (files.length === 0) {
        return {
          text: `${file_path} ${line}:${character}: rename produced no text edits${
            unsupported.length === 0 ? '' : ` (unsupported operations: ${unsupported.join(', ')})`
          }`,
        };
      }

      return {
        text: renderApplied(
          {
            summary: `renamed to "${new_name}" in ${files.length} file${files.length === 1 ? '' : 's'}`,
            files: files.map((file) => ({
              path: file.path,
              unchanged: file.before === file.after,
              diff: lineDiff(file.before, file.after, ctx.limits.maxDiffLines),
            })),
            unsupported,
          },
          ctx.limits,
        ),
      };
    },
  });
}

// ── lsp_code_action ─────────────────────────────────────────────────────────

function codeActionTool(ctx) {
  return defineTool({
    name: 'lsp_code_action',
    description:
      'Quick fixes, refactors and source actions the language server offers at a range. Reports them only — nothing is written. Use the returned titles to decide, then apply the change yourself with edit or write.',
    parameters: {
      file_path: FILE_PATH,
      range: {
        ...RANGE_PARAM,
        description:
          'Optional one-based UTF-16 range. When omitted, the first reported diagnostic in the file is used.',
      },
    },
    output: TEXT_OUTPUT,
    async execute({ file_path, range }, exec) {
      const opened = await openForCall(ctx, file_path, exec);
      const { session, document, uri } = opened;

      if (session.capability('codeActionProvider') === undefined) {
        throw lspError(LSP_ERROR.UNSUPPORTED, `${opened.serverId} does not support code actions`);
      }

      let wireRange = requireRange(range);
      if (wireRange === undefined) {
        // No range given: anchor on the first diagnostic, which is what a caller
        // asking "what can I do about this file" almost always means.
        const normalized = normalizeDiagnostics(
          (await collectDiagnostics(session, document, uri, exec.signal)).items,
          document.decoder(session.encoding),
        );
        if (normalized.length === 0) {
          return { text: `${opened.displayPath}: no diagnostics to attach a code action to; pass an explicit range` };
        }
        // `range` is already a zero-based wire range in UTF-16 units, which is
        // exactly what the request needs — it must not be shifted again.
        wireRange = normalized[0].range;
      }

      const actionsPayload = await session.request(
        'textDocument/codeAction',
        {
          textDocument: { uri },
          range: wireRange,
          context: { diagnostics: await contextDiagnostics(ctx, opened, exec.signal) },
        },
        exec.signal,
      );
      const all = normalizeCodeActions(actionsPayload);
      const actions = all.slice(0, ctx.limits.maxCodeActions);
      const start = document.toModel(wireRange.start, session.encoding);
      const end = document.toModel(wireRange.end, session.encoding);

      return {
        text: renderCodeActions(
          {
            file_path: opened.displayPath,
            range: { start, end },
            actions,
            truncated: all.length > actions.length,
            total: all.length,
          },
          ctx.limits,
        ),
      };
    },
  });
}

/**
 * The diagnostics sent alongside a code-action request.
 *
 * Servers match quick fixes against this context, so it is the file's real
 * diagnostics — not an empty array, which would suppress every fix.
 */
/**
 * Collect a document's diagnostics from both channels.
 *
 * `pull` is the primary source, but a server may report a problem only through
 * `publishDiagnostics` (rust-analyzer's lints do), so the two are merged rather
 * than treated as alternatives.
 *
 * @param session - the live session.
 * @param document - the open document.
 * @param uri - the document's URI.
 * @param signal - caller cancellation.
 * @returns `{ items, pullUsed }`: the merged wire diagnostics and whether the
 *   pull channel actually answered.
 */
async function collectDiagnostics(session, document, uri, signal) {
  const pulled = await session.pullDiagnostics(uri, signal);
  const pullUsed = pulled.unsupported !== true;
  const pulledItems = pullUsed ? (pulled.result?.items ?? []) : [];
  // When the pull channel produced nothing, the answer may still be in flight on
  // the push channel: a server can answer the pull with an empty list (or refuse
  // it outright) while its analysis is still running, and report the real
  // problem by notification moments later. Waiting keeps that race from turning
  // into a reported "no diagnostics".
  if (pulledItems.length === 0) {
    await session.settlePublished(uri, 3000, signal);
  }
  const merged = mergeDiagnostics(Array.isArray(pulledItems) ? pulledItems : [], document.published ?? []);
  return { items: merged, pullUsed };
}

/**
 * The diagnostics sent alongside a code-action request.
 *
 * Servers match quick fixes against this context, so it is the file's real
 * diagnostics — not an empty array, which would suppress every fix.
 */
async function contextDiagnostics(ctx, opened, signal) {
  const { session, document, uri } = opened;
  const { items } = await collectDiagnostics(session, document, uri, signal);
  return items.slice(0, ctx.limits.maxDiagnostics);
}

// ── lsp_symbols ─────────────────────────────────────────────────────────────

function symbolsTool(ctx) {
  return defineTool({
    name: 'lsp_symbols',
    description:
      'Outline of the symbols a file declares (functions, classes, methods), or a workspace-wide symbol search when query is given. Read-only. Useful for locating a definition without reading the whole file.',
    parameters: {
      file_path: FILE_PATH,
      query: {
        type: 'string',
        description: 'Optional name to search for across the workspace. When set, file_path only selects the language server.',
      },
    },
    output: TEXT_OUTPUT,
    async execute({ file_path, query }, exec) {
      const opened = await openForCall(ctx, file_path, exec);
      const { session, document, uri } = opened;
      const decode = document.decoder(session.encoding);

      const workspaceQuery = typeof query === 'string' && query.trim() !== '';
      if (workspaceQuery && session.capability('workspaceSymbolProvider') === undefined) {
        throw lspError(LSP_ERROR.UNSUPPORTED, `${opened.serverId} does not support workspace symbol search`);
      }

      const payload = workspaceQuery
        ? await session.request('workspace/symbol', { query }, exec.signal)
        : await session.request('textDocument/documentSymbol', { textDocument: { uri } }, exec.signal);

      const all = normalizeSymbols(payload, decode);
      const symbols = all.slice(0, ctx.limits.maxSymbols);
      return {
        text: renderSymbols(
          {
            symbols,
            ...(workspaceQuery ? { query } : { file_path: opened.displayPath }),
            truncated: all.length > symbols.length,
            total: all.length,
          },
          ctx.limits,
        ),
      };
    },
  });
}

// ── shared write path ───────────────────────────────────────────────────────

/**
 * Apply edits to the open document, then re-open it from the new bytes.
 *
 * The conversion from the server's encoding happens in `applyEdits`, using the
 * codec bound to the exact text the edits were computed against.
 */
async function applyEditsAndClose(ctx, opened, edits, signal) {
  const { session, document, uri, target, text, root } = opened;
  const outcome = await applyEdits(ctx, target, text, edits, signal, {
    codec: document.codec,
    encoding: session.encoding,
    root,
  });
  // The file on disk is now ahead of what the server was told; dropping the
  // document makes the next call re-read and re-open the fresh bytes.
  await session.closeDocument(uri);
  return outcome;
}

/** Drop a document from the session when the server has just rewritten it. */
async function closeIfOpen(ctx, session, path, root) {
  const target = await ctx.fs.resolve(path, { cwd: root.path });
  await session.closeDocument(ctx.fs.fileUrl(target));
}
