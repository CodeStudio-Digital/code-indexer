/**
 * Smoke tests for the CandidatePipeline orchestrator.
 *
 * The goal is to lock down the execution-order invariants from
 * `candidate-pipeline/candidate_pipeline.rs:89-137`:
 *
 *   - QueryHydrators run BEFORE sources
 *   - Sources fan out in parallel
 *   - Hydrators preserve order
 *   - Filters run sequentially; kept feeds next
 *   - Scorers run sequentially; accumulate fields on candidates
 *   - Selector picks top-K
 *   - Side effects fire AFTER response is built, not blocking
 *   - `enable(query)` is honored at every stage
 */
import { describe, expect, it, vi } from 'vitest';
import { CandidatePipeline } from '../pipeline.js';
import { InMemoryTelemetrySink } from '../stats.js';
import type {
  Source,
  Filter,
  Scorer,
  Selector,
  Hydrator,
  SideEffect,
  QueryHydrator,
} from '../traits.js';
import type {
  PipelineQuery,
  PipelineCandidate,
  SelectResult,
  FilterResult,
  SideEffectInput,
  CandidateResult,
} from '../types.js';

interface TestQuery extends PipelineQuery {
  text: string;
  /** Mutable counter so QueryHydrators can demonstrate they ran. */
  hydratedCount: number;
}

interface TestCandidate extends PipelineCandidate {
  text: string;
  score: number;
  scoredBy: string[];
  hydratedBy: string[];
}

function makeQuery(text = 'q'): TestQuery {
  return { queryId: 'q1', text, hydratedCount: 0 };
}

function makeCandidate(id: string, text: string): TestCandidate {
  return { candidateId: id, text, score: 0, scoredBy: [], hydratedBy: [] };
}

// ─── Minimal selector that just sorts by score ────────────────────────────
class IdentitySelector implements Selector<TestQuery, TestCandidate> {
  readonly name = 'identity';
  enable() { return true; }
  size() { return 100; }
  score(c: TestCandidate) { return c.score; }
  select(_q: TestQuery, candidates: TestCandidate[]): SelectResult<TestCandidate> {
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    return { selected: sorted, nonSelected: [] };
  }
}

describe('CandidatePipeline', () => {
  it('runs sources in parallel and merges candidates', async () => {
    const src1: Source<TestQuery, TestCandidate> = {
      name: 's1',
      enable: () => true,
      async source() { return [makeCandidate('a', 'A'), makeCandidate('b', 'B')]; },
    };
    const src2: Source<TestQuery, TestCandidate> = {
      name: 's2',
      enable: () => true,
      async source() { return [makeCandidate('c', 'C')]; },
    };

    const sink = new InMemoryTelemetrySink();
    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_sources', telemetry: sink },
      { sources: [src1, src2], selector: new IdentitySelector() },
    );

    const result = await pipeline.execute(makeQuery());
    expect(result.selected.map((c) => c.candidateId).sort()).toEqual(['a', 'b', 'c']);
    expect(sink.events.filter((e) => e.stage === 'source')).toHaveLength(2);
  });

  it('honors enable(query) gates and reports skipped components', async () => {
    const enabled: Source<TestQuery, TestCandidate> = {
      name: 'enabled',
      enable: () => true,
      async source() { return [makeCandidate('a', 'A')]; },
    };
    const disabled: Source<TestQuery, TestCandidate> = {
      name: 'disabled',
      enable: () => false,
      async source() { throw new Error('should not run'); },
    };

    const sink = new InMemoryTelemetrySink();
    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_enable', telemetry: sink },
      { sources: [enabled, disabled], selector: new IdentitySelector() },
    );

    const result = await pipeline.execute(makeQuery());
    expect(result.selected).toHaveLength(1);
    expect(result.diag.skipped).toContain('source/disabled');
  });

  it('runs filters sequentially: kept feeds next filter', async () => {
    const order: string[] = [];
    const oddFilter: Filter<TestQuery, TestCandidate> = {
      name: 'odd',
      enable: () => true,
      filter(_q, candidates): FilterResult<TestCandidate> {
        order.push('odd');
        const kept = candidates.filter((c) => Number(c.candidateId) % 2 === 1);
        return { kept, removed: candidates.filter((c) => Number(c.candidateId) % 2 === 0) };
      },
    };
    const lessThan5: Filter<TestQuery, TestCandidate> = {
      name: 'lt5',
      enable: () => true,
      filter(_q, candidates): FilterResult<TestCandidate> {
        order.push('lt5');
        const kept = candidates.filter((c) => Number(c.candidateId) < 5);
        return { kept, removed: candidates.filter((c) => Number(c.candidateId) >= 5) };
      },
    };
    const allSource: Source<TestQuery, TestCandidate> = {
      name: 'all',
      enable: () => true,
      async source() {
        return [1, 2, 3, 4, 5, 6, 7].map((i) => makeCandidate(String(i), `c${i}`));
      },
    };

    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_filter' },
      { sources: [allSource], filters: [oddFilter, lessThan5], selector: new IdentitySelector() },
    );

    const result = await pipeline.execute(makeQuery());
    expect(order).toEqual(['odd', 'lt5']);
    // After odd: 1, 3, 5, 7. After lt5: 1, 3.
    expect(result.selected.map((c) => c.candidateId).sort()).toEqual(['1', '3']);
    expect(result.nonSelected.map((c) => c.candidateId).sort()).toEqual(['2', '4', '5', '6', '7']);
  });

  it('runs scorers sequentially accumulating fields', async () => {
    const scorerA: Scorer<TestQuery, TestCandidate> = {
      name: 'A',
      enable: () => true,
      async score(_q, candidates): Promise<Array<CandidateResult<TestCandidate>>> {
        return candidates.map((c) => ({
          ok: true,
          candidate: { ...c, score: c.score + 1, scoredBy: [...c.scoredBy, 'A'] },
        }));
      },
      update(c, scored) { c.score = scored.score; c.scoredBy = scored.scoredBy; },
    };
    const scorerB: Scorer<TestQuery, TestCandidate> = {
      name: 'B',
      enable: () => true,
      async score(_q, candidates): Promise<Array<CandidateResult<TestCandidate>>> {
        return candidates.map((c) => ({
          ok: true,
          candidate: { ...c, score: c.score + 2, scoredBy: [...c.scoredBy, 'B'] },
        }));
      },
      update(c, scored) { c.score = scored.score; c.scoredBy = scored.scoredBy; },
    };
    const src: Source<TestQuery, TestCandidate> = {
      name: 's',
      enable: () => true,
      async source() { return [makeCandidate('a', 'A'), makeCandidate('b', 'B')]; },
    };

    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_scorer' },
      { sources: [src], scorers: [scorerA, scorerB], selector: new IdentitySelector() },
    );
    const result = await pipeline.execute(makeQuery());
    expect(result.selected.every((c) => c.score === 3)).toBe(true);
    expect(result.selected.every((c) => c.scoredBy.join('-') === 'A-B')).toBe(true);
  });

  it('runs query hydrators before sources', async () => {
    const events: string[] = [];
    const qh: QueryHydrator<TestQuery> = {
      name: 'qh',
      enable: () => true,
      async hydrate() { events.push('qh'); return { hydratedCount: 1 }; },
      update(q, partial) { Object.assign(q, partial); },
    };
    const src: Source<TestQuery, TestCandidate> = {
      name: 's',
      enable: () => true,
      async source(query) { events.push(`s:${query.hydratedCount}`); return []; },
    };
    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_qh' },
      { queryHydrators: [qh], sources: [src], selector: new IdentitySelector() },
    );
    await pipeline.execute(makeQuery());
    expect(events).toEqual(['qh', 's:1']);
  });

  it('fires side effects after response is computed', async () => {
    const sideEffect = vi.fn().mockResolvedValue(undefined);
    const se: SideEffect<TestQuery, TestCandidate> = {
      name: 'log',
      enable: () => true,
      async sideEffect(input: SideEffectInput<TestQuery, TestCandidate>) {
        sideEffect(input.selectedCandidates.length);
      },
    };
    const src: Source<TestQuery, TestCandidate> = {
      name: 's',
      enable: () => true,
      async source() { return [makeCandidate('a', 'A')]; },
    };
    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_se' },
      { sources: [src], sideEffects: [se], selector: new IdentitySelector() },
    );
    const result = await pipeline.execute(makeQuery());
    // Side effect runs via setImmediate; we await one macrotask:
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.selected).toHaveLength(1);
    expect(sideEffect).toHaveBeenCalledWith(1);
  });

  it('preserves order through hydrators (invariant)', async () => {
    const order: string[] = ['z', 'a', 'm', 'c'];
    const src: Source<TestQuery, TestCandidate> = {
      name: 'src',
      enable: () => true,
      async source() { return order.map((id) => makeCandidate(id, id)); },
    };
    const hydrator: Hydrator<TestQuery, TestCandidate> = {
      name: 'h',
      enable: () => true,
      async hydrate(_q, cs): Promise<Array<CandidateResult<TestCandidate>>> {
        // Return in same order, mutated.
        return cs.map((c) => ({
          ok: true,
          candidate: { ...c, hydratedBy: [...c.hydratedBy, 'h'] },
        }));
      },
      update(c, h) { c.hydratedBy = h.hydratedBy; },
    };
    const pipeline = new CandidatePipeline<TestQuery, TestCandidate>(
      { name: 'p_order' },
      { sources: [src], hydrators: [hydrator], selector: new IdentitySelector() },
    );
    const result = await pipeline.execute(makeQuery());
    expect(result.selected.map((c) => c.candidateId)).toEqual(order);
    expect(result.selected.every((c) => c.hydratedBy.includes('h'))).toBe(true);
  });
});
