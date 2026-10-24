import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { PipelineProviderResolver, ResolvedBinding } from '@mcp/services/pipelines/index.js';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { QueryRewriter } from '@mcp/services/services/docs/query-rewriter.js';
import { Reranker } from '@mcp/services/services/docs/reranker.js';
import { CrossEncoderReranker } from '@mcp/services/services/docs/cross-encoder-reranker.js';
import { DocHybridSearch } from '@mcp/services/services/docs/search.js';
import { makeDocsSynthesizeTool } from '../tools/docs-synthesize.js';
import { makeDocsSearchTool } from '../tools/docs-search-chunks.js';
import { reviewAnswer } from '../review/review-gate.js';
import { DocsResearchSessionsStore } from '../session-store/docs-research-sessions-store.js';
import { runDocsAgent } from '../index.js';

const providerFactory = vi.hoisted(() => vi.fn());
vi.mock('@mcp/services/providers/factory.js', () => ({ createCoderProvider: providerFactory }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); providerFactory.mockReset(); });
const binding = { pipelineName: 'docs_research', bindingRole: 'scorer_llm',
  provider: { id: 'fixture', kind: 'cloudflare', enabled: true }, modelId: 'fixture', modelMode: '',
  config: {}, resolvedFrom: 'global', bindingId: 1 } as unknown as ResolvedBinding;
const chunk = { id: 1, collection_id: 7, source_id: 1, heading_path: 'Guide', content: 'Documented behavior.',
  summary: null, concepts: [], source_uri: 'https://example.invalid/docs' };
const docStore = { getChunksByIds: () => [chunk], listCollections: () => [] } as unknown as DocStore;
const resolver = () => ({ resolveOrNull: vi.fn(async () => binding) }) as unknown as PipelineProviderResolver;
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function blockedFetch() {
  const entered = latch(); let observed: AbortSignal | undefined;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    observed = init.signal as AbortSignal; entered.resolve(); observed.throwIfAborted();
    return new Promise<Response>((_resolve, reject) => observed!.addEventListener('abort', () => reject(observed!.reason), { once: true }));
  });
  vi.stubGlobal('fetch', fetch); return { entered, fetch, signal: () => observed };
}

it.each(['synthesize', 'review', 'rewrite', 'rerank'] as const)('cancels the %s provider instead of degrading cancellation into success', async operation => {
  const controller = new AbortController(), fetch = blockedFetch(), signal = controller.signal;
  const context = { cwd: process.cwd(), signal } as ToolContext;
  const pending = operation === 'synthesize'
    ? makeDocsSynthesizeTool({ docStore, resolver: resolver() }).handler({ query: 'query', outline: ['Guide'], chunk_ids: [1] }, context)
    : operation === 'review' ? reviewAnswer({ query: 'query', markdown: 'Answer [^1]', chunks: [{ chunk_id: 1, heading_path: 'Guide', content: 'Source' }], binding, signal })
    : operation === 'rewrite' ? new QueryRewriter({ resolver: resolver() }).rewrite('query', { signal })
    : new Reranker({ resolver: resolver() }).rerank('query', [1, 2].map(chunk_id => ({ chunk_id, heading_path: 'Guide', snippet: 'Source', pre_rerank_score: 1 })), { signal });
  void pending.catch(() => {});
  await fetch.entered.promise; controller.abort(new Error('cancel requested'));
  await expect(pending).rejects.toThrow(); expect(fetch.signal()?.aborted).toBe(true); expect(fetch.fetch).toHaveBeenCalledOnce();
});

it('stops vector fanout on cancellation without starting another collection or search', async () => {
  const controller = new AbortController(), entered = latch();
  const embed = vi.fn(async (_namespace: string, _query: string, options: { signal?: AbortSignal }) => {
    entered.resolve(); return new Promise<never>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  });
  const search = vi.fn(), store = { listCollections: () => Array.from({ length: 10 }, (_, id) => ({ id: id + 1 })) };
  const hybrid = new DocHybridSearch(store as unknown as DocStore, { embedQueryForNamespace: embed } as never, { search } as never);
  const pending = hybrid.search({ query: 'query', mode: 'vector', signal: controller.signal }); void pending.catch(() => {});
  await entered.promise; controller.abort(new Error('cancel embeddings'));
  await expect(pending).rejects.toThrow('cancel embeddings'); expect(embed).toHaveBeenCalledTimes(4); expect(search).not.toHaveBeenCalled();
});

it('does not publish cancelled search evidence even when a backend returns a late response', async () => {
  const controller = new AbortController(), recordSearch = vi.fn();
  const search = vi.fn(async (input: { signal?: AbortSignal }) => {
    expect(input.signal).toBe(controller.signal); controller.abort(new Error('cancel search'));
    return { results: [], diag: {} };
  });
  const tool = makeDocsSearchTool({ docHybridSearch: { search } as never,
    ledger: { canSearch: () => true, recordSearch } as never });
  await expect(tool.handler({ query: 'query' }, { cwd: process.cwd(), projectName: 'test', signal: controller.signal })).rejects.toThrow('cancel search');
  expect(recordSearch).not.toHaveBeenCalled();
});

it('forwards cancellation to the local cross-encoder and refuses late calibrated scores', async () => {
  const controller = new AbortController();
  const service = { name: 'local', rerank: vi.fn(async (_query: string, _docs: unknown[], _count?: number, options?: { signal?: AbortSignal }) => {
    expect(options?.signal).toBe(controller.signal); controller.abort(new Error('cancel rerank'));
    return [{ id: '1', score: 1, originalScore: 1 }];
  }) };
  await expect(new CrossEncoderReranker(service).rerank('query', [1, 2].map(chunk_id => ({
    chunk_id, heading_path: 'Guide', snippet: 'Source', pre_rerank_score: 1,
  })), { signal: controller.signal })).rejects.toThrow('cancel rerank');
});

it.each(['parent', 'handle'] as const)('records aborted research when %s cancels during the post-run review', async source => {
  const directory = await mkdtemp(join(tmpdir(), 'docs-cancellation-'));
  await Promise.all([mkdir(join(directory, 'project')), mkdir(join(directory, 'data'))]);
  const sessions = FsSessionStore.fromRoots({ dataDir: join(directory, 'data'), projectRootResolver: {
    resolveProjectRoot: () => join(directory, 'project'), listProjectRoots: () => [],
  } });
  const controller = new AbortController(), fetch = blockedFetch();
  const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat() {
    yield { type: 'tool_call_start', id: 'finish', name: 'docs_finish' };
    yield { type: 'tool_call_end', id: 'finish', name: 'docs_finish', input: { markdown: 'Answer [^1]', chunks_cited: [1], confidence: 'medium' } };
    yield { type: 'done' };
  } };
  providerFactory.mockResolvedValue(provider);
  let handle: Awaited<ReturnType<typeof runDocsAgent>> | undefined;
  try {
    handle = await runDocsAgent({ query: 'query', triggeredBy: 'user', signal: controller.signal }, {
      sessionStore: sessions, docStore, docHybridSearch: {} as never, pipelineResolver: resolver(),
    });
    await Promise.race([fetch.entered.promise, handle.done.then(result => { throw new Error(`Research stopped before review: ${result.errorMessage}`); })]);
    if (source === 'parent') controller.abort(new Error('cancel research')); else handle.abort();
    const result = await handle.done;
    expect(result.errorMessage).toBeTruthy(); expect(fetch.signal()?.aborted).toBe(true);
    expect((await new DocsResearchSessionsStore(sessions).get(handle.sessionId))?.status).toBe('aborted');
  } finally {
    controller.abort(); handle?.abort(); await handle?.done.catch(() => {}); await sessions.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') || !directory.includes('docs-cancellation-')) throw new Error('Foreign fixture');
    await rm(directory, { recursive: true, force: true });
  }
});
