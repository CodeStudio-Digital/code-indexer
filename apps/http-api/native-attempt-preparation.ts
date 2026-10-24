import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime, type AgentRun, type AgentRunAttempt, type EnvironmentId } from '@mcp/agent-runtime-contracts';
import { nativePrepareAttempt, validateSnapshotManifest } from '@mcp/agent-runtime-host';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { NativeWorkspaceLease } from './native-workspace-leases.js';

export interface NativeAttemptPreparationInput {
  readonly prepare: agentV1Runtime.PrepareAttempt;
  readonly activationNonceSha256: Uint8Array;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits: readonly agentV1Common.ResourceLimitKind[];
}

export interface NativeAttemptAdmission {
  readonly preparationRef: string;
  readonly preparationSha256: string;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
}

export interface NativePreparationRecord {
  checkpointType: 'native-preparation-v1';
  encodedPrepare: string;
  activationNonceSha256: string;
  requiredContainmentLevel: number;
  requiredEnforcedLimits: number[];
  agentRunVersion: number;
  attemptVersion: number;
}

export function nativeRecordId(attemptId: string, phase: 'prepare' | 'activate' | 'physical-recovery'): string {
  const hex = createHash('sha256').update(`native-attempt:v1:${attemptId}:${phase}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Validate the exact environment grant admitted for this attempt, including
 * a managed worktree. The original project root is not the execution root. */
export async function assertPreparedWorkspaceLease(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, lease: NativeWorkspaceLease): Promise<void> {
  const record = await repository.get('nativePreparation', nativeRecordId(context.attemptId, 'prepare'));
  const data = record?.data as unknown as NativePreparationRecord | undefined;
  if (data?.checkpointType !== 'native-preparation-v1' || typeof data.encodedPrepare !== 'string'
    || data.encodedPrepare.length > 12 * 1024 * 1024) throw new Error('Native workspace has no admitted preparation');
  const prepare = fromBinary(agentV1Runtime.PrepareAttemptSchema, Buffer.from(data.encodedPrepare, 'base64'));
  const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, prepare.encodedSpec);
  const owner = spec.identity, snapshot = spec.workspaceLeaseSnapshot;
  const digest = createHash('sha256').update(JSON.stringify(lease)).digest();
  if (!owner || owner.sessionId !== context.sessionId || owner.commandId !== context.commandId
    || owner.agentRunId !== context.agentRunId || owner.attemptId !== context.attemptId
    || owner.executorOwnerId !== context.executorOwnerId || owner.fencingEpoch !== BigInt(context.fencingEpoch)
    || !snapshot || snapshot.origin !== 'product-authority'
    || snapshot.schemaId !== 'codestudio.product.workspace-lease.v1' || snapshot.schemaVersion !== 1
    || !Buffer.from(nativePrepareAttempt(spec).expectedSpecSha256).equals(prepare.expectedSpecSha256)
    || !digest.equals(snapshot.contentSha256)) {
    throw new Error('Native workspace lease differs from its admitted preparation');
  }
}

export function copyNativePreparation(input: NativeAttemptPreparationInput): NativeAttemptPreparationInput {
  const encoded = toBinary(agentV1Runtime.PrepareAttemptSchema, input.prepare);
  if (encoded.length > 8 * 1024 * 1024) throw new Error('Native preparation exceeds 8 MiB');
  return { prepare: fromBinary(agentV1Runtime.PrepareAttemptSchema, encoded),
    activationNonceSha256: Uint8Array.from(input.activationNonceSha256), requiredContainmentLevel: input.requiredContainmentLevel,
    requiredEnforcedLimits: [...input.requiredEnforcedLimits] };
}

export function validateNativePreparation(input: NativeAttemptPreparationInput, context: ControlPlaneRunContext,
  run: AgentRun, attempt: AgentRunAttempt, rootAgentRunId: string): agentV1Runtime.ResolvedAttemptSpec {
  const { prepare } = input;
  const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, prepare.encodedSpec);
  const identity = spec.identity;
  if (!identity || !prepare.identity || !Buffer.from(toBinary(agentV1Common.AttemptIdentitySchema, identity))
    .equals(toBinary(agentV1Common.AttemptIdentitySchema, prepare.identity))
    || identity.sessionId !== context.sessionId || identity.commandId !== context.commandId
    || identity.agentRunId !== context.agentRunId || identity.attemptId !== context.attemptId
    || identity.executorOwnerId !== context.executorOwnerId || identity.fencingEpoch !== BigInt(context.fencingEpoch)
    || identity.correlationId !== context.correlationId || identity.rootAgentRunId !== rootAgentRunId
    || identity.parentAgentRunId !== run.parentAgentRunId || identity.ownerAgentRunId !== run.ownerAgentRunId) {
    throw new Error('Native preparation does not match durable authority');
  }
  const canonical = nativePrepareAttempt(spec);
  validateSnapshotManifest(prepare.expectedSnapshots, canonical.expectedSnapshots);
  const digest = canonical.expectedSpecSha256;
  if (spec.schemaVersion !== 1 || prepare.specSchemaVersion !== 1 || spec.specVersion !== BigInt(run.specVersion)
    || !Buffer.from(digest).equals(prepare.expectedSpecSha256) || input.activationNonceSha256.length !== 32
    || spec.ordinal !== attempt.ordinal || spec.role !== run.role || spec.spawnDepth !== run.spawnDepth
    || !spec.agentDefinitionId || !spec.task?.body.case || !spec.providerBinding?.effectiveProvider
    || !spec.providerBinding.effectiveModel || !prepare.idempotencyKey
    || spec.workspaceLeaseFencingEpoch <= 0n || spec.deadlineAtUnixMs <= BigInt(Date.now())
    || BigInt(Date.parse(attempt.executorLease.expiresAt)) <= BigInt(Date.now())) {
    throw new Error('Native preparation has unresolved, divergent, or expired executable inputs');
  }
  if (![agentV1Common.ContainmentLevel.MONITORED, agentV1Common.ContainmentLevel.HARD_PROCESS,
    agentV1Common.ContainmentLevel.HARD_AGGREGATE].includes(input.requiredContainmentLevel)
    || input.requiredEnforcedLimits.some((limit) => limit <= 0 || limit > agentV1Common.ResourceLimitKind.SCRATCH_BYTES)
    || new Set(input.requiredEnforcedLimits).size !== input.requiredEnforcedLimits.length) {
    throw new Error('Native containment requirements are invalid');
  }
  const budget = spec.resourceBudget;
  if (!budget || [budget.softMemoryBytes, budget.hardMemoryBytes, budget.cpuTimeMs, budget.maxWallMs,
    budget.maxHotTranscriptBytes, budget.maxIpcBytes, budget.maxSpoolBytes, budget.maxArtifactBytes,
    budget.cancelGraceMs].some((value) => value <= 0n)
    || [budget.maxProcesses, budget.maxThreads, budget.maxOpenHandles, budget.maxIpcFrames,
      budget.maxConcurrentTools, budget.maxBlockingTasks].some((value) => value <= 0)
    || budget.softMemoryBytes > budget.hardMemoryBytes || budget.maxArtifactBytes > budget.maxSpoolBytes) {
    throw new Error('Native resource budget is invalid');
  }
  return spec;
}

/** Caller owns the session queue and rechecks authority after all I/O. */
export async function commitNativePreparation(repository: ControlPlaneFileRepository, context: ControlPlaneRunContext,
  input: NativeAttemptPreparationInput, run: AgentRun, attempt: AgentRunAttempt,
  spec: agentV1Runtime.ResolvedAttemptSpec, updateRun: (value: AgentRun) => Promise<unknown>): Promise<NativeAttemptAdmission> {
  const id = nativeRecordId(context.attemptId, 'prepare');
  const existing = await repository.get('nativePreparation', id);
  const prior = existing?.data as unknown as NativePreparationRecord | undefined;
  const data: NativePreparationRecord = {
    checkpointType: 'native-preparation-v1', encodedPrepare: Buffer.from(toBinary(agentV1Runtime.PrepareAttemptSchema, input.prepare)).toString('base64'),
    activationNonceSha256: Buffer.from(input.activationNonceSha256).toString('hex'),
    requiredContainmentLevel: input.requiredContainmentLevel, requiredEnforcedLimits: [...input.requiredEnforcedLimits],
    // Resolution and activation each advance the run once; activation advances
    // the attempt once. A committed record fixes these versions across replay.
    agentRunVersion: prior?.agentRunVersion ?? run.version + 2,
    attemptVersion: prior?.attemptVersion ?? attempt.version + 1,
  };
  if (prior && hashControlPlanePayload(prior) !== hashControlPlanePayload(data)) {
    throw new Error('Native preparation was already committed with different inputs');
  }
  if (!prior) await repository.create('nativePreparation', { id, operationId: id,
    relations: { session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId }, data: { ...data } });
  const resolved: AgentRun = JSON.parse(JSON.stringify({ ...run,
    effectiveProvider: spec.providerBinding!.effectiveProvider, effectiveModel: spec.providerBinding!.effectiveModel,
    effectiveReasoningEffort: spec.providerBinding!.effectiveReasoningEffort || undefined,
    effectivePreset: spec.agentDefinitionId, capabilitySetRef: spec.capabilitySetSnapshot!.ref,
    environmentId: spec.environmentSnapshot!.ref as EnvironmentId, presetResolutionRef: spec.presetSnapshot!.ref,
    policySnapshotRef: spec.policySnapshot!.ref, version: data.agentRunVersion - 1 }));
  if (run.version > resolved.version || attempt.version !== data.attemptVersion - 1) {
    throw new Error('Native preparation versions were superseded');
  }
  if (hashControlPlanePayload(run) !== hashControlPlanePayload(resolved)) await updateRun(resolved);
  return { preparationRef: `events/native-preparations/${id}.json`, preparationSha256: hashControlPlanePayload(data),
    activationAuthoritySeal: create(agentV1Common.ActivationAuthoritySealSchema, { agentRunVersion: BigInt(data.agentRunVersion),
      attemptVersion: BigInt(data.attemptVersion), activationNonceSha256: Uint8Array.from(input.activationNonceSha256) }) };
}
