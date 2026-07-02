/**
 * Onda D+E — pure mappers/fallbacks for signature help + document symbols.
 * No sqlite: db objects are hand-rolled fakes (ABI-gate friendly).
 */
import { describe, expect, it } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { mapServerSignatureHelp, mapServerDocumentSymbols } from '../server-backend-ops.js';
import { computeCallContext, splitParams, fallbackSignatureHelp } from '../fallback-signature.js';
import { fallbackDocumentSymbols } from '../fallback-document-symbols.js';

describe('mapServerSignatureHelp', () => {
  it('maps string labels and offset-pair labels (Intelephense style)', () => {
    const dto = mapServerSignatureHelp({
      signatures: [{
        label: 'str_replace(mixed $search, mixed $replace, string $subject)',
        documentation: { value: 'Replaces text' },
        parameters: [
          { label: 'mixed $search' },
          { label: [27, 41] }, // offsets into the signature label
        ],
      }],
      activeSignature: null,
      activeParameter: 1,
    });
    expect(dto?.signatures[0].parameters[0].label).toBe('mixed $search');
    expect(dto?.signatures[0].parameters[1].label).toBe('mixed $replace');
    expect(dto?.signatures[0].documentation).toBe('Replaces text');
    expect(dto?.activeSignature).toBe(0);
    expect(dto?.activeParameter).toBe(1);
  });

  it('returns null on empty/garbage payloads', () => {
    expect(mapServerSignatureHelp(null)).toBeNull();
    expect(mapServerSignatureHelp({ signatures: [] })).toBeNull();
    expect(mapServerSignatureHelp({ signatures: [{}] })).toBeNull();
  });
});

describe('mapServerDocumentSymbols', () => {
  const r0 = { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } };
  it('hierarchical DocumentSymbol[] keeps children and converts to 1-based', () => {
    const out = mapServerDocumentSymbols([{
      name: 'UserService', kind: 5, range: r0, selectionRange: r0,
      children: [{ name: 'save', kind: 6, range: r0, selectionRange: r0 }],
    }]);
    expect(out[0].name).toBe('UserService');
    expect(out[0].kind).toBe('class');
    expect(out[0].range.start).toEqual({ line: 1, column: 1 });
    expect(out[0].children?.[0].name).toBe('save');
    expect(out[0].children?.[0].kind).toBe('method');
  });

  it('flat SymbolInformation[] is promoted to a shallow hierarchy by containerName', () => {
    const loc = { range: r0 };
    const out = mapServerDocumentSymbols([
      { name: 'UserService', kind: 5, location: loc },
      { name: 'save', kind: 6, location: loc, containerName: 'UserService' },
      { name: 'helper', kind: 12, location: loc },
    ]);
    expect(out.map((s) => s.name)).toEqual(['UserService', 'helper']);
    expect(out[0].children?.map((s) => s.name)).toEqual(['save']);
  });
});

describe('computeCallContext / splitParams', () => {
  it('finds the innermost unclosed call and counts top-level commas', () => {
    const lines = ['$x = str_replace($a, otherFn($b, $c), '];
    expect(computeCallContext(lines, { line: 1, column: lines[0].length + 1 }))
      .toEqual({ name: 'str_replace', activeParameter: 2 });
  });

  it('ignores commas inside strings and closed parens', () => {
    const lines = ["foo('a,b', bar(1, 2), "];
    expect(computeCallContext(lines, { line: 1, column: lines[0].length + 1 }))
      .toEqual({ name: 'foo', activeParameter: 2 });
  });

  it('returns null outside any call', () => {
    expect(computeCallContext(['$a = 1;'], { line: 1, column: 8 })).toBeNull();
  });

  it('splitParams respects nesting', () => {
    expect(splitParams('array $a, callable(int, int) $cmp, string $sep = ","'))
      .toEqual(['array $a', 'callable(int, int) $cmp', 'string $sep = ","']);
  });
});

describe('fallbackSignatureHelp / fallbackDocumentSymbols (fake db)', () => {
  const sym = (over: Record<string, unknown>) => ({
    id: 1, project_id: 1, file_id: 1, file_path: 'a.php', name: 'x', kind: 'function',
    signature: '', parent: null, namespace: null, modifiers: '[]', return_type: null,
    parameters: null, line: 1, col: 1, end_line: 2, exported: 1, comment: null,
    tags: '[]', created_at: '', stable_id: null, ...over,
  });

  it('builds one signature from the index parameters', () => {
    const db = {
      findSymbolsByName: () => [sym({ name: 'sendMail', parameters: 'string $to, string $subject', return_type: 'bool' })],
    } as unknown as CodeIndexDB;
    const dto = fallbackSignatureHelp(db, 1, '$m = sendMail($to, ', { line: 1, column: 20 });
    expect(dto?.signatures[0].label).toBe('sendMail(string $to, string $subject): bool');
    expect(dto?.activeParameter).toBe(1);
  });

  it('outline rebuilds hierarchy from parent names', () => {
    const db = {
      getSymbolsByFile: () => [
        sym({ name: 'UserService', kind: 'class', line: 3, end_line: 20 }),
        sym({ name: 'save', kind: 'method', parent: 'UserService', line: 5, end_line: 8 }),
        sym({ name: 'helper', kind: 'function', line: 22, end_line: 25 }),
      ],
    } as unknown as CodeIndexDB;
    const out = fallbackDocumentSymbols(db, 1, 'a.php');
    expect(out.map((s) => s.name)).toEqual(['UserService', 'helper']);
    expect(out[0].children?.[0].name).toBe('save');
    expect(out[0].range).toEqual({ start: { line: 3, column: 1 }, end: { line: 20, column: 1 } });
  });
});
