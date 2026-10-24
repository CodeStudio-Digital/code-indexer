// Run through modules and native binaries shipped in the candidate installer.
// The outer run-tracked-test.ps1 job owns this script and every child PID.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';

const [packageArg, outputArg, phase] = process.argv.slice(2);
if (!packageArg || !outputArg) throw new Error('Expected win-unpacked directory and fresh report directory');
const candidate = resolve(packageArg), output = resolve(outputArg), archive = join(candidate, 'resources', 'app.asar');
if (!phase) {
  await mkdir(output);
  const asarSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  for (const step of ['execute', 'recover']) {
    const run = spawnSync(join(candidate, 'CodeStudio.exe'), [fileURLToPath(import.meta.url), candidate, output, step],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, timeout: 180_000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, `Packaged documentation ${step} failed`);
  }
  const execution = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
  const recovery = JSON.parse(await readFile(join(output, 'recovery.json'), 'utf8'));
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, asarSha256, execution, recovery,
    scope: 'Packaged ASAR, persisted preview setting, real Rust processes, selected deterministic provider and local corpus; fresh-process root and child history. No user profile or live account calls.' }, null, 2));
  console.log(JSON.stringify({ passed: true, asarSha256, nativeAttempts: execution.nativeAttempts, references: recovery.references }));
} else await runPhase();

async function runPhase() {
  const dataDir = join(output, 'data'), projectRoot = join(output, 'project'), dbPath = join(dataDir, 'index.db');
  Object.assign(process.env, { MCP_DATA_DIR: dataDir, MCP_INDEX_DB: dbPath,
    MCP_RUNTIME_COORDINATION_DIR: join(output, 'coordination'), MCP_DISABLE_TELEMETRY: '1', MCP_PROJECT_DB: '0' });
  delete process.env.CODESTUDIO_NATIVE_CODER_DEV;
  const load = path => import(pathToFileURL(join(archive, 'dist', path)).href);
  const { FsSessionStore } = await load('packages/session-storage/src/fs-store/index.js');
  const { ControlPlaneFileRepository } = await load('packages/session-storage/src/index.js');
  const { FileControlPlaneStore } = await load('apps/http-api/file-control-plane-store.js');
  const { MessageBridge } = await load('packages/orchestrator-host/src/index.js');
  const { NativeSessionReader, verifyRuntimePackage, parseRuntimePackageAnchor, inspectUnresolvedCapabilityDispatches } = await load('packages/agent-runtime-host/src/index.js');
  const { projectNativeSessionHistory } = await load('apps/http-api/native-session-history.js');
  await mkdir(dataDir, { recursive: true }); await mkdir(projectRoot, { recursive: true });
  const sessions = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: () => projectRoot, listProjectRoots: () => [{ project_id: 1, root_path: projectRoot }],
  } });
  const store = new FileControlPlaneStore(sessions), channels = new MessageChannel();
  const main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const paths = { packageDirectory: join(candidate, 'resources', 'native-agent-runtime', 'x86_64-pc-windows-msvc'),
    anchorPath: join(archive, 'dist', 'apps', 'electron', 'native-agent-runtime-integrity.json'), sessionRoot: join(dataDir, 'native-sessions') };
  let execution, bus, offHistory, clearSearch;
  try {
    const runtime = await verifyRuntimePackage(paths.packageDirectory, parseRuntimePackageAnchor(await readFile(paths.anchorPath)));
    if (phase === 'recover') {
      const saved = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
      const { createNativeChildHistoryReader } = await load('apps/http-api/workers/native-child-history-reader.js');
      const { registerWorkerNativeChildHistory } = await load('apps/http-api/sse/worker-native-child-history.js');
      offHistory = registerWorkerNativeChildHistory(main, (runId, closing) => ({ sessionId: saved.sessionId, projectId: 1,
        store, signal: new AbortController().signal, assertOwner() { assert.equal(runId, 0); assert.equal(closing, true); } }));
      const read = createNativeChildHistoryReader(worker, 0, paths);
      for (const ref of saved.references) assert((await read(ref, { maxChars: 12000 })).includes('strict mode'));
      const reader = await NativeSessionReader.open(runtime, { rootPath: paths.sessionRoot, sessionId: saved.sessionId });
      try {
        assert.deepEqual(await inspectUnresolvedCapabilityDispatches(reader.store, saved.sessionId, 10000), []);
        const history = await projectNativeSessionHistory(reader, saved.sessionId, new Date().toISOString());
        assert(JSON.stringify(history).includes('docs_deep_research'));
        assert(JSON.stringify(history).includes('native-child-journal:'));
      } finally { await reader.close(); }
      await writeFile(join(output, 'recovery.json'), JSON.stringify({ passed: true, pid: process.pid,
        references: saved.references.length, unresolvedEffects: 0, freshProcess: true }, null, 2));
      return;
    }
    assert.equal(phase, 'execute');
    const { ToolRegistry } = await load('packages/code-agent/src/core/registry.js');
    const { prepareCoderAttempt } = await load('packages/code-agent/src/runtime/attempt-preparation.js');
    const { ragSearchDocsTool, setGlobalDocSearch } = await load('packages/code-agent/src/tools/rag-search-docs.js');
    const { ragReadDocTool } = await load('packages/code-agent/src/tools/rag-read-doc.js');
    const { ragDocOutlineTool } = await load('packages/code-agent/src/tools/rag-doc-outline.js');
    const { docsDeepResearchTool, setGlobalDocsResearcher } = await load('packages/docs-agent/src/bridges/docs-bridge.js');
    const { resolveRuntimePolicyV1 } = await load('packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js');
    const { hashControlPlanePayload } = await load('packages/store/src/control-plane/index.js');
    const { executeNativeCoder } = await load('apps/http-api/workers/native-coder-execution.js');
    const { dispatchNativeAuthority } = await load('apps/http-api/workers/native-authority-bridge.js');
    const { nativeCoderDevelopmentConfig } = await load('apps/http-api/sse/native-coder-worker-handle.js');
    const { AppSettingsStore } = await load('packages/store/src/app-settings-store.js');
    const { createBus } = await load('apps/http-api/coder-bus.js');
    const Database = createRequire(join(archive, 'package.json'))('better-sqlite3'), db = new Database(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'); db.close();
    const settings = new AppSettingsStore(dbPath);
    try { settings.set('CODESTUDIO_NATIVE_CODER_DEV', '1'); delete process.env.CODESTUDIO_NATIVE_CODER_DEV;
      assert.equal(settings.applyToProcessEnv().applied, 1); } finally { settings.close(); }
    const session = await sessions.createSession({ project_id: 1, provider: 'openai', model: 'fixture', title: 'Packaged native documentation' });
    const command = { schemaVersion: 1, commandId: randomUUID(), sessionId: session.id, correlationId: randomUUID(),
      requestedAt: new Date().toISOString(), actor: { actorId: 'packaged-fixture', actorType: 'user', source: 'http' },
      kind: 'send_message', idempotencyKey: randomUUID(), payload: {} };
    const context = { sessionId: session.id, commandId: command.commandId, correlationId: command.correlationId,
      actor: command.actor, agentRunId: randomUUID(), attemptId: randomUUID(), executorOwnerId: `fixture:${randomUUID()}`, fencingEpoch: 1 };
    await store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: { ...context,
      role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
      executorExpiresAt: new Date(Date.now() + 120_000).toISOString() } });
    main.handle('native.authority', packet => dispatchNativeAuthority({ authority: store, context, ...packet, assertOwner() {} }));
    bus = createBus(new AbortController());
    const source = { chunk_id: 7, collection: 'packaged-docs-v3', source_id: 2, source_uri: 'https://docs.example.test/v3',
      heading_path: 'Configure', anchor: null, api_symbol: null, api_signature: null, concepts: [], summary: null };
    setGlobalDocSearch({ async search(input) { assert.equal(input.collection, source.collection); return {
      results: [{ ...source, snippet: 'Enable strict mode', score: 1, relevance: 0.99 }],
      diag: { fts_hits: 1, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } }; },
      async readChunk(input) { assert.equal(input.chunk_id, 7); return { chunk: { ...source, content: 'Enable strict mode before configure().', token_count: 12 }, prev: [], next: [] }; } });
    setGlobalDocsResearcher({ async runResearch() { throw new Error('Legacy research must never run inside the native tree'); } });
    clearSearch = () => { setGlobalDocSearch(null); setGlobalDocsResearcher(null); };
    const answer = JSON.stringify({ markdown: 'Enable strict mode.[^7]', citations: [7], confidence: 'high' });
    let rootCalls = 0, researchCalls = 0, reviewCalls = 0;
    const tool = (id, name, input) => [{ type: 'tool_call_start', id, name }, { type: 'tool_call_end', id, name, input }];
    const provider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      if (request.system.includes('You research indexed documentation.')) {
        researchCalls++;
        assert.deepEqual(request.tools.map(t => t.name).sort(), ['rag_doc_outline', 'rag_read_doc', 'rag_search_docs', 'record_memo']);
        if (researchCalls === 1) yield* tool('search', 'rag_search_docs', { query: 'configure v3' });
        else if (researchCalls === 2) yield* tool('read', 'rag_read_doc', { chunk_id: 7 });
        else yield { type: 'text_delta', text: answer };
      } else if (request.system.includes('Review the draft against the supplied evidence.')) {
        reviewCalls++; assert.deepEqual(request.tools.map(t => t.name), ['record_memo']);
        assert(JSON.stringify(request.messages).includes('Enable strict mode before configure().'));
        yield { type: 'text_delta', text: answer };
      } else {
        rootCalls++;
        if (rootCalls === 1) yield* tool('research', 'docs_deep_research', { query: 'How to configure v3?', collections: [source.collection] });
        else { assert(JSON.stringify(request.messages).includes('confidence: high')); yield { type: 'text_delta', text: 'PACKAGED_DOCS_COMPLETE' }; }
      }
      yield { type: 'done' };
    } };
    const registry = new ToolRegistry(); registry.registerAll([ragSearchDocsTool, ragReadDocTool, ragDocOutlineTool, docsDeepResearchTool]); registry.seal();
    const systemPrompt = 'Research indexed documentation with citations.', runtimePolicy = resolveRuntimePolicyV1({ request: {
      revision: 'packaged-docs', values: { execution: { maxTurns: 12, maxToolCalls: 24, maxWallMs: 100_000 } } } });
    const preparation = prepareCoderAttempt({ sessionId: session.id, agentRunId: context.agentRunId, runnerRunId: randomUUID(),
      provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: projectRoot },
      policy: { permissionMode: 'auto', planMode: false, specMode: false, runtime: runtimePolicy } }, registry);
    const config = await nativeCoderDevelopmentConfig({ context, sessionId: session.id, dbPath, projectRoot,
      workerFile: join(archive, 'dist', 'apps', 'http-api', 'workers', 'coder-worker.js') });
    assert(config); assert.equal(config.packageDirectory, paths.packageDirectory);
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, config, assertOwner() {}, prepared: {
      preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 12,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Research configuration.' }] }],
      toolContext: { cwd: projectRoot, projectName: 'packaged-docs', projectId: 1, runtimeGeneration: 'rust_v1', signal: bus.ctrl.signal } } });
    const outcome = await execution.done; assert.equal(outcome.reason, 'completed'); assert.equal(outcome.effectOutcome, undefined);
    assert.deepEqual([rootCalls, researchCalls, reviewCalls], [2, 3, 1]);
    const result = bus.buffer.find(event => event.event === 'tool_call_result' && event.data.name === 'docs_deep_research').data.result;
    assert.equal(result.isError, false); const references = [result.structuredData.nativeTranscriptRef, result.structuredData.reviewTranscriptRef];
    assert(references.every(ref => ref.startsWith('native-child-journal:')));
    const repository = new ControlPlaneFileRepository({ sessionRoot: sessions.catalog.get(session.id).location.bundle_path });
    const routes = (await repository.list('runtimeRoute')).items;
    assert.equal(routes.length, 3); assert(routes.every(row => row.data.route.runtimeGeneration === 'rust_v1'));
    assert.deepEqual(JSON.parse(await readFile(join(config.workspaceLeaseRoot, 'leases.json'), 'utf8')).state.leases, []);
    await writeFile(join(output, 'execution.json'), JSON.stringify({ passed: true, pid: process.pid, sessionId: session.id,
      references, nativeAttempts: routes.length, rootCalls, researchCalls, reviewCalls, persistedPreview: true,
      selectedProviderPreserved: true, workspaceLeases: 0 }, null, 2));
  } finally {
    bus?.ctrl.abort(); await execution?.done.catch(() => {}); clearSearch?.(); offHistory?.();
    main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close(); await sessions.close();
  }
}
