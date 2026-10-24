import { createHash, randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { unknownToolOutcome } from "@mcp/agent-runtime-host/tool-result.js";
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { agentV1Runtime as wire, asAgentRunAttemptId, asAgentRunId, asCorrelationId, asSessionCommandId, type SessionCommand } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['continue', 'limit', 'parallel', 'image', 'skills', 'unknown', 'transport-unknown', 'stale'] as const)('continues only fully settled native effects: %s', async scenario => {
  const product = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  let context = product.context;
  let bus = createBus(new AbortController());
  const root = join(product.directory, 'project');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=';
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  let calls = 0;
  let writes = 0;
  let nextProvider!: () => void;
  const providerStarted = new Promise<void>(resolve => { nextProvider = resolve; });
  let phase = 'prepare';
  try {
    const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
    const registry = new ToolRegistry();
    if (scenario === 'parallel') {
      const read = fsTools.find(tool => tool.name === 'read_file')!;
      let reads = 0;
      registry.register({ ...read, handler: async (args, toolContext) => {
        await delay(++reads === 1 ? 180 : 10);
        return read.handler(args, toolContext);
      } });
    }
    const createFile = fsTools.find(tool => tool.name === 'create_file')!;
    registry.register({ ...createFile, handler: async (args, toolContext) => {
      writes++;
      const result = await createFile.handler(args, toolContext);
      if (scenario === 'transport-unknown') return unknownToolOutcome('Mutation applied but transport confirmation was lost.');
      // An effect succeeded, but its material cannot be durably committed.
      return scenario === 'image' ? { ...result, extraUserBlocks: [{ type: 'image' as const, mediaType: 'image/png', base64: png }] }
        : scenario === 'unknown' ? { ...result, extraUserBlocks: [{ type: 'document' as const,
        name: 'missing.txt', mediaType: 'text/plain', path: 'missing.txt' }] } : result;
    } });
    registry.seal();
    const systemPrompt = 'Create once and then report.';
    const preparation = prepareCoderAttempt({ sessionId: context.sessionId, agentRunId: context.agentRunId,
      runnerRunId: 'native-continuation', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'auto', planMode: false, specMode: false } }, registry);
    const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      if (++calls === 1) {
        yield { type: 'tool_call_start', id: 'create-once', name: 'create_file' };
        yield { type: 'tool_call_end', id: 'create-once', name: 'create_file', input: { path: 'once.txt', content: 'written once' } };
        if (scenario === 'parallel') for (let index = 0; index < 4; index++) {
          yield { type: 'tool_call_start', id: `read-${index}`, name: 'read_file' };
          yield { type: 'tool_call_end', id: `read-${index}`, name: 'read_file', input: { path: 'once.txt' } };
        }
        yield { type: 'done' };
      } else {
        nextProvider();
        await new Promise<void>(resolve => {
          if (request.signal!.aborted) resolve();
          else request.signal!.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'done' };
      }
    } };
    const config = () => ({ mode: 'test' as const, context,
      packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(product.directory, 'native-sessions'),
      workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') });
    const prepared: PreparedCoderInputs = { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: ['limit', 'parallel', 'image', 'skills'].includes(scenario) ? 1 : 3,
      preparedUserContext: scenario === 'skills' ? create(wire.ProviderPreparedUserContextV1Schema, {
        messageIndex: 0, selectedSkillIds: ['review'], contentUtf8: 'ORIGINAL_SELECTED_INSTRUCTIONS' }) : undefined,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Create once.txt' }] }],
      toolContext: { cwd: root, projectName: 'native-continuation', signal: bus.ctrl.signal }, signal: bus.ctrl.signal };
    phase = 'first launch';
    const first = await executeNativeCoder({ prepared, config: config(), bridge: worker, runId: 1, bus, assertOwner() {} });
    phase = 'first execution';
    if (scenario === 'continue' || scenario === 'stale') {
      await providerStarted;
      phase = 'first cancel';
      await first.cancel({ code: 'user_cancelled' });
    }
    phase = 'first completion';
    if (scenario === 'unknown' || scenario === 'transport-unknown') {
      await expect(first.done).rejects.toThrow('TOOL_OUTCOME_UNKNOWN');
    } else {
      const result = await first.done;
      if (['limit', 'parallel', 'image', 'skills'].includes(scenario)) { expect(result.reason).toBe('max_turns'); expect(calls).toBe(1); }
    }
    if (scenario === 'parallel') {
      const finished = bus.buffer.filter(row => row.event === 'tool_call_result').map(row => (row.data as { provider_tool_use_id: string }).provider_tool_use_id);
      expect(finished.indexOf('read-1')).toBeLessThan(finished.indexOf('read-0'));
    }
    phase = 'first history';
    expect(writes).toBe(1);
    expect(await readFile(join(root, 'once.txt'), 'utf8')).toBe('written once');
    const reader = await NativeSessionReader.open(runtime, { rootPath: config().sessionRoot, sessionId: context.sessionId });
    let history;
    try { history = await projectNativeSessionHistory(reader, context.sessionId, new Date().toISOString()); }
    finally { await reader.close(); }
    if (scenario === 'skills') {
      expect(history.messages[0]?.selectedSkillIds).toEqual(['review']);
      expect(JSON.stringify(history.messages)).not.toContain('ORIGINAL_SELECTED_INSTRUCTIONS');
      prepared.preparedUserContext!.contentUtf8 = 'CHANGED_AFTER_PAUSE';
    }
    if (scenario === 'stale') {
      const result = history.messages.at(-1)!.content[0]!;
      if (result.type !== 'tool_result') throw new Error('Expected committed tool result');
      result.content = 'stale result that must not reach the provider';
    }
    const command: SessionCommand = { schemaVersion: 1, commandId: asSessionCommandId(randomUUID()),
      sessionId: context.sessionId, correlationId: asCorrelationId(randomUUID()), requestedAt: new Date().toISOString(),
      actor: context.actor, kind: 'resume', idempotencyKey: randomUUID(), payload: {} };
    context = { ...context, commandId: command.commandId, correlationId: command.correlationId,
      agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()), executorOwnerId: `host:${randomUUID()}` };
    await product.store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
      ...context, role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
      executorExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
    bus = createBus(new AbortController());
    let resumedCalls = 0;
    phase = 'continuation launch';
    const starting = executeNativeCoder({ config: config(), bridge: worker, runId: 2, bus, assertOwner() {},
      prepared: { ...prepared, resume: true, preparation: prepareCoderAttempt({ ...preparation, agentRunId: context.agentRunId,
        runnerRunId: 'continued' }, registry), messages: history.messages, signal: bus.ctrl.signal,
        toolContext: { cwd: root, projectName: 'native-continuation', signal: bus.ctrl.signal },
        provider: { ...provider, async *chat(request) {
          resumedCalls++;
          if (scenario === 'skills') {
            expect(JSON.stringify(request.messages[0])).toContain('ORIGINAL_SELECTED_INSTRUCTIONS');
            expect(JSON.stringify(request.messages)).not.toContain('CHANGED_AFTER_PAUSE');
          }
          expect(request.messages).toHaveLength(scenario === 'parallel' ? 7 : scenario === 'image' ? 4 : 3);
          expect(request.messages.at(-1)?.role).toBe(scenario === 'image' ? 'user' : 'tool');
          if (scenario === 'image') expect(request.messages.at(-1)?.content).toContainEqual({ type: 'image', mediaType: 'image/png', base64: png });
          expect(JSON.stringify(request.messages)).not.toContain('without adding a user message');
          yield { type: 'text_delta', text: 'continued without repeating the write' };
          yield { type: 'done' };
        } } } });
    if (scenario === 'unknown' || scenario === 'transport-unknown' || scenario === 'stale') {
      // The retained workspace lease can reject before journal hydration;
      // both barriers must keep an uncertain mutation from being repeated.
      await expect(starting).rejects.toThrow(scenario !== 'stale'
        ? /unresolved effects|unresolved expired writers/ : 'differs from its durable frontier');
      expect(resumedCalls).toBe(0);
    } else {
      const second = await starting;
      phase = 'continuation completion';
      await second.done;
      expect(resumedCalls).toBe(1);
      const reopened = await NativeSessionReader.open(runtime, { rootPath: config().sessionRoot, sessionId: context.sessionId });
      try {
        const projected = await projectNativeSessionHistory(reopened, context.sessionId, new Date().toISOString(), async attemptId => attemptId === context.attemptId);
        expect(projected.messages).toHaveLength(scenario === 'parallel' ? 8 : scenario === 'image' ? 5 : 4);
        expect(JSON.stringify(projected.messages.at(-1))).toContain('continued without repeating');
      } finally { await reopened.close(); }
    }
    expect(writes).toBe(1);
  } catch (cause) {
    console.error({ scenario, phase, calls, writes, events: bus.buffer });
    throw cause;
  } finally {
    bus.ctrl.abort(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
