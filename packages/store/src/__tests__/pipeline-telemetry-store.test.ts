/**
 * Tests for `PipelineTelemetryStore.summary()` and the filter-aware
 * `cacheStats()`. These back the pipeline-telemetry dashboard cards, which
 * must describe the SAME population + window as the histogram/cache panels
 * (the previous client-side sum over a truncated row sample did not).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import {
  PipelineTelemetryStore,
  type PipelineTelemetryInsert,
} from '../pipeline-telemetry-store.js';

interface Handle {
  db: CodeIndexDB;
  store: PipelineTelemetryStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-pt-store-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new PipelineTelemetryStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function row(over: Partial<PipelineTelemetryInsert>): PipelineTelemetryInsert {
  return {
    pipeline_name: 'doc_search',
    stage: 'query_rewrite',
    component_name: 'QueryRewriter',
    duration_ms: 5,
    duration_bucket: '0-10ms',
    ...over,
  };
}

describe('PipelineTelemetryStore.summary', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns zeroes on an empty table', () => {
    expect(h.store.summary()).toEqual({
      events: 0, errorRows: 0, subErrors: 0,
      cacheHits: 0, cacheMisses: 0, hitRate: 0,
    });
  });

  it('counts events, error rows (≤ events), sub-failures, and cache totals', () => {
    h.store.insert(row({ cache_hits: 1, cache_misses: 0, errors: 0 }));
    h.store.insert(row({ cache_hits: 0, cache_misses: 1, errors: 2 })); // 1 row, 2 sub-failures
    h.store.insert(row({ cache_hits: 0, cache_misses: 1, errors: 3 })); // 1 row, 3 sub-failures
    const s = h.store.summary();
    expect(s.events).toBe(3);
    expect(s.errorRows).toBe(2);          // never exceeds events
    expect(s.subErrors).toBe(5);          // 2 + 3
    expect(s.cacheHits).toBe(1);
    expect(s.cacheMisses).toBe(2);
    expect(s.hitRate).toBeCloseTo(1 / 3);
  });

  it('scopes by pipeline + stage', () => {
    h.store.insert(row({ pipeline_name: 'doc_search', stage: 'query_rewrite', errors: 1 }));
    h.store.insert(row({ pipeline_name: 'doc_search', stage: 'rerank', component_name: 'Reranker' }));
    h.store.insert(row({ pipeline_name: 'quality_classifiers', stage: 'side_effect', component_name: 'classify' }));
    expect(h.store.summary({ pipelineName: 'doc_search' }).events).toBe(2);
    expect(h.store.summary({ pipelineName: 'doc_search', stage: 'rerank' }).events).toBe(1);
    expect(h.store.summary({ pipelineName: 'quality_classifiers' }).errorRows).toBe(0);
  });

  it('scopes by since (excludes older rows)', () => {
    const oldId = h.store.insert(row({ errors: 9 }));
    h.db.raw().prepare('UPDATE pipeline_telemetry SET created_at = ? WHERE id = ?')
      .run('2020-01-01 00:00:00', oldId);
    h.store.insert(row({ errors: 1 }));
    const since = '2025-01-01 00:00:00';
    const s = h.store.summary({ since });
    expect(s.events).toBe(1);
    expect(s.subErrors).toBe(1);
  });
});

describe('PipelineTelemetryStore.cacheStats filters', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('respects the pipeline/stage filter (regression: used to ignore it)', () => {
    h.store.insert(row({ pipeline_name: 'doc_search', stage: 'query_rewrite', cache_misses: 1 }));
    h.store.insert(row({ pipeline_name: 'doc_search', stage: 'rerank', component_name: 'Reranker', cache_misses: 1 }));
    h.store.insert(row({ pipeline_name: 'other', stage: 'x', component_name: 'y', cache_hits: 1 }));

    const all = h.store.cacheStats();
    expect(all.length).toBe(3);

    const scoped = h.store.cacheStats({ pipelineName: 'doc_search' });
    expect(scoped.length).toBe(2);
    expect(scoped.every((s) => s.pipeline_name === 'doc_search')).toBe(true);

    const stageScoped = h.store.cacheStats({ pipelineName: 'doc_search', stage: 'rerank' });
    expect(stageScoped.length).toBe(1);
    expect(stageScoped[0].component_name).toBe('Reranker');
  });
});
