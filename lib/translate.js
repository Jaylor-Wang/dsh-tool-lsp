/**
 * Translation between the model-facing coordinate convention and the LSP wire
 * format.
 *
 * Two conventions meet here and must not be confused:
 *
 *  - **Model-facing**: one-based line and character (the editor/cursor
 *    convention), always counted in UTF-16 code units.
 *  - **Wire**: zero-based line and character, counted in whatever position
 *    encoding the server negotiated (`utf-16`, `utf-8`, or `utf-32`).
 *
 * Line numbers are encoding-independent — a newline is one unit in every
 * encoding — so only the character offset *inside* a line is converted. That is
 * what keeps this tractable: two lookup tables map every UTF-16 index to its
 * absolute UTF-8 byte or UTF-32 code-point offset, and a conversion subtracts
 * the line's own base offset on both sides.
 *
 * @module dsh-tool-lsp/translate
 */
import { LSP_ERROR, lspError } from './vocabulary.js';

/** Position encodings this client can speak. `utf-16` is the protocol default. */
const SUPPORTED_ENCODINGS = ['utf-16', 'utf-8', 'utf-32'];

/**
 * Pick the position encoding for a server from its `initialize` result.
 *
 * Absent means `utf-16` per the LSP spec. An unrecognised value is refused
 * rather than silently treated as UTF-16: guessing would shift every position on
 * a document containing non-ASCII text.
 *
 * @param encoding - the `positionEncoding` the server reported, if any.
 * @returns the negotiated encoding.
 * @throws when the server asks for an encoding this client cannot speak.
 */
export function negotiatePositionEncoding(encoding) {
  if (encoding === undefined || encoding === null) return 'utf-16';
  if (SUPPORTED_ENCODINGS.includes(encoding)) return encoding;
  throw lspError(
    LSP_ERROR.UNSUPPORTED,
    `server negotiated unsupported position encoding "${String(encoding)}"; this client supports ${SUPPORTED_ENCODINGS.join(', ')}`,
  );
}

/**
 * Converts positions between UTF-16 and one server's negotiated encoding for a
 * single document.
 *
 * One instance per open document: the tables are sized to the text, so they are
 * built once when the document is opened rather than per request.
 */
export class PositionCodec {
  /**
   * @param text - the document text positions are converted against.
   */
  constructor(text) {
    this.length = text.length;
    /** UTF-16 index → absolute UTF-8 byte offset. */
    this.utf8 = new Uint32Array(text.length + 1);
    /** UTF-16 index → absolute UTF-32 code-point offset. */
    this.utf32 = new Uint32Array(text.length + 1);
    /** UTF-16 index of the first unit of each line. */
    this.lineStarts = [0];

    let bytes = 0;
    let points = 0;
    for (let i = 0; i < text.length; ) {
      const codePoint = text.codePointAt(i);
      const width = codePoint > 0xffff ? 2 : 1;
      // The offset BEFORE the code point at `i`; both units of a surrogate pair
      // share it, so an illegal mid-pair offset still lands somewhere sane.
      this.utf8[i] = bytes;
      this.utf32[i] = points;
      if (width === 2) {
        this.utf8[i + 1] = bytes;
        this.utf32[i + 1] = points;
      }
      if (codePoint === 0x0a) this.lineStarts.push(i + width);
      bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      points += 1;
      i += width;
    }
    this.utf8[text.length] = bytes;
    this.utf32[text.length] = points;
  }

  /**
   * Convert a UTF-16 position to the server's encoding.
   *
   * A character offset inside a surrogate pair (never legal in any encoding)
   * maps to the code point's own offset.
   *
   * @param position - the zero-based UTF-16 position.
   * @param encoding - the server's position encoding.
   * @returns the converted position (identical object when the encoding is `utf-16`).
   */
  encode(position, encoding) {
    if (encoding === 'utf-16') return position;
    const table = encoding === 'utf-8' ? this.utf8 : this.utf32;
    const line = this.#clampLine(position.line);
    const lineStart = this.lineStarts[line];
    const lineEnd = this.lineStarts[line + 1] ?? this.length;
    const character = Math.min(Math.max(Math.trunc(position.character), 0), lineEnd - lineStart);
    const base = table[lineStart];
    return { line, character: table[lineStart + character] - base };
  }

  /**
   * Convert a server-side position back to UTF-16.
   *
   * An offset inside a multi-unit code point (illegal per protocol) maps to that
   * code point's first UTF-16 unit.
   *
   * @param position - the zero-based position in the server's encoding.
   * @param encoding - the server's position encoding.
   * @returns the UTF-16 position (identical object when the encoding is `utf-16`).
   */
  decode(position, encoding) {
    if (encoding === 'utf-16') return position;
    const table = encoding === 'utf-8' ? this.utf8 : this.utf32;
    const line = this.#clampLine(position.line);
    const lineStart = this.lineStarts[line];
    const base = table[lineStart];
    const target = base + Math.max(Math.trunc(position.character), 0);
    // The table is non-decreasing, so bisect for the first index reaching the target.
    let lo = lineStart;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (table[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return { line, character: lo - lineStart };
  }

  /** Clamp a line number into the document's line range. */
  #clampLine(line) {
    return Math.min(Math.max(Math.trunc(line), 0), this.lineStarts.length - 1);
  }
}

/**
 * Convert a one-based, UTF-16 model position to the zero-based wire position.
 *
 * @param line - one-based line.
 * @param character - one-based UTF-16 column.
 * @returns the zero-based position.
 */
export function toWirePosition(line, character) {
  return { line: Math.max(Math.trunc(line) - 1, 0), character: Math.max(Math.trunc(character) - 1, 0) };
}

/**
 * Convert a zero-based wire position to the one-based, UTF-16 model convention.
 *
 * @param position - the zero-based position.
 * @returns the one-based position.
 */
export function toModelPosition(position) {
  return { line: Math.trunc(position.line) + 1, character: Math.trunc(position.character) + 1 };
}

/**
 * Whether a value is a well-formed wire position (non-negative integer line and character).
 * @param value - the candidate.
 * @returns true when it is a usable position.
 */
export function isWirePosition(value) {
  if (value === null || typeof value !== 'object') return false;
  return isCoordinate(value.line) && isCoordinate(value.character);
}

/** Whether a value is a non-negative safe integer. */
export function isCoordinate(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Normalize a wire range, converting both ends out of the server's encoding.
 *
 * The result is still a wire (zero-based) range: `convert` maps a position from
 * the server's negotiated encoding into UTF-16 units, and nothing here changes
 * the base. Callers that need the model convention pass the result through
 * {@link toModelPosition}.
 *
 * @param value - the candidate range.
 * @param convert - an encoding converter, or `undefined` to pass positions through.
 * @returns the range in zero-based UTF-16 coordinates.
 * @throws when either end is not a well-formed position.
 */
export function toRange(value, convert) {
  if (value === null || typeof value !== 'object') {
    throw lspError(LSP_ERROR.SERVER_ERROR, 'LSP response contained a malformed range');
  }
  if (!isWirePosition(value.start) || !isWirePosition(value.end)) {
    throw lspError(LSP_ERROR.SERVER_ERROR, 'LSP response contained a malformed range endpoint');
  }
  if (convert === undefined) return { start: value.start, end: value.end };
  return { start: convert(value.start), end: convert(value.end) };
}

/**
 * Convert a range with the given position converter, or pass it through.
 * @param range - the range to convert.
 * @param convert - a position converter, or `undefined`.
 * @returns the converted range.
 */
export function convertRange(range, convert) {
  if (convert === undefined) return range;
  return { start: convert(range.start), end: convert(range.end) };
}

/**
 * Strip a `file:` URI to its path, tolerating non-URI paths.
 *
 * Servers report locations as URIs; the model expects paths it can pass back to
 * `read`/`edit`. A value that is not a URI is returned unchanged.
 *
 * @param uri - the server-reported URI or path.
 * @returns the filesystem path.
 */
export function uriToPath(uri) {
  if (typeof uri !== 'string') return '';
  if (!uri.startsWith('file:')) return uri;
  try {
    const url = new URL(uri);
    // Windows paths arrive as `/C:/...`; drop the leading slash the URL adds.
    const decoded = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return uri;
  }
}

// ── payload normalization ───────────────────────────────────────────────────
//
// Every server result is validated before it reaches the tool layer. A malformed
// payload is refused with a classified error rather than partially rendered:
// a half-parsed diagnostic list reads as authoritative to the model, which is
// worse than an explicit failure.

/** Severity numbers as defined by the LSP spec. */
export const DIAGNOSTIC_SEVERITY = { ERROR: 1, WARNING: 2, INFORMATION: 3, HINT: 4 };

/** Severity number to the label shown to the model. */
const SEVERITY_LABEL = { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' };

/** A malformed server payload, classified for the tool layer. */
function malformedResponse(message) {
  return lspError(LSP_ERROR.SERVER_ERROR, message);
}

/**
 * Normalize a diagnostics payload — either a bare array (push result) or the
 * `{ items }` envelope (pull result).
 *
 * @param payload - the server payload.
 * @param decode - a position converter from wire to the model convention.
 * @returns the normalized diagnostics.
 * @throws when the payload or any entry is malformed.
 */
export function normalizeDiagnostics(payload, decode) {
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== 'object') {
    throw malformedResponse('LSP diagnostics result was not an object or array');
  }
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw malformedResponse('LSP diagnostics result had no items array');
  return items.map((item) => normalizeDiagnostic(item, decode));
}

/** Normalize one wire diagnostic. */
function normalizeDiagnostic(value, decode) {
  if (value === null || typeof value !== 'object') {
    throw malformedResponse('LSP diagnostics contained a non-object entry');
  }
  const range = toRange(value.range, decode);
  if (typeof value.message !== 'string') throw malformedResponse('LSP diagnostic had no message string');
  const severity = value.severity === undefined ? DIAGNOSTIC_SEVERITY.ERROR : value.severity;
  if (!Number.isInteger(severity) || severity < 1 || severity > 4) {
    throw malformedResponse('LSP diagnostic severity must be an integer from 1 to 4');
  }
  if (value.source !== undefined && typeof value.source !== 'string') {
    throw malformedResponse('LSP diagnostic source must be a string');
  }
  if (value.code !== undefined && typeof value.code !== 'string' && typeof value.code !== 'number') {
    throw malformedResponse('LSP diagnostic code must be a string or number');
  }
  return {
    range,
    start: toModelPosition(range.start),
    end: toModelPosition(range.end),
    severity: SEVERITY_LABEL[severity],
    message: value.message,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.code === undefined ? {} : { code: String(value.code) }),
  };
}

/**
 * Normalize a symbols payload — `DocumentSymbol[]` (hierarchical) or
 * `SymbolInformation[]` (flat).
 *
 * The two shapes are told apart structurally: a document symbol carries a
 * `range` and possibly `children`; a symbol information carries a `location`.
 * Both flatten to one list, but document symbols keep their nesting depth.
 *
 * @param payload - the server payload.
 * @param decode - a position converter from wire to the model convention.
 * @returns the normalized symbols, in server order, depth-first.
 * @throws when the payload or any entry is malformed.
 */
export function normalizeSymbols(payload, decode) {
  if (payload === null || payload === undefined) return [];
  if (!Array.isArray(payload)) throw malformedResponse('LSP symbols result was not an array');
  const symbols = [];
  for (const item of payload) collectSymbol(item, decode, 0, symbols);
  return symbols;
}

/** Flatten one symbol, recursing into document-symbol children. */
function collectSymbol(value, decode, depth, out) {
  if (value === null || typeof value !== 'object') {
    throw malformedResponse('LSP symbols contained a non-object entry');
  }
  if (typeof value.name !== 'string') throw malformedResponse('LSP symbol had no name string');
  const kind = symbolKindLabel(value.kind);
  // `SymbolInformation` (flat form) reports a location; `DocumentSymbol` reports
  // a range. Prefer the location when present, since it is what callers jump to.
  if (value.location !== undefined) {
    const location = normalizeLocation(value.location, decode);
    out.push({ name: value.name, kind, depth, ...location });
    return;
  }
  if (value.range === undefined) throw malformedResponse('LSP symbol had neither range nor location');
  const range = toRange(value.range, decode);
  // `selectionRange` is the identifier itself; `range` is the whole declaration.
  // Callers jump to the identifier, so it is the reported position when present.
  const selection = value.selectionRange === undefined ? range : toRange(value.selectionRange, decode);
  out.push({
    name: value.name,
    kind,
    depth,
    range,
    start: toModelPosition(selection.start),
    end: toModelPosition(selection.end),
    ...(value.containerName === undefined ? {} : { container: value.containerName }),
  });
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) throw malformedResponse('LSP symbol children were not an array');
    for (const child of value.children) collectSymbol(child, decode, depth + 1, out);
  }
}

/** Normalize a `Location`, resolving `LocationLink` style fields too. */
export function normalizeLocation(value, decode) {
  if (value === null || typeof value !== 'object') {
    throw malformedResponse('LSP location was not an object');
  }
  // `LocationLink` uses targetUri/targetRange; `Location` uses uri/range.
  const uri = value.uri ?? value.targetUri;
  const range = value.range ?? value.targetSelectionRange ?? value.targetRange;
  if (typeof uri !== 'string') throw malformedResponse('LSP location had no uri');
  const normalized = toRange(range, decode);
  return {
    file_path: uriToPath(uri),
    range: normalized,
    start: toModelPosition(normalized.start),
    end: toModelPosition(normalized.end),
  };
}

/**
 * Normalize a code-action payload.
 *
 * @param payload - the server payload.
 * @returns the normalized actions.
 * @throws when the payload or any entry is malformed.
 */
export function normalizeCodeActions(payload) {
  if (payload === null || payload === undefined) return [];
  if (!Array.isArray(payload)) throw malformedResponse('LSP code actions result was not an array');
  return payload.map((value) => {
    if (value === null || typeof value !== 'object') {
      throw malformedResponse('LSP code actions contained a non-object entry');
    }
    if (typeof value.title !== 'string') throw malformedResponse('LSP code action had no title string');
    const editCount = countEdits(value.edit);
    return {
      title: value.title,
      ...(value.kind === undefined ? {} : { kind: value.kind }),
      ...(value.isPreferred === undefined ? {} : { preferred: value.isPreferred }),
      ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
      /** Files the action would touch; the model applies the edits itself. */
      editCount,
    };
  });
}

/** Count the file entries in a `WorkspaceEdit`, tolerating both of its shapes. */
function countEdits(edit) {
  if (edit === null || typeof edit !== 'object') return 0;
  if (edit.documentChanges !== undefined) {
    return Array.isArray(edit.documentChanges) ? edit.documentChanges.length : 0;
  }
  if (edit.changes !== undefined) {
    return edit.changes !== null && typeof edit.changes === 'object' ? Object.keys(edit.changes).length : 0;
  }
  return 0;
}

/**
 * Decode a `WorkspaceEdit` into per-file text edits, keyed by path.
 *
 * Handles both wire shapes: `changes` (uri → TextEdit[]) and `documentChanges`
 * (TextDocumentEdit entries, possibly interleaved with file operations, which
 * this plugin does not apply and therefore reports as unsupported).
 *
 * @param value - the `WorkspaceEdit`.
 * @returns `{ files, unsupported }`, where `files` maps a path to its edits.
 * @throws when the edit payload is malformed.
 */
export function decodeWorkspaceEdit(value) {
  if (value === null || typeof value !== 'object') {
    throw malformedResponse('LSP workspace edit was not an object');
  }
  const files = new Map();
  const unsupported = [];

  if (value.documentChanges !== undefined) {
    if (!Array.isArray(value.documentChanges)) {
      throw malformedResponse('LSP workspace edit documentChanges was not an array');
    }
    for (const change of value.documentChanges) {
      if (change === null || typeof change !== 'object') {
        throw malformedResponse('LSP document change was not an object');
      }
      if (change.textDocument === undefined) {
        // A create/rename/delete operation: not a text edit, and applying it
        // would change files the caller never saw.
        unsupported.push(typeof change.kind === 'string' ? change.kind : 'file-operation');
        continue;
      }
      const path = uriToPath(change.textDocument.uri);
      files.set(path, [...(files.get(path) ?? []), ...decodeTextEdits(change.edits)]);
    }
    return { files, unsupported };
  }

  if (value.changes !== undefined) {
    if (value.changes === null || typeof value.changes !== 'object') {
      throw malformedResponse('LSP workspace edit changes was not an object');
    }
    for (const [uri, edits] of Object.entries(value.changes)) {
      files.set(uriToPath(uri), decodeTextEdits(edits));
    }
  }
  return { files, unsupported };
}

/**
 * Validate a `TextEdit[]` payload.
 *
 * @param value - the candidate array.
 * @returns the edits, unchanged (they are already wire positions).
 * @throws when the payload is not an array of well-formed edits.
 */
export function decodeTextEdits(value) {
  if (!Array.isArray(value)) throw malformedResponse('LSP text edits were not an array');
  return value.map((edit) => {
    if (edit === null || typeof edit !== 'object') {
      throw malformedResponse('LSP text edit was not an object');
    }
    if (!isWirePosition(edit.range?.start) || !isWirePosition(edit.range?.end)) {
      throw malformedResponse('LSP text edit had a malformed range');
    }
    if (typeof edit.newText !== 'string') throw malformedResponse('LSP text edit had no newText string');
    return { range: edit.range, newText: edit.newText };
  });
}

/**
 * The label for a `SymbolKind` number.
 * @param kind - the numeric kind.
 * @returns the lowercase label, or `'unknown'` when out of range.
 */
export function symbolKindLabel(kind) {
  const labels = [
    'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field',
    'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string',
    'number', 'boolean', 'array', 'object', 'key', 'null', 'enum-member', 'struct',
    'event', 'operator', 'type-parameter',
  ];
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 1 || kind > labels.length) return 'unknown';
  return labels[kind - 1];
}
