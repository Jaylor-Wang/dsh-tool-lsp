/**
 * Stage-3 tests: position encoding and payload normalization.
 *
 * The encoding tests use text where the three encodings genuinely disagree —
 * ASCII (all equal), accented Latin and CJK (UTF-8 ≠ UTF-16), and emoji
 * (astral, so a surrogate pair in UTF-16) — because text where they agree proves
 * nothing about the conversion.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PositionCodec,
  decodeTextEdits,
  decodeWorkspaceEdit,
  isWirePosition,
  negotiatePositionEncoding,
  normalizeCodeActions,
  normalizeDiagnostics,
  normalizeLocation,
  normalizeSymbols,
  symbolKindLabel,
  toModelPosition,
  toRange,
  toWirePosition,
  uriToPath,
} from '../lib/translate.js';
import { LSP_ERROR } from '../lib/vocabulary.js';

/** Assert a plugin error with the expected code. */
function hasCode(code) {
  return (error) => error.code === code;
}

// ── negotiation ─────────────────────────────────────────────────────────────

test('negotiatePositionEncoding: absent means utf-16', () => {
  assert.equal(negotiatePositionEncoding(undefined), 'utf-16');
  assert.equal(negotiatePositionEncoding(null), 'utf-16');
});

test('negotiatePositionEncoding: accepts the three supported encodings', () => {
  for (const encoding of ['utf-16', 'utf-8', 'utf-32']) {
    assert.equal(negotiatePositionEncoding(encoding), encoding);
  }
});

test('negotiatePositionEncoding: refuses an unknown encoding instead of guessing', () => {
  assert.throws(() => negotiatePositionEncoding('utf-7'), hasCode(LSP_ERROR.UNSUPPORTED));
});

// ── one-based ↔ zero-based ──────────────────────────────────────────────────

test('toWirePosition: one-based model input becomes zero-based wire output', () => {
  assert.deepEqual(toWirePosition(1, 1), { line: 0, character: 0 });
  assert.deepEqual(toWirePosition(10, 5), { line: 9, character: 4 });
});

test('toWirePosition: clamps instead of producing a negative coordinate', () => {
  assert.deepEqual(toWirePosition(0, 0), { line: 0, character: 0 });
});

test('toModelPosition: zero-based wire becomes one-based model convention', () => {
  assert.deepEqual(toModelPosition({ line: 0, character: 0 }), { line: 1, character: 1 });
});

// ── position codec ──────────────────────────────────────────────────────────

test('codec: utf-16 is the identity for every position', () => {
  const codec = new PositionCodec('const 中文 = "😀";\nlet x = 1;\n');
  for (const position of [
    { line: 0, character: 0 },
    { line: 0, character: 6 },
    { line: 1, character: 4 },
  ]) {
    assert.deepEqual(codec.encode(position, 'utf-16'), position);
    assert.deepEqual(codec.decode(position, 'utf-16'), position);
  }
});

test('codec: ASCII text makes all three encodings agree', () => {
  const codec = new PositionCodec('hello world\nsecond line\n');
  const position = { line: 0, character: 5 };
  assert.deepEqual(codec.encode(position, 'utf-8'), position);
  assert.deepEqual(codec.encode(position, 'utf-32'), position);
});

test('codec: multi-byte characters diverge in utf-8 but not utf-32', () => {
  // Row: `中` occupies 1 UTF-16 unit, 3 UTF-8 bytes, 1 code point.
  const codec = new PositionCodec('中文abc\n');
  // Offset 2 is after both CJK characters: 6 UTF-8 bytes, 2 code points.
  assert.deepEqual(codec.encode({ line: 0, character: 2 }, 'utf-8'), { line: 0, character: 6 });
  assert.deepEqual(codec.encode({ line: 0, character: 2 }, 'utf-32'), { line: 0, character: 2 });
});

test('codec: astral characters are 2 UTF-16 units but 1 code point', () => {
  // An emoji is a surrogate pair: UTF-16 width 2, UTF-8 width 4, UTF-32 width 1.
  const codec = new PositionCodec('😀x\n');
  assert.deepEqual(codec.encode({ line: 0, character: 2 }, 'utf-8'), { line: 0, character: 4 });
  assert.deepEqual(codec.encode({ line: 0, character: 2 }, 'utf-32'), { line: 0, character: 1 });
  assert.deepEqual(codec.encode({ line: 0, character: 3 }, 'utf-32'), { line: 0, character: 2 });
});

test('codec: a mid-surrogate offset maps to the code point start, not a crash', () => {
  const codec = new PositionCodec('😀x\n');
  // Offset 1 splits the pair — illegal, but it must not produce garbage.
  assert.deepEqual(codec.encode({ line: 0, character: 1 }, 'utf-8'), { line: 0, character: 0 });
  assert.deepEqual(codec.encode({ line: 0, character: 1 }, 'utf-32'), { line: 0, character: 0 });
});

test('codec: offsets are per-line, not document-wide', () => {
  // The second line starts after a 3-byte CJK character plus a newline; a
  // document-wide table would leak that offset into line 1.
  const codec = new PositionCodec('中\nabc\n');
  assert.deepEqual(codec.encode({ line: 1, character: 1 }, 'utf-8'), { line: 1, character: 1 });
});

test('codec: encode/decode round-trip is stable in every encoding', () => {
  const text = 'const 名前 = "😀";\nlet 数 = 42;\n// コメント\n';
  const codec = new PositionCodec(text);
  for (const encoding of ['utf-8', 'utf-32']) {
    for (let line = 0; line < 3; line += 1) {
      for (let character = 0; character < 8; character += 1) {
        const wire = codec.encode({ line, character }, encoding);
        const back = codec.decode(wire, encoding);
        assert.deepEqual(back, { line, character }, `round-trip failed at ${line}:${character} in ${encoding}`);
      }
    }
  }
});

test('codec: an out-of-range line clamps to the last line', () => {
  // `a\nb\n` has three line starts ([0, 2, 4]) because the trailing newline
  // opens a final empty line; the last valid line index is therefore 2.
  const codec = new PositionCodec('a\nb\n');
  const encoded = codec.encode({ line: 99, character: 0 }, 'utf-8');
  assert.equal(encoded.line, 2, 'line 99 must clamp to the final (empty) line');
});

test('codec: an over-long character offset clamps to the line end', () => {
  // Line 0 of `ab\ncd\n` spans indices 0..3 — the newline is part of the line's
  // extent, so the clamp bound is 3, not 2.
  const codec = new PositionCodec('ab\ncd\n');
  assert.deepEqual(codec.encode({ line: 0, character: 99 }, 'utf-8'), { line: 0, character: 3 });
});

// ── wire validation ─────────────────────────────────────────────────────────

test('isWirePosition: rejects negatives, fractions, and non-numbers', () => {
  assert.equal(isWirePosition({ line: 0, character: 0 }), true);
  assert.equal(isWirePosition({ line: -1, character: 0 }), false);
  assert.equal(isWirePosition({ line: 0.5, character: 0 }), false);
  assert.equal(isWirePosition({ line: '0', character: 0 }), false);
  assert.equal(isWirePosition(null), false);
});

test('toRange: a malformed endpoint is refused, not silently accepted', () => {
  assert.throws(
    () => toRange({ start: { line: 0, character: 0 }, end: { line: -1, character: 0 } }, undefined),
    hasCode(LSP_ERROR.SERVER_ERROR),
  );
});

// ── uri handling ────────────────────────────────────────────────────────────

test('uriToPath: decodes percent escapes and Windows drive paths', () => {
  assert.equal(uriToPath('file:///home/u/a%20b.ts'), '/home/u/a b.ts');
  assert.equal(uriToPath('file:///C:/proj/a.ts'), 'C:/proj/a.ts');
  assert.equal(uriToPath('untitled:Untitled-1'), 'untitled:Untitled-1');
});

// ── diagnostics ─────────────────────────────────────────────────────────────

test('normalizeDiagnostics: maps severity numbers to labels and defaults to error', () => {
  const [d] = normalizeDiagnostics(
    [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'boom' }],
    undefined,
  );
  assert.equal(d.severity, 'error');
  assert.equal(d.message, 'boom');
});

test('normalizeDiagnostics: accepts the { items } pull-diagnostics envelope', () => {
  const items = normalizeDiagnostics(
    { items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x', severity: 2 }] },
    undefined,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'warning');
});

test('normalizeDiagnostics: null and undefined are an empty list, not an error', () => {
  assert.deepEqual(normalizeDiagnostics(null, undefined), []);
  assert.deepEqual(normalizeDiagnostics(undefined, undefined), []);
});

test('normalizeDiagnostics: an out-of-range severity is refused', () => {
  assert.throws(
    () => normalizeDiagnostics([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message: 'm', severity: 9 }], undefined),
    hasCode(LSP_ERROR.SERVER_ERROR),
  );
});

// ── symbols ─────────────────────────────────────────────────────────────────

test('normalizeSymbols: flattens DocumentSymbol children with a depth', () => {
  const symbols = normalizeSymbols(
    [
      {
        name: 'Outer',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
        children: [
          { name: 'Inner', kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 2, character: 2 } } },
        ],
      },
    ],
    undefined,
  );
  assert.deepEqual(symbols.map((s) => [s.name, s.kind, s.depth]), [
    ['Outer', 'class', 0],
    ['Inner', 'method', 1],
  ]);
});

test('normalizeSymbols: accepts flat SymbolInformation with a location', () => {
  const [s] = normalizeSymbols(
    [{ name: 'fn', kind: 12, location: { uri: 'file:///a.ts', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } } }],
    undefined,
  );
  assert.equal(s.kind, 'function');
  assert.equal(s.file_path, '/a.ts');
  // The model gets one-based positions back, not wire positions.
  assert.deepEqual(s.start, { line: 4, character: 1 });
});

test('normalizeSymbols: a symbol with neither range nor location is refused', () => {
  assert.throws(() => normalizeSymbols([{ name: 'x', kind: 1 }], undefined), hasCode(LSP_ERROR.SERVER_ERROR));
});

test('symbolKindLabel: maps known kinds and tolerates unknown ones', () => {
  assert.equal(symbolKindLabel(1), 'file');
  assert.equal(symbolKindLabel(26), 'type-parameter');
  assert.equal(symbolKindLabel(999), 'unknown');
  assert.equal(symbolKindLabel(undefined), 'unknown');
});

// ── code actions + edits ────────────────────────────────────────────────────

test('normalizeCodeActions: reports the shape without applying it', () => {
  const [action] = normalizeCodeActions([
    { title: 'Fix it', kind: 'quickfix', isPreferred: true, edit: { changes: { 'file:///a.ts': [] } } },
  ]);
  assert.equal(action.title, 'Fix it');
  assert.equal(action.preferred, true);
  assert.equal(action.editCount, 1);
});

test('decodeWorkspaceEdit: reads the `changes` shape', () => {
  const { files, unsupported } = decodeWorkspaceEdit({
    changes: { 'file:///a.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] },
  });
  assert.deepEqual([...files.keys()], ['/a.ts']);
  assert.equal(files.get('/a.ts')[0].newText, 'x');
  assert.deepEqual(unsupported, []);
});

test('decodeWorkspaceEdit: reads the `documentChanges` shape', () => {
  const { files } = decodeWorkspaceEdit({
    documentChanges: [
      {
        textDocument: { uri: 'file:///b.ts', version: 3 },
        edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: 'y' }],
      },
    ],
  });
  assert.deepEqual([...files.keys()], ['/b.ts']);
});

test('decodeWorkspaceEdit: file operations are reported, never applied', () => {
  // A create/rename/delete is not a text edit; applying it would touch files the
  // caller never saw.
  const { files, unsupported } = decodeWorkspaceEdit({
    documentChanges: [{ kind: 'create', uri: 'file:///new.ts' }],
  });
  assert.equal(files.size, 0);
  assert.deepEqual(unsupported, ['create']);
});

test('decodeWorkspaceEdit: edits to the same file across entries accumulate', () => {
  const { files } = decodeWorkspaceEdit({
    documentChanges: [
      { textDocument: { uri: 'file:///a.ts' }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'p' }] },
      { textDocument: { uri: 'file:///a.ts' }, edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'q' }] },
    ],
  });
  assert.equal(files.get('/a.ts').length, 2);
});

test('decodeTextEdits: an edit without newText is refused', () => {
  assert.throws(() => decodeTextEdits([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]), hasCode(LSP_ERROR.SERVER_ERROR));
});

test('normalizeLocation: accepts LocationLink target fields', () => {
  const location = normalizeLocation(
    { targetUri: 'file:///c.ts', targetRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } },
    undefined,
  );
  assert.equal(location.file_path, '/c.ts');
  assert.deepEqual(location.start, { line: 3, character: 1 });
});
