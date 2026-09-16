/**
 * Execution: turning one tool call into protocol traffic, and turning the
 * server's answer into filesystem changes.
 *
 * This module owns the two boundaries the tool definitions stay clear of:
 *
 *  - **File → session resolution.** A call names a path; the workspace root, the
 *    nearest project marker, and the configured entries decide which server (if
 *    any) owns it.
 *  - **Applying edits.** A server returns edits in its own coordinate space
 *    against the text it was shown. Applying them is the one destructive act in
 *    this plugin, so it is done against a single captured basis and written
 *    through the filesystem seam, which owns the staleness guard.
 *
 * @module dsh-tool-lsp/executor
 */
import { findProjectMarker, configuredProjectMarkers } from './project.js';
import { routeFile } from './servers.js';
import { decodeWorkspaceEdit, PositionCodec } from './translate.js';
import { displayPath } from './render.js';
import { LSP_ERROR, lspError } from './vocabulary.js';

/**
 * Resolve the workspace root once, as both a path and a `file:` URI.
 *
 * @param fs - the filesystem seam.
 * @param root - the workspace root path.
 * @param signal - optional cancellation.
 * @returns `{ path, uri }`.
 */
export async function resolveRoot(fs, root, signal) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw lspError(LSP_ERROR.NO_SERVER, 'dsh-tool-lsp needs a workspace root to resolve files against');
  }
  const target = await fs.resolve(root, signal === undefined ? {} : { signal });
  return { path: fs.processPath(target), uri: fs.fileUrl(target) };
}

/**
 * Resolve one call's file to the server that owns it, and open it.
 *
 * The workspace root is resolved per call from the executing agent's session, so
 * a call made from any session is routed against that session's workspace rather
 * than the plugin process's directory.
 *
 * @param ctx - the execution context: `fs`, the resolved servers, the session
 *   table, the root resolver, and per-call limits.
 * @param filePath - the caller's path, workspace-relative or absolute.
 * @param exec - the tool execution context (carries the caller's agent and signal).
 * @returns `{ session, document, path, uri, text, root, ... }`.
 * @throws `LSP_NO_SERVER` when nothing claims the file, or a filesystem error
 *   when the file cannot be read.
 */
export async function openForCall(ctx, filePath, exec) {
  const { fs, servers } = ctx;
  const signal = exec?.signal;
  const root = await ctx.rootFor(exec, signal);
  const target = await fs.resolve(filePath, { cwd: root.path, ...(signal === undefined ? {} : { signal }) });
  const path = fs.processPath(target);

  const info = await fs.stat(target, signal);
  if (info === undefined) {
    throw lspError(LSP_ERROR.NO_SERVER, `file does not exist: ${path}`);
  }
  if (info.type !== 'file') {
    throw lspError(LSP_ERROR.NO_SERVER, `not a regular file: ${path}`);
  }
  if (info.size !== undefined && info.size > ctx.maxDocumentBytes) {
    throw lspError(
      LSP_ERROR.NO_SERVER,
      `file is ${info.size} bytes, above the configured maxDocumentBytes (${ctx.maxDocumentBytes})`,
    );
  }

  const route = await routeForCall(ctx, servers, path, root.path, signal);
  if (route === undefined) {
    throw lspError(
      LSP_ERROR.NO_SERVER,
      `no configured language server claims ${path}; configure a server entry whose extensionToLanguage or fileGlobs match it`,
    );
  }

  // Read through the seam, which records the observation the write-intent
  // policy uses later to detect an external change.
  const text = await fs.readText(target, signal);
  const session = await ctx.sessionFor(route.server, root, signal);
  const uri = fs.fileUrl(target);
  const document = await session.openDocument(uri, route.languageId, text);

  return {
    session,
    document,
    path,
    /** The path as the model should see it: workspace-relative when inside the root. */
    displayPath: displayPath(path, root.path),
    uri,
    target,
    text,
    root,
    /** The resolved server entry that owns this file, for per-entry options. */
    server: route.server,
    serverId: route.server.serverId,
    languageId: route.languageId,
  };
}

/**
 * Route a path to a server entry, consulting project markers when any entry
 * declares one.
 *
 * @param ctx - the execution context.
 * @param servers - the resolved servers.
 * @param path - the absolute file path.
 * @param rootPath - the workspace root the marker walk is bounded by.
 * @param signal - caller cancellation.
 * @returns the route, or `undefined`.
 */
async function routeForCall(ctx, servers, path, rootPath, signal) {
  const markers = configuredProjectMarkers(servers);
  const marker =
    markers.length === 0 ? undefined : await findProjectMarker(ctx.fs, markers, path, rootPath, signal);
  return routeFile(servers, path, marker);
}

/**
 * Apply a set of server-produced edits and write the result.
 *
 * All edits are applied against `text` — the exact text the server was shown —
 * in one pass, so they compose correctly regardless of their wire order. The
 * write goes through the filesystem seam with no explicit intent: the
 * `fs/write-intent` waterfall supplies the guard, which is what turns a file
 * changed since the caller read it into `LSP_WRITE_CONFLICT` rather than a
 * silent overwrite.
 *
 * @param ctx - the execution context.
 * @param target - the file's resolved target.
 * @param text - the text the edits were computed against.
 * @param edits - wire-position text edits for this file.
 * @param signal - caller cancellation.
 * @param options - `{ codec, encoding, root }`: the codec converts the server's
 *   `character` offsets into UTF-16 indices (both are omitted only when the
 *   server negotiated `utf-16`, where the two coincide), and `root` makes the
 *   returned path workspace-relative.
 * @returns `{ path, before, after, operation }`.
 */
export async function applyEdits(ctx, target, text, edits, signal, options = {}) {
  const { codec, encoding, root } = options;
  const absolute = ctx.fs.processPath(target);
  const path = root === undefined ? absolute : displayPath(absolute, root.path);
  const after = applyTextEdits(text, toUtf16Edits(edits, codec, encoding));
  if (after === text) {
    return { path, before: text, after: text, operation: 'unchanged' };
  }
  try {
    const outcome = await ctx.fs.writeText(target, after, undefined, signal);
    return {
      path,
      before: outcome.before ?? text,
      after: outcome.after,
      operation: outcome.operation,
    };
  } catch (error) {
    throw classifyWrite(error, path);
  }
}

/**
 * Convert a server's edits into UTF-16 character offsets.
 *
 * An LSP `character` offset is counted in the session's negotiated encoding, so
 * for a `utf-8` server it is a byte offset and for `utf-32` a code-point offset.
 * Splicing those into a JavaScript string — which is UTF-16 — would land at the
 * wrong place on any line containing non-ASCII text. The conversion is done here,
 * once, so {@link applyTextEdits} can stay a pure string function.
 *
 * @param edits - the server's edits.
 * @param codec - the codec for the document the edits were computed against.
 * @param encoding - the server's negotiated encoding.
 * @returns edits whose ranges are UTF-16 offsets.
 */
export function toUtf16Edits(edits, codec, encoding) {
  if (codec === undefined || encoding === undefined || encoding === 'utf-16') return edits;
  return edits.map((edit) => ({
    newText: edit.newText,
    range: {
      start: codec.decode(edit.range.start, encoding),
      end: codec.decode(edit.range.end, encoding),
    },
  }));
}

/**
 * Apply LSP text edits to a string.
 *
 * Edits are expressed as ranges into the ORIGINAL text, so they are sorted and
 * applied back-to-front: applying forward would shift every later offset.
 *
 * Ranges must already be UTF-16 offsets — see {@link toUtf16Edits}.
 *
 * @param text - the original text (LF or CRLF).
 * @param edits - the edits, in zero-based UTF-16 coordinates.
 * @returns the edited text.
 */
export function applyTextEdits(text, edits) {
  if (edits.length === 0) return text;

  // Offsets are computed against the original text, so line starts are measured
  // once. `character` here is already in the server's encoding — callers convert
  // to UTF-16 offsets before calling.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const offsetOf = (position) => {
    const line = Math.min(Math.max(position.line, 0), lineStarts.length - 1);
    const start = lineStarts[line];
    const end = lineStarts[line + 1] ?? text.length;
    return Math.min(start + Math.max(position.character, 0), end);
  };

  const located = edits.map((edit) => ({
    start: offsetOf(edit.range.start),
    end: offsetOf(edit.range.end),
    newText: edit.newText,
  }));
  // Latest first: every replacement then lies entirely to the right of the ones
  // already applied, so no offset needs recomputing.
  located.sort((a, b) => b.start - a.start);

  let result = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of located) {
    if (edit.end > previousStart) {
      throw lspError(
        LSP_ERROR.SERVER_ERROR,
        'language server returned overlapping edits; refusing to apply an ambiguous change',
      );
    }
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    previousStart = edit.start;
  }
  return result;
}

/**
 * Decode a `WorkspaceEdit` and apply every edit it carries.
 *
 * A rename commonly edits files other than the one the cursor was in, and those
 * documents may not be open in the server. Each file is therefore read fresh,
 * and its edits are converted through a codec built from *that* file's text —
 * offsets are only meaningful relative to the document they were computed for.
 * These files are not opened into the server: the write is the last step, so no
 * analysis of them is requested.
 *
 * @param ctx - the execution context.
 * @param workspaceEdit - the server's edit payload.
 * @param root - the workspace root the edit's paths resolve against.
 * @param signal - caller cancellation.
 * @param encoding - the server's negotiated position encoding.
 * @returns `{ files, unsupported }` where `files` describes what changed.
 */
export async function applyWorkspaceEdit(ctx, workspaceEdit, root, signal, encoding) {
  const { files, unsupported } = decodeWorkspaceEdit(workspaceEdit);
  const applied = [];
  for (const [path, edits] of files) {
    if (edits.length === 0) continue;
    const target = await ctx.fs.resolve(path, { cwd: root.path, ...(signal === undefined ? {} : { signal }) });
    const text = await ctx.fs.readText(target, signal);
    const outcome = await applyEdits(ctx, target, text, edits, signal, {
      codec: new PositionCodec(text),
      encoding,
      root,
    });
    applied.push({ path: outcome.path, before: outcome.before, after: outcome.after });
  }
  return { files: applied, unsupported };
}

/**
 * Classify a failed write.
 *
 * The observation policy reports a stale file as `FS_STALE_VERSION` (the file
 * changed since it was read) or `FS_NOT_OBSERVED` (it was never read). Both mean
 * the same thing to a caller: re-read, then retry.
 *
 * @param error - the thrown value.
 * @param path - the file that could not be written.
 * @returns a classified error.
 */
function classifyWrite(error, path) {
  const code = error?.code;
  if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') {
    return lspError(
      LSP_ERROR.WRITE_CONFLICT,
      `${path} changed since it was read; re-read it and retry the operation`,
    );
  }
  if (code === 'FS_SANDBOX_DENIED' || code === 'FS_PERMISSION_DENIED') {
    return lspError(LSP_ERROR.WRITE_CONFLICT, `cannot write ${path}: ${error.message}`);
  }
  return error;
}

/**
 * A compact unified-style diff over whole lines, for tool output.
 *
 * This is a reading aid, not a patch format: it shows the model what changed
 * without asking it to parse hunk headers.
 *
 * @param before - the previous content.
 * @param after - the new content.
 * @param maxLines - cap on emitted lines.
 * @returns `{ lines, truncated }`.
 */
export function lineDiff(before, after, maxLines) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  // Trim the shared head and tail so only the changed window is scanned; a
  // one-line change in a large file then costs constant work.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const lines = [];
  let truncated = false;
  const push = (text) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    lines.push(text);
  };

  if (head > 0) push(`  ${head} unchanged line${head === 1 ? '' : 's'} before`);
  for (const line of oldLines.slice(head, oldLines.length - tail)) push(`- ${line}`);
  for (const line of newLines.slice(head, newLines.length - tail)) push(`+ ${line}`);
  if (tail > 0) push(`  ${tail} unchanged line${tail === 1 ? '' : 's'} after`);
  return { lines, truncated };
}
