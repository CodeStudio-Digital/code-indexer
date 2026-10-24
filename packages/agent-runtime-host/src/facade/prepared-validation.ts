import { toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
  isResolvedAgentRun,
  type AgentRunId,
} from '@mcp/agent-runtime-contracts';
import { AgentRuntimeHostError } from '../errors.js';
import { semanticSha256 } from '../ipc/semantic-hash.js';
import { assertLegacyPreparation } from './legacy-prepared-validation.js';
import type {
  ExecutableAgentAttempt,
  PreparedAgentAttempt,
  ResumeAgentCommand,
  StartAgentCommand,
} from './types.js';

function reject(detail: string): never {
  throw new AgentRuntimeHostError(
    'prepared_attempt_mismatch',
    `Prepared attempt is not executable: ${detail}`,
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validSha256(value: Uint8Array | undefined): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32;
}

function unixMs(value: string, field: string): bigint {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) reject(`${field} is not a safe timestamp`);
  return BigInt(parsed);
}

function assertSnapshot(
  snapshot: {
    ref: string;
    version: bigint;
    contentSha256: Uint8Array;
    origin: string;
    schemaId: string;
    schemaVersion: number;
  } | undefined,
  field: string,
): void {
  if (
    !snapshot
    || !nonEmpty(snapshot.ref)
    || snapshot.version <= 0n
    || !validSha256(snapshot.contentSha256)
    || !nonEmpty(snapshot.origin)
    || !nonEmpty(snapshot.schemaId)
    || !Number.isSafeInteger(snapshot.schemaVersion)
    || snapshot.schemaVersion <= 0
  ) {
    reject(`${field} is missing versioned, hashed provenance`);
  }
}

function assertResourceBudget(
  budget: agentV1Common.ResourceBudget | undefined,
): void {
  if (!budget) reject('resource budget is absent');
  const positiveBigints = [
    budget.softMemoryBytes,
    budget.hardMemoryBytes,
    budget.cpuTimeMs,
    budget.maxWallMs,
    budget.maxHotTranscriptBytes,
    budget.maxIpcBytes,
    budget.maxSpoolBytes,
    budget.maxArtifactBytes,
    budget.cancelGraceMs,
  ];
  const positiveNumbers = [
    budget.maxProcesses,
    budget.maxThreads,
    budget.maxOpenHandles,
    budget.maxIpcFrames,
    budget.maxConcurrentTools,
    budget.maxBlockingTasks,
  ];
  if (
    positiveBigints.some((value) => value <= 0n)
    || positiveNumbers.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || budget.softMemoryBytes > budget.hardMemoryBytes
    || budget.maxThreads < budget.maxProcesses
    || budget.maxArtifactBytes > budget.maxSpoolBytes
  ) {
    reject('resource budget is zero, unsafe, or internally inconsistent');
  }
}

function assertWireSpec(prepared: PreparedAgentAttempt): void {
  const { authority, run, wireSpec } = prepared;
  const identity = wireSpec.identity;
  if (
    !identity
    || identity.sessionId !== authority.sessionId
    || identity.commandId !== authority.commandId
    || identity.agentRunId !== authority.agentRunId
    || identity.attemptId !== authority.attemptId
    || identity.executorOwnerId !== authority.executorOwnerId
    || identity.fencingEpoch !== authority.fencingEpoch
    || identity.correlationId !== authority.correlationId
    || identity.rootAgentRunId !== authority.rootAgentRunId
  ) {
    reject('wire identity does not match durable authority');
  }
  if (
    wireSpec.schemaVersion !== 1
    || wireSpec.specVersion !== BigInt(run.specVersion)
    || wireSpec.role !== run.role
    || wireSpec.deadlineAtUnixMs !== authority.deadlineAtUnixMs
    || (wireSpec.executionDeadlineAtUnixMs !== undefined && (wireSpec.executionDeadlineAtUnixMs <= 0n
      || wireSpec.executionDeadlineAtUnixMs > wireSpec.deadlineAtUnixMs))
    || wireSpec.workspaceLeaseFencingEpoch <= 0n
  ) {
    reject('wire versions, role, deadline, or workspace fence are inconsistent');
  }
  if (
    !wireSpec.task
    || wireSpec.task.body.case === undefined
    || !wireSpec.providerBinding
    || wireSpec.providerBinding.effectiveProvider !== run.effectiveProvider
    || wireSpec.providerBinding.effectiveModel !== run.effectiveModel
  ) {
    reject('task or effective provider binding is unresolved');
  }

  assertSnapshot(wireSpec.verifierPolicySnapshot, 'verifier policy snapshot');
  assertSnapshot(wireSpec.capabilitySetSnapshot, 'capability set snapshot');
  assertSnapshot(wireSpec.environmentSnapshot, 'environment snapshot');
  assertSnapshot(wireSpec.workspaceLeaseSnapshot, 'workspace lease snapshot');
  assertSnapshot(wireSpec.policySnapshot, 'policy snapshot');
  assertSnapshot(wireSpec.presetSnapshot, 'preset snapshot');
  assertSnapshot(wireSpec.agentDefinitionSnapshot, 'agent definition snapshot');
  assertResourceBudget(wireSpec.resourceBudget);
}

function assertSpecDigest(prepared: PreparedAgentAttempt): void {
  if (!validSha256(prepared.expectedSpecSha256)) {
    reject('expected spec SHA-256 is absent');
  }
  const encoded = toBinary(
    agentV1Runtime.ResolvedAttemptSpecSchema,
    prepared.wireSpec,
  );
  const actual = semanticSha256({
    schemaId: 'codestudio.agent.v1.ResolvedAttemptSpec',
    schemaVersion: prepared.wireSpec.schemaVersion,
    canonicalBytes: encoded,
  });
  if (!Buffer.from(actual).equals(Buffer.from(prepared.expectedSpecSha256))) {
    reject('expected spec SHA-256 does not match the generated wire spec');
  }
}

export function assertPreparedAttempt(
  prepared: ExecutableAgentAttempt,
  command: StartAgentCommand | ResumeAgentCommand,
  now: Date,
  expectedAgentRunId?: AgentRunId,
): void {
  assertPreparedAttemptCurrent(prepared, now);
  const { authority, routing, run } = prepared;
  if (
    authority.sessionId !== command.sessionId
    || authority.commandId !== command.commandId
    || authority.correlationId !== command.correlationId
    || routing.eligibility.surface !== command.payload.surface
    || routing.preference !== command.payload.runtimePreference
  ) {
    reject('accepted command does not match prepared authority or routing');
  }
  if (expectedAgentRunId && run.agentRunId !== expectedAgentRunId) {
    reject('resume returned a different AgentRun');
  }
  if (command.kind === 'start') {
    if ('wireSpec' in prepared ? !command.payload.spec
      : command.payload.admittedPreparationRef !== prepared.admission.preparationRef) {
      reject('start command does not reference its prepared input');
    }
  }
}

export function assertPreparedAttemptCurrent(
  prepared: ExecutableAgentAttempt,
  now: Date,
): void {
  const { authority, attempt, routing, run } = prepared;
  if (
    !isResolvedAgentRun(run)
    || run.status !== 'starting'
    || run.activeAttemptId !== attempt.attemptId
    || attempt.status !== 'starting'
    || attempt.agentRunId !== run.agentRunId
    || attempt.executorLease.status !== 'active'
    || !Number.isSafeInteger(attempt.executorLease.fencingEpoch)
    || attempt.executorLease.fencingEpoch <= 0
  ) {
    reject('run, attempt, resolution, or active lease state is inconsistent');
  }
  if (
    authority.sessionId !== run.sessionId
    || authority.commandId !== run.commandId
    || authority.agentRunId !== run.agentRunId
    || authority.attemptId !== attempt.attemptId
    || authority.executorOwnerId !== attempt.executorLease.ownerId
    || authority.fencingEpoch !== BigInt(attempt.executorLease.fencingEpoch)
    || authority.leaseExpiresAtUnixMs
      !== unixMs(attempt.executorLease.expiresAt, 'lease expiry')
    || authority.leaseExpiresAtUnixMs <= BigInt(now.getTime())
    || authority.deadlineAtUnixMs <= BigInt(now.getTime())
  ) {
    reject('authority is stale, expired, or does not match the active lease');
  }
  if (
    routing.sessionId !== run.sessionId
    || routing.agentRunId !== run.agentRunId
    || routing.attemptId !== attempt.attemptId
    || routing.eligibility.provider !== run.effectiveProvider
  ) {
    reject('routing does not match command, run, or effective provider');
  }
  if ('wireSpec' in prepared) {
    assertWireSpec(prepared);
    assertSpecDigest(prepared);
  } else {
    assertLegacyPreparation(prepared);
  }
}
