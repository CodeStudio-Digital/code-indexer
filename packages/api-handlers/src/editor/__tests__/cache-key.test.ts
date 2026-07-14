import { describe, expect, it } from 'vitest';
import { completionResultCacheKey, type CompletionCacheKeyInput } from '../completion/cache-key.js';

const base: CompletionCacheKeyInput = {
  bindingRevision: 'binding-a', projectId: 1, file: 'a.ts', language: 'typescript',
  cursorLine: 10, documentVersion: 2, contextRevision: 3, contextEngine: 'v3', windowHash: 'abc',
};

describe('completion result cache key', () => {
  it.each([
    ['bindingRevision', 'binding-b'], ['documentVersion', 4], ['contextRevision', 5],
    ['contextEngine', 'v2'], ['windowHash', 'xyz'],
  ] as const)('invalidates on %s changes', (field, value) => {
    expect(completionResultCacheKey({ ...base, [field]: value })).not.toBe(completionResultCacheKey(base));
  });
});
