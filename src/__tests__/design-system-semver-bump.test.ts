import { describe, it, expect } from 'vitest';
import { bumpSemver, formatSemver, parseSemver, resolveBumpKind } from '../core/design-system/semver-bump.js';

describe('semver-bump (design-system)', () => {
  describe('parseSemver', () => {
    it('parses M.m.p triples', () => {
      expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
      expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    });

    it('throws on non-strict input', () => {
      expect(() => parseSemver('1.2')).toThrow();
      expect(() => parseSemver('1.2.3-rc.1')).toThrow();
      expect(() => parseSemver('v1.2.3')).toThrow();
      expect(() => parseSemver('garbage')).toThrow();
    });
  });

  describe('formatSemver', () => {
    it('formats triples as strings', () => {
      expect(formatSemver({ major: 1, minor: 2, patch: 3 })).toBe('1.2.3');
    });
  });

  describe('bumpSemver', () => {
    it('returns 1.0.0 when there is no previous version', () => {
      expect(bumpSemver(null, 'patch')).toBe('1.0.0');
      expect(bumpSemver(null, 'minor')).toBe('1.0.0');
      expect(bumpSemver(null, 'major')).toBe('1.0.0');
      expect(bumpSemver(null, 'initial')).toBe('1.0.0');
    });

    it('bumps patch correctly', () => {
      expect(bumpSemver('1.0.0', 'patch')).toBe('1.0.1');
      expect(bumpSemver('1.2.3', 'patch')).toBe('1.2.4');
    });

    it('bumps minor correctly and resets patch', () => {
      expect(bumpSemver('1.0.5', 'minor')).toBe('1.1.0');
      expect(bumpSemver('2.7.99', 'minor')).toBe('2.8.0');
    });

    it('bumps major correctly and resets minor + patch', () => {
      expect(bumpSemver('1.5.9', 'major')).toBe('2.0.0');
      expect(bumpSemver('5.0.0', 'major')).toBe('6.0.0');
    });

    it('returns 1.0.0 for "initial" regardless of previous', () => {
      expect(bumpSemver('1.5.9', 'initial')).toBe('1.0.0');
    });
  });

  describe('resolveBumpKind', () => {
    it('returns "initial" when there is no previous version', () => {
      expect(resolveBumpKind({ previous: null, hint: 'patch' })).toBe('initial');
      expect(resolveBumpKind({ previous: null, hint: 'major' })).toBe('initial');
    });

    it('respects the hint when there is a previous version', () => {
      expect(resolveBumpKind({ previous: '1.0.0', hint: 'patch' })).toBe('patch');
      expect(resolveBumpKind({ previous: '1.0.0', hint: 'minor' })).toBe('minor');
      expect(resolveBumpKind({ previous: '1.0.0', hint: 'major' })).toBe('major');
    });
  });
});
