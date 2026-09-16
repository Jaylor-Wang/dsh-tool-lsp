/**
 * Rendering: turning a canonical tool result into the text the model reads.
 *
 * Two rules shape everything here.
 *
 * Every result is bounded. A language server will happily return thousands of
 * diagnostics for a generated file, and an unbounded dump crowds out the rest of
 * the conversation. Each renderer applies its own cap and says plainly when it
 * truncated, so the model knows the list is partial rather than complete.
 *
 * Every path is workspace-relative. An absolute path in a result is both noise
 * and a portability hazard: the model can pass a relative path straight back to
 * `read`/`edit`, which resolve against the workspace.
 *
 * @module dsh-tool-lsp/render
 */

/**
 * Render a path relative to the workspace root when it lies inside it.
 *
 * @param path - the absolute path.
 * @param root - the absolute workspace root.
 * @returns the relative path, or the original when it lies outside.
 */
export function displayPath(path, root) {
  if (typeof path !== 'string' || path === '') return path;
  if (typeof root !== 'string' || root === '') return path;
  const normalize = (value) => value.replaceAll('\\', '/');
  const target = normalize(path);
  const base = normalize(root).replace(/\/$/, '');
  const identity = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (identity(target) === identity(base)) return '.';
  if (!identity(target).startsWith(`${identity(base)}/`)) return path;
  return target.slice(base.length + 1);
}

/**
 * Format a one-based position as `line:column`.
 * @param position - the one-based position.
 * @returns the formatted locator.
 */
export function formatPosition(position) {
  return `${position.line}:${position.character}`;
}

/**
 * Format a range as `start-end` on one line, or `start` when it is empty.
 * @param start - the one-based start.
 * @param end - the one-based end.
 * @returns the formatted locator.
 */
export function formatRange(start, end) {
  if (start.line === end.line && start.character === end.character) return formatPosition(start);
  if (start.line === end.line) return `${start.line}:${start.character}-${end.character}`;
  return `${start.line}:${start.character}-${end.line}:${end.character}`;
}

/** A note appended when a list was cut short. */
function truncationNote(shown, total) {
  return `\n… ${total - shown} more not shown (raise the matching max* setting to see them)`;
}

/**
 * Render diagnostics.
 *
 * Grouped by severity in the order a reader cares about, because "is this file
 * broken" is answered by the error count, not by the order a server happened to
 * emit.
 *
 * @param result - the canonical diagnostics result.
 * @param limits - `{ maxResultChars }`.
 * @returns the rendered text.
 */
export function renderDiagnostics(result, limits) {
  const { file_path, diagnostics, truncated, source } = result;
  if (diagnostics.length === 0) {
    return `${file_path}: no diagnostics${source === undefined ? '' : ` (${source})`}`;
  }

  const counts = new Map();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.severity, (counts.get(diagnostic.severity) ?? 0) + 1);
  }
  const summary = ['error', 'warning', 'information', 'hint']
    .filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity)} ${severity}`)
    .join(', ');

  const lines = [`${file_path}: ${summary}${source === undefined ? '' : ` (${source})`}`];
  for (const diagnostic of diagnostics) {
    const locator = formatRange(diagnostic.start, diagnostic.end);
    const origin = diagnostic.source === undefined ? '' : ` [${diagnostic.source}]`;
    const code = diagnostic.code === undefined ? '' : ` (${diagnostic.code})`;
    lines.push(`  ${diagnostic.severity} ${locator}${origin}${code}: ${oneLine(diagnostic.message)}`);
  }
  if (truncated) lines.push(truncationNote(diagnostics.length, result.total));

  return clip(lines.join('\n'), limits);
}

/**
 * Render document or workspace symbols as an indented outline.
 *
 * @param result - the canonical symbols result.
 * @param limits - `{ maxResultChars }`.
 * @returns the rendered text.
 */
export function renderSymbols(result, limits) {
  const { symbols, query, file_path, truncated } = result;
  const scope = query === undefined ? file_path : `"${query}" in workspace`;
  if (symbols.length === 0) return `${scope}: no symbols found`;

  const lines = [`${scope}: ${symbols.length} symbol${symbols.length === 1 ? '' : 's'}`];
  for (const symbol of symbols) {
    const indent = '  '.repeat(symbol.depth + 1);
    const locator = symbol.start === undefined ? '' : ` ${formatPosition(symbol.start)}`;
    const container = symbol.container === undefined ? '' : ` (in ${symbol.container})`;
    lines.push(`${indent}${symbol.kind} ${symbol.name}${locator}${container}`);
  }
  if (truncated) lines.push(truncationNote(symbols.length, result.total));
  return clip(lines.join('\n'), limits);
}

/**
 * Render code actions.
 *
 * Actions are reported, never applied: the model applies an edit itself, so the
 * text says explicitly whether an action carries an edit and how many files it
 * would touch.
 *
 * @param result - the canonical code actions result.
 * @param limits - `{ maxResultChars }`.
 * @returns the rendered text.
 */
export function renderCodeActions(result, limits) {
  const { file_path, range, actions, truncated } = result;
  const where = `${file_path} ${formatRange(range.start, range.end)}`;
  if (actions.length === 0) return `${where}: no code actions available`;

  const lines = [`${where}: ${actions.length} action${actions.length === 1 ? '' : 's'}`];
  actions.forEach((action, index) => {
    const kind = action.kind === undefined || action.kind === '' ? '' : ` [${action.kind}]`;
    const preferred = action.preferred === true ? ' (preferred)' : '';
    const disabled = action.disabled === true ? ' (unavailable)' : '';
    const edits = action.editCount === 0 ? '' : ` — edits ${action.editCount} file(s)`;
    lines.push(`  ${index + 1}. ${oneLine(action.title)}${kind}${preferred}${disabled}${edits}`);
  });
  if (truncated) lines.push(truncationNote(actions.length, result.total));
  return clip(lines.join('\n'), limits);
}

/**
 * Render an applied write as a diff.
 *
 * @param result - `{ files, unsupported, summary }`.
 * @param limits - `{ maxResultChars, maxDiffLines }`.
 * @returns the rendered text.
 */
export function renderApplied(result, limits) {
  const { summary, files, unsupported = [] } = result;
  const lines = [summary];
  for (const file of files) {
    if (file.unchanged === true) {
      lines.push(`  ${file.path}: already up to date`);
      continue;
    }
    lines.push(`  ${file.path}:`);
    for (const line of file.diff.lines) lines.push(`    ${line}`);
    if (file.diff.truncated) lines.push('    … diff truncated');
  }
  if (unsupported.length > 0) {
    lines.push(
      `  not applied (file operations this plugin does not perform): ${unsupported.join(', ')}`,
    );
  }
  return clip(lines.join('\n'), limits);
}

/** Collapse newlines in a server-supplied string so one item stays one line. */
function oneLine(text) {
  return String(text).replace(/\s*\n\s*/g, ' ').trim();
}

/** Apply the character budget, marking a clipped result explicitly. */
function clip(text, limits) {
  const max = limits?.maxResultChars;
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n… output clipped at ${max} characters`;
}
