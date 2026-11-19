import { expect, it, vi } from 'vitest';
import { AgentMemoryService, dedupeAgentMemoryHits } from '../agent-memory-service.js';
import type { AgentMemoryRow } from '@mcp/shared/types.js';

const row = (id: number, content = `Durable fact ${id}`) => ({ id, name: `memory-${id}`, description: '', content,
  scope: 'project', project_id: 7, type: 'procedure', source: 'session', importance: 0.7, archived_at: null } as AgentMemoryRow);
function fixture(rows: AgentMemoryRow[]) {
  const writeTarget = { generationId: 7, embeddingFingerprint: 'space-7', namespace: 'memory:project:p7' };
  const embed = vi.fn(async (_namespace: string, texts: string[]) => ({ vectors: texts.map((_, i) => [i, 1]), tokens: 0, writeTarget }));
  const vectors = { listItems: vi.fn(async () => []), upsert: vi.fn(async records => records.length), search: vi.fn(async () => []) };
  const db = { listAgentMemoryForSemanticIndex: (scope: string) => scope === 'project' ? rows : [],
    getProject: () => ({ name: 'fixture' }), searchAgentMemoryFts: () => rows };
  const service = new AgentMemoryService(db as any, { embedDocumentsForNamespace: embed, fingerprint: () => 'space-7' } as any, vectors as any);
  return { service, embed, vectors, writeTarget, db };
}

it('embeds 40 memories in two requests (32+8), keeping a generation pin on every write', async () => {
  const f = fixture(Array.from({ length: 40 }, (_, i) => row(i + 1)));
  expect(await f.service.backfillEmbeddings(7, 40, 'project')).toEqual({ embedded: 40, failed: 0, skipped: 0, total: 40 });
  expect(f.embed.mock.calls.map(call => call[1].length)).toEqual([32, 8]);
  expect(f.vectors.upsert).toHaveBeenCalledTimes(40);
  for (const call of f.vectors.upsert.mock.calls as any[]) expect(call[2]).toEqual(f.writeTarget);
});

it('bounds chunked memories by texts, not just row count', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => row(i + 1, 'Long memory. '.repeat(650))));
  const result = await f.service.backfillEmbeddings(7, 20, 'project');
  expect(result.embedded).toBe(20);
  expect(f.embed.mock.calls.length).toBe(3);
  expect(f.embed.mock.calls.every(call => call[1].length <= 32)).toBe(true);
});

it('stops on a quota response and preserves its retry reason instead of issuing a request per remaining row', async () => {
  const f = fixture(Array.from({ length: 80 }, (_, i) => row(i + 1)));
  f.embed.mockRejectedValueOnce(new Error('429 free-models-per-min Retry-After: 60'));
  const result = await f.service.backfillEmbeddings(7, 80, 'project');
  expect(result).toMatchObject({ embedded: 0, failed: 32, total: 80, error: expect.stringContaining('429') });
  expect(f.embed).toHaveBeenCalledOnce(); expect(f.vectors.upsert).not.toHaveBeenCalled();
});

it('rejects an incomplete batch without writing partial vectors', async () => {
  const f = fixture([row(1), row(2)]);
  f.embed.mockResolvedValueOnce({ vectors: [[1]], tokens: 0, writeTarget: f.writeTarget });
  expect(await f.service.backfillEmbeddings(7)).toMatchObject({ failed: 2, error: expect.stringContaining('incomplete') });
  expect(f.vectors.upsert).not.toHaveBeenCalled();
});

it('applies the semantic-profile reranker to lexical results even with no embedding backend', async () => {
  const f = fixture([row(1, 'Deploy procedure'), row(2, 'Test procedure')]);
  const rerank = vi.fn(async () => [{ id: '2', score: 0.9, originalScore: 0 }, { id: '1', score: 0.1, originalScore: 0 }]);
  const service = new AgentMemoryService(f.db as any, null, null, null, null, { name: 'fixture', rerank });
  expect((await service.search('project', 7, 'test', 2)).map(r => r.id)).toEqual([2, 1]);
  expect(rerank).toHaveBeenCalledOnce();
  rerank.mockRejectedValueOnce(new Error('429'));
  expect((await service.search('project', 7, 'test', 2)).map(r => r.id)).toEqual([1, 2]);
});

it('does not erase negation, version changes or different types as near-duplicates', () => {
  const memories = [row(1, 'Always run tests with Node 18.'), row(2, 'Never run tests with Node 18.'), row(3, 'Always run tests with Node 22.')];
  expect(dedupeAgentMemoryHits(memories.map(r => ({ ...r, score: 1 })))).toHaveLength(3);
});
