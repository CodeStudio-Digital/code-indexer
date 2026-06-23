/**
 * Pure-logic tests for the stateful LSP plumbing: offset-delta application
 * (document-store), per-file coalescing + cancellation (diagnostics-hub)
 * and word extraction (index fallback). No sqlite, no Monaco.
 */
import { describe, it, expect } from 'vitest';
import { openDoc, changeDoc, getDoc, closeDoc } from '../document-store.js';
import { publishDiagnostics, subscribeDiagnostics, hasDiagnosticsSubscribers } from '../diagnostics-hub.js';
import { wordAt } from '../index-fallback.js';
import type { DiagnosticsFrame } from '@mcp/api-bus';

const frame = (file: string, msg: string): DiagnosticsFrame => ({
  file,
  source: 'ts',
  diagnostics: msg
    ? [{ file, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, severity: 'error', message: msg }]
    : [],
});

describe('document-store delta application', () => {
  it('applies Monaco-style changes by offset, in received order', () => {
    openDoc(91, 'a.ts', 'typescript', 1, 'const x = 1;\nconst y = 2;\n');
    // Single event, two changes sorted offset-DESC over the PRE buffer:
    // replace "2" (offset 23) and "1" (offset 10).
    expect(changeDoc(91, 'a.ts', 2, [
      { range: { start: { line: 2, column: 11 }, end: { line: 2, column: 12 } }, rangeOffset: 23, rangeLength: 1, text: '42' },
      { range: { start: { line: 1, column: 11 }, end: { line: 1, column: 12 } }, rangeOffset: 10, rangeLength: 1, text: '"one"' },
    ])).toBe(true);
    expect(getDoc(91, 'a.ts')!.content).toBe('const x = "one";\nconst y = 42;\n');
    expect(getDoc(91, 'a.ts')!.version).toBe(2);
    closeDoc(91, 'a.ts');
  });

  it('rejects stale/out-of-order versions and bad offsets → resync', () => {
    openDoc(92, 'b.ts', 'typescript', 5, 'abc');
    expect(changeDoc(92, 'b.ts', 5, [])).toBe(false);                       // same version
    expect(changeDoc(92, 'b.ts', 4, [])).toBe(false);                       // older
    expect(changeDoc(92, 'b.ts', 6, [
      { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, rangeOffset: 99, rangeLength: 1, text: 'x' },
    ])).toBe(false);                                                        // out of bounds
    expect(changeDoc(92, 'b.ts', 7, [
      { range: { start: { line: 1, column: 4 }, end: { line: 1, column: 4 } }, rangeOffset: 3, rangeLength: 0, text: 'd' },
    ])).toBe(true);
    expect(getDoc(92, 'b.ts')!.content).toBe('abcd');
    closeDoc(92, 'b.ts');
  });

  it('unknown file → resync; close removes', () => {
    expect(changeDoc(93, 'nope.ts', 2, [])).toBe(false);
    openDoc(93, 'c.ts', 'typescript', 1, 'x');
    closeDoc(93, 'c.ts');
    expect(getDoc(93, 'c.ts')).toBeUndefined();
  });
});

describe('diagnostics-hub', () => {
  it('coalesces per file for slow consumers; return() unsubscribes', async () => {
    const it1 = subscribeDiagnostics(7)[Symbol.asyncIterator]();
    // Force subscription registration before publishing.
    const first = it1.next();
    expect(hasDiagnosticsSubscribers(7)).toBe(true);

    publishDiagnostics(7, frame('a.ts', 'v1'));
    expect((await first).value.diagnostics[0]?.message).toBe('v1');

    // Two updates for the SAME file before the consumer drains → only the
    // latest survives; a different file keeps its own slot.
    publishDiagnostics(7, frame('a.ts', 'v2'));
    publishDiagnostics(7, frame('a.ts', 'v3'));
    publishDiagnostics(7, frame('b.ts', 'other'));
    const second = await it1.next();
    const third = await it1.next();
    const got = [second.value, third.value].map((f) => `${f.file}:${f.diagnostics[0]?.message}`);
    expect(got).toContain('a.ts:v3');
    expect(got).toContain('b.ts:other');
    expect(got).not.toContain('a.ts:v2');

    await it1.return!();
    expect(hasDiagnosticsSubscribers(7)).toBe(false);
    publishDiagnostics(7, frame('a.ts', 'after-close')); // must not throw
  });

  it('replays the latest frame to subscribers that connect after publish', async () => {
    publishDiagnostics(8, frame('late.php', 'already computed'));
    const it = subscribeDiagnostics(8)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value.file).toBe('late.php');
    expect(first.value.diagnostics[0]?.message).toBe('already computed');
    await it.return!();
  });
});

describe('index-fallback wordAt', () => {
  const content = 'function handleChange($foo) {\n  return $foo->bar_baz;\n}\n';
  it('extracts identifiers at/inside/just-after the word', () => {
    expect(wordAt(content, 1, 10)).toBe('handleChange');  // start
    expect(wordAt(content, 1, 15)).toBe('handleChange');  // middle
    expect(wordAt(content, 2, 17)).toBe('bar_baz');       // $foo->|bar_baz
  });
  it('returns null for non-word positions and 1-char words', () => {
    expect(wordAt(content, 1, 29)).toBeNull();            // '{'
    expect(wordAt('x y', 1, 1)).toBeNull();               // 1-char word
    expect(wordAt(content, 99, 1)).toBeNull();            // out of range
  });
});
