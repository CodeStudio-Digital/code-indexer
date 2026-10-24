import { randomUUID, createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Capability, type AgentRunId } from '@mcp/agent-runtime-contracts';
import type { ValidatedCapabilityPrepare } from '@mcp/agent-runtime-host';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { PermissionGate } from '../../core/permission-gate.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import { resolveCapabilitySet } from '../../core/capability-catalog.js';
import { ok, unknownToolOutcome, type CoderTool, type ToolContext, type ToolResult } from '../../core/tool.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';
import { createHostCapabilityPolicy } from '../host-capability-policy.js';
import { HostEffectScope } from '../host-effect-scope.js';
import { NativeInvocationBudget, NativeNestedCapabilities } from '../native-nested-capabilities.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function tool(name: string, handler: CoderTool['handler'], write = false, timeoutMs = 1000): CoderTool {
  return { name, handler, source: 'native', description: name, timeoutMs,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    mutates: write, parallelSafe: !write, riskLevel: write ? 'write' : 'read',
    ...(write ? { effectBoundary: 'control' as const } : {}), repeatPolicy: 'volatile' };
}
function fixture(tools: CoderTool[], options: { maximum?: number; hidden?: string[]; ask?: boolean } = {}) {
  const registry = new ToolRegistry(); tools.forEach(t => registry.register(t));
  const code = buildCodeExecTool(registry); registry.register(code); registry.seal();
  const agentRunId = randomUUID() as AgentRunId, attemptId = randomUUID();
  const identity = create(agentV1Common.AttemptIdentitySchema, { attemptId, agentRunId });
  const authority = { attemptId, environmentId: 'env', environmentVersion: 1, workspaceLeaseId: 'lease',
    workspaceLeaseVersion: 1, workspaceFencingEpoch: 1, deadlineAtUnixMs: BigInt(Date.now() + 60000), policyVersion: 'policy' };
  const state = { planMode: false, planApproved: false, taskScope: null, specMode: false, specApproved: false };
  const cancel = new AbortController(), answer = deferred<string>(), emitted = vi.fn();
  const context: ToolContext = { cwd: process.cwd(), projectName: 'nested', toolCallLedger: new ToolCallLedger(),
    signal: cancel.signal, permissionGate: new PermissionGate({ getMode: () => options.ask ? 'ask' : 'unrestricted',
      emit: emitted, waitForUserInput: () => answer.promise }),
    mutationFence: createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: process.cwd(), assertLease() {},
      snapshot: () => ({ ...authority, ownerAgentRunId: agentRunId }) }) };
  const policy = createHostCapabilityPolicy({ registry, toolContext: context, getPolicyContext: () => state,
    readAuthority: async () => authority });
  const resolver = policy.decisionResolverFactory({ identity, runtimeInstanceId: 'runtime',
    limits: create(agentV1Common.FrameLimitsSchema), timeoutMs: 1000 }, { now: () => BigInt(Date.now()) });
  const retire = vi.spyOn(resolver, 'retire');
  const set = resolveCapabilitySet(registry.list(), { agentRunId, resolvedAt: new Date().toISOString() }).set;
  // Resolve IDs through the registered descriptors rather than relying on ID formatting.
  const hiddenIds = new Set(registry.list().filter(t => options.hidden?.includes(t.name))
    .map(t => resolveCapabilitySet([t], { agentRunId, resolvedAt: new Date().toISOString() }).set.registered[0]));
  const effects = new HostEffectScope(), budget = new NativeInvocationBudget(options.maximum);
  const nested = new NativeNestedCapabilities({ registry, capabilitySet: { ...set, visible: set.visible.filter(id => !hiddenIds.has(id)) },
    resolver, validateGrant: policy.validateGrant, effects, budget, now: () => BigInt(Date.now()) });
  const parent = (): ValidatedCapabilityPrepare => ({ identity, runtimeInstanceId: 'runtime', operationId: randomUUID(),
    providerOperationId: randomUUID(), toolUseId: 'script', capabilityId: 'code_exec', capabilityVersion: '1',
    executionClass: agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY, mutates: false,
    encodedJsonInput: Buffer.from('{}'), inputSha256: createHash('sha256').update('{}').digest(),
    capabilitySetSha256: Buffer.from(set.hash, 'hex'), idempotencyKey: randomUUID(), deadlineAtUnixMs: authority.deadlineAtUnixMs });
  const run = (source: string) => {
    const request = parent();
    if (!budget.take()) throw new Error('max_tool_calls');
    return { request, result: code.handler({ code: source }, { ...context, currentToolUseId: request.toolUseId,
      nestedCapabilityDispatch: nested.bind(request) }) };
  };
  return { registry, code, context, state, cancel, answer, emitted, effects, nested, retire, run };
}

describe('native nested capabilities', () => {
  it('keeps native workflow at the top level while retaining schema discovery', async () => {
    const run = vi.fn(async () => ok('must not run inside script'));
    const f = fixture([tool('workflow', run, true)]);
    const schema = await f.run('return tool_schema("workflow");').result;
    expect(schema.content).toContain('"invokeAs": "top_level"');
    expect((await f.run('return await tools.workflow({});').result).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it('overlaps at most four reads and keeps a write between the surrounding read groups', async () => {
    let active = 0, maximum = 0; const order: string[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const read = vi.fn(async args => {
      const id = Number(args.id); active++; maximum = Math.max(maximum, active); order.push(`start:${id}`);
      if (id < 5) await gates[id]!.promise;
      active--; order.push(`end:${id}`); return ok(String(id));
    });
    const f = fixture([tool('read_probe', read), tool('mutate', async () => { order.push('write'); return ok('done'); }, true)]);
    const run = f.run('return await Promise.all([...[0,1,2,3,4].map(id=>tools.read_probe({id})), tools.mutate({}), tools.read_probe({id:5})]);');
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4)); expect(maximum).toBe(4);
      gates[2]!.resolve(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
      expect(order).not.toContain('write'); gates.forEach(g => g.resolve());
      expect((await run.result).isError).not.toBe(true);
      expect(order.indexOf('write')).toBeGreaterThan(order.indexOf('end:4'));
      expect(order.indexOf('start:5')).toBeGreaterThan(order.indexOf('write'));
    } finally { gates.forEach(g => g.resolve()); await f.effects.waitForIdle(); }
  });
  it('releases a late approval after parent retirement without dispatching its mutation', async () => {
    const write = vi.fn(async () => ok('must not run'));
    const f = fixture([tool('mutate', write, true)], { ask: true });
    const run = f.run('return await tools.mutate({});');
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled()); f.nested.retire(run.request);
    f.answer.resolve(JSON.stringify({ approved: true }));
    expect((await run.result).isError).toBe(true); expect(write).not.toHaveBeenCalled(); expect(f.retire).toHaveBeenCalledOnce();
  });
  it('uses native policy for each child, including spec mode without a legacy runner', async () => {
    const write = vi.fn(async () => ok('changed'));
    const f = fixture([tool('mutate', write, true)]); f.state.specMode = true;
    const denied = await f.run('return await tools.mutate({});').result;
    expect(denied.isError).toBe(true); expect(denied.content).toContain('policy_'); expect(write).not.toHaveBeenCalled();
    f.state.specApproved = true;
    expect((await f.run('return await tools.mutate({});').result).isError).not.toBe(true);
    expect(write).toHaveBeenCalledOnce();
  });
  it('hides tools outside the immutable attempt from calls and introspection', async () => {
    const hidden = vi.fn(async () => ok('secret'));
    const f = fixture([tool('hidden_probe', hidden)], { hidden: ['hidden_probe'] });
    const result = await f.run('return tool_schema("hidden_probe");').result;
    expect(result.isError).toBe(true); expect(result.content).toContain('unknown tool');
    expect((await f.run('return await tools.hidden_probe({});').result).isError).toBe(true);
    expect(hidden).not.toHaveBeenCalled();
  });
  it('captures input before approval and does not ask a second local permission', async () => {
    const write = vi.fn(async args => ok(String(args.value)));
    const f = fixture([tool('mutate', write, true)], { ask: true });
    const { result } = f.run('const args={value:"approved"}; const done=tools.mutate(args); args.value="changed"; return await done;');
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.answer.resolve(JSON.stringify({ approved: true }));
    expect((await result).isError).not.toBe(true);
    expect(write.mock.calls[0]?.[0]).toEqual({ value: 'approved' });
    expect(f.emitted.mock.calls.filter(([event]) => event === 'tool_approval_request')).toHaveLength(1);
  });
  it('counts physical children and later scripts against the same attempt budget', async () => {
    const read = vi.fn(async () => ok('read'));
    const f = fixture([tool('read_probe', read)], { maximum: 4 });
    expect((await f.run('await tools.read_probe({}); return await tools.read_probe({});').result).isError).not.toBe(true);
    const next = await f.run('return await tools.read_probe({});').result;
    expect(next.isError).toBe(true); expect(next.content).toContain('max_tool_calls'); expect(read).toHaveBeenCalledTimes(2);
  });
  it('retains grants until the durable parent is retired', async () => {
    const f = fixture([tool('read_probe', async () => ok('read'))]);
    const run = f.run('return await tools.read_probe({});'); await run.result;
    expect(f.retire).not.toHaveBeenCalled(); f.nested.retire(run.request); expect(f.retire).toHaveBeenCalledOnce();
  });
  it('retains physical ownership and sticky uncertainty after a mutating timeout', async () => {
    const done = deferred<ToolResult>(), write = vi.fn(() => done.promise);
    const f = fixture([tool('mutate', write, true, 20)]);
    try {
      const result = await f.run('try { await tools.mutate({}); } catch {} return "caught";').result;
      expect(result.effectOutcome).toBe('unknown'); expect(f.effects.activeCount).toBe(1);
      expect(f.context.toolCallLedger?.outcomeUnknownTool).toBe('mutate');
      expect((await f.run('return await tools.mutate({});').result).effectOutcome).toBe('unknown');
      expect(write).toHaveBeenCalledOnce();
    } finally { done.resolve(ok('late ACK')); await f.effects.waitForIdle(); }
  });
  it('preserves structured data and image blocks from out-of-order results in invocation order', async () => {
    const first = deferred<ToolResult>();
    const image = { type: 'image' as const, mediaType: 'image/png' as const, base64: 'AA==' };
    const second = vi.fn();
    const f = fixture([tool('read_probe', async args => args.id === 1 ? first.promise
      : (second(), { content: 'second', structuredData: { value: 2 }, extraUserBlocks: [image] }))]);
    const run = f.run('return await Promise.all([tools.read_probe({id:1}), tools.read_probe({id:2})]);');
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.effects.activeCount).toBe(1));
    first.resolve({ content: 'first', extraUserBlocks: [{ type: 'text', text: 'block-1' }] });
    const result = await run.result;
    expect(result.content).toContain('value');
    expect(result.extraUserBlocks).toEqual([{ type: 'text', text: 'block-1' }, image]);
  });
  it('does not permit a caught explicit unknown to run another child', async () => {
    const write = vi.fn(async () => unknownToolOutcome('lost ACK'));
    const f = fixture([tool('mutate', write, true)]);
    const result = await f.run('try { await tools.mutate({}); } catch {} try { await tools.mutate({}); } catch {}').result;
    expect(result.effectOutcome).toBe('unknown'); expect(write).toHaveBeenCalledOnce();
  });
});
