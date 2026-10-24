import { randomUUID } from 'node:crypto';
import { asAgentRunId, asSessionId } from '@mcp/agent-runtime-contracts';
import type { SubagentSpec } from '@mcp/code-agent/tools/implement-subagent.js';
import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { rememberNativeProviderSelection } from '@mcp/code-agent/runtime/native-provider-binding.js';
import type { PreparedCoderInputs } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { NativeAgentTreePort, snapshotNativeChildContext } from '../workers/native-agent-tree-port.js';
import type { NativeCoderTreeOwner } from '../workers/native-coder-tree.js';
import { resolveRuntimePolicyV1 } from '../../../packages/agent-runtime-host/src/runtime-policy/RuntimePolicyResolver.js';
import { NativeTreeScheduler } from '../workers/native-tree-scheduler.js';
import { uncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';

function fixture(effectivePlanning?: () => { planMode: boolean; specMode: boolean }) {
  const registry = new ToolRegistry();
  const tool: CoderTool = { name: 'read_file', source: 'native', description: 'read', parameters: { type: 'object', properties: {} },
    handler: vi.fn(async () => ({ content: 'original' })) };
  registry.register(tool); registry.seal();
  const provider: ChatProvider = { name: 'openai', model: 'vendor-model', setModel() {}, async *chat() { yield { type: 'done' }; } };
  const parentId = asAgentRunId(randomUUID()), childId = asAgentRunId(randomUUID()), sessionId = asSessionId(randomUUID());
  const context: ToolContext = { cwd: process.cwd(), projectName: 'fixture', runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: parentId };
  const preparation = prepareCoderAttempt({ sessionId, agentRunId: parentId, runnerRunId: randomUUID(),
    provider: 'configured-account', model: 'model::mode', agentDefinitionId: 'coder', systemPromptSha256: '0'.repeat(64),
    capabilityProfile: 'full', environment: { kind: 'host', cwd: context.cwd }, policy: { permissionMode: 'ask', planMode: false, specMode: false,
      runtime: resolveRuntimePolicyV1({ request: { revision: 'parent', values: { execution: { maxTurns: 8, maxToolCalls: 5, maxWallMs: 30_000 } } } }) } }, registry);
  let child: PreparedCoderInputs | undefined;
  const runPrepared = vi.fn(async (request, prepare, _observe, signal) => {
    signal.throwIfAborted();
    const admission = { kind: 'reserved', context: { sessionId, agentRunId: childId, attemptId: randomUUID() } };
    child = await prepare(admission, signal);
    return { admission, outcome: { reason: 'completed', usage: { input_tokens: 10, output_tokens: 2 } }, finalText: 'bounded result',
      transcriptRef: `native-child-journal:${sessionId}:${childId}:${admission.context.attemptId}` };
  });
  const owner = { runPrepared, scheduler: new NativeTreeScheduler(4), shared: { root: { attemptId: randomUUID() }, budget: { limits: { deadlineAtUnixMs: Date.now() + 60_000 } } } } as unknown as NativeCoderTreeOwner;
  const prepared = { preparation, registry, toolContext: context, provider, systemPrompt: 'parent', messages: [], thinking: false, maxTurns: 8 };
  const port = new NativeAgentTreePort(owner, prepared, snapshotNativeChildContext(context), Date.now() + 45_000, effectivePlanning);
  const parent = { provider, tools: [tool], ctx: context, sessionId };
  const spec: SubagentSpec = { systemPrompt: 'child', allowlist: new Set(['read_file']), maxTurns: 3,
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Read the file' }] }], limits: { maxToolCalls: 2, timeoutMs: 10_000 }, spawnId: 'stable' };
  return { port, parent, spec, runPrepared, child: () => child!, tool, prepared, context };
}

it.each([false, true])('seals the child with the live parent approval state (approved=%s)', approved => {
  const f = fixture(() => ({ planMode: !approved, specMode: false }));
  f.prepared.preparation.policy.planMode = true;
  return f.port.run(f.parent, f.spec).then(() => {
    expect(f.child().preparation.policy.planMode).toBe(!approved);
    expect(f.prepared.preparation.policy.planMode).toBe(true);
  });
});

it('uses owned registry implementations, intersects capabilities and seals a bounded child policy and journal reference', async () => {
  const f = fixture();
  const replacement = vi.fn();
  f.parent.tools = [{ ...f.tool, handler: replacement }, { ...f.tool, name: 'foreign' }];
  const result = await f.port.run(f.parent, { ...f.spec, allowlist: null });
  const child = f.child();
  expect(child.registry.list().map(tool => tool.name)).toEqual(['read_file', 'record_memo']);
  expect(child.registry.get('read_file')?.handler).toBe(f.tool.handler);
  expect(child.toolContext.controlPlaneParentAgentRunId).not.toBe(f.context.controlPlaneParentAgentRunId);
  expect(child.toolContext.ports?.agentTree).toBeUndefined();
  expect(child.preparation.policy.runtime?.execution).toMatchObject({ maxTurns: 3, maxToolCalls: 2, maxWallMs: 10_000 });
  expect(child.preparation.policy.runtime?.policyDigest).not.toBe(f.prepared.preparation.policy.runtime?.policyDigest);
  expect(child.preparation.provider).toBe('configured-account'); expect(child.preparation.model).toBe('model::mode');
  expect(f.runPrepared.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'spawn:stable', taskSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(result.nativeTranscriptRef).toMatch(/^native-child-journal:/); expect(result.transcript).toBeUndefined();
  expect(result.finalText).toBe('bounded result'); expect(replacement).not.toHaveBeenCalled();
});

it('requires configured provider provenance and preserves the configured model alias for an override', async () => {
  const f = fixture(), other: ChatProvider = { ...f.parent.provider };
  await expect(f.port.run(f.parent, { ...f.spec, provider: other })).rejects.toThrow('configured product selection');
  expect(f.runPrepared).not.toHaveBeenCalled();
  rememberNativeProviderSelection(other, { provider: 'second-account', model: 'selected::reasoning' });
  await f.port.run(f.parent, { ...f.spec, provider: other });
  expect(f.child().provider).toBe(other);
  expect(f.child().preparation).toMatchObject({ provider: 'second-account', model: 'selected::reasoning' });
  expect(() => rememberNativeProviderSelection(other, { provider: 'foreign-account', model: 'selected::reasoning' })).toThrow('rebound');
});

it('awaits the durable admission callback before child preparation and refuses a failed checkpoint', async () => {
  const f = fixture();
  const onNativeAdmission = vi.fn(async (reference: string) => {
    expect(reference).toMatch(/^native-child-journal:(?:[a-f\d-]{36}:){3}[a-f\d-]{36}$/);
    expect(f.child()).toBeUndefined();
    throw new Error('checkpoint disk full');
  });
  await expect(f.port.run(f.parent, { ...f.spec, onNativeAdmission })).rejects.toThrow('checkpoint disk full');
  expect(onNativeAdmission).toHaveBeenCalledOnce();
  expect(f.child()).toBeUndefined();
  expect((await f.port.run(f.parent, f.spec)).reason).toBe('completed');
});

it('propagates an uncertain child effect as a failure even if the terminal reason says completed', async () => {
  const f = fixture();
  const original = f.runPrepared.getMockImplementation()!;
  f.runPrepared.mockImplementation(async (...args) => {
    const result = await original(...args);
    return { ...result, outcome: { ...result.outcome, effectOutcome: 'unknown' as const } };
  });
  expect(await f.port.run(f.parent, f.spec)).toMatchObject({ reason: 'error', effectOutcome: 'unknown' });
});

it('preserves typed uncertainty when physical child shutdown rejects', async () => {
  const f = fixture();
  f.runPrepared.mockRejectedValueOnce(uncertainToolOutcomeError('child-write'));
  expect(await f.port.run(f.parent, f.spec)).toMatchObject({ reason: 'error', effectOutcome: 'unknown',
    failureDetail: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') });
});

it('refuses foreign parents, disabled subagents, invalid limits and pre-cancelled callers before admission', async () => {
  const f = fixture();
  await expect(f.port.run({ ...f.parent, ctx: { ...f.context, controlPlaneParentAgentRunId: 'foreign' } }, f.spec)).rejects.toThrow('foreign');
  await expect(f.port.run(f.parent, { ...f.spec, limits: { maxToolCalls: -1 } })).rejects.toThrow('limit');
  await expect(f.port.run(f.parent, { ...f.spec, signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
  f.prepared.preparation.policy.runtime!.subagents.enabled = false;
  await expect(f.port.run(f.parent, f.spec)).rejects.toThrow('disabled');
  expect(f.runPrepared).not.toHaveBeenCalled();
});

it('captures a fresh context without lease-bound execution ports or invocation identities', () => {
  const f = fixture();
  const context = { ...f.context, ports: { interactions: {} as never, commands: {} as never, agentTree: f.port },
    signal: new AbortController().signal, runner: {} as never, mutationFence: {} as never, currentToolInvocation: { name: 'spawn_agent', input: {} } };
  const snapshot = snapshotNativeChildContext(context);
  expect(snapshot.ports).toEqual({ fs: undefined });
  for (const key of ['signal', 'runner', 'mutationFence', 'currentToolInvocation']) expect(snapshot).not.toHaveProperty(key);
  expect(snapshot.cwd).toBe(context.cwd);
});
