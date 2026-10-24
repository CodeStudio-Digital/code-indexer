import { createHash, randomUUID } from 'node:crypto';
import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { supervisorFactId } from '../supervisor-fact-ledger.js';
import { MessageChannel } from 'node:worker_threads';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { asAgentRunAttemptId, asAgentRunId, asCorrelationId, asSessionCommandId, type SessionCommand } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['tools', 'turns', 'cumulative', 'denied', 'failure', 'wall', 'wall_tool', 'wall_approval', 'long_tool', 'burst', 'burst_barriers', 'lease_renewal', 'lease_expiry'] as const)('settles a native policy budget without exceeding it: %s', async scenario => {
  await runBudget(scenario);
}, 55_000);
const longIt = process.env.MCP_RUST_AGENT_LONG_E2E === '1' ? physicalIt : it.skip;
longIt('keeps the admitted native attempt alive beyond two minutes', async () => {
  await runBudget('long');
}, 150_000);
const leaseLongIt = process.env.MCP_RUST_AGENT_LEASE_LONG_E2E === '1' ? physicalIt : it.skip;
leaseLongIt('keeps one physical attempt alive beyond its original ten-minute executor lease', async () => {
  await runBudget('lease_long');
}, 650_000);

const channelBudgetIt = process.env.MCP_RUST_AGENT_CHANNEL_BUDGET_E2E === '1' ? physicalIt : it.skip;
channelBudgetIt('settles a durable terminal before exhausting the Data channel identity budget', async () => {
  await runBudget('channel_budget');
}, 300_000);

async function runBudget(scenario: 'tools' | 'turns' | 'cumulative' | 'denied' | 'failure' | 'wall' | 'wall_tool' | 'wall_approval' | 'long_tool' | 'long' | 'burst' | 'burst_barriers' | 'lease_renewal' | 'lease_expiry' | 'lease_long' | 'channel_budget') {
  const f = await supervisorFactFixture('coder', scenario === 'lease_renewal' || scenario === 'lease_expiry' ? 8_000 : 600_000);
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  let bus = createBus(new AbortController());
  let context = f.context;
  const root = join(f.directory, 'project');
  const leaseRoot = join(f.directory, 'native-workspace-leases');
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: f.store, context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  let effects = 0, calls = 0, dispatched = 0, produced = 0;
  try {
    const registry = new ToolRegistry();
    const createFile = fsTools.find(tool => tool.name === 'create_file')!;
    registry.register({ ...createFile, handler: async (input, ctx) => {
      dispatched++;
      if (scenario === 'failure') throw new Error('Fixture dispatch failed before any write');
      if (scenario === 'wall_tool') await delay(20_000, undefined, { signal: ctx.signal });
      if (scenario === 'long_tool') await delay(32_000, undefined, { signal: ctx.signal });
      effects++;
      return createFile.handler(input, ctx);
    } });
    registry.seal();
    const systemPrompt = 'Execute only within the admitted budget.';
    const runtime = resolveRuntimePolicyV1({ request: { revision: 'budget-fixture', values: { execution: {
      maxToolCalls: scenario === 'tools' || scenario === 'cumulative' ? 1 : null,
      maxTurns: ['turns', 'denied', 'failure', 'long_tool'].includes(scenario) ? 1 : null, maxWallMs: scenario.startsWith('wall') ? 3_000 : scenario === 'lease_renewal' || scenario === 'lease_expiry' ? 20_000 : null,
    } } } });
    const preparation = prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId,
      runnerRunId: 'native-budget', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
      environment: { kind: 'host', cwd: root }, policy: { permissionMode: scenario === 'wall_approval' ? 'ask' : 'auto', planMode: scenario === 'denied', specMode: false, runtime } }, registry);
    const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      calls++;
      if (scenario === 'channel_budget') {
        for (let index = 0; index < 45_000; index++) {
          produced++;
          yield { type: 'text_delta', text: 'x', itemId: String(index) };
        }
      } else if (scenario === 'lease_long') {
        const providerStarted = Date.now();
        while (Date.now() - providerStarted < 610_000) {
          await f.store.renewAttemptLease(context, new Date(Date.now() + 600_000).toISOString());
          yield { type: 'text_delta', text: '.' };
          await delay(Math.min(20_000, 610_000 - (Date.now() - providerStarted)), undefined, { signal: request.signal });
        }
        yield { type: 'text_delta', text: 'Completed after the original ten-minute lease.' };
      } else if (scenario.startsWith('lease_')) {
        yield { type: 'text_delta', text: 'Before the original lease expires.' };
        if (scenario === 'lease_renewal') await f.store.renewAttemptLease(context, new Date(Date.now() + 30_000).toISOString());
        await delay(10_000, undefined, { signal: request.signal });
        yield { type: 'text_delta', text: 'Completed after the renewed lease was acknowledged.' };
      } else if (scenario.startsWith('burst')) {
        for (let index = 0; index < 1_000; index++) yield { type: 'text_delta', text: 'x',
          itemId: scenario === 'burst_barriers' ? String(index) : 'answer' };
      } else if (scenario === 'long' || scenario === 'wall') {
        const started = Date.now();
        while (Date.now() - started < 125_000) {
          yield { type: 'text_delta', text: '.' };
          await delay(Math.min(20_000, 125_000 - (Date.now() - started)), undefined, { signal: request.signal });
        }
        yield { type: 'text_delta', text: 'Completed after the former deadline.' };
      } else {
        for (let index = 0; index < (scenario === 'tools' || scenario === 'wall_tool' || scenario === 'wall_approval' ? 2 : 1); index++) {
          const id = 'create-' + calls + '-' + index;
          yield { type: 'tool_call_start', id, name: 'create_file' };
          yield { type: 'tool_call_end', id, name: 'create_file', input: { path: id + '.txt', content: 'once' } };
        }
      }
      yield { type: 'done' };
    } };
    const started = performance.now();
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(f.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: leaseRoot },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 4,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Execute within the budget.' }] }],
        toolContext: { cwd: root, projectName: 'native-budget', signal: bus.ctrl.signal }, signal: bus.ctrl.signal } });
    if (scenario === 'lease_expiry') {
      await expect(execution.done).rejects.toBeDefined();
      expect(bus.ctrl.signal.aborted).toBe(true);
      expect(effects).toBe(0);
      expect(performance.now() - started).toBeLessThan(20_000);
      expect(JSON.stringify(bus.buffer)).not.toContain('Completed after the renewed lease was acknowledged.');
      return;
    }
    const result = await execution.done;
    expect(result.reason).toBe(scenario === 'channel_budget' ? 'ipc_identity_budget' : scenario === 'long' || scenario.startsWith('lease_') || scenario.startsWith('burst') ? 'completed' : scenario.startsWith('wall') ? 'aborted' : ['turns', 'denied', 'failure', 'long_tool'].includes(scenario) ? 'max_turns' : 'max_tool_calls');
    expect(effects).toBe(['tools', 'long', 'burst', 'burst_barriers', 'denied', 'failure', 'lease_renewal', 'lease_long', 'channel_budget'].includes(scenario) || scenario.startsWith('wall') ? 0 : 1);
    if (scenario === 'wall_tool') expect(dispatched).toBe(1);
    if (scenario === 'wall_approval') {
      expect(dispatched).toBe(0);
      expect(bus.buffer.filter(row => row.event === 'tool_approval_request')).toHaveLength(1);
      expect(bus.buffer.filter(row => row.event === 'tool_approval_resolved')).toHaveLength(1);
    }
    expect(calls).toBe(scenario === 'cumulative' ? 2 : 1);
    expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    expect((bus.endReason?.data as { reason?: string })?.reason).toBe(result.reason);
    const packageInfo = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
    const reader = await NativeSessionReader.open(packageInfo, { rootPath: join(f.directory, 'native-sessions'), sessionId: f.context.sessionId });
    let history;
    try { history = await projectNativeSessionHistory(reader, f.context.sessionId, new Date().toISOString()); }
    finally { await reader.close(); }
    if (scenario === 'tools' || scenario === 'cumulative') {
      const wire = JSON.stringify(history?.messages);
      expect(wire.match(/capability_rejected:max_tool_calls/g)).toHaveLength(scenario === 'tools' ? 2 : 1);
      const results = bus.buffer.filter(row => row.event === 'tool_call_result');
      expect(results).toHaveLength(2);
    }
    if (scenario !== 'long' && !scenario.startsWith('lease_') && !scenario.startsWith('burst') && !scenario.startsWith('wall')) {
      const command: SessionCommand = { schemaVersion: 1, commandId: asSessionCommandId(randomUUID()),
        sessionId: context.sessionId, correlationId: asCorrelationId(randomUUID()), requestedAt: new Date().toISOString(),
        actor: context.actor, kind: 'resume', idempotencyKey: randomUUID(), payload: {} };
      context = { ...context, commandId: command.commandId, correlationId: command.correlationId,
        agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()), executorOwnerId: 'host:' + randomUUID() };
      await f.store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
        ...context, role: 'coder', agentDefinitionId: 'coder', waitMode: 'foreground', requestedCapabilityProfile: 'full',
        executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      } });
      bus = createBus(new AbortController());
      const previousEffects = effects;
      let continuedCalls = 0;
      execution = await executeNativeCoder({ bridge: worker, runId: 2, bus, assertOwner() {},
        config: { mode: 'test', context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
          anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(f.directory, 'native-sessions'),
          workspaceRoot: root, workspaceLeaseRoot: leaseRoot },
        prepared: { preparation: prepareCoderAttempt({ ...preparation, agentRunId: context.agentRunId, runnerRunId: 'budget-continuation' }, registry),
          registry, systemPrompt, thinking: false, maxTurns: 4, messages: history.messages, resume: true,
          signal: bus.ctrl.signal, toolContext: { cwd: root, projectName: 'native-budget', signal: bus.ctrl.signal },
          provider: { ...provider, async *chat(request) {
            continuedCalls++;
            if (scenario === 'channel_budget') {
              expect(request.messages.at(-1)?.role).toBe('assistant');
              expect(JSON.stringify(request.messages.at(-1)?.content)).toContain('x'.repeat(1_000));
            } else expect(request.messages.at(-1)?.role).toBe('tool');
            yield { type: 'text_delta', text: 'Continued from the settled budget without replay.' };
            yield { type: 'done' };
          } },
        },
      });
      expect((await execution.done).reason).toBe('completed');
      expect(effects).toBe(previousEffects);
      expect(continuedCalls).toBe(1);
      expect(JSON.parse(await readFile(join(leaseRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
    }
    if (scenario === 'channel_budget') {
      expect(produced).toBeGreaterThan(1_000);
      expect(produced).toBeLessThan(45_000);
      expect(dispatched).toBe(0);
      expect(JSON.stringify(history.messages)).toContain('x'.repeat(1_000));
      console.log('Native channel budget result', { produced, elapsedMs: performance.now() - started, reason: result.reason });
    }
    if (scenario.startsWith('burst')) {
      expect(JSON.stringify(history?.messages)).toContain('x'.repeat(1_000));
      const report = { scenario, elapsedMs: performance.now() - started, events: bus.buffer.length,
        textEvents: bus.buffer.filter(row => row.event === 'text').length };
      if (process.env.MCP_HARNESS_BURST_REPORT) await writeFile(process.env.MCP_HARNESS_BURST_REPORT + '-' + scenario + '.json', JSON.stringify(report));
    }
    if (scenario === 'long') {
      expect(performance.now() - started).toBeGreaterThan(125_000);
      expect(JSON.stringify(history?.messages)).toContain('Completed after the former deadline.');
    }
    if (scenario === 'lease_long') {
      expect(performance.now() - started).toBeGreaterThan(610_000);
      expect(JSON.stringify(history?.messages)).toContain('Completed after the original ten-minute lease.');
    }
  } catch (cause) {
    const physical = await f.repository.get('supervisorFact', supervisorFactId(context.attemptId, 'attemptProcessExited'));
    const physicalBody = physical && fromBinary(agentV1Supervisor.ManagementPayloadSchema, Buffer.from(String(physical.data.encodedPayload), 'base64')).body;
    console.error('Native budget diagnostic', { scenario, calls, dispatched, effects,
      eventCount: bus.buffer.length, eventKinds: bus.buffer.slice(-30).map(row => row.event), endReason: bus.endReason,
      physical: physicalBody?.case === 'attemptProcessExited' ? { exitCode: physicalBody.value.exitCode, cause: physicalBody.value.cause } : undefined });
    throw cause;
  } finally {
    bus.ctrl.abort();
    if (execution) { await execution.cancel({ code: 'user_cancelled' }).catch(() => undefined); await execution.done.catch(() => undefined); }
    main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
  }
}
