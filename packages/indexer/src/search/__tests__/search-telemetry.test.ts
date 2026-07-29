import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSemanticSearchTelemetryStore } from '../search-telemetry.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('FileSemanticSearchTelemetryStore', () => {
  it('persists privacy-safe request/outcome rows and aggregates value metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-telemetry-'));
    roots.push(root);
    const store = new FileSemanticSearchTelemetryStore((projectId) =>
      projectId === 7 ? root : null);
    store.emit({
      schema_version: 1,
      kind: 'search',
      recorded_at: new Date().toISOString(),
      request_id: 'request-7',
      project_id: 7,
      consumer: 'search_everywhere',
      query_class: 'natural_language',
      requested_mode: 'auto',
      planned_mode: 'hybrid',
      effective_mode: 'hybrid',
      generation_id: 4,
      cache_hit: false,
      fallback: false,
      result_count: 10,
      total_time_ms: 1250,
      reranker_applied: true,
      reranker_failed: false,
      session_scoped: false,
    });
    store.recordOutcome({
      schema_version: 1,
      kind: 'outcome',
      recorded_at: new Date().toISOString(),
      request_id: 'request-7',
      project_id: 7,
      outcome: 'opened',
      semantic_win: true,
    });
    store.recordOutcome({
      schema_version: 1,
      kind: 'outcome',
      recorded_at: new Date().toISOString(),
      request_id: 'not-a-recorded-search',
      project_id: 7,
      outcome: 'opened',
      semantic_win: true,
    });
    await store.flush();

    await expect(store.summarize(7, 30)).resolves.toMatchObject({
      total_searches: 1,
      semantic_searches: 1,
      lexical_searches: 0,
      reranker_applied: 1,
      opened_results: 1,
      semantic_wins: 1,
      p50_ms: 1250,
      p95_ms: 1250,
      consumers: { search_everywhere: 1 },
      effective_modes: { hybrid: 1 },
    });
    const raw = await readFile(
      join(root, '.mcp-indexer', 'metrics', 'semantic-search.jsonl'),
      'utf8',
    );
    expect(raw).not.toContain('how does the bank account change');
    expect(raw).not.toContain('src/private-file.ts');
    expect(raw).toContain('"request_id":"request-7"');
  });
});
