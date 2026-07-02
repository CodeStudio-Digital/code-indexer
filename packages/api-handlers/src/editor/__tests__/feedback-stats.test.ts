import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEditorHandlers } from '../index.js';
import { computeEditorStats, __resetStatsCacheForTests } from '../stats.js';

type Row = {
  stage: string; component_name: string; duration_ms: number; errors: number;
  diag_json: string | null; created_at: string;
};

function row(over: Partial<Row>): Row {
  return {
    stage: 'autocomplete', component_name: 'codestral-latest', duration_ms: 400,
    errors: 0, diag_json: JSON.stringify({ status: 'ok', endpoint: 'fim' }),
    created_at: '2026-07-01T12:00:00.000Z', ...over,
  };
}

function makeDeps(rows: Row[] = [], binding: unknown = { modelId: 'codestral-latest' }) {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    deps: {
      db: {} as never,
      pipelineProviderResolver: { resolveOrNull: vi.fn(async () => binding) } as never,
      pipelineTelemetryStore: {
        insert: (r: Record<string, unknown>) => { inserts.push(r); },
        list: () => rows,
      } as never,
    },
    inserts,
  };
}

const ctx = {} as never;

beforeEach(() => {
  __resetStatsCacheForTests();
});

describe('feedback action → stage mapping + dedupe', () => {
  it('maps every lifecycle action and dedupes per (requestId, action)', async () => {
    const { deps, inserts } = makeDeps();
    const h = createEditorHandlers(deps);
    // Unknown requestId still records with model 'unknown'.
    await h.feedback({ projectId: 1, requestId: 'r1', action: 'shown' }, ctx);
    await h.feedback({ projectId: 1, requestId: 'r1', action: 'accept' }, ctx);
    await h.feedback({ projectId: 1, requestId: 'r1', action: 'reject', shownForMs: 900 }, ctx);
    await h.feedback({ projectId: 1, requestId: 'r1', action: 'partial', acceptedChars: 7, partialKind: 'word' }, ctx);
    const stages = inserts.map((i) => i.stage);
    expect(stages).toEqual([
      'autocomplete_shown', 'autocomplete_accept', 'autocomplete_reject', 'autocomplete_partial',
    ]);
    expect(inserts.every((i) => i.component_name === 'unknown')).toBe(true);
  });

  it('prefilter_skip records the detail batch without a requestId', async () => {
    const { deps, inserts } = makeDeps();
    const h = createEditorHandlers(deps);
    const r = await h.feedback({ projectId: 1, action: 'prefilter_skip', detail: 'r1:12,r3:4' }, ctx);
    expect(r.ok).toBe(true);
    expect(inserts[0]).toMatchObject({ stage: 'autocomplete_prefilter', component_name: 'client' });
    expect(JSON.parse(String(inserts[0]!.diag ? JSON.stringify(inserts[0]!.diag) : '{}'))).toMatchObject({ detail: 'r1:12,r3:4' });
  });

  it('garbage input never throws', async () => {
    const { deps } = makeDeps();
    const h = createEditorHandlers(deps);
    expect((await h.feedback({ projectId: 1, action: 'nope' as never }, ctx)).ok).toBe(false);
    expect((await h.feedback(undefined as never, ctx)).ok).toBe(true); // defaults to accept path
  });
});

describe('computeEditorStats', () => {
  it('aggregates counts, accept rate, latency percentiles, per-model and daily', async () => {
    const rows: Row[] = [
      ...Array.from({ length: 10 }, (_, i) => row({ duration_ms: 100 + i * 100 })),
      row({ stage: 'autocomplete_shown' }),
      row({ stage: 'autocomplete_shown', created_at: '2026-06-30T10:00:00.000Z' }),
      row({ stage: 'autocomplete_accept' }),
      row({ stage: 'autocomplete_reject' }),
      row({ stage: 'autocomplete', diag_json: JSON.stringify({ status: 'timeout' }), errors: 1 }),
    ];
    const { deps } = makeDeps(rows);
    const stats = await computeEditorStats(deps, 7);
    expect(stats.configured).toBe(true);
    expect(stats.model).toBe('codestral-latest');
    expect(stats.requests).toBe(11);
    expect(stats.shown).toBe(2);
    expect(stats.accepted).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.acceptRate).toBeCloseTo(0.5);
    expect(stats.statusBreakdown.ok).toBe(10);
    expect(stats.statusBreakdown.timeout).toBe(1);
    expect(stats.endpointSplit.fim).toBe(10);
    expect(stats.latency.p50).toBe(600);
    expect(stats.byModel[0]).toMatchObject({ model: 'codestral-latest', requests: 11 });
    expect(stats.daily.length).toBe(2);
  });

  it('acceptRate is null while no shown events exist; days clamp to ≤30', async () => {
    const { deps } = makeDeps([row({}), row({ stage: 'autocomplete_accept' })]);
    const stats = await computeEditorStats(deps, 90);
    expect(stats.windowDays).toBe(30);
    expect(stats.acceptRate).toBeNull();
    expect(stats.accepted).toBe(1);
  });

  it('fails open: no binding + throwing store still return a zeroed result', async () => {
    const deps = {
      db: {} as never,
      pipelineProviderResolver: { resolveOrNull: vi.fn(async () => null) } as never,
      pipelineTelemetryStore: { insert: () => undefined, list: () => { throw new Error('db'); } } as never,
    };
    const stats = await computeEditorStats(deps, 7);
    expect(stats.configured).toBe(false);
    expect(stats.requests).toBe(0);
    expect(stats.acceptRate).toBeNull();
  });

  it('caches for 30s (second call skips the store)', async () => {
    const listSpy = vi.fn(() => [] as Row[]);
    const deps = {
      db: {} as never,
      pipelineProviderResolver: { resolveOrNull: vi.fn(async () => null) } as never,
      pipelineTelemetryStore: { insert: () => undefined, list: listSpy } as never,
    };
    await computeEditorStats(deps, 7);
    await computeEditorStats(deps, 7);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });
});
