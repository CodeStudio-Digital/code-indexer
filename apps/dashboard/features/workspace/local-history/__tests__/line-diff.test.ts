import { describe, it, expect } from 'vitest';
import { lineDiff, diffStat, normalizeForDiff } from '../line-diff.js';

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

  // Causa-raiz do "arquivo inteiro alterado": snapshot CRLF vs. disco LF (Windows).
  it('treats CRLF snapshot vs LF disk as line-ending-equal (only real change shows)', () => {
    const out = lineDiff('a\r\nb\r\nc', 'a\nB\nc');
    expect(out).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('CRLF vs LF with no content change is identical', () => {
    const out = lineDiff('a\r\nb\r\nc', 'a\nb\nc');
    expect(diffStat(out)).toEqual({ added: 0, removed: 0 });
  });

  it('normalizes lone CR (classic Mac) line endings too', () => {
    const out = lineDiff('a\rb\rc', 'a\nb\nc');
    expect(diffStat(out)).toEqual({ added: 0, removed: 0 });
  });

  it('strips a leading BOM so it does not poison the first line', () => {
    const out = lineDiff('﻿x\ny', 'x\ny');
    expect(diffStat(out)).toEqual({ added: 0, removed: 0 });
  });
});

describe('normalizeForDiff', () => {
  it('unifies CRLF and lone CR to LF and strips a leading BOM', () => {
    expect(normalizeForDiff('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('only strips the BOM at the very start', () => {
    expect(normalizeForDiff('a﻿b')).toBe('a﻿b');
  });
});
