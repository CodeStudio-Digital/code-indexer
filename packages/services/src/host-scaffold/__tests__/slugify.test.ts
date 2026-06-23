import { describe, it, expect } from 'vitest';
import { slugify } from '../slugify.js';

describe('slugify', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips diacritics mid-word', () => {
    expect(slugify('naïve café')).toBe('naive-cafe');
  });

  it('collapses runs of separators and trims', () => {
    expect(slugify('  __My  Cool__Project!!  ')).toBe('my-cool-project');
  });

  it('falls back to "project" when empty after cleaning', () => {
    expect(slugify('!!!')).toBe('project');
    expect(slugify('')).toBe('project');
  });

  it('suffixes Windows reserved device names', () => {
    expect(slugify('CON')).toBe('con-app');
    expect(slugify('com1')).toBe('com1-app');
    expect(slugify('lpt9')).toBe('lpt9-app');
  });

  it('caps length and never leaves a trailing dash', () => {
    const out = slugify('a'.repeat(80));
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('-')).toBe(false);
  });
});
