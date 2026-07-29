/**
 * These numbers arrive from the renderer over IPC and are handed straight to a
 * driver, inside the Electron MAIN process. An unbounded row cap there is not a
 * slow query — it takes down the app with every connection pool, SSH tunnel and
 * unsaved buffer in it. Pin the clamps.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_LIMIT,
  MAX_RESULT_ROWS,
  clampMaxRows,
  clampOffset,
  clampPageLimit,
} from '../limits.js';

describe('clampMaxRows', () => {
  it('leaves an omitted cap to the driver default', () => {
    expect(clampMaxRows(undefined)).toBeUndefined();
    expect(clampMaxRows(null)).toBeUndefined();
  });

  it('passes a sane request through untouched', () => {
    expect(clampMaxRows(500)).toBe(500);
    expect(clampMaxRows(MAX_RESULT_ROWS)).toBe(MAX_RESULT_ROWS);
  });

  it('caps an absurd request instead of trusting it', () => {
    expect(clampMaxRows(1e9)).toBe(MAX_RESULT_ROWS);
    expect(clampMaxRows(Number.MAX_SAFE_INTEGER)).toBe(MAX_RESULT_ROWS);
  });

  it('never resolves garbage to "unbounded"', () => {
    expect(clampMaxRows(0)).toBe(1);
    expect(clampMaxRows(-5)).toBe(1);
    expect(clampMaxRows(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampMaxRows(Number.NaN)).toBe(1);
    expect(clampMaxRows('nonsense')).toBe(1);
  });

  it('floors a fractional cap', () => {
    expect(clampMaxRows(10.9)).toBe(10);
  });
});

describe('clampPageLimit / clampOffset', () => {
  it('defaults a missing or unusable page size', () => {
    expect(clampPageLimit(undefined)).toBe(100);
    expect(clampPageLimit('abc')).toBe(100);
  });

  it('bounds the page size on both ends', () => {
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(-10)).toBe(1);
    expect(clampPageLimit(1e9)).toBe(MAX_PAGE_LIMIT);
    expect(clampPageLimit(200)).toBe(200);
  });

  it('refuses a negative or unsafe offset', () => {
    expect(clampOffset(-1)).toBe(0);
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(1e21)).toBe(0);
    expect(clampOffset(4_000)).toBe(4_000);
  });
});
