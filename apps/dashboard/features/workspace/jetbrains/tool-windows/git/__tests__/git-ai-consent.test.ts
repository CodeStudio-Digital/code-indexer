import { describe, expect, it } from 'vitest';
import { readGitAiDiffConsent, writeGitAiDiffConsent } from '../git-ai-consent.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('Git AI diff consent', () => {
  it('defaults to denied and persists both choices', () => {
    const storage = memoryStorage();
    expect(readGitAiDiffConsent(storage)).toBe(false);

    writeGitAiDiffConsent(true, storage);
    expect(readGitAiDiffConsent(storage)).toBe(true);

    writeGitAiDiffConsent(false, storage);
    expect(readGitAiDiffConsent(storage)).toBe(false);
  });

  it('fails closed when storage is unavailable', () => {
    const broken = {
      getItem: () => { throw new Error('disabled'); },
      setItem: () => { throw new Error('disabled'); },
    };
    expect(readGitAiDiffConsent(broken)).toBe(false);
    expect(() => writeGitAiDiffConsent(true, broken)).not.toThrow();
  });
});
