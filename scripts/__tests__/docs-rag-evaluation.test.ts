import { describe, expect, it, vi } from 'vitest';
import { aggregate, parseGold, runOne } from '../docs-rag-evaluation.js';

describe('documentation evaluation', () => {
  it('retains explicit negatives and reports malformed or empty relevance labels', () => {
    expect(parseGold('# gold\n{"query":"absent","relevant":[]}')).toHaveLength(1);
    for (const bad of ['{', '{"query":"absent"}', '{"query":"topic","relevant":[{}]}']) {
      expect(() => parseGold('# gold\n' + bad)).toThrow(/line 2/);
    }
  });

  it('scores negatives separately and records the actual reranking path', async () => {
    const search = { search: vi.fn()
      .mockResolvedValueOnce({ results: [{ source_uri: '/api', heading_path: null }],
        diag: { mode: 'fts', rerank_used: false, rerank_skip_reason: 'disabled', rerank_candidates: 2 } })
      .mockResolvedValueOnce({ results: [], diag: { mode: 'fts' } }) };
    const rows = [await runOne(search, 'rerank', { query: 'api', relevant: [{ source_uri_contains: '/api' }] }),
      await runOne(search, 'fts', { query: 'absent', relevant: [] })];
    expect(rows[0]).toMatchObject({ mode: 'rerank', executed: 'fts', reranked: false, skipReason: 'disabled' });
    expect(aggregate(rows)).toMatchObject({ n: 1, recall5: 1, negatives: 1, correctAbsences: 1, reranked: 0 });
  });
});
