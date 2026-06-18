import { describe, it, expect } from 'vitest';
import { lineDiff, diffStat } from '../line-diff.js';

describe('lineDiff', () => {
  it('marks added, removed and context lines', () => {
    const out = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(out).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('handles pure insertion at the end', () => {
    const out = lineDiff('a', 'a\nb');
    expect(diffStat(out)).toEqual({ added: 1, removed: 0 });
  });

  it('handles full deletion (restore-to-empty)', () => {
    const out = lineDiff('a\nb', '');
    // '' split → [''], so one trailing empty add line is expected.
    expect(diffStat(out).removed).toBe(2);
  });

  it('identical content is all context', () => {
    const out = lineDiff('x\ny', 'x\ny');
    expect(diffStat(out)).toEqual({ added: 0, removed: 0 });
  });
});
