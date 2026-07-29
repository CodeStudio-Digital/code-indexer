/**
 * ShadowTrafficRunner tests.
 *
 * Invariants verified:
 *   - sampleRate=0 → no variants run
 *   - sampleRate=1 → every query runs all enabled variants
 *   - sampling is deterministic per queryHash
 *   - variants run AFTER the response is built (scheduler is invoked)
 *   - one failing variant doesn't stop the others
 *   - rows land in counterfactual_logs with the right shape
 *   - PipelineShadowVariant adapter snapshots selected candidateIds
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';
import {
  PipelineShadowVariant,
  ShadowTrafficRunner,
  type ShadowVariant,
} from '../index.js';
import {
  CandidatePipeline,
  InMemoryTelemetrySink,
  type PipelineCandidate,
  type PipelineQuery,
  type Selector,
  type Source,
} from '@mcp/candidate-pipeline';

interface DbHandle {
  db: CodeIndexDB;
  store: CounterfactualLogStore;
  dir: string;
}

function setupDb(): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-shadow-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new CounterfactualLogStore(db.raw()), dir };
}

function teardown(handle: DbHandle): void {
  try { handle.db.close(); } catch { /* */ }
  try { rmSync(handle.dir, { recursive: true, force: true }); } catch { /* */ }
}

/** Synchronous scheduler — tests want to await side effects. */
const inlineScheduler = (fn: () => void) => fn();

describe('ShadowTrafficRunner', () => {
  let handle: DbHandle;
  beforeEach(() => { handle = setupDb(); });
  afterEach(() => teardown(handle));

  function makeStubVariant(name: string, output: unknown, opts: { enabled?: boolean; fail?: boolean } = {}): ShadowVariant<{ id: string }> {
    return {
      name,
      enable: () => opts.enabled !== false,
      async run() {
        if (opts.fail) throw new Error(`${name} boom`);
        return output;
      },
    };
  }

  it('returns false and writes nothing when sampleRate=0', async () => {
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [makeStubVariant('v1', { picked: 'a' })],
      store: handle.store,
      sampleRate: 0,
      scheduler: inlineScheduler,
    });
    const sampled = runner.recordAndShadow(
      { queryHash: 'q', payload: { id: '1' } },
      { picked: 'prod' },
    );
    expect(sampled).toBe(false);
    const rows = handle.store.list();
    expect(rows).toHaveLength(0);
  });

  it('runs every variant when sampleRate=1', async () => {
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [
        makeStubVariant('a', { x: 1 }),
        makeStubVariant('b', { x: 2 }),
      ],
      store: handle.store,
      sampleRate: 1,
      scheduler: inlineScheduler,
    });
    await runner.runVariants(
      { queryHash: 'q1', payload: { id: 'q1' } },
      { picked: 'prod' },
    );
    const rows = handle.store.list();
    expect(rows).toHaveLength(2);
    const variantNames = rows.map((r) => r.shadow_variant).sort();
    expect(variantNames).toEqual(['a', 'b']);
    expect(rows[0].pipeline_name).toBe('tool_selection');
  });

  it('routes session observations to telemetry without creating a global SQLite row', async () => {
    const telemetry = new InMemoryTelemetrySink();
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [makeStubVariant('a', { picked: ['x', 'y'] })],
      store: handle.store,
      telemetry,
      sampleRate: 1,
      scheduler: inlineScheduler,
    });
    await runner.runVariants(
      {
        queryHash: 'q',
        payload: { id: '1' },
        sessionId: '018f0f5e-7b2d-7a45-8c11-0123456789ab',
      },
      { picked: ['prod'] },
    );
    expect(handle.store.list()).toHaveLength(0);
    expect(telemetry.events).toEqual([
      expect.objectContaining({
        component: 'shadow/a',
        sessionId: '018f0f5e-7b2d-7a45-8c11-0123456789ab',
      }),
    ]);
  });

  it('one variant failing does not stop the others', async () => {
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [
        makeStubVariant('flaky', null, { fail: true }),
        makeStubVariant('healthy', { ok: true }),
      ],
      store: handle.store,
      sampleRate: 1,
      scheduler: inlineScheduler,
    });
    const results = await runner.runVariants(
      { queryHash: 'q', payload: { id: '1' } },
      { picked: 'prod' },
    );
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.variantName === 'flaky')?.error).toContain('boom');
    expect(results.find((r) => r.variantName === 'healthy')?.error).toBeUndefined();
    const rows = handle.store.list();
    expect(rows).toHaveLength(2);
  });

  it('skips variants whose enable() returns false', async () => {
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [
        makeStubVariant('off', { x: 1 }, { enabled: false }),
        makeStubVariant('on', { x: 2 }),
      ],
      store: handle.store,
      sampleRate: 1,
      scheduler: inlineScheduler,
    });
    await runner.runVariants(
      { queryHash: 'q', payload: { id: '1' } },
      'prod',
    );
    const rows = handle.store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].shadow_variant).toBe('on');
  });

  it('sampling is deterministic per queryHash', () => {
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [makeStubVariant('v', {})],
      store: handle.store,
      sampleRate: 0.5,
      scheduler: () => {}, // suppress execution; we only test the sampling decision
    });
    const a1 = runner.recordAndShadow({ queryHash: 'aaa', payload: {} }, 'p');
    const a2 = runner.recordAndShadow({ queryHash: 'aaa', payload: {} }, 'p');
    const a3 = runner.recordAndShadow({ queryHash: 'aaa', payload: {} }, 'p');
    expect(a1).toBe(a2);
    expect(a2).toBe(a3);
    const b1 = runner.recordAndShadow({ queryHash: 'zzz_different', payload: {} }, 'p');
    const b2 = runner.recordAndShadow({ queryHash: 'zzz_different', payload: {} }, 'p');
    expect(b1).toBe(b2);
  });

  it('scheduler is consulted (variants run off-path)', async () => {
    const scheduler = vi.fn((fn: () => void) => fn());
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [makeStubVariant('v', { ok: true })],
      store: handle.store,
      sampleRate: 1,
      scheduler,
    });
    runner.recordAndShadow({ queryHash: 'q', payload: {} }, 'prod');
    expect(scheduler).toHaveBeenCalledTimes(1);
  });

  it('stats() reports counters and reset works', async () => {
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [makeStubVariant('v', { ok: true })],
      store: handle.store,
      sampleRate: 1,
      scheduler: inlineScheduler,
    });
    await runner.runVariants({ queryHash: 'q', payload: {} }, 'prod');
    await runner.runVariants({ queryHash: 'q2', payload: {} }, 'prod');
    expect(runner.stats().runsTotal).toBe(2);
    expect(runner.stats().runsLastFlush).toBe(2);
    runner.flushCounters();
    expect(runner.stats().runsLastFlush).toBe(0);
    expect(runner.stats().runsTotal).toBe(2); // cumulative survives
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PipelineShadowVariant adapter — proves the high-level wiring works.
// ─────────────────────────────────────────────────────────────────────────

interface TQ extends PipelineQuery { topK: number }
interface TC extends PipelineCandidate { name: string; score: number }

function makeMiniPipeline(k: number): CandidatePipeline<TQ, TC> {
  const sources: Source<TQ, TC>[] = [{
    name: 'fake',
    enable: () => true,
    async source() {
      return [
        { candidateId: 'a', name: 'a', score: 1 },
        { candidateId: 'b', name: 'b', score: 2 },
        { candidateId: 'c', name: 'c', score: 3 },
      ];
    },
  }];
  const selector: Selector<TQ, TC> = {
    name: 'top_k_selector',
    enable: () => true,
    size: () => k,
    score: (c) => c.score,
    select: (_q, candidates) => {
      const sorted = [...candidates].sort((a, b) => b.score - a.score);
      return { selected: sorted.slice(0, k), nonSelected: sorted.slice(k) };
    },
  };
  return new CandidatePipeline<TQ, TC>({ name: 'mini' }, { sources, selector });
}

describe('PipelineShadowVariant', () => {
  it('default summarize returns selected candidateIds', async () => {
    const variant = new PipelineShadowVariant<TQ, TC>({
      name: 'k_1',
      pipeline: makeMiniPipeline(1),
    });
    const result = await variant.run({ queryId: 'q', topK: 1 });
    expect(result).toEqual({ selectedIds: ['c'] });
  });

  it('custom summarize is applied', async () => {
    const variant = new PipelineShadowVariant<TQ, TC>({
      name: 'k_2_named',
      pipeline: makeMiniPipeline(2),
      summarize: (r) => ({ names: r.selected.map((c) => c.name) }),
    });
    const result = await variant.run({ queryId: 'q', topK: 2 });
    expect(result).toEqual({ names: ['c', 'b'] });
  });

  it('integrates with ShadowTrafficRunner end-to-end', async () => {
    let handle: DbHandle | null = null;
    try {
      handle = setupDb();
      const runner = new ShadowTrafficRunner<TQ>({
        pipelineName: 'mini',
        variants: [
          new PipelineShadowVariant<TQ, TC>({ name: 'k_1', pipeline: makeMiniPipeline(1) }),
          new PipelineShadowVariant<TQ, TC>({ name: 'k_2', pipeline: makeMiniPipeline(2) }),
        ],
        store: handle.store,
        sampleRate: 1,
        scheduler: inlineScheduler,
      });
      await runner.runVariants(
        { queryHash: 'q', payload: { queryId: 'q', topK: 3 } },
        { selectedIds: ['a', 'b', 'c'] },
      );
      const rows = handle.store.list();
      expect(rows).toHaveLength(2);
      const k1 = rows.find((r) => r.shadow_variant === 'k_1');
      expect(JSON.parse(k1!.shadow_prediction_json!)).toEqual({ selectedIds: ['c'] });
    } finally {
      if (handle) teardown(handle);
    }
  });
});
