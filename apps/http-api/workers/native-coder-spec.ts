import type { NativeCoderExecutionBudget } from './native-coder-budget.js';
import { createHash, randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Common as common, agentV1Runtime as wire, agentV1SessionStore as storage,
  type AgentRunSpec } from '../../../packages/agent-runtime-contracts/src/index.js';
import type { HostHydrationSource } from '../../../packages/agent-runtime-host/src/ipc/HostDataHydration.js';
import { composeNativeHydrationSources } from '../../../packages/agent-runtime-host/src/native/NativeHydrationComposition.js';
import type { prepareNativeCoderContext } from '../../../packages/code-agent/src/runtime/native-coder-context.js';
import type { PreparedCoderInputs } from '../../../packages/code-agent/src/runtime/prepared-coder-execution.js';
import type { NativeProductAuthority } from '../native-attempt-runtime.js';
import type { ControlPlaneRunContext } from '../../../packages/store/src/control-plane/index.js';
import type { NativeWorkspaceLease } from '../native-workspace-leases.js';
import type { prepareNativeContinuation } from './native-coder-continuation.js';
import { NATIVE_SESSION_FRAME_BYTES, NATIVE_SESSION_PAYLOAD_BYTES } from '../../../packages/agent-runtime-host/src/native/NativeSessionStoreLimits.js';

export function buildNativeCoderSpec(input: {
  context: ControlPlaneRunContext;
  state: Awaited<ReturnType<NativeProductAuthority['getAttemptState']>>;
  prepared: PreparedCoderInputs;
  material: Awaited<ReturnType<typeof prepareNativeCoderContext>>;
  lease: NativeWorkspaceLease;
  executionBudget: NativeCoderExecutionBudget;
  treeLimits?: { maxAgents: number; maxDepth: number };
  sessionRoot: string;
  storageEpoch?: bigint;
  continuation?: Awaited<ReturnType<typeof prepareNativeContinuation>>;
}) {
  const { context, state, prepared, material, lease, executionBudget } = input;
  if (executionBudget.deadlineAtUnixMs !== lease.expiresAtUnixMs) throw new Error('Native workspace lease differs from its execution budget');
  const now = Date.now();
  const remaining = BigInt(lease.expiresAtUnixMs - now);
  if (executionBudget.executionDeadlineAtUnixMs <= now || executionBudget.executionDeadlineAtUnixMs > lease.expiresAtUnixMs) {
    throw new Error('Native preparation exhausted its execution budget');
  }
  if (remaining <= 0n) throw new Error('Native preparation exhausted its authority deadline');
  const snapshots = [
    snapshot('verifier', { schemaVersion: 1, mode: 'product-development', workspaceAccess: lease.access,
      ...(input.continuation ? { continuation: input.continuation.proof } : {}) }),
    snapshot('environment', { schemaVersion: 1, environmentId: lease.environmentId,
      root: lease.root, kind: prepared.preparation.environment.kind, version: lease.environmentVersion }),
    snapshot('workspace-lease', lease),
    snapshot('policy', prepared.preparation.policy),
  ];
  const spec = create(wire.ResolvedAttemptSpecSchema, {
    schemaVersion: 1, specVersion: BigInt(state.run.specVersion), ordinal: state.attempt.ordinal,
    identity: { ...context, fencingEpoch: BigInt(context.fencingEpoch), rootAgentRunId: state.command.agentRunId!,
      parentAgentRunId: state.run.parentAgentRunId, ownerAgentRunId: state.run.ownerAgentRunId },
    trigger: input.continuation ? wire.AttemptTrigger.SESSION_CONTINUATION : wire.AttemptTrigger.INITIAL,
    spawnDepth: state.run.spawnDepth, role: state.run.role, agentDefinitionId: prepared.preparation.agentDefinitionId,
    task: material.task, providerBinding: material.providerBinding, waitMode: wire.AgentRunWaitMode.FOREGROUND,
    deadlineAtUnixMs: BigInt(lease.expiresAtUnixMs), executionDeadlineAtUnixMs: BigInt(executionBudget.executionDeadlineAtUnixMs), workspaceLeaseFencingEpoch: BigInt(lease.fencingEpoch),
    verifierPolicySnapshot: snapshots[0]!.reference, environmentSnapshot: snapshots[1]!.reference,
    workspaceLeaseSnapshot: snapshots[2]!.reference, policySnapshot: snapshots[3]!.reference,
    agentDefinitionSnapshot: material.definitionSnapshot, capabilitySetSnapshot: material.capabilitySetSnapshot,
    presetSnapshot: material.presetSnapshot,
    initialConversationSnapshot: input.continuation ? undefined : material.initialConversationSnapshot,
    checkpointInput: input.continuation?.reference,
    runTreeBudget: { maxTurns: executionBudget.maxTurns === undefined ? undefined : BigInt(executionBudget.maxTurns),
      maxToolCalls: executionBudget.maxToolCalls === undefined ? undefined : BigInt(executionBudget.maxToolCalls),
      maxWallMs: remaining, maxAgents: input.treeLimits?.maxAgents ?? 1, maxDepth: Math.max(1, input.treeLimits?.maxDepth ?? 1) },
    resourceBudget: { softMemoryBytes: 256n * 1024n * 1024n, hardMemoryBytes: 512n * 1024n * 1024n,
      cpuTimeMs: remaining, maxWallMs: remaining, maxProcesses: 16, maxThreads: 64, maxOpenHandles: 1024,
      maxHotTranscriptBytes: 8n * 1024n * 1024n, maxIpcFrames: 256, maxIpcBytes: 16n * 1024n * 1024n,
      maxSpoolBytes: 32n * 1024n * 1024n, maxArtifactBytes: 16n * 1024n * 1024n,
      maxConcurrentTools: 4, maxBlockingTasks: 4, cancelGraceMs: 1000n },
  });
  const runSpec: AgentRunSpec = { schemaVersion: 1, sessionId: context.sessionId, commandId: context.commandId,
    spawnDepth: state.run.spawnDepth, role: state.run.role, agentDefinitionId: prepared.preparation.agentDefinitionId,
    task: { text: 'Prepared product conversation' }, requestedCapabilityProfile: prepared.preparation.capabilityProfile,
    requestedEnvironment: { kind: prepared.preparation.environment.kind, projectId: lease.environmentId, access: lease.access, retention: 'retain_on_failure' },
    waitMode: 'foreground', budget: { maxWallMs: Number(remaining), maxTurns: executionBudget.maxTurns, maxToolCalls: executionBudget.maxToolCalls }, idempotencyKey: context.commandId };
  const preparedSource = input.continuation?.source ?? material.source;
  const source: HostHydrationSource = {
    items: [...snapshots.map((item) => ({ reference: { case: 'snapshot' as const, value: item.reference },
      byteLength: BigInt(item.bytes.length) })), ...preparedSource.items],
    readExact: async (ordinal, offset, length, signal) => {
      signal?.throwIfAborted();
      if (ordinal >= snapshots.length) return preparedSource.readExact(ordinal - snapshots.length, offset, length, signal);
      const entry = snapshots[ordinal];
      if (!entry || offset < 0n || !Number.isSafeInteger(length) || length < 1 || offset + BigInt(length) > BigInt(entry.bytes.length)) {
        throw new Error('Native authority hydration read exceeds snapshot');
      }
      return entry.bytes.slice(Number(offset), Number(offset) + length);
    },
    close: async (cause) => { for (const entry of snapshots) entry.bytes.fill(0); await preparedSource.close?.(cause); },
  };
  return { spec, runSpec, source: composeNativeHydrationSources(spec, [source]), sessionStore: {
    instanceId: `product-session:${randomUUID()}`, rootId: 'native-product-sessions', rootPath: input.sessionRoot,
    maximumFrameBytes: NATIVE_SESSION_FRAME_BYTES, sessionId: context.sessionId,
    authority: create(storage.SessionStoreAuthoritySchema, { storageGeneration: storage.StorageGeneration.RUST_FS_V1,
      leaseEpoch: input.storageEpoch ?? 1n, writerId: context.attemptId }),
    limits: create(storage.SessionStoreLimitsSchema, { maxRecords: 1_000_000n, maxPayloadBytes: BigInt(NATIVE_SESSION_PAYLOAD_BYTES),
      maxAuthorityTransitions: 100_000n }),
    openIdempotencyKey: `native-product-open:${context.attemptId}`, nowUnixMs: () => BigInt(Date.now()), timeoutMs: 10_000n,
  } };
}

function snapshot(label: string, value: unknown) {
  const bytes = Uint8Array.from(Buffer.from(JSON.stringify(value)));
  return { bytes, reference: create(common.SnapshotRefSchema, { ref: `product-${label}:${randomUUID()}`,
    version: 1n, origin: 'product-authority', schemaId: `codestudio.product.${label}.v1`, schemaVersion: 1,
    contentSha256: Uint8Array.from(createHash('sha256').update(bytes).digest()) }) };
}
