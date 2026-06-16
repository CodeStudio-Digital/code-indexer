/**
 * Coverage for the code/table-aware packer — the whole point is that a fenced
 * code block or a markdown table is never severed when a section is split.
 */
import { describe, it, expect } from 'vitest';
import { packSections } from '../chunk-packer.js';

describe('packSections', () => {
  it('returns the body unchanged when it already fits', () => {
    expect(packSections('short body', 100)).toEqual(['short body']);
  });

  it('never splits inside a fenced code block (kept whole even when oversized)', () => {
    const code = '```js\n' + 'const x = 1;\n'.repeat(40) + '```';
    const body = `intro paragraph here\n\n${code}\n\noutro paragraph here`;
    const pieces = packSections(body, 120);
    const codePiece = pieces.find((p) => p.includes('```js'));
    expect(codePiece).toBeDefined();
    // Both fence markers live in the same piece → the block is intact.
    expect(codePiece!.match(/```/g)?.length).toBe(2);
  });

  it('keeps a markdown table atomic, header row included', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `| ${i} | ${'y'.repeat(12)} |`).join('\n');
    const table = `| name | value |\n| --- | --- |\n${rows}`;
    const body = `lead in paragraph\n\n${table}`;
    const pieces = packSections(body, 80);
    const tablePiece = pieces.find((p) => p.includes('| name | value |'));
    expect(tablePiece).toBeDefined();
    expect(tablePiece).toContain('| --- | --- |');
  });

  it('still hard-splits a pathological oversized prose paragraph', () => {
    const pieces = packSections('z'.repeat(500), 100);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 100)).toBe(true);
  });

  it('does not treat a pipe-containing sentence above a bare --- as a table', () => {
    // The separator `---` has no pipe → it's a horizontal rule, not a table
    // delimiter. The prose must pack/split normally, never frozen as atomic.
    const body = `a sentence with a | pipe\n---\n${'w'.repeat(300)}`;
    const pieces = packSections(body, 120);
    // The pipe sentence + `---` are ONE prose block: piece 0 holds both
    // (a false table-detection would isolate the sentence into its own piece
    // with `---` pushed to a later one).
    expect(pieces[0]).toContain('a sentence with a | pipe');
    expect(pieces[0]).toContain('---');
    expect(pieces.every((p) => p.length <= 120)).toBe(true);
  });
});
