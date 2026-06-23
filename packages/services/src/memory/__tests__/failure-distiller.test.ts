import { describe, it, expect } from 'vitest';
import { FailureDistiller } from '../failure-distiller.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';

// A resolver that fails the test if the LLM path is ever reached — proves the
// cheap guards short-circuit before any binding resolution.
const throwingResolver = {
  resolveOrNull: async () => {
    throw new Error('resolver must not be called');
  },
} as unknown as PipelineProviderResolver;

describe('FailureDistiller', () => {
  it('returns [] without touching the resolver when there are no errors', async () => {
    const d = new FailureDistiller({ resolver: throwingResolver });
    expect(await d.distill({ errorsAndFixes: [] })).toEqual([]);
    expect(await d.distill({ errorsAndFixes: ['   '] })).toEqual([]); // whitespace-only filtered out
    expect(await d.distill({})).toEqual([]);
  });

  it('returns [] when skipLlm is set', async () => {
    const d = new FailureDistiller({ resolver: throwingResolver, skipLlm: true });
    expect(await d.distill({ errorsAndFixes: ['boom -> fixed by X'] })).toEqual([]);
  });
});
