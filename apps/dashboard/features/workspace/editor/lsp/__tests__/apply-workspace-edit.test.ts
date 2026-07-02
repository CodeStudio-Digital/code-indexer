/**
 * applyEditsToContent — a metade PURA do apply-workspace-edit (rename em
 * arquivos sem model Monaco). Pinos: ranges 1-based início-inclusivo /
 * fim-exclusivo, aplicação de trás para frente (ordenar por start DESC), e
 * independência da ordem de chegada dos edits.
 */
import { describe, it, expect } from 'vitest';
import { applyEditsToContent, type ContentEdit } from '../apply-workspace-edit.js';

const edit = (
  startLine: number, startCol: number, endLine: number, endCol: number, newText: string,
): ContentEdit => ({
  range: { start: { line: startLine, column: startCol }, end: { line: endLine, column: endCol } },
  newText,
});

describe('applyEditsToContent', () => {
  it('applies a single edit (1-based, end-exclusive)', () => {
    // "foo" ocupa colunas 7..9; end exclusivo = coluna 10.
    expect(applyEditsToContent('const foo = 1;', [edit(1, 7, 1, 10, 'bar')]))
      .toBe('const bar = 1;');
  });

  it('applies multiple edits on the SAME line without offset drift', () => {
    const content = 'foo(foo, foo);';
    const edits = [
      edit(1, 1, 1, 4, 'renamed'),
      edit(1, 5, 1, 8, 'renamed'),
      edit(1, 10, 1, 13, 'renamed'),
    ];
    expect(applyEditsToContent(content, edits)).toBe('renamed(renamed, renamed);');
  });

  it('applies edits across different lines', () => {
    const content = 'let foo = 1;\nfoo += 2;\nreturn foo;\n';
    const edits = [
      edit(1, 5, 1, 8, 'total'),
      edit(2, 1, 2, 4, 'total'),
      edit(3, 8, 3, 11, 'total'),
    ];
    expect(applyEditsToContent(content, edits)).toBe('let total = 1;\ntotal += 2;\nreturn total;\n');
  });

  it('is independent of the arrival order (sorts start DESC internally)', () => {
    const content = 'a b a b a';
    const forward = [edit(1, 1, 1, 2, 'xx'), edit(1, 5, 1, 6, 'xx'), edit(1, 9, 1, 10, 'xx')];
    const reversed = [...forward].reverse();
    const shuffled = [forward[1], forward[2], forward[0]];
    const expected = 'xx b xx b xx';
    expect(applyEditsToContent(content, forward)).toBe(expected);
    expect(applyEditsToContent(content, reversed)).toBe(expected);
    expect(applyEditsToContent(content, shuffled)).toBe(expected);
  });

  it('handles new text longer AND shorter than the span', () => {
    const content = 'aaa bbb aaa';
    const edits = [edit(1, 1, 1, 4, 'z'), edit(1, 9, 1, 12, 'zzzzz')];
    expect(applyEditsToContent(content, edits)).toBe('z bbb zzzzz');
  });

  it('returns content untouched for an empty edit list', () => {
    expect(applyEditsToContent('unchanged', [])).toBe('unchanged');
  });

  it('clamps out-of-bounds positions instead of corrupting the buffer', () => {
    // Edit no fim do arquivo com end além do conteúdo — vira append seguro.
    expect(applyEditsToContent('ab', [edit(9, 1, 9, 99, '!')])).toBe('ab!');
  });
});
