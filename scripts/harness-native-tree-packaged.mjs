// Exercise internal native tree composition from the actual ASAR, then read its
// durable child history in a fresh process. This does not activate product tools.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';

const [packageArg, outputArg, phase] = process.argv.slice(2);
if (!packageArg || !outputArg) throw new Error('Expected win-unpacked directory and fresh report directory');
const candidate = resolve(packageArg), output = resolve(outputArg);
const archive = join(candidate, 'resources', 'app.asar');
if (!phase) {
  await mkdir(output);
  const asarSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  for (const step of ['execute', 'recover']) {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const run = spawnSync(join(candidate, 'CodeStudio.exe'), [fileURLToPath(import.meta.url), candidate, output, step],
      { env, stdio: 'inherit', windowsHide: true, timeout: 180_000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, `Packaged tree ${step} failed`);
  }
  const execution = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
  const recovery = JSON.parse(await readFile(join(output, 'recovery.json'), 'utf8'));
  const report = { passed: true, asarSha256, execution, recovery,
    scope: 'Internal Rust tree composition from packaged ASAR with deterministic providers; fresh-process history recovery; no product catalog activation or installed profile' };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, asarSha256, activations: execution.activations, recovered: recovery.references }));
} else {
  await runPhase();
}

async function runPhase() {
  const dataDir = join(output, 'data'), projectRoot = join(output, 'project');
  Object.assign(process.env, { MCP_DATA_DIR: dataDir, MCP_INDEX_DB: join(dataDir, 'index.db'),
    MCP_RUNTIME_COORDINATION_DIR: join(output, 'coordination'), MCP_DISABLE_TELEMETRY: '1', MCP_PROJECT_DB: '0' });
  const load = path => import(pathToFileURL(join(archive, 'dist', path)).href);
  const { FsSessionStore } = await load('packages/session-storage/src/fs-store/index.js');
  const { ControlPlaneFileRepository } = await load('packages/session-storage/src/index.js');
  const { FileControlPlaneStore } = await load('apps/http-api/file-control-plane-store.js');
  const { MessageBridge } = await load('packages/orchestrator-host/src/index.js');
  const { createNativeChildHistoryReader } = await load('apps/http-api/workers/native-child-history-reader.js');
  const { registerWorkerNativeChildHistory } = await load('apps/http-api/sse/worker-native-child-history.js');
  const { findRetainedAgent } = await load('packages/code-agent/src/tools/read-agent-transcript.js');
  const { stopResumeSweepForTests, peekSessionGroupCountForTests } = await load('packages/code-agent/src/tools/subagent-resume-registry.js');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const sessions = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: () => projectRoot, listProjectRoots: () => [{ project_id: 1, root_path: projectRoot }],
  } });
  const store = new FileControlPlaneStore(sessions), channels = new MessageChannel();
  const main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const paths = { packageDirectory: join(candidate, 'resources', 'native-agent-runtime', 'x86_64-pc-windows-msvc'),
    anchorPath: join(archive, 'dist', 'apps', 'electron', 'native-agent-runtime-integrity.json'), sessionRoot: join(output, 'native-sessions') };
  let execution, bus, offHistory;
  try {
    if (phase === 'recover') {
      const saved = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
      assert.equal(peekSessionGroupCountForTests(saved.sessionId), 0, 'Recovery must start without the first process cache');
      let ownerLive = true;
      offHistory = registerWorkerNativeChildHistory(main, (runId, closing) => ({ sessionId: saved.sessionId, projectId: 1,
        store, signal: new AbortController().signal, assertOwner() { assert(ownerLive && runId === 0 && closing === true); } }));
      const read = createNativeChildHistoryReader(worker, 0, paths);
      for (const index of [1, 2]) {
        const agent = await findRetainedAgent(saved.sessionId, saved.groupId, index, sessions);
        assert(agent?.nativeTranscriptRef, `Missing retained child ${index}`);
        const digest = await read(agent.nativeTranscriptRef, { maxChars: 4000 });
        assert(digest.includes(index === 1 ? 'record_memo' : 'PACKAGE_WRITE_COMPLETE'), digest);
      }
      assert.equal(await readFile(join(projectRoot, 'child.txt'), 'utf8'), 'exactly once');
      const recovered = await findRetainedAgent(saved.sessionId, saved.groupId, 2, sessions);
      ownerLive = false;
      await assert.rejects(read(recovered.nativeTranscriptRef), /assertion|false|assert/i);
      await writeFile(join(output, 'recovery.json'), JSON.stringify({ passed: true, references: 2, coldWorkerRunId: 0,
        noExecutionAuthority: true, staleOwnerRejected: true, pid: process.pid }, null, 2));
      return;
    }
    assert.equal(phase, 'execute');
    const { ToolRegistry } = await load('packages/code-agent/src/core/registry.js');
    const { fsTools } = await load('packages/code-agent/src/tools/fs.js');
    const { prepareCoderAttempt } = await load('packages/code-agent/src/runtime/attempt-preparation.js');
    const { rememberNativeProviderSelection } = await load('packages/code-agent/src/runtime/native-provider-binding.js');
    const { buildSpawnAgentTool } = await load('packages/code-agent/src/tools/spawn-agent.js');
    const { buildResumeAgentTool } = await load('packages/code-agent/src/tools/resume-agent.js');
    const { buildRequestReviewTool } = await load('packages/code-agent/src/tools/request-review.js');
    const { buildReadAgentTranscriptTool } = await load('packages/code-agent/src/tools/read-agent-transcript.js');
    const { resolveRuntimePolicyV1 } = await load('packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js');
    const { hashControlPlanePayload } = await load('packages/store/src/control-plane/index.js');
    const { executeNativeCoder } = await load('apps/http-api/workers/native-coder-execution.js');
    const { dispatchNativeAuthority } = await load('apps/http-api/workers/native-authority-bridge.js');
    const { createBus } = await load('apps/http-api/coder-bus.js');
    const session = await sessions.createSession({ project_id: 1, provider: 'openai', model: 'fixture', title: 'Packaged native tree' });
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
    const approvals = [];
    bus.subscribers.add(event => {
      if (event.event === 'tool_approval_request') {
        const pending = Promise.resolve().then(() => execution.resolveInteraction(`tool_approval:${event.data.toolUseId}`,
          { idempotencyKey: `approve:${event.data.toolUseId}`, value: '{"approved":true}' }));
        void pending.catch(cause => bus.ctrl.abort(cause)); approvals.push(pending);
      }
    });
    const tool = (id, name, input) => [{ type: 'tool_call_start', id, name }, { type: 'tool_call_end', id, name, input }, { type: 'done' }];
    const childProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      const encoded = JSON.stringify(request.messages);
      if (encoded.includes('PACKAGE_MEMO')) {
        if (!encoded.includes('package-memo-call')) yield* tool('package-memo-call', 'record_memo', { text: 'Preserve settings.', kind: 'warning' });
        else { yield { type: 'text_delta', text: 'PACKAGE_MEMO_COMPLETE' }; yield { type: 'done' }; }
      } else {
        assert(encoded.includes('PACKAGE_WRITE'));
        if (!encoded.includes('package-write-call')) yield* tool('package-write-call', 'create_file', { path: 'child.txt', content: 'exactly once' });
        else { yield { type: 'text_delta', text: 'PACKAGE_WRITE_COMPLETE' }; yield { type: 'done' }; }
      }
    } };
    const reviewer = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      assert(!JSON.stringify(request.messages).includes('Root private context'));
      yield { type: 'text_delta', text: '<review>{"findings":[]}</review>' }; yield { type: 'done' };
    } };
    for (const provider of [childProvider, reviewer]) rememberNativeProviderSelection(provider, { provider: 'openai', model: 'fixture' });
    let calls = 0, groupId;
    const provider = { name: 'openai', model: 'fixture', setModel() {}, async *chat() {
      calls++;
      if (calls === 1) yield* tool('package-spawn', 'spawn_agent', { agents: [
        { task: 'PACKAGE_MEMO record a warning.', profile: 'explore', label: 'memo', max_turns: 3 },
        { task: 'PACKAGE_WRITE create child.txt once.', profile: 'implement', label: 'writer', max_turns: 1, files: ['child.txt'] },
      ] });
      else if (calls === 2) {
        groupId = bus.buffer.find(event => event.event === 'agents_group_start').data.groupId;
        yield* tool('package-resume', 'resume_agent', { spawn_id: groupId, guidance: 'Summarize the confirmed write without repeating it.' });
      } else if (calls === 3) yield* tool('package-history', 'read_agent_transcript', { spawn_id: groupId, agent: 2, max_chars: 4000 });
      else if (calls === 4) yield* tool('package-review', 'request_review', { spec: 'Check the child file.', diff: 'diff --git a/child.txt b/child.txt\n+exactly once' });
      else { yield { type: 'text_delta', text: 'PACKAGE_TREE_COMPLETE' }; yield { type: 'done' }; }
    } };
    const registry = new ToolRegistry();
    for (const name of ['create_file', 'read_file']) registry.register(fsTools.find(value => value.name === name));
    const deps = { provider, subagentProvider: childProvider, parentTools: registry.list(), sessionId: session.id, sessionStore: sessions };
    registry.register(buildSpawnAgentTool(deps, registry)); registry.register(buildResumeAgentTool(deps));
    registry.register(buildReadAgentTranscriptTool(sessions));
    registry.register(buildRequestReviewTool({ ...deps, reviewerProvider: reviewer })); registry.seal();
    const systemPrompt = 'Root private context. Complete the owned task.';
    const runtime = resolveRuntimePolicyV1({ request: { revision: 'packaged-tree', values: {
      execution: { maxTurns: 30, maxToolCalls: 20, maxWallMs: 100_000 } } } });
    const prepared = { registry, provider, systemPrompt, thinking: false, maxTurns: 30,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run the tree.' }] }],
      toolContext: { cwd: projectRoot, projectName: 'packaged-tree', sessionId: session.id,
        runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: context.agentRunId },
      preparation: prepareCoderAttempt({ sessionId: session.id, agentRunId: context.agentRunId, runnerRunId: randomUUID(),
        provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
        systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: projectRoot },
        policy: { permissionMode: 'auto', planMode: false, specMode: false, runtime } }, registry) };
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {}, prepared,
      tree: { maxAgents: 5, maxDepth: 2, maxParallel: 2 }, config: { mode: 'test', context, ...paths,
        workspaceRoot: projectRoot, workspaceLeaseRoot: join(output, 'workspace-leases') } });
    const outcome = await execution.done; await Promise.all(approvals);
    assert.equal(outcome.reason, 'completed', JSON.stringify(outcome));
    const results = bus.buffer.filter(event => event.event === 'tool_call_result').map(event => event.data);
    assert.equal(results.length, 4, JSON.stringify(results));
    for (const result of results.slice(1)) assert.equal(result.result.isError, false, JSON.stringify(result));
    assert(JSON.stringify(results).includes('Preserve settings.')); assert(JSON.stringify(results).includes('PACKAGE_WRITE_COMPLETE'));
    assert.equal(await readFile(join(projectRoot, 'child.txt'), 'utf8'), 'exactly once');
    const writer = await findRetainedAgent(session.id, groupId, 2, sessions); assert.equal(writer.attempt, 2);
    const repository = new ControlPlaneFileRepository({ sessionRoot: sessions.catalog.get(session.id).location.bundle_path });
    const activations = (await repository.list('nativeActivation')).items.length; assert.equal(activations, 5);
    assert.deepEqual(JSON.parse(await readFile(join(output, 'workspace-leases', 'leases.json'), 'utf8')).state.leases, []);
    await writeFile(join(output, 'execution.json'), JSON.stringify({ passed: true, sessionId: session.id, groupId,
      activations, rootProviderCalls: calls, toolResults: results.length, preservedWrite: true, resumedAttempt: writer.attempt, pid: process.pid }, null, 2));
  } finally {
    bus?.ctrl.abort();
    if (execution) { await execution.cancel({ code: 'user_cancelled' }).catch(() => {}); await execution.done.catch(() => {}); }
    offHistory?.(); main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close();
    stopResumeSweepForTests(); await sessions.close();
  }
}
