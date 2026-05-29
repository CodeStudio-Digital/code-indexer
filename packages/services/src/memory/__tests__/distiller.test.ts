import { describe, it, expect } from 'vitest';
import { parseMemoryCandidates } from '../distiller.js';

describe('parseMemoryCandidates', () => {
  it('parses a valid JSON array with validated fields', () => {
    const out = parseMemoryCandidates(
      '[{"title":"Use JWT","content":"Auth via JWT","category":"decision","importance":0.8}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'Use JWT', content: 'Auth via JWT', category: 'decision', importance: 0.8 });
  });

  it('strips code fences and surrounding prose', () => {
    const out = parseMemoryCandidates(
      'Here you go:\n```json\n[{"title":"T","content":"C","category":"note","importance":0.3}]\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('T');
  });

  it('defaults unknown category to note and clamps importance', () => {
    const out = parseMemoryCandidates('[{"title":"T","content":"C","category":"bogus","importance":5}]');
    expect(out[0].category).toBe('note');
    expect(out[0].importance).toBe(1);
  });

  it('drops entries missing title or content', () => {
    const out = parseMemoryCandidates(
      '[{"title":"","content":"C","category":"note"},{"title":"T","content":"C2","category":"note"}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('C2');
  });

  it('returns [] for non-array, garbage, or empty input', () => {
    expect(parseMemoryCandidates('not json at all')).toEqual([]);
    expect(parseMemoryCandidates('{"title":"x"}')).toEqual([]);
    expect(parseMemoryCandidates('')).toEqual([]);
  });

  it('keeps only string entries in referencedFiles', () => {
    const out = parseMemoryCandidates(
      '[{"title":"T","content":"C","category":"note","importance":0.5,"referencedFiles":["a.ts",1,"b.ts"]}]',
    );
    expect(out[0].referencedFiles).toEqual(['a.ts', 'b.ts']);
  });
});
