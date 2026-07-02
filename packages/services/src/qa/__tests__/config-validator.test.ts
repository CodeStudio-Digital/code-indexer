import { describe, it, expect } from 'vitest';
import { validateQaRunConfig } from '../config-validator.js';

/** Minimal config satisfying the three contract checks. */
const GOOD_CONFIG = `
import { defineConfig } from '@playwright/test';
const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;
export default defineConfig({
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['./tests/e2e/reporter.ts'],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    connectOptions: wsEndpoint ? { wsEndpoint } : undefined,
  },
});
`;

describe('validateQaRunConfig — happy path', () => {
  it('accepts the scaffolded template shape', () => {
    const v = validateQaRunConfig(GOOD_CONFIG);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.suggestion).toBeUndefined();
  });

  it('accepts inline connectOptions without an intermediate const', () => {
    const inline = GOOD_CONFIG.replace(
      'const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;',
      '',
    ).replace(
      'connectOptions: wsEndpoint ? { wsEndpoint } : undefined,',
      'connectOptions: { wsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT! },',
    );
    expect(validateQaRunConfig(inline).ok).toBe(true);
  });
});

describe('validateQaRunConfig — problems', () => {
  it('flags a removed wsEndpoint wiring (local browser launch)', () => {
    const bad = GOOD_CONFIG
      .replace('const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;', '')
      .replace('connectOptions: wsEndpoint ? { wsEndpoint } : undefined,', '');
    const v = validateQaRunConfig(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes('PLAYWRIGHT_WS_ENDPOINT'))).toBe(true);
    expect(v.suggestion).toContain('Restore QA config');
  });

  it('flags a removed streaming reporter', () => {
    const bad = GOOD_CONFIG.replace(`['./tests/e2e/reporter.ts'],`, '');
    const v = validateQaRunConfig(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes('reporter'))).toBe(true);
  });

  it('flags a hardcoded baseURL', () => {
    const bad = GOOD_CONFIG.replace(
      "baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',",
      "baseURL: 'http://localhost:5173',",
    );
    const v = validateQaRunConfig(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes('PLAYWRIGHT_BASE_URL'))).toBe(true);
  });

  it('accumulates every problem on an empty file', () => {
    const v = validateQaRunConfig('');
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(3);
  });
});
