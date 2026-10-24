import { createHash } from 'node:crypto';
import type { ResourceBinding } from '@mcp/agent-runtime-contracts';
import type { NativeCoderDevelopmentConfig } from './workers/native-coder-execution.js';
import type { NativeProductAuthority } from './native-attempt-runtime.js';
import type { FileControlPlaneAuthority } from './file-control-plane-store.js';
import type { WorkerMcpCallRequest } from './sse/worker-mcp-calls.js';
import { NativeWorkspaceLeaseStore, type NativeWorkspaceLease } from './native-workspace-leases.js';

/** Validate only the owning worker's authority. The transport invokes the
 * returned synchronous predicate after reconnect, immediately before tools/call. */
export async function authorizeNativeMcpDispatch(request: WorkerMcpCallRequest,
  config: NativeCoderDevelopmentConfig, store: NativeProductAuthority & Pick<FileControlPlaneAuthority, 'assertNativeWorkspaceLease'>,
  assertOwner: () => void): Promise<() => void> {
  const packet = request.authority as { payload?: { lease?: NativeWorkspaceLease; sharedLease?: NativeWorkspaceLease };
    binding?: ResourceBinding; toolUseId?: string } | undefined;
  const lease = packet?.payload?.lease, binding = packet?.binding;
  const sharedLease = packet?.payload?.sharedLease;
  const name = 'ext_' + request.serverId + '__' + request.toolName;
  if (!lease || !binding || !packet?.toolUseId || !request.catalogueRevision
    || lease.ownerAgentRunId !== config.context.agentRunId || lease.attemptId !== config.context.attemptId
    || lease.access !== 'exclusive_write'
    || binding.environmentId !== lease.environmentId || binding.environmentVersion !== lease.environmentVersion
    || binding.workspaceLeaseId !== lease.leaseId || binding.workspaceLeaseVersion !== lease.version
    || binding.workspaceFencingEpoch !== lease.fencingEpoch
    || binding.bindingId !== 'effect:' + lease.leaseId + ':' + packet.toolUseId
    || binding.effectiveInputHash !== createHash('sha256').update(JSON.stringify(request.args)).digest('hex')
    || !Array.isArray(binding.canonicalResources) || binding.canonicalResources.length !== 1
    || binding.canonicalResources[0]?.kind !== 'application'
    || binding.canonicalResources[0].appId !== name
    || !binding.canonicalResources[0].operations.includes('tools/call')) {
    throw new Error('Native MCP dispatch has no matching product resource authority');
  }
  if (!!config.sharedWorkspaceLeaseRoot !== !!sharedLease || (sharedLease
    && (sharedLease.attemptId !== lease.attemptId || sharedLease.ownerAgentRunId !== lease.ownerAgentRunId
      || sharedLease.root !== lease.root || sharedLease.access !== lease.access
      || sharedLease.expiresAtUnixMs !== lease.expiresAtUnixMs))) {
    throw new Error('Native MCP dispatch has no matching shared workspace authority');
  }
  assertOwner();
  const state = await store.getAttemptState(config.context);
  await store.assertNativeWorkspaceLease(config.context, lease);
  const expiresAt = Math.min(lease.expiresAtUnixMs, Date.parse(state.attempt.executorLease.expiresAt), Date.parse(binding.expiresAt));
  if (!Number.isFinite(expiresAt)) throw new Error('Native MCP authority deadline is invalid');
  const verifier = NativeWorkspaceLeaseStore.verifier(config.workspaceLeaseRoot);
  const sharedVerifier = config.sharedWorkspaceLeaseRoot && NativeWorkspaceLeaseStore.verifier(config.sharedWorkspaceLeaseRoot);
  const assertDispatch = () => {
    assertOwner();
    if (Date.now() >= expiresAt) throw new Error('Native MCP authority expired');
    verifier.assertCurrentForMutation(lease);
    if (sharedVerifier && sharedLease) sharedVerifier.assertCurrentForMutation(sharedLease);
  };
  assertDispatch();
  return assertDispatch;
}
