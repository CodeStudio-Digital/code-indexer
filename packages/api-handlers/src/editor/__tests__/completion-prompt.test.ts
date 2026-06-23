import { describe, expect, it } from 'vitest';
import { postProcessCompletion, stopSequencesFor, trimWindows } from '../completion-prompt.js';

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

describe('postProcessCompletion', () => {
  it('strips a wrapping markdown fence', () => {
    const raw = '```ts\nconst x = 1;\n```';
    expect(postProcessCompletion(raw, 'let y;\n', '', true)).toBe('const x = 1;');
  });

  it('cuts the echoed prefix tail', () => {
    // Model re-typed "const total = " before adding the new code.
    const raw = 'const total = items.reduce((a, b) => a + b, 0);';
    const out = postProcessCompletion(raw, 'function sum(items) {\n  const total = ', '', true);
    expect(out).toBe('items.reduce((a, b) => a + b, 0);');
  });

  it('does not cut overlaps shorter than 3 chars (legit repeats)', () => {
    const out = postProcessCompletion('aa + bb', 'x = a', '', true);
    expect(out).toBe('aa + bb'); // 'a' overlap (len 1/2) must survive
  });

  it('drops the re-typed suffix head (closing brackets already in buffer)', () => {
    const out = postProcessCompletion('return a + b;\n}', 'function f() {\n  ', '\n}', true);
    expect(out).toBe('return a + b;');
  });

  it('keeps only the first line in single-line mode', () => {
    const out = postProcessCompletion('one();\ntwo();\nthree();', 'x', '', false);
    expect(out).toBe('one();');
  });

  it('removes stray <CURSOR> markers and returns "" when nothing remains', () => {
    expect(postProcessCompletion('<CURSOR>', 'p', 's', true)).toBe('');
    expect(postProcessCompletion('   \n\n', 'p', 's', true)).toBe('');
  });

  it('strips inline <think> reasoning and keeps the code after it', () => {
    const raw = '<think>user wants the class list…</think>SwaggerCommand::class,';
    expect(postProcessCompletion(raw, 'return [\n  ', '', true)).toBe('SwaggerCommand::class,');
  });

  it('returns "" when the token budget died mid-reasoning (unterminated think)', () => {
    expect(postProcessCompletion('<think>still reasoning about', 'p', 's', true)).toBe('');
  });

  it('keeps code but drops a trailing fence + prose', () => {
    const raw = 'return $x;\n```\nThis completes the method.';
    expect(postProcessCompletion(raw, 'function f() {\n  ', '', true)).toBe('return $x;');
  });
});

describe('stopSequencesFor', () => {
  it('never stops at fences (fence-opening models were cut at char 0)', () => {
    expect(stopSequencesFor(true)).toEqual([]);
    expect(stopSequencesFor(false)).toEqual(['\n']);
  });
});
