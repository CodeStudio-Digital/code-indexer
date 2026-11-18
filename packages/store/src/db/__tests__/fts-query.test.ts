/**
 * Tests for the canonical FTS5 query builder. Pure string logic — no DB, no
 * native sqlite ABI required. Pins the invariant that motivated this helper:
 * operator-significant characters (`.`, `-`, `:`) must be neutralized via
 * phrase-quoting so they never reach the FTS5 parser as syntax.
 */
import { describe, expect, it } from 'vitest';
import { boundAgentMemoryQuery, buildAgentMemoryFtsMatch, buildFtsMatch, ftsTokens } from '../fts-query.js';

describe('buildFtsMatch', () => {
  it('quotes a dotted identifier so the dot is not parsed as an operator', () => {
    // Regression: previously raised `fts5: syntax error near "."`.
    expect(buildFtsMatch('auth.api.client')).toBe('"auth.api.client"');
  });

  it('quotes every token and joins with the connector (AND default)', () => {
    expect(buildFtsMatch('AuthenticatorClient User-Token aud auth.api.client', 'AND')).toBe(
      '"AuthenticatorClient" AND "User-Token" AND "aud" AND "auth.api.client"',
    );
  });

  it('joins with OR when asked', () => {
    expect(buildFtsMatch('foo bar', 'OR')).toBe('"foo" OR "bar"');
  });

  it('drops bare boolean operators so prose cannot form an FTS expression', () => {
    expect(buildFtsMatch('cats AND dogs OR NOT birds')).toBe('"cats" AND "dogs" AND "birds"');
  });

  it('strips embedded quotes from a token', () => {
    expect(buildFtsMatch('foo"bar')).toBe('"foobar"');
  });

  it('returns empty string for empty / whitespace / pure-operator input', () => {
    expect(buildFtsMatch('')).toBe('');
    expect(buildFtsMatch('   ')).toBe('');
    expect(buildFtsMatch('AND OR NOT')).toBe('');
  });
});

describe('ftsTokens', () => {
  it('counts meaningful terms (drives the AND→OR recall fallback)', () => {
    expect(ftsTokens('one two three')).toHaveLength(3);
    expect(ftsTokens('solo')).toHaveLength(1);
    expect(ftsTokens('  ')).toHaveLength(0);
  });
});

describe('agent memory FTS query', () => {
  it('bounds a pasted specification while keeping terms from both ends', () => {
    const spec = 'desktop.engine requirements ' +
      Array.from({ length: 22_000 }, (_, index) => `section${index}`).join(' ') +
      ' renderer-validation';
    const bounded = boundAgentMemoryQuery(spec);
    expect(bounded.length).toBeLessThanOrEqual(4096);
    expect(bounded).toMatch(/^desktop\.engine requirements /);
    expect(bounded).toMatch(/ renderer-validation$/);
    const match = buildAgentMemoryFtsMatch(spec);
    expect(match.split(' OR ')).toHaveLength(24);
    expect(match).toContain('"desktop.engine"');
    expect(match).toContain('"renderer-validation"');
  });

  it('keeps quoted code identifiers and removes repeated terms case-insensitively', () => {
    expect(buildAgentMemoryFtsMatch('auth.api.client registry Registry OR ---')).toBe(
      '"auth.api.client" OR "registry"',
    );
  });
});
