import { createHash } from 'node:crypto';
import type { ResourceBinding } from '@mcp/agent-runtime-contracts';
import type { NativeCoderDevelopmentConfig } from './workers/native-coder-execution.js';
import type { NativeProductAuthority } from './native-attempt-runtime.js';
import type { FileControlPlaneAuthority } from './file-control-plane-store.js';
import { NativeWorkspaceLeaseStore, type NativeWorkspaceLease } from './native-workspace-leases.js';

export interface NativeApplicationRequest {
  key: string;
  authority?: { payload: unknown; binding?: ResourceBinding; toolUseId?: string; toolName: string; input: Record<string, unknown> };
}

export async function authorizeNativeApplicationDispatch(request: NativeApplicationRequest,
  config: NativeCoderDevelopmentConfig, contract: { name: string; key: string; operation: string; args: Record<string, unknown>; databaseId?: string },
  store: NativeProductAuthority & Pick<FileControlPlaneAuthority, 'assertNativeWorkspaceLease'>,
  assertOwner: () => void) {
  const packet = request.authority;
  const payload = packet?.payload as { lease?: NativeWorkspaceLease; sharedLease?: NativeWorkspaceLease } | undefined;
  const lease = payload?.lease, sharedLease = payload?.sharedLease, binding = packet?.binding;
  const { name, args } = contract;
  const resource = binding?.canonicalResources?.[0];
  const matchingResource = binding?.canonicalResources?.length === 1 && resource
    && (contract.databaseId ? resource.kind === 'database' && resource.databaseId === contract.databaseId
      : resource.kind === 'application' && resource.appId === name)
    && 'operations' in resource && resource.operations.includes(contract.operation);
  if (!lease || !binding || !packet?.toolUseId || packet.toolName !== name || !packet.input
    || request.key !== contract.key
    || lease.ownerAgentRunId !== config.context.agentRunId || lease.attemptId !== config.context.attemptId
    || lease.access !== 'exclusive_write'
    || binding.environmentId !== lease.environmentId || binding.environmentVersion !== lease.environmentVersion
    || binding.workspaceLeaseId !== lease.leaseId || binding.workspaceLeaseVersion !== lease.version
    || binding.workspaceFencingEpoch !== lease.fencingEpoch
    || binding.bindingId !== `effect:${lease.leaseId}:${packet.toolUseId}`
    || binding.effectiveInputHash !== createHash('sha256').update(JSON.stringify(packet.input)).digest('hex')
    || !matchingResource) {
    throw new Error('Native application has no matching product resource authority');
  }
  if (!!config.sharedWorkspaceLeaseRoot !== !!sharedLease || (sharedLease
    && (sharedLease.attemptId !== lease.attemptId || sharedLease.ownerAgentRunId !== lease.ownerAgentRunId
      || sharedLease.root !== lease.root || sharedLease.access !== lease.access
      || sharedLease.expiresAtUnixMs !== lease.expiresAtUnixMs))) {
    throw new Error('Native application has no matching shared workspace authority');
  }
  assertOwner();
  const state = await store.getAttemptState(config.context);
  await store.assertNativeWorkspaceLease(config.context, lease);
  const expiresAt = Math.min(lease.expiresAtUnixMs, Date.parse(state.attempt.executorLease.expiresAt), Date.parse(binding.expiresAt));
  if (!Number.isFinite(expiresAt)) throw new Error('Native application deadline is invalid');
  const verifier = NativeWorkspaceLeaseStore.verifier(config.workspaceLeaseRoot);
  const sharedVerifier = config.sharedWorkspaceLeaseRoot && NativeWorkspaceLeaseStore.verifier(config.sharedWorkspaceLeaseRoot);
  const assertLifetime = () => {
    assertOwner();
    verifier.assertCurrentForMutation(lease);
    if (sharedVerifier && sharedLease) sharedVerifier.assertCurrentForMutation(sharedLease);
  };
  const assertDispatch = () => {
    assertLifetime();
    if (Date.now() >= expiresAt) throw new Error('Native application invocation authority expired');
  };
  assertDispatch();
  return { lease, args, assertDispatch, assertLifetime };
}
