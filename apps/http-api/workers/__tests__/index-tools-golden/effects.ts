import { expect } from 'vitest';
import type { ParityCase } from './compare.js';
import type { ParityFixture } from './fixture.js';

/**
 * The calls each read case makes to the fakes (semantic owner, namespace
 * wake). Until E5 the suite compared them with the bridge's calls; since E6
 * they are written out here. A case not listed makes none. A read case runs
 * twice (determinism check), so its calls appear twice.
 */
interface FakeEffects { semantic: unknown[]; wake: string[] }

/** search: mode auto, type all and limit 20 unless the case says otherwise (tools/search.ts). */
const search = (fx: ParityFixture, query: string, extra: Record<string, unknown> = {}) =>
  ({ projectId: fx.main.id, query, mode: 'auto', type: 'all', limit: 20, sessionId: 's-parity', ...extra });
/** search_memory: five results by default (tools/search-memory.ts). */
const memory = (fx: ParityFixture, query: string) => ({ projectId: fx.main.id, query, limit: 5, memory: true });
/** semantic_neighbors of `target`: hybrid symbols, limit 10 + 2, query built from the seed (tools/semantic-neighbors.ts). */
const neighbors = (fx: ParityFixture) => ({ projectId: fx.main.id, mode: 'hybrid', type: 'symbols', limit: 12, sessionId: 's-parity',
  query: expect.stringMatching(/^File: src\/target\.ts\nfunction target\ntarget\(\)/) });

const CALLS: Record<string, (fx: ParityFixture) => Partial<FakeEffects>> = {
  S1: fx => ({ semantic: [search(fx, 'widget shape')] }),
  S3: fx => ({ semantic: [search(fx, 'offline')] }),
  S6: fx => ({ semantic: [search(fx, 'hang')] }),
  S7: fx => ({ semantic: [search(fx, 'widget shape', { type: 'symbols', limit: 1 })] }),
  'S-company': fx => ({ semantic: [search(fx, 'widget shape', { companySessionId: 'c-parity' })] }),
  N1: fx => ({ semantic: [neighbors(fx)] }),
  N2: fx => ({ semantic: [neighbors(fx)] }),
  N3: fx => ({ semantic: [neighbors(fx)] }),
  SM1: fx => ({ semantic: [memory(fx, 'decision')] }),
  SM2: fx => ({ semantic: [memory(fx, 'offline')] }),
};

/** Ids of the cases above, to check that each names a real case. */
export const CASES_WITH_CALLS = Object.keys(CALLS);

export function expectedEffects(c: ParityCase, fx: ParityFixture): FakeEffects {
  const once = CALLS[c.id]?.(fx) ?? {};
  const runs = c.once ? 1 : 2;
  const repeat = <T>(list: T[] = []) => Array.from({ length: runs }, () => list).flat();
  return { semantic: repeat(once.semantic), wake: repeat(once.wake) };
}
