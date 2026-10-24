import { createHash, randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { ragSearchDocsTool, setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import { ragReadDocTool } from '@mcp/code-agent/tools/rag-read-doc.js';
import { ragDocOutlineTool } from '@mcp/code-agent/tools/rag-doc-outline.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { docsDeepResearchTool } from '../../../packages/docs-agent/src/bridges/docs-bridge.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage, inspectUnresolvedCapabilityDispatches } from '@mcp/agent-runtime-host';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
const reports: unknown[] = [];
physicalIt.each(['complete', 'cancel'] as const)('runs documentation research and review in the owned Rust tree: %s', async scenario => {
  const f = await supervisorFactFixture('coder', 120_000), channels = new MessageChannel();
  const main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const bus = createBus(new AbortController()), root = join(f.directory, 'project'), leases = join(f.directory, 'leases');
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  let searching!: () => void;
  const entered = new Promise<void>(done => { searching = done; });
  let searchCount = 0, readCount = 0, rootCalls = 0, researchCalls = 0, reviewCalls = 0;
  let cancelAckMs: number | undefined;
  const answer = JSON.stringify({ markdown: 'Enable strict mode.[^7]', citations: [7], confidence: 'high' });
  const source = { chunk_id: 7, collection: 'native-docs-v3', source_id: 2, source_uri: 'https://docs.example.test/v3',
    heading_path: 'Configure', anchor: null, api_symbol: null, api_signature: null, concepts: [], summary: null };
  setGlobalDocSearch({
    async search(input, signal) {
      expect(input.collection).toBe('native-docs-v3'); expect(input.scope).toBe('project');
      searchCount++; searching();
      if (scenario === 'cancel') await new Promise<void>((_done, reject) => {
        const abort = () => reject(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      return { results: [{ ...source, snippet: 'Enable strict mode', score: 1, relevance: 0.99 }],
        diag: { fts_hits: 1, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } };
    },
    async readChunk(input, signal) {
      signal?.throwIfAborted(); expect(input).toMatchObject({ chunk_id: 7, window: 0 }); readCount++;
      return { chunk: { ...source, content: 'Enable strict mode before configure().', token_count: 12 }, prev: [], next: [] };
    },
  });
  main.handle('native.authority', payload => {
    const packet = payload as { agentRunId: string; operation: NativeAuthorityOperation };
    return dispatchNativeAuthority({ authority: f.store, context: f.context, ...packet, assertOwner() {} });
  });
  const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
    if (request.system.includes('You research indexed documentation.')) {
      researchCalls++;
      expect(request.tools.map(t => t.name).sort()).toEqual(['rag_doc_outline', 'rag_read_doc', 'rag_search_docs', 'record_memo']);
      if (researchCalls === 1 || researchCalls === 2) {
        const name = researchCalls === 1 ? 'rag_search_docs' : 'rag_read_doc', id = `doc-${researchCalls}`;
        yield { type: 'tool_call_start', id, name };
        yield { type: 'tool_call_end', id, name, input: researchCalls === 1 ? { query: 'configure v3' } : { chunk_id: 7 } };
      } else yield { type: 'text_delta', text: answer };
    } else if (request.system.includes('Review the draft against the supplied evidence.')) {
      reviewCalls++; expect(request.tools.map(t => t.name)).toEqual(['record_memo']);
      expect(JSON.stringify(request.messages)).toContain('Enable strict mode before configure().');
      yield { type: 'text_delta', text: answer };
    } else {
      rootCalls++;
      if (rootCalls === 1) {
        yield { type: 'tool_call_start', id: 'research', name: 'docs_deep_research' };
        yield { type: 'tool_call_end', id: 'research', name: 'docs_deep_research', input: { query: 'How to configure v3?', collections: ['native-docs-v3'] } };
      } else {
        expect(JSON.stringify(request.messages)).toContain('confidence: high');
        expect(JSON.stringify(request.messages)).toContain('native-child-journal:');
        yield { type: 'text_delta', text: 'Research and independent review completed.' };
      }
    }
    yield { type: 'done' };
  } };
  try {
    const registry = new ToolRegistry(); registry.registerAll([ragSearchDocsTool, ragReadDocTool, ragDocOutlineTool, docsDeepResearchTool]); registry.seal();
    const systemPrompt = 'Use docs_deep_research for a cited answer.', started = performance.now();
    const preparation = prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId,
      runnerRunId: randomUUID(), provider: 'openai', model: 'fixture', agentDefinitionId: 'coder',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
      environment: { kind: 'host', cwd: root }, policy: { permissionMode: 'auto', planMode: false, specMode: false,
        runtime: resolveRuntimePolicyV1({ request: { revision: 'native-docs', values: { execution: { maxTurns: 12, maxToolCalls: 24, maxWallMs: 90_000 } } } }) } }, registry);
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: f.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(f.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: leases },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 12,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Research configuration.' }] }],
        toolContext: { cwd: root, projectName: 'docs-native', projectId: 1, runtimeGeneration: 'rust_v1', signal: bus.ctrl.signal } } });
    if (scenario === 'cancel') { await entered; const startCancel = performance.now();
      await execution.cancel({ code: 'user_cancelled' }); cancelAckMs = performance.now() - startCancel; }
    const outcome = await execution.done;
    expect(outcome.reason).toBe(scenario === 'complete' ? 'completed' : 'aborted');
    expect(outcome.effectOutcome).toBeUndefined();
    expect(JSON.parse(await readFile(join(leases, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    const routes = (await f.repository.list('runtimeRoute')).items;
    expect(routes).toHaveLength(scenario === 'complete' ? 3 : 2);
    expect(routes.every(row => (row.data.route as { runtimeGeneration?: string }).runtimeGeneration === 'rust_v1')).toBe(true);
    const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
    const reader = await NativeSessionReader.open(runtime, { rootPath: join(f.directory, 'native-sessions'), sessionId: f.context.sessionId });
    try {
      expect(await inspectUnresolvedCapabilityDispatches(reader.store, f.context.sessionId, 10_000)).toEqual([]);
      if (scenario === 'complete') {
        expect([rootCalls, researchCalls, reviewCalls, searchCount, readCount]).toEqual([2, 3, 1, 1, 1]);
        const history = await projectNativeSessionHistory(reader, f.context.sessionId, new Date().toISOString());
        expect(JSON.stringify(history)).toContain('docs_deep_research');
        expect(JSON.stringify(history)).toContain('native-child-journal:');
      } else expect(reviewCalls).toBe(0);
    } finally { await reader.close(); }
    reports.push({ scenario, passed: true, durationMs: performance.now() - started, rootCalls, researchCalls, reviewCalls,
      searchCount, readCount, nativeAttempts: routes.length, remainingWorkspaceLeases: 0, unresolvedEffects: 0, cancelAckMs,
      scope: 'Real contained Rust processes and durable native journals; deterministic local provider and corpus fixtures, no live account calls.' });
    const reportPath = process.env.MCP_NATIVE_DOCS_REPORT;
    if (reportPath) {
      if (!resolve(reportPath).startsWith(resolve('scratch') + sep)) throw new Error('Report must remain inside workspace scratch');
      await writeFile(reportPath, JSON.stringify(reports, null, 2));
    }
  } finally {
    bus.ctrl.abort(); await execution?.done.catch(() => undefined);
    main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close();
    setGlobalDocSearch(null); await f.sessions.close();
    if (!resolve(f.directory).startsWith(resolve(tmpdir()) + sep + 'codestudio-supervisor-facts-')) throw new Error('Refusing unrelated temporary directory cleanup');
    await rm(f.directory, { recursive: true, force: true });
  }
}, 120_000);
