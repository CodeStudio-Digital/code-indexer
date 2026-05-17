import { describe, it, expect } from 'vitest';
import { compareSemver } from '@mcp/indexer/bootstrap/semver-compare.js';

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('2.5.7', '2.5.7')).toBe(0);
  });

  it('returns positive when a > b at major', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('returns negative when a < b at minor', () => {
    expect(compareSemver('1.2.5', '1.3.0')).toBeLessThan(0);
  });

  it('returns positive when a > b at patch', () => {
    expect(compareSemver('1.0.10', '1.0.9')).toBeGreaterThan(0);
  });

  it('treats missing components as 0', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.1', '1.0.99')).toBeGreaterThan(0);
  });

  it('treats unparseable input as 0.0.0', () => {
    expect(compareSemver('garbage', 'garbage')).toBe(0);
    expect(compareSemver('garbage', '0.0.1')).toBeLessThan(0);
    expect(compareSemver('0.0.1', 'garbage')).toBeGreaterThan(0);
  });

  it('ignores trailing whitespace', () => {
    expect(compareSemver(' 1.0.0 ', '1.0.0')).toBe(0);
  });
});
