import { createHash, randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1SessionStore as journal, asSessionCommandId, asCorrelationId, asAgentRunId, asAgentRunAttemptId } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { verifyRuntimePackage, parseRuntimePackageAnchor, NativeSessionReader, inspectNativeSupervisorLifecycleEvidence } from '@mcp/agent-runtime-host';
import { installNativeSessionHistory, projectNativeSessionHistory } from '../native-session-history.js';
import { MessageChannel } from 'node:worker_threads';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';
import { commitNativeSupervisorRecovery } from '../native-supervisor-recovery.js';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { nativeRecordId } from '../native-attempt-preparation.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['read', 'cancel', 'provider-failure'] as const)('runs the product native composition through worker authority RPC: %s', async (scenario) => {
  const product = await supervisorFactFixture('coder');
  const closeHistory = installNativeSessionHistory(product.sessions, product.directory);
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  const root = join(product.directory, 'project');
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=';
  let calls = 0;
  let started!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  let providerAborted = false;
  const committedOperations: string[] = [];
  const observedTools: string[] = [];
  let managementConnection = '';
  let currentContext = product.context;
  let currentRunId = 1;
  main.handle('native.authority', async (payload) => {
    const request = payload as { runId: number; operation: NativeAuthorityOperation };
    if (request.operation.kind === 'fact') managementConnection = request.operation.connectionId;
    expect(request.runId).toBe(currentRunId);
    const result = await dispatchNativeAuthority({ authority: product.store, context: currentContext,
      operation: request.operation, assertOwner() {} });
    committedOperations.push(request.operation.kind);
    return result;
  });
  try {
    const runtimePackage = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
    const inspectEvidence = (attemptId: string) => inspectNativeSupervisorLifecycleEvidence(runtimePackage, {
      rootPath: join(product.directory, 'native-sessions'), connectionId: managementConnection,
      sessionId: product.context.sessionId, attemptId,
    });
    const assertReconciled = async () => {
      const source = { rootPath: join(product.directory, 'native-sessions'), runtimePackage };
      const restarted = new FileControlPlaneStore(product.sessions, { nativeRecovery: {
        isPresent: async () => true, load: async () => source,
      } });
      const callsBeforeRecovery = calls;
      expect(await restarted.recoverInterruptedRuns('process-restart', new Date().toISOString(), { nativeOnly: true })).toBe(0);
      expect(await product.repository.get('checkpoint', nativeRecordId(product.context.attemptId, 'physical-recovery'))).not.toBeNull();
      expect(calls).toBe(callsBeforeRecovery);
      const receipt = await product.store.reconcileNativeSupervisor(product.context, source);
      expect(receipt).toMatchObject({ supervisorReaped: true, hostEffectsReconciled: false });
      expect(await product.store.reconcileNativeSupervisor(product.context, source)).toEqual(receipt);
      expect((await product.store.getAttemptState(product.context, false)).attempt.status).toBe('terminal');
      const evidence = (await inspectEvidence(product.context.attemptId))!;
      evidence.hostAcknowledged = false; // A lost ACK cannot change physical idempotency.
      expect(await commitNativeSupervisorRecovery(product.repository, product.context, product.identity, evidence)).toEqual(receipt);
      evidence.exited!.runnerProvenance!.pid++;
      await expect(commitNativeSupervisorRecovery(product.repository, product.context, product.identity, evidence))
        .rejects.toThrow('original process ownership');
      evidence.exited!.runnerProvenance!.pid--;
      evidence.connectionId = 'foreign-connection';
      await expect(commitNativeSupervisorRecovery(product.repository, product.context, product.identity, evidence))
        .rejects.toThrow('another connection');
    };
    await writeFile(join(root, 'sample.txt'), 'product-native-read');
    await writeFile(join(root, 'fixture.txt'), 'native durable document');
    const registry = new ToolRegistry();
    registry.register(fsTools.find((tool) => tool.name === 'read_file')!);
    registry.seal();
    const systemPrompt = 'Read the requested file and report its content.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId,
      agentRunId: product.context.agentRunId, runnerRunId: 'native-preparation', provider: 'openai', model: 'fixture',
      agentDefinitionId: 'coder', systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
      capabilityProfile: 'full', environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    const provider: ChatProvider = { name: 'adapter-protocol', model: 'resolved-vendor-model', setModel() {}, async *chat(request) {
      calls++;
      if (calls === 1) await expect(inspectEvidence(product.context.attemptId)).rejects.toMatchObject({ failure: { code: journal.SessionStoreFailureCode.LOCK_BUSY } });
      expect(request.system).toBe(systemPrompt);
      if (scenario === 'provider-failure') throw new Error('Fixture provider failure');
      if (scenario === 'read') {
        expect(request.messages[0]!.content).toContainEqual({ type: 'image', mediaType: 'image/png', base64: imageBase64 });
        expect(request.messages[0]!.content).toContainEqual({ type: 'document', name: 'fixture.txt', mediaType: 'text/plain', text: 'native durable document' });
      }
      if (scenario === 'cancel') {
        started();
        await new Promise<void>(resolve => {
          const aborted = () => { providerAborted = true; resolve(); };
          if (request.signal!.aborted) aborted();
          else request.signal!.addEventListener('abort', aborted, { once: true });
        });
        yield { type: 'done' }; return;
      }
      if (calls === 1) {
        expect(await product.store.getRuntimeRoute(product.context.sessionId, product.context.attemptId))
          .toMatchObject({ runtimeGeneration: 'rust_v1' });
        expect(committedOperations).toContain('activate');
        yield { type: 'tool_call_start', id: 'read-1', name: 'read_file' };
        yield { type: 'tool_call_end', id: 'read-1', name: 'read_file', input: { path: 'sample.txt' } };
      } else {
        const live = await closeHistory.readLive(product.context.sessionId);
        expect(live?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(JSON.stringify(live?.messages)).toContain('product-native-read');
        expect((await closeHistory.readLive(product.context.sessionId))?.messages).toEqual(live?.messages);
        const stats = await closeHistory.readLive(product.context.sessionId, { kind: 'stats', boundary: 0 });
        expect(stats?.messages).toEqual([]);
        expect(stats?.rows).toEqual([]);
        expect(stats?.selection).toMatchObject({ visibleCount: 3, maxSeq: 3 });
        expect((await product.sessions.loadSessionMessagesTail(product.context.sessionId, 1))?.message_rows.map(row => row.seq)).toEqual([2, 3]);
        expect(await product.sessions.getMessageCount(product.context.sessionId)).toBe(3);
        expect(await product.sessions.previousUserMessageSeq(product.context.sessionId, 3)).toBe(1);
        expect(JSON.stringify(request.messages)).toContain('product-native-read');
        yield { type: 'text_delta', text: 'native-worker-complete' };
      }
      yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 3 } };
      yield { type: 'done' };
    } };
    const execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: product.context,
        packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'),
        sessionRoot: join(product.directory, 'native-sessions'), workspaceRoot: root,
        workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Read sample.txt' },
          ...(scenario === 'read' ? [{ type: 'image' as const, mediaType: 'image/png', base64: imageBase64 },
            { type: 'document' as const, name: 'fixture.txt', mediaType: 'text/plain', path: join(root, 'fixture.txt') }] : [])] }],
        toolContext: { cwd: root, projectName: 'worker-native', signal: bus.ctrl.signal,
          onToolSettled: event => { if (!event.result.isError) observedTools.push(event.toolName); } }, signal: bus.ctrl.signal },
    });
    if (scenario === 'provider-failure') {
      await expect(execution.done).rejects.toThrow();
      const leaseState = JSON.parse(await readFile(join(product.directory, 'native-workspace-leases', 'leases.json'), 'utf8'));
      expect(leaseState.state.leases).toEqual([]);
      expect(calls).toBe(1);
      expect((await product.store.getAttemptState(product.context, false)).run.status).toBe('failed');
      await assertReconciled();
    } else if (scenario === 'cancel') {
      await providerStarted;
      expect((await closeHistory.readLive(product.context.sessionId))?.messages.map(message => message.role)).toEqual(['user']);
      await execution.cancel({ code: 'user_cancelled' });
      expect(await execution.done).toMatchObject({ reason: 'aborted' });
      expect(providerAborted).toBe(true);
      expect(calls).toBe(1);
      expect(await inspectEvidence(product.context.attemptId)).toMatchObject({ hostAcknowledged: true,
        exited: { identity: { attemptId: product.context.attemptId } }, reaped: { identity: { attemptId: product.context.attemptId } } });
      await assertReconciled();
    } else {
      expect(await execution.done).toMatchObject({ usage: { input_tokens: 20, output_tokens: 6 } });
      expect(calls).toBe(2);
      expect(observedTools).toEqual(['read_file']);
      expect(bus.buffer.some((row) => row.event === 'message_complete'
        && JSON.stringify(row.data).includes('native-worker-complete'))).toBe(true);
      expect(await inspectEvidence(product.context.attemptId)).toMatchObject({ hostAcknowledged: true,
        exited: { identity: { attemptId: product.context.attemptId } }, reaped: { identity: { attemptId: product.context.attemptId } } });
      await assertReconciled();
      const reader = await NativeSessionReader.open(runtimePackage, { rootPath: join(product.directory, 'native-sessions'),
        sessionId: product.context.sessionId, authority: create(journal.SessionStoreAuthoritySchema, {
          storageGeneration: journal.StorageGeneration.RUST_FS_V1,
          leaseEpoch: BigInt(product.context.fencingEpoch), writerId: product.context.attemptId,
        }) });
      try {
        const history = await projectNativeSessionHistory(reader, product.context.sessionId, new Date().toISOString());
        expect(history.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(JSON.stringify(history.messages)).toContain('Read sample.txt');
        expect(JSON.stringify(history.messages)).toContain('native-worker-complete');
        expect(JSON.stringify(history.messages[0])).toContain(imageBase64);
        expect(JSON.stringify(history.messages[0])).toContain('native durable document');
        const firstAttachments = (await reader.store.list(0n, 256)).records.filter(record => record.kind === journal.SessionRecordKind.ATTACHMENT);
        expect(firstAttachments).toHaveLength(2);
        // A subsequent command must use committed bytes even if the original disappears.
        await rm(join(root, 'fixture.txt'));
        expect(history.rows.map(row => row.seq)).toEqual([1, 2, 3, 4]);
        // A new command has a new run/attempt with control-plane epoch one.
        // The session storage authority must advance independently to two.
        currentContext = { ...product.context, commandId: asSessionCommandId(randomUUID()),
          correlationId: asCorrelationId(randomUUID()), agentRunId: asAgentRunId(randomUUID()),
          attemptId: asAgentRunAttemptId(randomUUID()), executorOwnerId: `host:${randomUUID()}` };
        currentRunId = 2;
        const command = { schemaVersion: 1 as const, commandId: currentContext.commandId, sessionId: currentContext.sessionId,
          correlationId: currentContext.correlationId, actor: currentContext.actor, requestedAt: new Date().toISOString(),
          kind: 'send_message' as const, idempotencyKey: randomUUID(), payload: {} };
        await product.store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
          ...currentContext, role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
          executorExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
        const nextBus = createBus(new AbortController());
        const nextPreparation = prepareCoderAttempt({ ...preparation, agentRunId: currentContext.agentRunId,
          runnerRunId: 'next-native-preparation' }, registry);
        const next = await executeNativeCoder({ bridge: worker, runId: 2, bus: nextBus, assertOwner() {},
          config: { mode: 'test', context: currentContext,
            packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
            anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'),
            sessionRoot: join(product.directory, 'native-sessions'), workspaceRoot: root,
            workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
          prepared: { preparation: nextPreparation, registry, systemPrompt, thinking: false, maxTurns: 3,
            messages: [...history.messages, { role: 'user', content: [{ type: 'text', text: 'Continue the same conversation' }] }],
            provider: { ...provider, async *chat(request) {
              expect(request.messages).toHaveLength(5);
              expect(JSON.stringify(request.messages)).toContain('native-worker-complete');
              expect(JSON.stringify(request.messages)).toContain(imageBase64);
              yield { type: 'text_delta', text: 'native-followup-complete' }; yield { type: 'done' };
            } }, toolContext: { cwd: root, projectName: 'worker-native', signal: nextBus.ctrl.signal }, signal: nextBus.ctrl.signal } });
        await next.done;
        await expect(reader.assertCurrent()).rejects.toThrow('concurrent');
        const nextReader = await NativeSessionReader.open(runtimePackage, { rootPath: join(product.directory, 'native-sessions'),
          sessionId: product.context.sessionId });
        try {
          expect(nextReader.state.authority!.leaseEpoch).toBe(2n);
          expect(nextReader.state.authority!.writerId).toBe(currentContext.attemptId);
          const nextHistory = await projectNativeSessionHistory(nextReader, product.context.sessionId, new Date().toISOString());
          expect(nextHistory.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
          expect(JSON.stringify(nextHistory.messages.at(-1))).toContain('native-followup-complete');
          expect(JSON.stringify(nextHistory.messages[0])).toContain(imageBase64);
          expect((await nextReader.store.list(0n, 256)).records.filter(record => record.kind === journal.SessionRecordKind.ATTACHMENT))
            .toEqual(firstAttachments);
        } finally { await nextReader.close(); }
      } finally { await reader.close(); }
    }
    expect(committedOperations.filter((kind) => kind === 'admit')).toHaveLength(scenario === 'read' ? 2 : 1);
    expect(committedOperations).toContain('terminal');
  } finally {
    await closeHistory();
    bus.ctrl.abort(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
