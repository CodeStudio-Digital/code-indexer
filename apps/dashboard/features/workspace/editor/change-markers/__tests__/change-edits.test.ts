/**
 * Rollback range-math tests. A fake line-based model captures the single edit
 * `rollbackChange` pushes; applying it must turn `current` back into `baseline`
 * for that block (the one-block case). Covers mid-file / top / EOF for added,
 * modified and deleted — the branches in `rollbackEdit`.
 */
import { describe, expect, it } from 'vitest';
import type * as MonacoNs from 'monaco-editor';
import { computeChanges } from '../diff-to-changes.js';
import { rollbackChange } from '../change-edits.js';

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}
const fakeMonaco = { Range: FakeRange } as unknown as typeof MonacoNs;

function offsetOf(lines: string[], line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  return off + (col - 1);
}

function fakeModel(initial: string) {
  let text = initial;
  return {
    getLineCount: () => text.split('\n').length,
    getValue: () => text,
    getLineMaxColumn: (ln: number) => (text.split('\n')[ln - 1]?.length ?? 0) + 1,
    pushEditOperations(_sel: unknown, edits: Array<{ range: FakeRange; text: string }>) {
      const lines = text.split('\n');
      const r = edits[0].range;
      const start = offsetOf(lines, r.startLineNumber, r.startColumn);
      const end = offsetOf(lines, r.endLineNumber, r.endColumn);
      text = text.slice(0, start) + edits[0].text + text.slice(end);
    },
    isDisposed: () => false,
  } as unknown as MonacoNs.editor.ITextModel;
}

function roundtrip(baseline: string, current: string): string {
  const changes = computeChanges(baseline, current);
  expect(changes).toHaveLength(1);
  const model = fakeModel(current);
  rollbackChange(fakeMonaco, model, changes[0]);
  return model.getValue();
}

describe('rollbackChange → restores baseline for one block', () => {
  it('added (mid / top / EOF)', () => {
    expect(roundtrip('a\nb\nc', 'a\nb\nX\nc')).toBe('a\nb\nc');
    expect(roundtrip('b\nc', 'X\nb\nc')).toBe('b\nc');
    expect(roundtrip('a\nb', 'a\nb\nC')).toBe('a\nb');
  });

  it('deleted (mid / top / EOF)', () => {
    expect(roundtrip('a\nb\nc', 'a\nc')).toBe('a\nb\nc');
    expect(roundtrip('a\nb\nc', 'b\nc')).toBe('a\nb\nc');
    expect(roundtrip('a\nb\nc\nd', 'a\nb\nc')).toBe('a\nb\nc\nd');
  });

  it('modified (mid / EOF)', () => {
    expect(roundtrip('a\nb\nc', 'a\nB\nc')).toBe('a\nb\nc');
    expect(roundtrip('a\nb\nc', 'a\nb\nC')).toBe('a\nb\nc');
  });
});
