import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { agentV1Capability as wire, type ResourceBinding } from '@mcp/agent-runtime-contracts';
import type { ValidatedCapabilityPrepare } from '@mcp/agent-runtime-host';
import { nativeToolUseId } from '@mcp/agent-runtime-host';
import { deriveCapabilityDescriptor } from '../core/capability-catalog.js';
import { evaluateToolInvocation, resolveToolInvocationMetadata, type PolicyContext } from '../core/policy.js';
import { aliasNormalizationEnabled, normalizeToolArgs } from '../core/tool-arg-aliases.js';
import type { CoderTool, ToolContext } from '../core/tool.js';
import type { ToolRegistry } from '../core/registry.js';
import type { ToolRegistryCapabilityDecisionResolverFactory } from './tool-registry-host-capability-executor.js';

export interface HostCapabilityPolicyAuthority {
  readonly attemptId: string;
  readonly environmentId: string;
  readonly environmentVersion: number;
  readonly workspaceLeaseId: string;
  readonly workspaceLeaseVersion: number;
  readonly workspaceFencingEpoch: number;
  readonly deadlineAtUnixMs: bigint;
  readonly policyVersion: string;
}

export interface HostCapabilityPolicyOptions {
  readonly registry: ToolRegistry;
  readonly toolContext: ToolContext;
  readonly getPolicyContext: () => PolicyContext;
  /** Read current fenced product authority, never provider/tool-supplied data. */
  readonly readAuthority: () => Promise<HostCapabilityPolicyAuthority>;
}

/** Existing product policy and PermissionGate remain the decision authorities.
 * Approval is bound to normalized input and the concrete resource fence, then
 * rechecked both after user input and at the physical executor boundary. */
export function createHostCapabilityPolicy(options: HostCapabilityPolicyOptions) {
  if (!options.registry.isSealed || !options.toolContext.permissionGate) {
    throw new Error('Native Host policy requires a sealed registry and the product permission gate');
  }
  const entries = new Map<string, CoderTool>(options.registry.list().map((tool) => [deriveCapabilityDescriptor(tool).descriptor.capabilityId, tool]));
  const seals = new Map<string, { authority: string; constraints: string; input: string; tool: CoderTool }>();
  const decisionResolverFactory: ToolRegistryCapabilityDecisionResolverFactory = (context, clock) => ({
    retire(_request, update) {
      if (update.decision.case === 'accepted') seals.delete(update.decision.value.grantId);
    },
    async resolve(request) {
      options.toolContext.signal?.throwIfAborted();
      const authority = await options.readAuthority();
      validateAuthority(authority, request, clock.now());
      if (context.identity.attemptId !== authority.attemptId) throw new Error('Native policy attempt differs from channel');
      const reject = (reasonCode: string) => ({ case: 'rejected' as const,
        value: create(wire.CapabilityRejectedSchema, { decisionId: randomUUID(), reasonCode,
          policyVersion: authority.policyVersion, decidedAtUnixMs: clock.now() }) });
      const tool = entries.get(request.capabilityId);
      if (!tool) return reject('tool_not_in_registry');
      const input = normalizedInput(tool, request);
      const policy = evaluateToolInvocation(tool, input, options.getPolicyContext());
      if (!policy.allowed) return reject(`policy_${policy.reason}`);
      let constraints: string;
      try { constraints = bindingSeal(options.toolContext, tool, request, input, authority, options.getPolicyContext().taskScope); }
      catch (error) { if (error instanceof TaskScopeViolation) return reject('policy_task_scope'); throw error; }
      if (!await options.toolContext.permissionGate!.check({ toolUseId: nativeToolUseId(request.identity.attemptId, request.providerOperationId, request.toolUseId),
        toolName: tool.name, tool, input }).then((decision) => decision.allowed)) {
        return reject(clock.now() >= request.deadlineAtUnixMs ? 'execution_deadline_elapsed' : 'user_denied');
      }
      const current = await options.readAuthority();
      options.toolContext.signal?.throwIfAborted();
      validateAuthority(current, request, clock.now());
      let currentConstraints: string;
      try { currentConstraints = bindingSeal(options.toolContext, tool, request, input, current, options.getPolicyContext().taskScope); }
      catch (error) { if (error instanceof TaskScopeViolation) return reject('policy_task_scope'); throw error; }
      if (authorityKey(current) !== authorityKey(authority) || currentConstraints !== constraints) return reject('approval_binding_changed');
      const policyAfterApproval = evaluateToolInvocation(tool, input, options.getPolicyContext());
      if (!policyAfterApproval.allowed) return reject(`policy_${policyAfterApproval.reason}`);
      if (seals.size >= 10_000) return reject('policy_grant_limit');
      const grantId = randomUUID();
      seals.set(grantId, { authority: authorityKey(current), constraints, input: hash(input), tool });
      const issued = clock.now();
      const expires = [issued + 300_000n, request.deadlineAtUnixMs, current.deadlineAtUnixMs]
        .reduce((a, b) => a < b ? a : b);
      return { case: 'accepted', value: create(wire.SealedExecutionGrantSchema, {
        grantId, decisionId: randomUUID(), capabilityId: request.capabilityId, capabilityVersion: request.capabilityVersion,
        operationId: request.operationId, toolUseId: request.toolUseId, effectiveInputSha256: Uint8Array.from(request.inputSha256),
        executionClass: request.executionClass, mutates: request.mutates,
        environmentId: current.environmentId, environmentVersion: BigInt(current.environmentVersion),
        workspaceLeaseId: current.workspaceLeaseId, workspaceLeaseVersion: BigInt(current.workspaceLeaseVersion),
        workspaceFencingEpoch: BigInt(current.workspaceFencingEpoch), resourceBindingId: `host:${request.operationId}`,
        constraintsSha256: Uint8Array.from(Buffer.from(constraints, 'hex')), policyVersion: current.policyVersion,
        nonce: Uint8Array.from(randomBytes(32)), issuedAtUnixMs: issued, expiresAtUnixMs: expires,
      }) };
    },
  });
  return { decisionResolverFactory, async validateGrant(request: ValidatedCapabilityPrepare, grant: wire.SealedExecutionGrant) {
    const sealed = seals.get(grant.grantId);
    if (!sealed) throw new Error('Native policy grant is not owned by this authority');
    const current = await options.readAuthority();
    validateAuthority(current, request, BigInt(Date.now()));
    const input = normalizedInput(sealed.tool, request);
    if (authorityKey(current) !== sealed.authority || hash(input) !== sealed.input
      || bindingSeal(options.toolContext, sealed.tool, request, input, current, options.getPolicyContext().taskScope) !== sealed.constraints
      || Buffer.from(grant.constraintsSha256).toString('hex') !== sealed.constraints
      || grant.expiresAtUnixMs <= BigInt(Date.now())
      || !evaluateToolInvocation(sealed.tool, input, options.getPolicyContext()).allowed) {
      throw new Error('Native policy grant became stale before execution');
    }
  } };
}

function normalizedInput(tool: CoderTool, request: ValidatedCapabilityPrepare): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.encodedJsonInput));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Native policy input is not an object');
  return aliasNormalizationEnabled() ? normalizeToolArgs(tool.parameters, parsed as Record<string, unknown>) : parsed as Record<string, unknown>;
}

function bindingSeal(context: ToolContext, tool: CoderTool, request: ValidatedCapabilityPrepare,
  input: Record<string, unknown>, authority: HostCapabilityPolicyAuthority, taskScope: PolicyContext['taskScope']): string {
  const metadata = resolveToolInvocationMetadata(tool, input);
  const effectful = metadata.mutates || metadata.executionClass !== 'read' || metadata.riskLevel !== 'read'
    || tool.effectBoundary !== undefined;
  if (effectful && context.mutationFence?.mode !== 'enforce') throw new Error('Native effect requires an enforced physical fence');
  const binding = context.mutationFence?.bindInvocation({ toolName: tool.name,
    toolUseId: nativeToolUseId(request.identity.attemptId, request.providerOperationId, request.toolUseId),
    effectiveInput: input, boundary: tool.effectBoundary, requiresEffectBoundary: effectful }).resourceBinding;
  if (effectful && !binding) throw new Error('Native effect requires a concrete resource binding');
  if (binding && (binding.environmentId !== authority.environmentId || binding.environmentVersion !== authority.environmentVersion
    || binding.workspaceLeaseId !== authority.workspaceLeaseId || binding.workspaceLeaseVersion !== authority.workspaceLeaseVersion
    || binding.workspaceFencingEpoch !== authority.workspaceFencingEpoch)) throw new Error('Native resource binding differs from product authority');
  // Check every declared filesystem target, including patch move destinations.
  // Arbitrary shell commands retain their existing advisory scope semantics.
  if (taskScope && binding) {
    const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    const roots = taskScope.files.filter(path => !isAbsolute(path) && !path.split(/[\\/]/).includes('..'))
      .map(path => canonical(resolve(context.cwd, path)));
    for (const resource of binding.canonicalResources) {
      if (resource.kind !== 'path' || resource.access !== 'write') continue;
      const candidate = canonical(resource.root);
      if (!roots.some(root => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep))) {
        throw new TaskScopeViolation(`Native write is outside the active task scope ${taskScope.id}`);
      }
    }
  }
  return hash({ authority: authorityKey(authority), input, taskScope, resources: binding ? bindingResources(binding) : { readScope: context.cwd } });
}

class TaskScopeViolation extends Error {}

function bindingResources(binding: ResourceBinding) { return { effectiveInputHash: binding.effectiveInputHash, resources: binding.canonicalResources }; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function authorityKey(value: HostCapabilityPolicyAuthority): string {
  return hash([value.attemptId, value.environmentId, value.environmentVersion, value.workspaceLeaseId,
    value.workspaceLeaseVersion, value.workspaceFencingEpoch, value.policyVersion]);
}
function validateAuthority(value: HostCapabilityPolicyAuthority, request: ValidatedCapabilityPrepare, now: bigint): void {
  if (value.attemptId !== request.identity.attemptId || !value.environmentId || !value.workspaceLeaseId || !value.policyVersion
    || [value.environmentVersion, value.workspaceLeaseVersion, value.workspaceFencingEpoch].some((n) => !Number.isSafeInteger(n) || n < 1)
    || now >= value.deadlineAtUnixMs || now >= request.deadlineAtUnixMs) throw new Error('Native policy authority is stale or invalid');
}
