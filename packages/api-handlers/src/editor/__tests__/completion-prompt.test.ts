import { describe, expect, it } from 'vitest';
import { stopSequencesFor, trimWindows } from '../completion-prompt.js';

describe('trimWindows', () => {
  it('clamps prefix to the last N lines and suffix to the first N', () => {
    const prefix = Array.from({ length: 100 }, (_, i) => `p${i}`).join('\n');
    const suffix = Array.from({ length: 50 }, (_, i) => `s${i}`).join('\n');
    const w = trimWindows(prefix, suffix, 10, 5);
    expect(w.prefix.split('\n')).toEqual(['p90', 'p91', 'p92', 'p93', 'p94', 'p95', 'p96', 'p97', 'p98', 'p99']);
    expect(w.suffix.split('\n')).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('keeps short windows untouched', () => {
    const w = trimWindows('a\nb', 'c', 80, 30);
    expect(w).toEqual({ prefix: 'a\nb', suffix: 'c' });
  });
});

// postProcess cases migrated verbatim to __tests__/postprocess-v2.test.ts
// (the pipeline moved to completion/postprocess.ts).

describe('stopSequencesFor', () => {
  it('never stops at fences (fence-opening models were cut at char 0)', () => {
    expect(stopSequencesFor(true)).toEqual([]);
    expect(stopSequencesFor(false)).toEqual(['\n']);
  });
});
