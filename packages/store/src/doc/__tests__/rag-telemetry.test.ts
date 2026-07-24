import { describe, expect, it, vi } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { recordSearchEvents } from '../rag-telemetry.js';

describe('documentation search telemetry', () => {
  it('writes a batch in one transaction and normalizes optional SQLite values', () => {
    const run = vi.fn();
    const transaction = vi.fn((operation: (batch: readonly unknown[]) => void) =>
      (batch: readonly unknown[]) => operation(batch));
    const db = {
      prepare: vi.fn(() => ({ run })),
      transaction,
    } as unknown as DB;

    recordSearchEvents(db, [{
      query_hash: 'a',
      scope: 'project',
      mode: 'fts',
      duration_ms: 2,
      fts_hits: 1,
      vector_hits: 0,
      no_good_match: true,
      result_count: 1,
    }, {
      project_id: 7,
      query_hash: 'b',
      scope: 'all',
      collection_ids: [2, 3],
      mode: 'hybrid',
      duration_ms: 4,
      fts_hits: 2,
      vector_hits: 1,
      no_good_match: false,
      result_count: 2,
    }]);

    expect(transaction).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toMatchObject({
      project_id: null,
      collection_ids_json: null,
      stale_vector_hits: 0,
      no_good_match: 1,
    });
    expect(run.mock.calls[1][0]).toMatchObject({
      project_id: 7,
      collection_ids_json: '[2,3]',
      no_good_match: 0,
    });
  });
});
