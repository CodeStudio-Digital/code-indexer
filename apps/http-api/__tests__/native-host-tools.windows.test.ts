import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import { expect, it } from 'vitest';
import { agentV1Runtime, agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import { ProviderGateway, composeNativeHydrationSources, type AgentRunHandleApi } from '@mcp/agent-runtime-host';
import type { ChatRequest } from '@mcp/provider-sdk/adapter.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { resolveCapabilitySet } from '@mcp/code-agent/core/capability-catalog.js';
import { PermissionGate, approvalAskId } from '@mcp/code-agent/core/permission-gate.js';
import { createMutationFenceAuthority } from '@mcp/code-agent/core/mutation-fence.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { createHostCapabilitySnapshot } from '@mcp/code-agent/runtime/host-capability-snapshot.js';
import { createToolRegistryCapabilityGatewayFactory } from '@mcp/code-agent/runtime/tool-registry-host-capability-executor.js';
import { createHostCapabilityPolicy } from '@mcp/code-agent/runtime/host-capability-policy.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import type { NativeRustHostAttemptRuntime } from '../../../packages/agent-runtime-host/src/native/NativeRustHostAttemptRuntime.js';
import { processRealFixture, readProcessRealEngineEvents } from '../../../packages/agent-runtime-host/src/__tests__/native-process-real-active-support.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { activateNativeCoderRuntimeFacade } from '../sse/native-coder-runtime-facade.js';
import { createBus, publish } from '../coder-bus.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { NativeContentAssembler } from '../../../packages/agent-runtime-host/src/native/NativeContentAssembler.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each([
  { approveWrite: true, cancelReads: false },
  { approveWrite: false, cancelReads: false },
  { approveWrite: false, cancelReads: true },
])('runs real Host tools through the native facade: %j', async ({ approveWrite, cancelReads }) => {
  const product = await supervisorFactFixture('coder');
  let fixture: Awaited<ReturnType<typeof processRealFixture>> | undefined;
  let runtime: NativeRustHostAttemptRuntime | undefined;
  let interactions: NativeCoderInteractions | undefined;
  let material: Awaited<ReturnType<typeof prepareNativeCoderContext>> | undefined;
  try {
    fixture = await processRealFixture(false, true, undefined, 1, undefined, undefined, product.identity);
    const root = fixture.workspaceRoot!;
    await Promise.all([1, 2, 3].map((index) => writeFile(join(root, `parallel-${index}.txt`), `parallel result ${index}`)));
    const bus = createBus(new AbortController());
    interactions = new NativeCoderInteractions(bus.ctrl.signal);
    let runningReads = 0, maximumReads = 0, startedReads = 0;
    let slowFinished = false;
    let releaseReaders!: () => void, releaseSlowRead!: () => void;
    const readersReady = new Promise<void>((resolve) => { releaseReaders = resolve; });
    const slowRead = new Promise<void>((resolve) => { releaseSlowRead = resolve; });
    const registry = new ToolRegistry();
    for (const tool of [...fsTools.filter((tool) => ['read_file', 'create_file'].includes(tool.name)),
      ...shellTools.filter((tool) => tool.name === 'run_command')]) registry.register({ ...tool,
        async handler(input, context) {
          if (tool.name !== 'read_file') { expect(runningReads).toBe(0); return tool.handler(input, context); }
          const ordinal = startedReads++;
          runningReads++; maximumReads = Math.max(maximumReads, runningReads);
          try {
            if (ordinal < 4) {
              if (startedReads === 4) releaseReaders();
              await Promise.race([readersReady, aborted(bus.ctrl.signal)]);
              if (cancelReads) await aborted(bus.ctrl.signal);
              if (ordinal === 0) await Promise.race([slowRead, aborted(bus.ctrl.signal)]);
            }
            const result = await tool.handler(input, context);
            if (ordinal === 0) slowFinished = true;
            return result;
          } finally { runningReads--; }
        },
      });
    registry.seal();
    const { set } = resolveCapabilitySet(registry.list(), { agentRunId: product.context.agentRunId });
    const wireSnapshot = createHostCapabilitySnapshot(registry, set);
    const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, fixture.prepare.encodedSpec);
    spec.deadlineAtUnixMs = BigInt(Date.now() + 45_000);
    spec.capabilitySetSnapshot!.contentSha256 = wireSnapshot.snapshotSha256;
    const source = fixture.options.data.source;
    const replaceRefs = new Set([spec.agentDefinitionSnapshot!.ref, spec.capabilitySetSnapshot!.ref, spec.presetSnapshot!.ref]);
    const systemPrompt = 'Use the product tools and preserve earlier context.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
      runnerRunId: product.context.attemptId, provider: spec.providerBinding!.effectiveProvider,
      model: spec.providerBinding!.effectiveModel, agentDefinitionId: spec.agentDefinitionId,
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
      environment: { kind: 'host', cwd: root }, policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    material = await prepareNativeCoderContext({ preparation, registry, systemPrompt, thinking: false, maximumBytes: 1024 * 1024,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Previous question' }] },
        { role: 'assistant', content: [{ type: 'thinking', text: 'Previous reasoning' }, { type: 'text', text: 'Previous answer' }], phase: 'final_answer' },
        { role: 'user', content: [{ type: 'text', text: 'real Host tools' },
          { type: 'image', mediaType: 'image/png', base64: 'AQID' }] },
      ] });
    spec.initialConversationSnapshot = material.initialConversationSnapshot;
    spec.task = material.task;
    spec.agentDefinitionSnapshot = material.definitionSnapshot;
    spec.capabilitySetSnapshot = material.capabilitySetSnapshot;
    spec.presetSnapshot = material.presetSnapshot;
    spec.providerBinding = material.providerBinding;
    const retained = source.items.flatMap((item, ordinal) => item.reference.case === 'snapshot' && replaceRefs.has(item.reference.value.ref)
      ? [] : [{ item, ordinal }]);
    const modifiedSource = composeNativeHydrationSources(spec, [{
      items: [...retained.map(({ item }) => item), ...material.source.items],
      readExact: (ordinal: number, offset: bigint, length: number, signal?: AbortSignal) => ordinal >= retained.length
        ? material!.source.readExact(ordinal - retained.length, offset, length, signal)
        : source.readExact(retained[ordinal]!.ordinal, offset, length, signal),
      close: async (cause?: unknown) => { await source.close(cause); await material!.source.close(cause); },
    }]);
    const approvals: string[] = [];
    let firstResultVisible!: () => void;
    const firstResult = new Promise<void>((resolve) => { firstResultVisible = resolve; });
    let releaseHandle!: (handle: AgentRunHandleApi) => void;
    const handleReady = new Promise<AgentRunHandleApi>((resolve) => { releaseHandle = resolve; });
    let approvalFailure: unknown;
    const permissions = new PermissionGate({ getMode: () => 'ask',
      waitForUserInput: (id) => interactions!.waitForInput(id),
      emit(event, payload) {
        publish(bus, event, payload);
        if (event !== 'tool_approval_request') return;
        approvals.push(String(payload.toolName));
        if (payload.toolName === 'create_file') expect(existsSync(join(root, 'created.txt'))).toBe(false);
        void (async () => {
          if (payload.toolName === 'create_file') {
            await firstResult;
            expect(bus.buffer.some((row) => row.event === 'tool_call_result'
              && (row.data as { provider_tool_use_id: string }).provider_tool_use_id === 'host-tool:0')).toBe(true);
            const replayed = [];
            for await (const committed of runtime!.replayCommittedEvents()) replayed.push(committed.record);
            expect(replayed.some((record) => record.body.case === 'capabilityTerminal'
              && record.body.value.toolUseId === 'host-tool:0')).toBe(true);
          }
          const handle = await handleReady;
          const response = { value: JSON.stringify({ approved: payload.toolName !== 'create_file' || approveWrite }), idempotencyKey: `approve:${String(payload.toolUseId)}` };
          await handle.resolveInteraction(approvalAskId(String(payload.toolUseId)), response);
          await handle.resolveInteraction(approvalAskId(String(payload.toolUseId)), response);
        })().catch((cause) => { approvalFailure = cause; bus.ctrl.abort(cause); });
      },
    });
    const mutationFence = createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: root,
      assertLease: () => { if (BigInt(Date.now()) >= spec.deadlineAtUnixMs) throw new Error('expired'); },
      snapshot: () => ({ environmentId: spec.environmentSnapshot!.ref, environmentVersion: 1,
        workspaceLeaseId: spec.workspaceLeaseSnapshot!.ref, workspaceLeaseVersion: 1,
        workspaceFencingEpoch: Number(spec.workspaceLeaseFencingEpoch), ownerAgentRunId: product.context.agentRunId }),
    });
    const dispatches: string[] = [];
    const toolContext = { cwd: root, projectName: 'native-product-tools', mutationFence,
      permissionGate: permissions, signal: bus.ctrl.signal };
    const policy = createHostCapabilityPolicy({ registry, toolContext,
      getPolicyContext: () => ({ planMode: false, planApproved: false, taskScope: null }),
      async readAuthority() {
        await product.store.getAttemptState(product.context);
        return { attemptId: product.context.attemptId, environmentId: spec.environmentSnapshot!.ref, environmentVersion: 1,
          workspaceLeaseId: spec.workspaceLeaseSnapshot!.ref, workspaceLeaseVersion: 1,
          workspaceFencingEpoch: Number(spec.workspaceLeaseFencingEpoch), deadlineAtUnixMs: spec.deadlineAtUnixMs,
          policyVersion: spec.policySnapshot!.ref };
      },
    });
    const factory = createToolRegistryCapabilityGatewayFactory({ registry, capabilitySet: set, wireSnapshot,
      toolContext, ...policy,
      commitResult: ({ toolName }) => { dispatches.push(toolName); },
    });
    let providerTurns = 0;
    const calls = [
      { name: 'read_file', input: { path: 'sample.txt' } },
      ...[1, 2, 3].map((index) => ({ name: 'read_file', input: { path: `parallel-${index}.txt` } })),
      { name: 'create_file', input: { path: 'created.txt', content: 'native-product-write' } },
      { name: 'run_command', input: { command: 'echo native-product-shell', timeout_ms: 5_000 } },
      { name: 'read_file', input: { path: 'created.txt' } },
    ];
    const provider = { name: 'openai', model: 'gpt-5', setModel() {}, async *chat(request: ChatRequest) {
      providerTurns++;
      if (providerTurns === 1) {
        expect(request.system).toBe(systemPrompt);
        expect(request.messages).toHaveLength(3);
        expect(request.messages[0]?.content).toEqual([{ type: 'text', text: 'Previous question' }]);
        expect(request.messages[1]?.content[0]).toEqual({ type: 'thinking', text: 'Previous reasoning' });
        expect(request.messages[2]?.content[1]).toEqual({ type: 'image', mediaType: 'image/png', base64: 'AQID' });
        expect(request.tools?.map((tool) => tool.name).sort()).toEqual(['create_file', 'read_file', 'run_command']);
        yield { type: 'thinking_delta' as const, text: 'Inspecting files before editing' };
        for (const [index, call] of calls.entries()) {
          const id = `host-tool:${index}`;
          yield { type: 'tool_call_start' as const, id, name: call.name };
          yield { type: 'tool_call_args' as const, id, partial_json: JSON.stringify(call.input) };
          yield { type: 'tool_call_end' as const, id, ...call };
        }
      } else if (providerTurns === 2) {
        expect(request.messages.some(message => message.role === 'assistant' && message.content.some(block =>
          block.type === 'thinking' && block.text === 'Inspecting files before editing'))).toBe(true);
        const results = request.messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_result');
        expect(results.map((result) => result.tool_use_id)).toEqual(calls.map((_, index) => `host-tool:${index}`));
        expect(results.map((result) => Boolean(result.is_error))).toEqual([false, false, false, false, !approveWrite, false, !approveWrite]);
        expect(results[5]!.content).toContain('native-product-shell');
        if (approveWrite) expect(results[6]!.content).toContain('native-product-write');
        else expect(results[4]!.content).toContain('capability_rejected:');
        // A remote provider may reuse a tool ID in a later response. Its
        // native operation must still be unique and must execute exactly once.
        yield { type: 'tool_call_start' as const, id: 'host-tool:0', name: 'read_file' };
        yield { type: 'tool_call_end' as const, id: 'host-tool:0', name: 'read_file', input: { path: 'sample.txt' } };
      } else {
        const results = request.messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_result');
        expect(results).toHaveLength(8);
        expect(results.at(-1)?.is_error).not.toBe(true);
        yield { type: 'text_delta' as const, text: 'real Host tools complete', phase: 'final_answer' as const };
      }
      yield { type: 'usage' as const, usage: { input_tokens: 10 + providerTurns, output_tokens: providerTurns } };
      yield { type: 'done' as const };
    } };
    const contents: { kind: agentV1SessionStore.EngineContentKindV1; toolUseId: string; text: string }[] = [];
    const observed: string[] = [];
    let observe: Promise<void> | undefined;
    const attached = await activateNativeCoderRuntimeFacade({ store: product.store, context: product.context, spec,
      runtimePackage: fixture.options.runtimePackage, requiredContainmentLevel: fixture.options.control.requiredContainmentLevel,
      requiredEnforcedLimits: fixture.options.control.requiredEnforcedLimits, source: modifiedSource, capabilityGatewayFactory: factory,
      providerGatewayFactory: (context, clock) => new ProviderGateway({ runtimeInstanceId: context.runtimeInstanceId,
        resolver: { resolve: () => provider }, artifactReader: material!.artifactReader, now: () => Number(clock.now()) }),
      sessionStore: fixture.options.sessionStore!, integrationMode: 'test', bus, environmentKind: 'host',
      capabilityCatalogVersion: set.catalogVersion, capabilityIds: set.visible,
      assertOwner() {}, provideInput: (id, value) => interactions!.provideInput(id, value),
      eligibility: { evaluate: async (candidate) => {
        expect(candidate.runtimeBinarySha256).toBe(fixture!.options.runtimePackage.binaries.runner.sha256);
        expect(candidate.capabilityIds).toEqual(set.visible);
        return { eligible: true, reasons: [] };
      } },
      runSpec: { schemaVersion: 1, sessionId: product.context.sessionId, commandId: product.context.commandId,
        spawnDepth: 0, role: 'coder', agentDefinitionId: 'coder', task: { text: 'real Host tools' },
        requestedCapabilityProfile: 'full', requestedEnvironment: { kind: 'host', projectId: 'fixture', access: 'exclusive_write', retention: 'retain_on_failure' },
        waitMode: 'foreground', budget: { maxWallMs: 60_000 }, idempotencyKey: product.context.commandId },
      runtimeCreated(value) {
        runtime = value;
        observe = (async () => {
      const assembler = new NativeContentAssembler();
      for await (const { record, receipt } of runtime!.subscribeCommittedEvents()) {
        observed.push(record.body.case!);
        if (!cancelReads && record.body.case === 'capabilityTerminal' && record.body.value.toolUseId === 'host-tool:1') {
          expect(slowFinished).toBe(false);
          expect(bus.buffer.some((row) => row.event === 'tool_call_result'
            && (row.data as { provider_tool_use_id: string }).provider_tool_use_id === 'host-tool:1')).toBe(true);
          releaseSlowRead();
        }
        if (record.body.case === 'content') {
          const bytes = assembler.append(record.body.value);
          if (bytes) contents.push({ kind: record.body.value.kind, toolUseId: record.body.value.toolUseId,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
          expect(receipt.kind).not.toBe(agentV1SessionStore.SessionRecordKind.LIFECYCLE_EVENT);
        }
        if (!cancelReads && record.body.case === 'capabilityTerminal' && record.body.value.toolUseId === 'host-tool:0') {
          expect(contents.some((content) => content.toolUseId === 'host-tool:0'
            && content.kind === agentV1SessionStore.EngineContentKindV1.TOOL_RESULT)).toBe(true);
          firstResultVisible();
        }
      }
      assembler.assertComplete();
        })();
        void observe.catch(() => undefined);
      },
    });
    releaseHandle(attached.handle);
    expect(attached.handle.runtimeGeneration).toBe('rust_v1');
    if (cancelReads) {
      await readersReady;
      await attached.handle.cancel({ code: 'user_cancelled' });
      await attached.closed;
      await observe;
      expect(runningReads).toBe(0);
      expect(maximumReads).toBe(4);
      expect(dispatches).toEqual([]);
      expect(approvals).toEqual([]);
      expect((await attached.handle.getSnapshot()).run.status).toBe('interrupted');
      expect(() => process.kill(runtime!.supervisorProcessId, 0)).toThrow();
      return;
    }
    try { await attached.closed; } catch (cause) {
      const events = await readProcessRealEngineEvents(fixture);
      throw new Error(`native Host test failed: turns=${providerTurns}, dispatches=${dispatches.join(',')}, `
        + `approvals=${approvals.join(',')}, events=${events.map((event) => event.body.case).join(',')}, `
        + `runtime=${String(runtime?.failureCause)}, approval=${String(approvalFailure)}`, { cause });
    }
    expect(providerTurns).toBe(3);
    await observe;
    expect(maximumReads).toBe(4);
    expect(slowFinished).toBe(true);
    expect(contents.filter((content) => content.kind === agentV1SessionStore.EngineContentKindV1.TOOL_RESULT)).toHaveLength(approveWrite ? 8 : 7);
    expect(contents.at(-1)?.text).toBe('real Host tools complete');
    expect(observed.at(-1)).toBe('terminal');
    expect((await attached.handle.getSnapshot()).run.status).toBe('completed');
    const facadeEvents = [];
    for await (const event of attached.handle.subscribeEvents()) facadeEvents.push(event);
    expect(facadeEvents.filter((event) => event.type === 'native.tool_call_result')).toHaveLength(8);
    const cards = bus.buffer.filter(row => row.event === 'tool_call_start');
    expect(new Set(cards.map(row => (row.data as { id: string }).id)).size).toBe(8);
    const messages = bus.buffer.filter(row => row.event === 'message_complete');
    expect(messages).toHaveLength(3);
    expect(messages.map(row => (row.data as { usage: { input_tokens: number } }).usage.input_tokens)).toEqual([11, 12, 13]);
    expect(messages[2]?.data).toMatchObject({ message: { phase: 'final_answer', content: [{ type: 'text', text: 'real Host tools complete' }] } });
    expect(facadeEvents.at(-1)?.type).toBe('native.done');
    expect(dispatches).toEqual([...calls.filter((call) => approveWrite || call.name !== 'create_file').map((call) => call.name), 'read_file']);
    expect(approvals).toEqual(['create_file', 'run_command']);
    if (approveWrite) expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('native-product-write');
    else {
      expect(existsSync(join(root, 'created.txt'))).toBe(false);
      expect(observed.filter((kind) => kind === 'capabilityRefused')).toHaveLength(1);
      expect(bus.buffer.some((row) => row.event === 'tool_call_result'
        && (row.data as { provider_tool_use_id: string }).provider_tool_use_id === 'host-tool:4'
        && (row.data as { result?: { error?: { code: string } } }).result?.error?.code === 'POLICY_DENIED')).toBe(true);
    }
    expect((await product.repository.list('supervisorFact')).items).toHaveLength(5);
  } finally {
    interactions?.close();
    material?.close();
    await runtime?.close(); await product.sessions.close();
    await rm(product.directory, { recursive: true, force: true });
    if (fixture) await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
