import { describe, it, expect } from 'vitest';
import { ProcedureDistiller } from '../procedure-distiller.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';

// A resolver that fails the test if the LLM path is ever reached — proves the
// cheap guards short-circuit before any binding resolution.
const throwingResolver = {
  resolveOrNull: async () => {
    throw new Error('resolver must not be called');
  },
} as unknown as PipelineProviderResolver;

describe('ProcedureDistiller', () => {
  it('returns [] without touching the resolver when there is no command trail', async () => {
    const d = new ProcedureDistiller({ resolver: throwingResolver });
    expect(await d.distill({ toolTrail: [] })).toEqual([]);
    expect(await d.distill({ toolTrail: ['   '] })).toEqual([]); // whitespace-only filtered out
    expect(await d.distill({})).toEqual([]);
  });

  it('returns [] when skipLlm is set', async () => {
    const d = new ProcedureDistiller({ resolver: throwingResolver, skipLlm: true });
    expect(await d.distill({ toolTrail: ['pnpm test'] })).toEqual([]);
  });
});
