import { createHash, randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Capability } from '@mcp/agent-runtime-contracts';
import type { ValidatedCapabilityPrepare } from '@mcp/agent-runtime-host';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { PermissionGate } from '../../core/permission-gate.js';
import { deriveCapabilityDescriptor } from '../../core/capability-catalog.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import { createHostCapabilityPolicy, type HostCapabilityPolicyAuthority } from '../host-capability-policy.js';
import type { CoderTool } from '../../core/tool.js';
import type { PolicyContext } from '../../core/policy.js';

function fixture() {
  const attemptId = randomUUID();
  const ownerAgentRunId = randomUUID();
  const authority = { attemptId, environmentId: 'environment', environmentVersion: 1,
    workspaceLeaseId: 'lease', workspaceLeaseVersion: 1, workspaceFencingEpoch: 1,
    deadlineAtUnixMs: BigInt(Date.now() + 60_000), policyVersion: 'policy-v1' } satisfies HostCapabilityPolicyAuthority;
  const tool: CoderTool = { name: 'write_probe', description: 'write', source: 'native',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    mutates: true, riskLevel: 'write', effectBoundary: 'filesystem', handler: async () => ({ content: 'unused' }) };
  const registry = new ToolRegistry(); registry.register(tool); registry.seal();
  let approve!: (value: string) => void;
  const emitted = vi.fn();
  const permissions = new PermissionGate({ getMode: () => 'ask', emit: emitted,
    waitForUserInput: () => new Promise((resolve) => { approve = resolve; }) });
  const controller = new AbortController();
  const mutationFence = createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: process.cwd(),
    assertLease() {}, snapshot: () => ({ ...authority, ownerAgentRunId }) });
  const state: PolicyContext = { planMode: false, planApproved: false, taskScope: null };
  const policy = createHostCapabilityPolicy({ registry, getPolicyContext: () => state,
    toolContext: { cwd: process.cwd(), projectName: 'test', permissionGate: permissions, mutationFence, signal: controller.signal },
    readAuthority: async () => ({ ...authority }) });
  const identity = create(agentV1Common.AttemptIdentitySchema, { attemptId });
  const encodedJsonInput = new TextEncoder().encode(JSON.stringify({ file_path: 'scratch/policy-probe.txt' }));
  const descriptor = deriveCapabilityDescriptor(tool).descriptor;
  const request: ValidatedCapabilityPrepare = { identity, runtimeInstanceId: 'runtime', operationId: 'operation',
    providerOperationId: 'provider', toolUseId: 'tool', capabilityId: descriptor.capabilityId, capabilityVersion: descriptor.version,
    executionClass: agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY, mutates: true,
    encodedJsonInput, inputSha256: createHash('sha256').update(encodedJsonInput).digest(),
    capabilitySetSha256: new Uint8Array(32), idempotencyKey: 'request', deadlineAtUnixMs: authority.deadlineAtUnixMs };
  const resolver = policy.decisionResolverFactory({ identity, runtimeInstanceId: 'runtime',
    limits: create(agentV1Common.FrameLimitsSchema), timeoutMs: 1_000 }, { now: () => BigInt(Date.now()) });
  return { authority, controller, state, policy, resolver, request, emitted, approve: (value = { approved: true }) => approve(JSON.stringify(value)) };
}

describe('product native Host policy', () => {
  it('rejects writes outside the active task and binds grants to its exact scope', async () => {
    const f = fixture(); f.state.taskScope = { id: 'task-a', files: ['other.txt'] };
    expect(await f.resolver.resolve(f.request)).toMatchObject({ case: 'rejected', value: { reasonCode: 'policy_task_scope' } });
    expect(f.emitted).not.toHaveBeenCalled();
    f.state.taskScope.files = ['scratch/policy-probe.txt'];
    const pending = f.resolver.resolve(f.request); await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.approve(); const decision = await pending;
    expect(decision.case).toBe('accepted'); if (decision.case !== 'accepted') return;
    await f.policy.validateGrant(f.request, decision.value);
    f.state.taskScope = { id: 'task-b', files: ['scratch/policy-probe.txt'] };
    await expect(f.policy.validateGrant(f.request, decision.value)).rejects.toThrow('stale');
  });
  it('rechecks task scope after user approval without allowing a prefix sibling', async () => {
    const f = fixture(); f.state.taskScope = { id: 'task', files: ['scratch/policy'] };
    expect(await f.resolver.resolve(f.request)).toMatchObject({ case: 'rejected', value: { reasonCode: 'policy_task_scope' } });
    f.state.taskScope.files = ['scratch']; const pending = f.resolver.resolve(f.request);
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.state.taskScope.files = ['other']; f.approve();
    expect(await pending).toMatchObject({ case: 'rejected', value: { reasonCode: 'policy_task_scope' } });
  });
  it('gives reused provider tool IDs distinct approval identities across turns', async () => {
    const f = fixture();
    const first = f.resolver.resolve(f.request);
    await vi.waitFor(() => expect(f.emitted.mock.calls.some(([event]) => event === 'tool_approval_request')).toBe(true));
    f.approve(); await first;
    const next = f.resolver.resolve({ ...f.request, operationId: 'operation-2', providerOperationId: 'provider-2' });
    await vi.waitFor(() => expect(f.emitted.mock.calls.filter(([event]) => event === 'tool_approval_request')).toHaveLength(2));
    const requests = f.emitted.mock.calls.filter(([event]) => event === 'tool_approval_request');
    expect(requests[0]![1].toolUseId).not.toBe(requests[1]![1].toolUseId);
    f.approve(); await next;
  });
  it('waits for actual permission, binds normalized resources and rechecks the lease before dispatch', async () => {
    const f = fixture(); const pending = f.resolver.resolve(f.request);
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.approve(); const decision = await pending;
    expect(decision.case).toBe('accepted');
    if (decision.case !== 'accepted') throw new Error('grant expected');
    await f.policy.validateGrant(f.request, decision.value);
    f.authority.workspaceFencingEpoch++;
    await expect(f.policy.validateGrant(f.request, decision.value)).rejects.toThrow('stale');
  });

  it('refuses a grant after authority changes while approval is pending', async () => {
    const f = fixture(); const pending = f.resolver.resolve(f.request);
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.authority.workspaceLeaseVersion++; f.approve();
    expect(await pending).toMatchObject({ case: 'rejected', value: { reasonCode: 'approval_binding_changed' } });
  });

  it('enforces plan mode before asking and rechecks plan state after approval', async () => {
    const f = fixture(); f.state.planMode = true;
    expect(await f.resolver.resolve(f.request)).toMatchObject({ case: 'rejected', value: { reasonCode: 'policy_plan_mode' } });
    expect(f.emitted).not.toHaveBeenCalled();
    f.state.planMode = false; const pending = f.resolver.resolve(f.request);
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.state.planMode = true; f.approve();
    expect(await pending).toMatchObject({ case: 'rejected', value: { reasonCode: 'policy_plan_mode' } });
  });

  it('does not accept a late approval after cancellation or a denied response', async () => {
    const f = fixture(); const pending = f.resolver.resolve(f.request);
    await vi.waitFor(() => expect(f.emitted).toHaveBeenCalled());
    f.controller.abort(); f.approve(); await expect(pending).rejects.toThrow();
    const denied = fixture(); const result = denied.resolver.resolve(denied.request);
    await vi.waitFor(() => expect(denied.emitted).toHaveBeenCalled());
    denied.approve({ approved: false });
    expect(await result).toMatchObject({ case: 'rejected', value: { reasonCode: 'user_denied' } });
  });
});
