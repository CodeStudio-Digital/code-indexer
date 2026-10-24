// Run only through run-tracked-test.ps1: every candidate/child PID is owned by
// its ledger. Uses the packaged ASAR and a fresh synthetic data directory.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';

const [packageArg, outputArg, phase] = process.argv.slice(2);
if (!packageArg || !outputArg) throw new Error('Expected win-unpacked directory and fresh report directory');
const candidate = resolve(packageArg), output = resolve(outputArg), archive = join(candidate, 'resources', 'app.asar');
if (!phase) {
  await mkdir(output);
  const asarSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  for (const step of ['execute', 'recover', 'recover-again', 'child-chapters-write', 'child-chapters-read']) {
    const run = spawnSync(join(candidate, 'CodeStudio.exe'), [fileURLToPath(import.meta.url), candidate, output, step],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, timeout: 180_000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, `Packaged messaging ${step} failed`);
  }
  const execution = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
  const recovery = JSON.parse(await readFile(join(output, 'recovery.json'), 'utf8'));
  const repeatedRecovery = JSON.parse(await readFile(join(output, 'recover-again.json'), 'utf8'));
  const childChapters = JSON.parse(await readFile(join(output, 'child-chapters-read.json'), 'utf8'));
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, asarSha256, execution, recovery, repeatedRecovery, childChapters,
    scope: 'Actual packaged ASAR and Rust processes; deterministic providers; isolated data; no installed profile or external provider' }, null, 2));
  console.log(JSON.stringify({ passed: true, asarSha256, activations: execution.activations, recoveredInbox: recovery.messages }));
} else await runPhase();

async function runPhase() {
  if (phase.startsWith('child-chapters-')) {
    const { runPackagedChildChapters } = await import('./harness-native-child-chapters-packaged.mjs');
    return runPackagedChildChapters({ candidate, output, phase });
  }
  const dataDir = join(output, 'data'), projectRoot = join(output, 'project');
  Object.assign(process.env, { MCP_DATA_DIR: dataDir, MCP_INDEX_DB: join(dataDir, 'index.db'),
    MCP_RUNTIME_COORDINATION_DIR: join(output, 'coordination'), MCP_DISABLE_TELEMETRY: '1', MCP_PROJECT_DB: '0' });
  const load = path => import(pathToFileURL(join(archive, 'dist', path)).href);
  const { FsSessionStore } = await load('packages/session-storage/src/fs-store/index.js');
  const { ControlPlaneFileRepository } = await load('packages/session-storage/src/index.js');
  const { FileControlPlaneStore } = await load('apps/http-api/file-control-plane-store.js');
  const { MessageBridge } = await load('packages/orchestrator-host/src/index.js');
  const { hashControlPlanePayload } = await load('packages/store/src/control-plane/index.js');
  const { stopResumeSweepForTests } = await load('packages/code-agent/src/tools/subagent-resume-registry.js');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const sessions = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: () => projectRoot, listProjectRoots: () => [{ project_id: 1, root_path: projectRoot }],
  } });
  const store = new FileControlPlaneStore(sessions), channels = new MessageChannel();
  const main = new MessageBridge({ port: channels.port1 }), worker = new MessageBridge({ port: channels.port2 });
  const actor = { actorId: 'packaged-messaging-fixture', actorType: 'user', source: 'http' };
  let execution, bus, owner;
  const accept = async sessionId => {
    const command = { schemaVersion: 1, commandId: randomUUID(), sessionId, correlationId: randomUUID(),
      requestedAt: new Date().toISOString(), actor, kind: 'send_message', idempotencyKey: randomUUID(), payload: {} };
    const context = { sessionId, commandId: command.commandId, correlationId: command.correlationId, actor,
      agentRunId: randomUUID(), attemptId: randomUUID(), executorOwnerId: `fixture:${randomUUID()}`, fencingEpoch: 1 };
    await store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: { ...context,
      role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
      executorExpiresAt: new Date(Date.now() + 120_000).toISOString() } });
    return context;
  };
  try {
    if (phase === 'recover' || phase === 'recover-again') {
      const saved = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
      const context = await accept(saved.sessionId); await store.markRunStarted(context, 'readonly-recovery-fixture');
      const previous = phase === 'recover-again' ? JSON.parse(await readFile(join(output, 'recovery.json'), 'utf8')).context : undefined;
      const inbox = await store.readNativeContinuationInbox(context, previous
        ? { agentRunId: previous.agentRunId, attemptId: previous.attemptId } : { reference: saved.sourceRef });
      assert.equal(inbox.length, 3); assert.equal(new Set(inbox.map(entry => entry.id)).size, 3);
      assert(inbox.some(entry => entry.message === 'Recovered inbox: keep seed.txt unchanged.'));
      const { NativeTreeInventory } = await load('apps/http-api/workers/native-tree-inventory.js');
      const { NativeTreeMailbox } = await load('apps/http-api/workers/native-tree-mailbox.js');
      const mailbox = new NativeTreeMailbox(new NativeTreeInventory(context.agentRunId));
      mailbox.register(context.agentRunId, (key, payload) => store.commitRuntimeRequest(context, key, payload));
      await mailbox.restore(context.agentRunId, [...inbox, ...inbox]);
      const { create } = await import(pathToFileURL(join(archive, 'node_modules', '@bufbuild', 'protobuf', 'dist', 'esm', 'index.js')).href);
      const { agentV1Runtime: wire } = await load('packages/agent-runtime-contracts/src/index.js');
      const frontier = await mailbox.preparation(context.agentRunId, { prepare: async () => ({ resetContinuation: false }) }).prepare(
        create(wire.ProviderStartSchema, { messages: [create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER })] }),
        new AbortController().signal, false);
      assert(frontier.context.contentUtf8.includes('Recovered inbox: keep seed.txt unchanged.'));
      for (const entry of inbox) assert.equal(frontier.context.contentUtf8.split(entry.id).length, 2);
      await store.terminalizeRun({ context, status: 'completed', commandStatus: 'succeeded', reason: 'readonly recovery checked' });
      assert.equal(await readFile(join(projectRoot, 'seed.txt'), 'utf8'), 'preserved content');
      await writeFile(join(output, phase === 'recover' ? 'recovery.json' : 'recover-again.json'), JSON.stringify({ passed: true, messages: inbox.length,
        context, deduplicated: true, noEffectReplay: true, coldProcess: true, pid: process.pid }, null, 2));
      return;
    }
    assert.equal(phase, 'execute');
    const { ToolRegistry } = await load('packages/code-agent/src/core/registry.js');
    const { fsTools } = await load('packages/code-agent/src/tools/fs.js');
    const { interactionTools } = await load('packages/code-agent/src/tools/interaction.js');
    const { buildSpawnAgentTool } = await load('packages/code-agent/src/tools/spawn-agent.js');
    const { buildCollectAgentsTool } = await load('packages/code-agent/src/tools/collect-agents.js');
    const { sendMessage } = await load('packages/code-agent/src/tools/send-message.js');
    const { sendInput } = await load('packages/code-agent/src/tools/send-input.js');
    const { followupTask } = await load('packages/code-agent/src/tools/followup-task.js');
    const { prepareCoderAttempt } = await load('packages/code-agent/src/runtime/attempt-preparation.js');
    const { rememberNativeProviderSelection } = await load('packages/code-agent/src/runtime/native-provider-binding.js');
    const { resolveRuntimePolicyV1 } = await load('packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js');
    const { executeNativeCoder } = await load('apps/http-api/workers/native-coder-execution.js');
    const { dispatchNativeAuthority } = await load('apps/http-api/workers/native-authority-bridge.js');
    const { nativeChildTranscriptRef } = await load('apps/http-api/native-child-storage.js');
    const { createBus } = await load('apps/http-api/coder-bus.js');
    const session = await sessions.createSession({ project_id: 1, provider: 'openai', model: 'fixture', title: 'Packaged native messaging' });
    const context = await accept(session.id);
    main.handle('native.authority', packet => dispatchNativeAuthority({ authority: store, context, ...packet, assertOwner() {} }));
    bus = createBus(new AbortController());
    let questionReady; const question = new Promise(resolve => { questionReady = resolve; });
    bus.subscribers.add(event => { if (event.event === 'question') questionReady(); });
    let rootCalls = 0, childCalls = 0, jobId, target, sourceRef;
    const result = name => bus.buffer.filter(event => event.event === 'tool_call_result' && event.data.name === name).at(-1)?.data.result;
    const tool = (id, name, input) => [{ type: 'tool_call_start', id, name }, { type: 'tool_call_end', id, name, input }, { type: 'done' }];
    const provider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      rootCalls++;
      if (rootCalls === 1) yield* tool('spawn', 'spawn_agent', { background: true, agents: [{ task: 'Ask which file to read, then report.', profile: 'full', max_turns: 4 }] });
      else if (rootCalls === 2) {
        jobId = result('spawn_agent')?.structuredData?.jobId; assert.match(jobId, /^native-job-/);
        await abortable(question, request.signal);
        const child = owner.list({}).find(member => !member.is_self); target = child.path;
        const childContext = await store.resolveNativeChild(context, child.agent_run_id);
        sourceRef = nativeChildTranscriptRef(childContext, context.attemptId);
        await store.commitRuntimeRequest(childContext, `native-tree:inbox:${'c'.repeat(64)}`, { schema: 1, type: 'inbox',
          sourceAgentRunId: context.agentRunId, envelope: { id: 'c'.repeat(64), from: '/root', to: target,
            kind: 'message', message: 'Recovered inbox: keep seed.txt unchanged.' } });
        yield* tool('message', 'send_message', { to: target, message: 'The file is seed.txt; preserve it.' });
      } else if (rootCalls === 3) { assert.equal(result('send_message').isError, false); yield* tool('input', 'send_input', { to: target, message: 'No answer needed. Read seed.txt and summarize.' }); }
      else if (rootCalls === 4) { assert.equal(result('send_input').structuredData.interrupted, true); yield* tool('read', 'read_file', { path: 'seed.txt' }); }
      else if (rootCalls === 5) { assert.equal(result('read_file').isError, false); yield* tool('collect', 'collect_agents', { job_id: jobId, timeout_s: 30 }); }
      else if (rootCalls === 6) { assert.equal(result('collect_agents').isError, false); yield* tool('followup', 'followup_task', { to: target, task: 'Continue the same transcript: give the preserved file name without editing it.' }); }
      else if (rootCalls === 7) { jobId = result('followup_task').structuredData.jobId; assert.match(jobId, /^native-job-/); yield* tool('collect-followup', 'collect_agents', { job_id: jobId, timeout_s: 30 }); }
      else { assert.equal(rootCalls, 8); assert.equal(result('collect_agents').isError, false); yield { type: 'text_delta', text: 'Messaging complete' }; yield { type: 'done' }; }
    } };
    const childProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      childCalls++; const messages = JSON.stringify(request.messages);
      if (childCalls === 1) yield* tool('question', 'ask_user', { question: 'Which file should I inspect?' });
      else if (childCalls === 2) {
        assert(messages.includes('The file is seed.txt; preserve it.')); assert(messages.includes('No answer needed.'));
        assert(messages.includes('interrupted')); assert(!messages.includes('Recovered inbox:'));
        yield* tool('child-read', 'read_file', { path: 'seed.txt' });
      } else {
        if (childCalls === 4) { assert(messages.includes('Continue the same transcript')); assert(messages.includes('preserved content'));
          assert(messages.includes('Recovered inbox: keep seed.txt unchanged.')); }
        else assert.equal(childCalls, 3);
        yield { type: 'text_delta', text: 'Read seed.txt: preserved content.' }; yield { type: 'done' };
      }
    } };
    rememberNativeProviderSelection(childProvider, { provider: 'openai', model: 'fixture' });
    const registry = new ToolRegistry(); registry.register(fsTools.find(tool => tool.name === 'read_file'));
    registry.register(interactionTools.find(tool => tool.name === 'ask_user')); registry.registerAll([sendMessage, sendInput, followupTask]);
    const deps = { provider, subagentProvider: childProvider, parentTools: registry.list(), sessionId: session.id, sessionStore: sessions };
    registry.register(buildCollectAgentsTool(deps)); registry.register(buildSpawnAgentTool(deps, registry)); registry.seal();
    const systemPrompt = 'Execute the owned task and retain all human permission gates.';
    const runtime = resolveRuntimePolicyV1({ request: { revision: 'packaged-messaging', values: {
      execution: { maxTurns: 20, maxToolCalls: 20, maxWallMs: 100_000 }, subagents: { maxParallel: 2, maxDepth: 2 } } } });
    await writeFile(join(projectRoot, 'seed.txt'), 'preserved content');
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      tree: { maxAgents: 5, maxDepth: 2, maxParallel: 2, ready(value) { owner = value; } },
      config: { mode: 'test', context, packageDirectory: join(candidate, 'resources', 'native-agent-runtime', 'x86_64-pc-windows-msvc'),
        anchorPath: join(archive, 'dist', 'apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(output, 'native-sessions'),
        workspaceRoot: projectRoot, workspaceLeaseRoot: join(output, 'workspace-leases') },
      prepared: { registry, provider, systemPrompt, thinking: false, maxTurns: 20,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Coordinate the native agents.' }] }],
        toolContext: { cwd: projectRoot, projectName: 'packaged-messaging', sessionId: session.id, runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: context.agentRunId },
        preparation: prepareCoderAttempt({ sessionId: session.id, agentRunId: context.agentRunId, runnerRunId: randomUUID(), provider: 'openai', model: 'fixture',
          agentDefinitionId: 'coder', systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
          environment: { kind: 'host', cwd: projectRoot }, policy: { permissionMode: 'auto', planMode: false, specMode: false, runtime } }, registry) } });
    assert.equal((await execution.done).reason, 'completed'); assert.equal(rootCalls, 8); assert.equal(childCalls, 4);
    const repository = new ControlPlaneFileRepository({ sessionRoot: sessions.catalog.get(session.id).location.bundle_path });
    const rows = (await repository.list('runtimeRequest')).items, activations = (await repository.list('nativeActivation')).items.length;
    for (const [type, count] of [['message', 2], ['inbox', 6], ['result', 2]]) assert.equal(rows.filter(row => row.data.nativeTree?.type === type).length, count);
    assert.equal(activations, 3); assert.equal(await readFile(join(projectRoot, 'seed.txt'), 'utf8'), 'preserved content');
    assert.deepEqual(JSON.parse(await readFile(join(output, 'workspace-leases', 'leases.json'), 'utf8')).state.leases, []);
    assert.deepEqual(owner.shared.resources.snapshot(), { memoryBytes: 0, processes: 0, groups: 0 });
    await writeFile(join(output, 'execution.json'), JSON.stringify({ passed: true, sessionId: session.id, sourceRef,
      rootCalls, childCalls, activations, durableMessages: 2, recoveredInboxBeforeFrontier: true,
      workspaceBarrier: true, noPermissionApproval: true, pendingLeases: 0, pid: process.pid }, null, 2));
  } catch (cause) {
    await writeFile(join(output, `${phase}-failure.json`), JSON.stringify({ passed: false,
      error: cause instanceof Error ? cause.stack : String(cause), pid: process.pid,
      events: bus?.buffer.filter(event => ['error', 'run_error', 'tool_call_result', 'question', 'agents_group_end'].includes(event.event)).slice(-20),
    }, null, 2));
    throw cause;
  } finally {
    bus?.ctrl.abort(); if (execution) { await execution.cancel({ code: 'user_cancelled' }).catch(() => {}); await execution.done.catch(() => {}); }
    main.dispose(); worker.dispose(); channels.port1.close(); channels.port2.close(); stopResumeSweepForTests(); await sessions.close();
  }
}
async function abortable(promise, signal) {
  signal?.throwIfAborted(); let cancel;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    cancel = () => reject(signal.reason); signal?.addEventListener('abort', cancel, { once: true });
  })]); } finally { signal?.removeEventListener('abort', cancel); }
}
