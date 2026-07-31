import { describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { AgentMemoryRow } from '@mcp/shared/types.js';
import type { VectorSearchOptions, VectorStore } from '@mcp/store/vectors.js';
import type { RerankerService } from '@mcp/indexer/search/reranker-types.js';
import {
  AgentMemoryService,
  dedupeAgentMemoryHits,
  type AgentMemoryHit,
} from '../agent-memory-service.js';

function embedding(overrides: Partial<EmbeddingService> = {}): EmbeddingService {
  return {
    embed: vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [1]), tokens: 0 })),
    embedQuery: vi.fn(async () => ({ vector: [1], tokens: 0 })),
    ...overrides,
  };
}

function memoryRow(id: number): AgentMemoryRow {
  return {
    id,
    scope: 'project',
    project_id: 7,
    name: 'active generation',
    description: 'query must use the stored vector space',
    content: 'semantic memory',
    type: 'fact',
    importance: 0.8,
    confidence: 1,
    source: 'test',
    source_session_id: null,
    tags: '[]',
    metadata: '{}',
    access_count: 0,
    last_accessed_at: null,
    stale_after: null,
    superseded_by: null,
    archived_at: null,
    created_at: '2026-07-15 12:00:00',
    updated_at: '2026-07-15 12:00:00',
  } as unknown as AgentMemoryRow;
}

describe('AgentMemoryService active-generation queries', () => {
  it('collapses automatic paraphrases in favor of an explicit canonical memory', () => {
    const content =
      'On disconnect, roll back pending optimistic mutations in reverse insertion order and preserve authoritative events.';
    const automatic = {
      ...memoryRow(1),
      name: 'automatic disconnect summary',
      source: 'session',
      content,
      score: 0.95,
    } as AgentMemoryHit;
    const canonical = {
      ...memoryRow(2),
      name: 'canonical disconnect decision',
      source: 'agent',
      content:
        'Pending optimistic mutations roll back in reverse insertion order on disconnect, preserving authoritative events.',
      score: 0.8,
    } as AgentMemoryHit;
    const distinct = {
      ...memoryRow(3),
      name: 'revision ordering',
      source: 'agent',
      content: 'Ignore incoming events whose revision is not newer than the applied revision.',
      score: 0.7,
    } as AgentMemoryHit;

    const results = dedupeAgentMemoryHits([automatic, canonical, distinct]);

    expect(results.map((row) => row.id)).toEqual([2, 3]);
    expect(results[0]!.score).toBe(0.95);
  });

  it('does not collapse two explicit memories even when their content overlaps', () => {
    const content = 'Preserve the six-field event contract for realtime mutations.';
    const user = {
      ...memoryRow(1),
      source: 'user',
      content,
      score: 0.9,
    } as AgentMemoryHit;
    const agent = {
      ...memoryRow(2),
      source: 'agent',
      content,
      score: 0.8,
    } as AgentMemoryHit;

    expect(dedupeAgentMemoryHits([user, agent]).map((row) => row.id)).toEqual([1, 2]);
  });

  it('collapses automatic symptom paraphrases by normalized title concepts', () => {
    const first = {
      ...memoryRow(1),
      name: 'optimistic-mutation-persistence-on-disconnect',
      source: 'session',
      content: 'The board stays changed.',
      score: 0.9,
    } as AgentMemoryHit;
    const richer = {
      ...memoryRow(2),
      name: 'optimistic-mutation-state-leak-on-connection-failure',
      source: 'session',
      content:
        'Pending callbacks must settle and the optimistic snapshot must be restored deterministically.',
      score: 0.7,
    } as AgentMemoryHit;

    const results = dedupeAgentMemoryHits([first, richer]);

    expect(results.map((row) => row.id)).toEqual([2]);
    expect(results[0]!.score).toBe(0.9);
  });

  it('deduplicates the FTS-only fallback before applying the result limit', async () => {
    const duplicate = {
      ...memoryRow(1),
      source: 'session',
      content: 'Disconnect rolls back every pending optimistic mutation in reverse insertion order.',
    } as AgentMemoryRow;
    const canonical = {
      ...memoryRow(2),
      source: 'agent',
      content: 'On disconnect, pending optimistic mutations roll back in reverse insertion order.',
    } as AgentMemoryRow;
    const distinct = {
      ...memoryRow(3),
      source: 'agent',
      content: 'Incoming realtime events use a monotonically increasing revision.',
    } as AgentMemoryRow;
    const service = new AgentMemoryService({
      searchAgentMemoryFts: vi.fn(() => [duplicate, canonical, distinct]),
    } as unknown as CodeIndexDB);

    const results = await service.search('project', 7, 'disconnect rollback', 5);

    expect(results.map((row) => row.id)).toEqual([2, 3]);
  });

  it('uses the Memory profile reranker after RRF and preserves descending scores', async () => {
    const first = memoryRow(1);
    const second = { ...memoryRow(2), name: 'preferred result' };
    const db = {
      searchAgentMemoryFts: vi.fn(() => [first, second]),
      getAgentMemoryById: vi.fn((id: number) => id === 1 ? first : second),
      getAgentMemoriesByIds: vi.fn((ids: readonly number[]) =>
        ids.map((id) => (id === 1 ? first : second))),
    } as unknown as CodeIndexDB;
    const vectors = {
      search: vi.fn(async () => [
        { id: 'am_1', score: 0.9, metadata: { type: 'agent_memory', scope: 'project', ref_id: '1' } },
        { id: 'am_2', score: 0.8, metadata: { type: 'agent_memory', scope: 'project', ref_id: '2' } },
      ]),
    } as unknown as VectorStore;
    const rerank = vi.fn(async () => [
      { id: '2', score: 0.95, originalScore: 0.01 },
      { id: '1', score: 0.4, originalScore: 0.02 },
    ]);
    const reranker = { name: 'memory-test', rerank } as RerankerService;
    const service = new AgentMemoryService(
      db,
      embedding(),
      vectors,
      embedding({ embedQueryForNamespace: vi.fn(async () => ({ vector: [1], tokens: 1, generationId: 3 })) }),
      null,
      reranker,
    );

    const results = await service.search('project', 7, 'preferred', 2);

    expect(results.map(({ id, score }) => [id, score])).toEqual([[2, 0.95], [1, 0.4]]);
    expect(rerank).toHaveBeenCalledWith(
      'preferred',
      expect.arrayContaining([expect.objectContaining({ id: '2', text: expect.stringContaining('preferred result') })]),
      2,
    );
  });

  it('reports relational memory mutations synchronously through the sink', () => {
    const live = memoryRow(4);
    const archived = { ...live, archived_at: '2026-07-15 13:00:00' };
    const restored = { ...live, archived_at: null };
    let current: AgentMemoryRow = live;
    const db = {
      createAgentMemory: vi.fn(() => live),
      getAgentMemoryById: vi.fn(() => current),
      archiveAgentMemory: vi.fn(() => { current = archived; }),
      restoreAgentMemory: vi.fn(() => { current = restored; return true; }),
    } as unknown as CodeIndexDB;
    const noteMutation = vi.fn();
    const service = new AgentMemoryService(
      db,
      null,
      null,
      null,
      { noteMutation },
    );

    expect(service.create({ projectId: 7, name: 'x', content: 'y' })).toBe(live);
    expect(noteMutation).toHaveBeenLastCalledWith({
      namespace: 'memory:project:p7', itemKeys: ['*'], operation: 'upsert',
    });
    expect(service.archive(4, 'test')).toBe(live);
    expect(noteMutation).toHaveBeenLastCalledWith({
      namespace: 'memory:project:p7', itemKeys: ['agent_memory:4'], operation: 'delete',
    });
    expect(service.restore(4)).toBe(restored);
    expect(noteMutation).toHaveBeenLastCalledWith({
      namespace: 'memory:project:p7', itemKeys: ['agent_memory:4'], operation: 'upsert',
    });
  });

  it('starts and settles a durable fence around the relational memory write', () => {
    const live = memoryRow(11);
    const order: string[] = [];
    const db = {
      createAgentMemory: vi.fn(() => {
        order.push('sqlite');
        return live;
      }),
    } as unknown as CodeIndexDB;
    const beginMutation = vi.fn(() => {
      order.push('fence:start');
      return { jobId: 71, token: 't71', namespace: 'memory:project:p7' };
    });
    const settleMutation = vi.fn(() => { order.push('fence:settle'); });
    const noteMutation = vi.fn();
    const service = new AgentMemoryService(db, null, null, null, {
      noteMutation,
      beginMutation,
      settleMutation,
    });

    expect(service.create({ projectId: 7, name: 'guarded', content: 'row' })).toBe(live);
    expect(order).toEqual(['fence:start', 'sqlite', 'fence:settle']);
    expect(beginMutation).toHaveBeenCalledWith({
      namespace: 'memory:project:p7', itemKeys: ['*'], operation: 'upsert',
    });
    expect(settleMutation).toHaveBeenCalledWith({
      jobId: 71, token: 't71', namespace: 'memory:project:p7',
    });
    expect(noteMutation).not.toHaveBeenCalled();
  });

  it('fences bulk scope hygiene before consolidation/decay touches SQLite', () => {
    const order: string[] = [];
    const service = new AgentMemoryService({
      listAgentMemoryForSemanticIndex: vi.fn(() => [memoryRow(3), memoryRow(4)]),
    } as unknown as CodeIndexDB, null, null, null, {
      noteMutation: vi.fn(),
      beginMutation: vi.fn(() => {
        order.push('fence:start');
        return { jobId: 72, token: 't72', namespace: 'memory:project:p7' };
      }),
      settleMutation: vi.fn(() => { order.push('fence:settle'); }),
    });

    const result = service.runScopeMutation('project', 7, () => {
      order.push('sqlite:hygiene');
      return { archived: 2, decayed: 1 };
    });

    expect(result).toEqual({ archived: 2, decayed: 1 });
    expect(order).toEqual(['fence:start', 'sqlite:hygiene', 'fence:settle']);
  });

  it('routes async scope hygiene through the shared relational retry queue', async () => {
    const order: string[] = [];
    let retryCalls = 0;
    const retry = async <T>(operation: () => T): Promise<T> => {
      retryCalls++;
      order.push('queue');
      return operation();
    };
    const execute = <T>(operation: () => T): T => {
      order.push('fail-fast');
      return operation();
    };
    const service = new AgentMemoryService({
      listAgentMemoryForSemanticIndex: vi.fn(() => [memoryRow(3)]),
    } as unknown as CodeIndexDB, null, null, null, {
      noteMutation: vi.fn(),
      beginMutation: vi.fn(() => {
        order.push('fence:start');
        return { jobId: 73, token: 't73', namespace: 'memory:project:p7' };
      }),
      settleMutation: vi.fn(() => { order.push('fence:settle'); }),
    }, null, { execute, retry });

    const result = await service.runScopeMutationAsync('project', 7, () => {
      order.push('sqlite:hygiene');
      return { archived: 1 };
    });

    expect(result).toEqual({ archived: 1 });
    expect(retryCalls).toBe(1);
    expect(order[0]).toBe('queue');
    expect(order).toContain('sqlite:hygiene');
    expect(order.indexOf('fence:start')).toBeLessThan(order.indexOf('sqlite:hygiene'));
    expect(order.indexOf('sqlite:hygiene')).toBeLessThan(order.indexOf('fence:settle'));
  });

  it('coalesces N inserts into one identity fence and one settlement', async () => {
    let nextId = 20;
    const createAgentMemory = vi.fn(() => memoryRow(nextId++));
    const beginMutation = vi.fn((input) => ({
      jobId: 80,
      token: 'batch-token',
      namespace: input.namespace,
    }));
    const settleMutation = vi.fn();
    const service = new AgentMemoryService({
      createAgentMemory,
    } as unknown as CodeIndexDB, null, null, null, {
      noteMutation: vi.fn(),
      beginMutation,
      settleMutation,
    });

    await service.runMutationBatch(async () => {
      for (let index = 0; index < 10; index++) {
        service.create({
          projectId: 7,
          name: `memory-${index}`,
          content: `content-${index}`,
        });
      }
    });

    expect(createAgentMemory).toHaveBeenCalledTimes(10);
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(beginMutation).toHaveBeenCalledWith({
      namespace: 'memory:project:p7',
      itemKeys: ['*'],
      operation: 'upsert',
    });
    expect(settleMutation).toHaveBeenCalledOnce();
    expect(settleMutation).toHaveBeenCalledWith({
      jobId: 80,
      token: 'batch-token',
      namespace: 'memory:project:p7',
    }, null);
  });

  it('routes project and user recall through their active namespace snapshot', async () => {
    const desired = embedding({
      embedQuery: vi.fn(async () => { throw new Error('desired target must not serve queries'); }),
    });
    const embedQueryForNamespace = vi.fn(async (namespace: string, _text: string) => ({
      vector: [17],
      tokens: 1,
      generationId: namespace === 'memory:user' ? 29 : 27,
    }));
    const query = embedding({ embedQueryForNamespace });
    const search = vi.fn(async (_vector: number[], _options: VectorSearchOptions) => []);
    const db = {
      searchAgentMemoryFts: vi.fn(() => []),
      getProject: vi.fn(() => ({ id: 7, name: 'project-seven' })),
    } as unknown as CodeIndexDB;
    const vectors = { search } as unknown as VectorStore;
    const service = new AgentMemoryService(db, desired, vectors, query);

    await service.search('project', 7, 'where is it', 5);
    await service.search('user', 0, 'my preference', 5);

    expect(embedQueryForNamespace.mock.calls.map(([namespace]) => namespace)).toEqual([
      'memory:project:p7',
      'memory:user',
    ]);
    expect(search.mock.calls.map(([, options]) => options.namespace)).toEqual([
      'memory:project:p7',
      'memory:user',
    ]);
    expect(search.mock.calls.map(([, options]) => options.generationId)).toEqual([27, 29]);
    expect(desired.embedQuery).not.toHaveBeenCalled();
  });

  it('recalls project memory after rename when vector metadata has the old name', async () => {
    const row = memoryRow(8);
    const db = {
      searchAgentMemoryFts: vi.fn(() => []),
      getProject: vi.fn(() => ({ id: 7, name: 'renamed-project' })),
      getAgentMemoryById: vi.fn((id: number) => id === row.id ? row : undefined),
      getAgentMemoriesByIds: vi.fn((ids: readonly number[]) =>
        ids.filter((id) => id === row.id).map(() => row)),
    } as unknown as CodeIndexDB;
    const search = vi.fn(async (_vector: number[], options: VectorSearchOptions) => {
      if (options.filter?.project_name) return [];
      return [{
        id: 'agent-memory:8:0',
        score: 0.95,
        metadata: {
          type: 'agent_memory',
          scope: 'project',
          ref_id: '8',
          project_name: 'old-project-name',
        },
      }];
    });
    const query = embedding({
      embedQueryForNamespace: vi.fn(async () => ({ vector: [17], tokens: 1, generationId: 27 })),
    });
    const service = new AgentMemoryService(
      db,
      embedding(),
      { search } as unknown as VectorStore,
      query,
    );

    const results = await service.search('project', 7, 'stable memory', 5);

    expect(results).toEqual([{ ...row, score: 1 / 61 }]);
    expect(search).toHaveBeenCalledWith([17], expect.objectContaining({
      namespace: 'memory:project:p7',
      generationId: 27,
      filter: { type: 'agent_memory', scope: 'project' },
    }));
  });

  it('keeps FTS results when no namespace generation is active', async () => {
    const row = memoryRow(3);
    const db = {
      searchAgentMemoryFts: vi.fn(() => [row]),
    } as unknown as CodeIndexDB;
    const search = vi.fn(async (_vector: number[], _options: { namespace?: string }) => []);
    const query = embedding({
      embedQueryForNamespace: vi.fn(async (_namespace: string, _text: string) => {
        throw new Error('No active semantic generation for memory:project:p7');
      }),
    });
    const service = new AgentMemoryService(
      db,
      embedding(),
      { search } as unknown as VectorStore,
      query,
    );

    const results = await service.search('project', 7, 'active generation', 5);

    expect(results).toEqual([{ ...row, score: 0 }]);
    expect(search).not.toHaveBeenCalled();
  });

  /**
   * Vector-match RANK feeds the RRF score, so the hydrated rows must stay in
   * match order. Hydration was a per-match point query, which preserved order
   * for free; batching it does not. A batch returns rows in whatever order the
   * database picks, and reordering here changes relevance silently — nothing
   * throws, results just get subtly worse. This pins the contract.
   */
  it('ranks by vector match order, not by the order rows are hydrated in', async () => {
    const rows = new Map([3, 1, 2].map((id) => [id, memoryRow(id)]));
    const db = {
      searchAgentMemoryFts: vi.fn(() => []),
      getAgentMemoryById: vi.fn((id: number) => rows.get(id)),
      // Deliberately ascending by id — the opposite of the match order below.
      getAgentMemoriesByIds: vi.fn((ids: readonly number[]) =>
        [...ids].sort((a, b) => a - b).map((id) => rows.get(id)!)),
    } as unknown as CodeIndexDB;
    const vectors = {
      search: vi.fn(async () => [
        { id: 'am_3', score: 0.9, metadata: { type: 'agent_memory', scope: 'project', ref_id: '3' } },
        { id: 'am_1', score: 0.8, metadata: { type: 'agent_memory', scope: 'project', ref_id: '1' } },
        { id: 'am_2', score: 0.7, metadata: { type: 'agent_memory', scope: 'project', ref_id: '2' } },
      ]),
    } as unknown as VectorStore;
    const service = new AgentMemoryService(db, embedding(), vectors, embedding());

    const results = await service.search('project', 7, 'ordering', 5);

    expect(results.map((r) => r.id)).toEqual([3, 1, 2]);
    // Strictly descending RRF scores confirm rank, not just id ordering.
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it('drops archived, out-of-scope and type-mismatched rows during hydration', async () => {
    const keep = memoryRow(1);
    const archived = { ...memoryRow(2), archived_at: '2026-07-20 10:00:00' } as AgentMemoryRow;
    const otherScope = { ...memoryRow(3), scope: 'global' } as unknown as AgentMemoryRow;
    const rows = new Map([[1, keep], [2, archived], [3, otherScope]]);
    const db = {
      searchAgentMemoryFts: vi.fn(() => []),
      getAgentMemoryById: vi.fn((id: number) => rows.get(id)),
      getAgentMemoriesByIds: vi.fn((ids: readonly number[]) => ids.map((id) => rows.get(id)!)),
    } as unknown as CodeIndexDB;
    const vectors = {
      search: vi.fn(async () => [3, 2, 1].map((id) => ({
        id: `am_${id}`,
        score: 0.9,
        metadata: { type: 'agent_memory', scope: 'project', ref_id: String(id) },
      }))),
    } as unknown as VectorStore;
    const service = new AgentMemoryService(db, embedding(), vectors, embedding());

    const results = await service.search('project', 7, 'filters', 5);

    expect(results.map((r) => r.id)).toEqual([1]);
  });

  it('ignores duplicate ref_ids from the vector store', async () => {
    const row = memoryRow(1);
    const db = {
      searchAgentMemoryFts: vi.fn(() => []),
      getAgentMemoryById: vi.fn(() => row),
      getAgentMemoriesByIds: vi.fn((ids: readonly number[]) => ids.map(() => row)),
    } as unknown as CodeIndexDB;
    const vectors = {
      search: vi.fn(async () => [1, 1, 1].map((id, i) => ({
        id: `am_${id}_${i}`,
        score: 0.9,
        metadata: { type: 'agent_memory', scope: 'project', ref_id: String(id) },
      }))),
    } as unknown as VectorStore;
    const service = new AgentMemoryService(db, embedding(), vectors, embedding());

    const results = await service.search('project', 7, 'dupes', 5);

    expect(results.map((r) => r.id)).toEqual([1]);
  });
});
