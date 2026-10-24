import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { asAgentRunId, asSessionId } from '@mcp/agent-runtime-contracts';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { ragSearchDocsTool, setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import { ragReadDocTool } from '@mcp/code-agent/tools/rag-read-doc.js';
import { ragDocOutlineTool } from '@mcp/code-agent/tools/rag-doc-outline.js';
import type { DocSearchBackend } from '@mcp/code-agent/tools/doc-search-types.js';
import { docsDeepResearchTool, setGlobalDocsResearcher, type DocsResearchBridge } from '../../../packages/docs-agent/src/bridges/docs-bridge.js';
import type { NativeCoderTreeOwner } from '../workers/native-coder-tree.js';
import { NativeTreeScheduler } from '../workers/native-tree-scheduler.js';
import { NativeDocsResearchPort, parseNativeResearchAnswer } from '../workers/native-docs-research-port.js';
import { NativeDocsResearchCorpus } from '../workers/native-docs-research-corpus.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';

const evidence = { chunk_id: 7, collection: 'framework-v3', source_uri: 'https://docs.example.test/setup',
  heading_path: 'Setup', content: 'Enable strict mode before calling configure.', partial: false };
const answer = JSON.stringify({ markdown: 'Enable strict mode.[^7]', citations: [7], confidence: 'high' });
function backend(): DocSearchBackend {
  return { search: vi.fn(async () => ({ results: [{ ...evidence, source_id: 2, anchor: null, api_symbol: null,
    api_signature: null, snippet: 'Enable strict mode', score: 1, relevance: 0.9, summary: null, concepts: [] }],
    diag: { fts_hits: 1, vector_hits: 0, mode: 'fts' as const, embedding_available: false, vector_available: false } })),
    readChunk: vi.fn(async () => ({ chunk: { ...evidence, source_id: 2, anchor: null, api_symbol: null,
      api_signature: null, token_count: 20, summary: null, concepts: [] }, prev: [], next: [] })),
    outline: vi.fn(async () => ({ kind: 'sources' as const, collection: evidence.collection,
      sources: [{ source_id: 2, type: 'url', doc_type: null, title: 'Setup', uri: evidence.source_uri, chunk_count: 1 }] })) };
}
function fixture() {
  const corpus = backend(); setGlobalDocSearch(corpus);
  const registry = new ToolRegistry(); registry.registerAll([ragSearchDocsTool, ragReadDocTool, ragDocOutlineTool, docsDeepResearchTool]); registry.seal();
  const sessionId = asSessionId(randomUUID()), parent = asAgentRunId(randomUUID());
  const context: ToolContext = { cwd: process.cwd(), projectName: 'docs-native', runtimeGeneration: 'rust_v1',
    controlPlaneParentAgentRunId: parent, sessionId, currentToolUseId: 'owned-docs-call', projectId: 17 };
  const provider = { name: 'openai', model: 'chosen-model', setModel() {}, async *chat() { yield { type: 'done' as const }; } };
  const preparation = prepareCoderAttempt({ sessionId, agentRunId: parent, runnerRunId: randomUUID(),
    provider: 'selected-account', model: 'selected::reasoning', agentDefinitionId: 'coder', systemPromptSha256: '0'.repeat(64),
    capabilityProfile: 'full', environment: { kind: 'host', cwd: process.cwd() },
    policy: { permissionMode: 'auto', planMode: false, specMode: false, runtime: resolveRuntimePolicyV1() } }, registry);
  const prepared: PreparedCoderInputs = { preparation, registry, toolContext: context, provider,
    systemPrompt: 'root', messages: [], thinking: false, maxTurns: 20 };
  const children: PreparedCoderInputs[] = [];
  let afterPrepare: (child: PreparedCoderInputs, index: number) => Promise<string> = async (child, index) => {
    if (index === 0) {
      expect(child.registry.list().map(t => t.name)).toEqual(['rag_search_docs', 'rag_read_doc', 'rag_doc_outline', 'record_memo']);
      expect((await child.registry.get('rag_search_docs')!.handler({ query: 'setup' }, child.toolContext)).isError).not.toBe(true);
      expect((await child.registry.get('rag_read_doc')!.handler({ chunk_id: 7 }, child.toolContext)).isError).not.toBe(true);
    } else {
      expect(child.registry.list().map(t => t.name)).toEqual(['record_memo']);
      expect(child.maxTurns).toBe(1);
      expect(JSON.stringify(child.messages)).toContain(evidence.content);
    }
    return answer;
  };
  const runPrepared = vi.fn(async (request, prepare, _observe, signal) => {
    const admission = { kind: 'reserved', context: { sessionId, agentRunId: asAgentRunId(randomUUID()), attemptId: randomUUID() } };
    const child = await prepare(admission, signal); children.push(child);
    expect(child.provider).toBe(provider);
    expect(request).toMatchObject({ provider: 'selected-account', model: 'selected::reasoning' });
    return { admission, finalText: await afterPrepare(child, children.length - 1),
      outcome: { reason: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
      transcriptRef: `native-child-journal:${sessionId}:${admission.context.agentRunId}:${admission.context.attemptId}` };
  });
  const owner = { runPrepared, scheduler: new NativeTreeScheduler(4), shared: { root: { attemptId: randomUUID() },
    budget: { limits: { deadlineAtUnixMs: Date.now() + 90_000 } } } } as unknown as NativeCoderTreeOwner;
  const port = new NativeDocsResearchPort(owner, prepared, context, Date.now() + 80_000);
  context.ports = { docsResearch: port };
  return { corpus, context, port, runPrepared, prepared, children, setChild: (fn: typeof afterPrepare) => { afterPrepare = fn; } };
}
afterEach(() => { setGlobalDocSearch(null); setGlobalDocsResearcher(null); });

it('researches and independently reviews with only sealed docs tools and the same selected provider', async () => {
  const f = fixture(), legacy = vi.fn(); setGlobalDocsResearcher({ runResearch: legacy } as unknown as DocsResearchBridge);
  const result = await docsDeepResearchTool.handler({ query: 'How do I configure v3?', collections: ['framework-v3'] }, f.context);
  expect(result.isError).not.toBe(true); expect(legacy).not.toHaveBeenCalled();
  expect(f.runPrepared).toHaveBeenCalledTimes(2);
  expect(result.subUsage).toEqual({ input_tokens: 20, output_tokens: 10 });
  expect(result.content).toContain('[^7]: [framework-v3: Setup](<https://docs.example.test/setup>)');
  expect(result.structuredData).toMatchObject({ status: 'completed', chunks_cited: [7], confidence: 'high', searches: 1, chunks_read: 1 });
  expect(f.corpus.search).toHaveBeenCalledWith(expect.objectContaining({ collection: 'framework-v3', project_id: 17, scope: 'project' }), expect.any(AbortSignal));
  expect(f.corpus.readChunk).toHaveBeenCalledWith(expect.objectContaining({ window: 0, max_chars: 16384 }), expect.any(AbortSignal));
});

it('fails closed without native ownership even when the legacy bridge is installed', async () => {
  const f = fixture(), legacy = vi.fn(); setGlobalDocsResearcher({ runResearch: legacy } as unknown as DocsResearchBridge);
  f.context.ports = undefined;
  expect(await docsDeepResearchTool.handler({ query: 'setup' }, f.context)).toMatchObject({ isError: true, content: expect.stringContaining('legacy research fallback is forbidden') });
  expect(legacy).not.toHaveBeenCalled(); expect(f.runPrepared).not.toHaveBeenCalled();
});

it('refuses stale invocation ownership, missing docs tools and cancellation before any child admission', async () => {
  const f = fixture();
  expect(await f.port.research({ query: 'setup' }, { ...f.context, currentToolUseId: undefined })).toMatchObject({ isError: true });
  expect(await f.port.research({ query: 'setup' }, { ...f.context, controlPlaneParentAgentRunId: 'foreign' })).toMatchObject({ isError: true });
  await expect(f.port.research({ query: 'setup' }, { ...f.context, signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop');
  expect(f.runPrepared).not.toHaveBeenCalled();
});

it('does not start review or replay a child when its outcome is unknown', async () => {
  const f = fixture(), impl = f.runPrepared.getMockImplementation()!;
  f.runPrepared.mockImplementation(async (...args) => ({ ...await impl(...args), outcome: { reason: 'completed',
    effectOutcome: 'unknown', usage: { input_tokens: 10, output_tokens: 5 } } }));
  const result = await f.port.research({ query: 'setup' }, f.context);
  expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown' });
  expect(f.runPrepared).toHaveBeenCalledOnce();
});

it('rejects an unread citation before launching the review', async () => {
  const f = fixture(); f.setChild(async () => answer);
  expect(await f.port.research({ query: 'setup' }, f.context)).toMatchObject({ isError: true, content: expect.stringContaining('unread') });
  expect(f.runPrepared).toHaveBeenCalledOnce();
});

it('propagates cancellation across corpus reads and never launches the review afterwards', async () => {
  const f = fixture(), controller = new AbortController(); f.context.signal = controller.signal;
  vi.mocked(f.corpus.search).mockImplementation(async (_args, signal) => {
    controller.abort(new Error('cancel research')); signal!.throwIfAborted(); throw new Error('unreachable');
  });
  await expect(f.port.research({ query: 'setup' }, f.context)).rejects.toThrow('cancel research');
  expect(f.runPrepared).toHaveBeenCalledOnce();
});

it('enforces collection scope before publishing search results and never reads guessed ids', async () => {
  const b = backend(), corpus = new NativeDocsResearchCorpus(b, ['other-collection']);
  const context = { cwd: process.cwd(), projectName: 'scope' };
  const read = corpus.decorate(ragReadDocTool);
  expect(await read.handler({ chunk_id: 7 }, context)).toMatchObject({ isError: true, content: expect.stringContaining('returned by this research') });
  expect(b.readChunk).not.toHaveBeenCalled();
  const result = await corpus.decorate(ragSearchDocsTool).handler({ query: 'secret', scope: 'all' }, context);
  expect(result).toMatchObject({ isError: true, content: expect.stringContaining('outside') });
  expect(result.content).not.toContain('strict mode');
  expect(await read.handler({ chunk_id: 7 }, context)).toMatchObject({ isError: true });
  expect(b.readChunk).not.toHaveBeenCalled();
});

it('keeps weak search hits out of the evidence set and rejects arbitrary collection overrides', async () => {
  const b = backend(), corpus = new NativeDocsResearchCorpus(b, ['framework-v3']);
  const context = { cwd: process.cwd(), projectName: 'scope' };
  const search = corpus.decorate(ragSearchDocsTool);
  expect(await search.handler({ query: 'setup', collection: 'foreign' }, context)).toMatchObject({ isError: true });
  expect(b.search).not.toHaveBeenCalled();
  const previous = vi.mocked(b.search).getMockImplementation()!;
  vi.mocked(b.search).mockImplementation(async (...args) => { const response = await previous(...args); response.diag.no_good_match = true; return response; });
  expect(JSON.parse((await search.handler({ query: 'setup' }, context)).content).results).toEqual([]);
  expect(await corpus.decorate(ragReadDocTool).handler({ chunk_id: 7 }, context)).toMatchObject({ isError: true });
});

it('drops unsolicited neighbor content, validates chunk identity and bounds evidence', async () => {
  const b = backend(), corpus = new NativeDocsResearchCorpus(b), context = { cwd: process.cwd(), projectName: 'scope' };
  await corpus.decorate(ragSearchDocsTool).handler({ query: 'setup' }, context);
  const original = vi.mocked(b.readChunk!).getMockImplementation()!;
  vi.mocked(b.readChunk!).mockImplementation(async (...args) => ({ ...await original(...args)!, prev: [{ content: 'foreign secret' }] } as never));
  const read = corpus.decorate(ragReadDocTool), result = await read.handler({ chunk_id: 7 }, context);
  expect(result.isError).not.toBe(true); expect(result.content).not.toContain('foreign secret');
  vi.mocked(b.readChunk!).mockImplementation(async (...args) => { const result = await original(...args); result!.chunk.chunk_id = 99; return result; });
  expect(await read.handler({ chunk_id: 7 }, context)).toMatchObject({ isError: true, content: expect.stringContaining('different chunk') });
  expect(corpus.evidence.has(99)).toBe(false);
});

it('retains every read page for review, deduplicates re-reads and refuses inconsistent overlap', async () => {
  const b = backend(), corpus = new NativeDocsResearchCorpus(b), context = { cwd: process.cwd(), projectName: 'pages' };
  await corpus.decorate(ragSearchDocsTool).handler({ query: 'setup' }, context);
  const original = vi.mocked(b.readChunk!).getMockImplementation()!;
  vi.mocked(b.readChunk!).mockImplementation(async (...args) => {
    const page = (await original(...args))!, offset = args[0].char_offset ?? 0;
    Object.assign(page.chunk, { char_offset: offset, content: offset === 0 ? 'ABCD' : offset === 4 ? 'EFGH' : 'CHANGED',
      next_char_offset: offset === 0 ? 4 : null }); return page;
  });
  const read = corpus.decorate(ragReadDocTool);
  for (const char_offset of [0, 4, 0]) expect((await read.handler({ chunk_id: 7, char_offset }, context)).isError).not.toBe(true);
  expect(JSON.parse(corpus.reviewEvidence())[0]).toMatchObject({ content: 'ABCD', char_offset: 0, partial: true,
    additional_pages: [{ char_offset: 4, content: 'EFGH' }] });
  const prior = corpus.reviewEvidence();
  expect(await read.handler({ chunk_id: 7, char_offset: 2 }, context)).toMatchObject({ isError: true, content: expect.stringContaining('changed between pages') });
  expect(corpus.reviewEvidence()).toBe(prior);
});

it('applies the evidence byte budget to all accumulated pages without losing earlier evidence', async () => {
  const b = backend(), corpus = new NativeDocsResearchCorpus(b), context = { cwd: process.cwd(), projectName: 'page-budget' };
  await corpus.decorate(ragSearchDocsTool).handler({ query: 'setup' }, context);
  const original = vi.mocked(b.readChunk!).getMockImplementation()!;
  vi.mocked(b.readChunk!).mockImplementation(async (...args) => {
    const page = (await original(...args))!, offset = args[0].char_offset ?? 0;
    Object.assign(page.chunk, { char_offset: offset, content: 'x'.repeat(32768), next_char_offset: offset + 32768 }); return page;
  });
  const read = corpus.decorate(ragReadDocTool);
  for (let index = 0; index < 5; index++) expect((await read.handler({ chunk_id: 7, char_offset: index * 32768, max_chars: 32768 }, context)).isError).not.toBe(true);
  const previous = corpus.reviewEvidence();
  expect(await read.handler({ chunk_id: 7, char_offset: 5 * 32768, max_chars: 32768 }, context)).toMatchObject({ isError: true, content: expect.stringContaining('evidence budget') });
  expect(corpus.reviewEvidence()).toBe(previous); expect(Buffer.byteLength(previous)).toBeLessThan(192 * 1024);
});

it.each([
  { markdown: 'Unsupported.[^8]', citations: [8], confidence: 'high' },
  { markdown: 'No citation', citations: [7], confidence: 'high' },
  { markdown: 'Claim.[^7]\n[^7]: forged source', citations: [7], confidence: 'high' },
  { markdown: 'Claim.[^7]', citations: [7, 7], confidence: 'high' },
])('rejects invalid citation contracts: %j', answer => {
  expect(() => parseNativeResearchAnswer(JSON.stringify(answer), new Map([[7, evidence]]))).toThrow();
});
it('reports low confidence without citations and rejects oversized source output', () => {
  expect(parseNativeResearchAnswer(JSON.stringify({ markdown: 'No evidence found.', citations: [], confidence: 'high' }), new Map())).toMatchObject({ confidence: 'low' });
  expect(() => parseNativeResearchAnswer('x'.repeat(65_537), new Map())).toThrow('bounded output');
});
