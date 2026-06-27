import { describe, expect, it, vi, afterEach } from 'vitest';
import { nativeFetch } from '../native-fetch.js';

describe('nativeFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the platform fetch when one exists', () => {
    expect(nativeFetch()).toBe(globalThis.fetch);
  });

  it('returns undefined when no global fetch exists (SDK falls back to node-fetch)', () => {
    vi.stubGlobal('fetch', undefined);
    expect(nativeFetch()).toBeUndefined();
  });

  it('returns undefined when global fetch is not callable', () => {
    vi.stubGlobal('fetch', {} as unknown);
    expect(nativeFetch()).toBeUndefined();
  });
});
