import { describe, expect, it } from 'vitest';
import { parseDsConsumer, parseDsWorkspace } from '../builder-config.js';

const CONSUMER = JSON.stringify({
  stack: 'react-ts',
  port: 5181,
  designSystem: { sessionId: 3, packageName: '@acme/ui', semver: '1.2.0', linkedAt: 'x' },
});

describe('parseDsConsumer', () => {
  it('parses a valid consumer link', () => {
    expect(parseDsConsumer(CONSUMER)).toEqual({
      sessionId: 3,
      packageName: '@acme/ui',
      semver: '1.2.0',
    });
  });

  it('returns null for null/empty/malformed json', () => {
    expect(parseDsConsumer(null)).toBeNull();
    expect(parseDsConsumer(undefined)).toBeNull();
    expect(parseDsConsumer('')).toBeNull();
    expect(parseDsConsumer('{not json')).toBeNull();
  });

  it('returns null when designSystem is absent (plain builder project)', () => {
    expect(parseDsConsumer(JSON.stringify({ stack: 'react-ts', port: 5181 }))).toBeNull();
  });

  it('returns null on a DS Studio workspace even if designSystem is present', () => {
    const workspace = JSON.stringify({
      stack: 'react-ts',
      kind: 'ds',
      packageName: '@acme/ds',
      designSystem: { sessionId: 1, packageName: '@acme/ui', semver: '1.0.0' },
    });
    expect(parseDsConsumer(workspace)).toBeNull();
  });

  it.each([
    ['missing sessionId', { packageName: '@acme/ui', semver: '1.0.0' }],
    ['non-integer sessionId', { sessionId: 1.5, packageName: '@acme/ui', semver: '1.0.0' }],
    ['zero sessionId', { sessionId: 0, packageName: '@acme/ui', semver: '1.0.0' }],
    ['missing packageName', { sessionId: 1, semver: '1.0.0' }],
    ['empty packageName', { sessionId: 1, packageName: '', semver: '1.0.0' }],
    ['missing semver', { sessionId: 1, packageName: '@acme/ui' }],
    ['non-string semver', { sessionId: 1, packageName: '@acme/ui', semver: 2 }],
  ])('returns null on invalid designSystem: %s', (_label, ds) => {
    expect(parseDsConsumer(JSON.stringify({ stack: 'react-ts', designSystem: ds }))).toBeNull();
  });

  it('returns null when designSystem is not an object', () => {
    expect(parseDsConsumer(JSON.stringify({ designSystem: '@acme/ui' }))).toBeNull();
  });
});

describe('parseDsWorkspace (regression)', () => {
  it('still parses a workspace and ignores consumer-only json', () => {
    expect(
      parseDsWorkspace(JSON.stringify({ stack: 'vue-ts', port: 5182, kind: 'ds', packageName: '@a/b' })),
    ).toEqual({ stack: 'vue-ts', port: 5182, packageName: '@a/b' });
    expect(parseDsWorkspace(CONSUMER)).toBeNull();
  });
});
