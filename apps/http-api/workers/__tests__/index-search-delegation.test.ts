/**
 * The semantic delegation tests of the index tools, with the worker RPC
 * client instead of a direct fake: an owner answer reaches the tool intact,
 * and every RPC failure takes the same FTS fallback, text and diagnostics as
 * an unreachable loopback owner with the same error.
 */
import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexToolContext } from '@mcp/indexer/agent-tools/context.js';
import { normalizeMcpToolResult } from '@mcp/indexer/agent-tools/tool.js';
import { searchTools } from '@mcp/indexer/agent-tools/tools/search.js';
import { snapshotTools } from '@mcp/indexer/agent-tools/tools/snapshots.js';
import type { McpSemanticSearchClient } from '@mcp/indexer/agent-tools/semantic-client.js';
import { registerWorkerIndexHandlers } from '../../sse/worker-index-handlers.js';
import type { IndexSearchService } from '../../server/index-search-service.js';
import { createRpcSemanticSearchClient } from '../index-search-rpc.js';

const search = searchTools.find(tool => tool.name === 'search')!;
const searchMemory = snapshotTools.find(tool => tool.name === 'search_memory')!;
const project = { id: 7, name: 'demo', root_path: 'D:/demo' };
const fileHit = { id: 4, type: 'file' as const, score: 0.8, fts_rank: null, vector_score: 0.8,
  data: { path: 'src/router.ts', language: 'typescript', line_count: 20, complexity: 1, layer: 'service', summary: 'routes', concepts: '[]' } };
const diagnostics = { vectorAvailable: true, embeddingAvailable: true, vectorRawMatches: 1, structuralRevision: 'remote:4',
  structuralRevisionAfter: 'remote:4', structuralRevisionStable: true, effectiveMode: 'hybrid' };
const memoryHit = { id: 3, project_id: 7, scope: 'project', name: 'Testing convention', type: 'convention',
  content: 'Run focused Vitest suites first.', source: 'agent', importance: 0.8, score: 0.03 };

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

/** The worker's RPC client wired to a host service (or to a host without handlers). */
function rpcClient(service: Partial<IndexSearchService> | null, deadlineMs?: number): McpSemanticSearchClient {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const off = service === null ? () => undefined
    : registerWorkerIndexHandlers(main, () => ({ ids: { sessionId: 'host-session' } }), () => service as IndexSearchService);
  cleanup.push(() => { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); });
  return createRpcSemanticSearchClient(worker, { deadlineMs });
}

/** Everything but the client is the same fake index the moved delegation tests use. */
function context(client: Partial<McpSemanticSearchClient>) {
  return {
    db: {
      getProjectByName: () => project,
      getEmbeddingCoverage: () => ({ files_total: 1, files_embedded: 1 }),
      countSemanticStale: () => 0,
      countAgentMemory: () => 1,
      getProjectMemoryContentPages: () => [{ ...memoryHit, content_characters: memoryHit.content.length }],
    },
    semanticSearchClient: client,
    hybridSearch: { searchWithDiag: vi.fn(async () => ({
      results: [{ ...fileHit, score: 0.1, vector_score: null, fts_rank: 1 }],
      diagnostics: { vectorAvailable: false, embeddingAvailable: false, ftsCount: 1 },
    })) },
    agentMemoryService: { search: vi.fn(async () => [memoryHit]) },
  } as unknown as IndexToolContext;
}

const unavailable = (error: string): Partial<McpSemanticSearchClient> => ({
  searchProject: async () => ({ ok: false, value: null, error }),
  searchProjectMemory: async () => ({ ok: false, value: null, error }),
});
const uuidless = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'));
const runSearch = async (ctx: IndexToolContext) =>
  uuidless(normalizeMcpToolResult(await search.handler({ project_name: 'demo', query: 'vector routing', mode: 'hybrid' }, ctx)));
const runMemory = async (ctx: IndexToolContext) =>
  uuidless(await searchMemory.handler({ project_name: 'demo', query: 'testing convention', format: 'text' }, ctx));

describe('index tools over the worker RPC client', () => {
  it('search: an owner answer reaches the tool as the direct client delivers it', async () => {
    const value = { results: [fileHit], diagnostics };
    const viaRpc = await runSearch(context(rpcClient({ projectSearch: async () => value })));
    const direct = await runSearch(context({ searchProject: async () => ({ ok: true, value, error: null }) as never }));
    expect(viaRpc).toEqual(direct);
    expect(viaRpc.text).toContain('vector 0.800');
  });

  it('search_memory: owner ids reach the tool as the direct client delivers them', async () => {
    const viaRpc = await runMemory(context(rpcClient({ memorySearch: async () => ({ status: 200 as const, results: [memoryHit] as never[] }) })));
    const direct = await runMemory(context({ searchProjectMemory: async () => ({ ok: true, value: { results: [{ id: 3, score: 0.03 }] }, error: null }) }));
    expect(viaRpc).toEqual(direct);
  });

  it.each([
    ['a host error', () => rpcClient({ projectSearch: async () => { throw new Error('connection refused'); },
      memorySearch: async () => { throw new Error('connection refused'); } }), 'connection refused'],
    ['a host without the handlers', () => rpcClient(null), "no handler registered for 'indexProjectSearch'"],
    ['the deadline', () => rpcClient({
      projectSearch: (_input, _ids, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      memorySearch: (_id, _query, _limit, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    }, 120), 'Local server request timed out'],
  ])('search falls back to FTS exactly like an unavailable owner on %s', async (_label, make, error) => {
    const viaRpc = await runSearch(context(make()));
    expect(viaRpc).toEqual(await runSearch(context(unavailable(error))));
    expect(viaRpc.text).toContain('FTS-only');
    expect(viaRpc.text).toContain(error);
  });

  it.each([
    ['a host error', () => rpcClient({ memorySearch: async () => { throw new Error('server stopped'); } }), 'server stopped'],
    ['a host without the handlers', () => rpcClient(null), "no handler registered for 'indexMemorySearch'"],
  ])('search_memory falls back to local FTS exactly like an unavailable owner on %s', async (_label, make, error) => {
    const viaRpc = await runMemory(context(make()));
    expect(viaRpc).toEqual(await runMemory(context(unavailable(error))));
    expect(JSON.stringify(viaRpc)).toContain('FTS-only');
  });
});
