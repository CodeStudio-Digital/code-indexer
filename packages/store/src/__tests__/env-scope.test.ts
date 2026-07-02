/**
 * Pure CSV-scope helpers (D1, migration 192) — no DB, plain-node vitest.
 *
 * Pin invariants:
 *   - NULL/empty scope means "all services" (pre-192 behavior).
 *   - Matching is case-insensitive and whitespace-tolerant (ids double
 *     as docker hostnames, but tools/operators may type 'MAIN').
 *   - normalizeServiceScope collapses "nothing left" to NULL so the DB
 *     never stores an empty-string scope that would mean "no service".
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeServiceScope,
  parseServiceScope,
  scopeIncludesService,
} from '../env-scope.js';

describe('parseServiceScope', () => {
  it('treats null/undefined/empty/whitespace as "all services" ([])', () => {
    expect(parseServiceScope(null)).toEqual([]);
    expect(parseServiceScope(undefined)).toEqual([]);
    expect(parseServiceScope('')).toEqual([]);
    expect(parseServiceScope('   ')).toEqual([]);
    expect(parseServiceScope(' , ,, ')).toEqual([]);
  });

  it('splits CSV, trims, lowercases, drops empties', () => {
    expect(parseServiceScope('api')).toEqual(['api']);
    expect(parseServiceScope(' Main , API ,, web ')).toEqual(['main', 'api', 'web']);
  });
});

describe('scopeIncludesService', () => {
  it('NULL scope → every service qualifies', () => {
    expect(scopeIncludesService(null, 'main')).toBe(true);
    expect(scopeIncludesService(undefined, 'api')).toBe(true);
    expect(scopeIncludesService('', 'anything')).toBe(true);
  });

  it('single id → only that service', () => {
    expect(scopeIncludesService('api', 'api')).toBe(true);
    expect(scopeIncludesService('api', 'main')).toBe(false);
    expect(scopeIncludesService('api', 'web')).toBe(false);
  });

  it('CSV → members in, others out; case/space-insensitive', () => {
    expect(scopeIncludesService('main,api', 'main')).toBe(true);
    expect(scopeIncludesService('main,api', 'api')).toBe(true);
    expect(scopeIncludesService('main,api', 'web')).toBe(false);
    expect(scopeIncludesService('Main, API', ' MAIN ')).toBe(true);
  });
});

describe('normalizeServiceScope', () => {
  it('empty-ish input collapses to null (all services)', () => {
    expect(normalizeServiceScope(null)).toBeNull();
    expect(normalizeServiceScope(undefined)).toBeNull();
    expect(normalizeServiceScope('  ')).toBeNull();
    expect(normalizeServiceScope(',,  ,')).toBeNull();
  });

  it('canonicalizes ids: trimmed + lowercased CSV', () => {
    expect(normalizeServiceScope(' API , Main ')).toBe('api,main');
    expect(normalizeServiceScope('a,,b')).toBe('a,b');
  });
});
