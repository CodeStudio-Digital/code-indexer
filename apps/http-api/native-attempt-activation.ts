import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime, agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type { DurableActivationGrant, PreparedDurabilityContext, PreparedDurabilityFacts, RuntimeRouteRecord } from '@mcp/agent-runtime-host';
import { validatePreparedFacts } from '@mcp/agent-runtime-host';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { nativeRecordId, type NativePreparationRecord } from './native-attempt-preparation.js';
import { supervisorFactId } from './supervisor-fact-ledger.js';

export function assertNativeActivationLive(control: PreparedDurabilityContext): void {
  control.signal.throwIfAborted();
  if (control.deadlineAtUnixMs <= BigInt(Date.now())) throw new Error('Native activation commit deadline expired');
}

export function copyPreparedFacts(facts: PreparedDurabilityFacts): PreparedDurabilityFacts {
  return { connectionId: facts.connectionId, prepareMessageId: facts.prepareMessageId, preparedMessageId: facts.preparedMessageId,
    prepare: fromBinary(agentV1Runtime.PrepareAttemptSchema, toBinary(agentV1Runtime.PrepareAttemptSchema, facts.prepare)),
    prepared: fromBinary(agentV1Runtime.AttemptPreparedSchema, toBinary(agentV1Runtime.AttemptPreparedSchema, facts.prepared)) };
}

/** Produces the activation grant only after immutable admission, physical
 * launch proofs, current ownership and the running projection are committed. */
export async function commitNativeActivation(input: {
  repository: ControlPlaneFileRepository;
  context: ControlPlaneRunContext;
  facts: PreparedDurabilityFacts;
  control: PreparedDurabilityContext;
  nonce: Uint8Array;
  assertCurrent(): Promise<unknown>;
  projectRunning(runtimeInstanceId: string, agentRunVersion: number, attemptVersion: number): Promise<void>;
}): Promise<DurableActivationGrant> {
  const { repository, context, facts, control, nonce } = input;
  assertNativeActivationLive(control);
  const preparation = await repository.get('nativePreparation', nativeRecordId(context.attemptId, 'prepare'));
  if (!preparation) throw new Error('Native activation has no durable preparation');
  const authority = preparation.data as unknown as NativePreparationRecord;
  const expectedPrepare = fromBinary(agentV1Runtime.PrepareAttemptSchema, Buffer.from(authority.encodedPrepare, 'base64'));
  const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, expectedPrepare.encodedSpec);
  const route = await repository.get('runtimeRoute', context.attemptId);
  const selected = route?.data.route as RuntimeRouteRecord | undefined;
  if (selected?.runtimeGeneration !== 'rust_v1') {
    throw new Error('Native activation requires an immutable Rust route');
  }
  const mismatches = [
    !Buffer.from(toBinary(agentV1Runtime.PrepareAttemptSchema, facts.prepare))
      .equals(toBinary(agentV1Runtime.PrepareAttemptSchema, expectedPrepare)) && 'prepare',
    (nonce.length !== 32 || createHash('sha256').update(nonce).digest('hex') !== authority.activationNonceSha256) && 'nonce',
    (!facts.connectionId || !facts.prepareMessageId || !facts.preparedMessageId
      || facts.connectionId.length > 512 || facts.prepareMessageId.length > 512 || facts.preparedMessageId.length > 512) && 'binding',
    (!facts.prepared.identity || !Buffer.from(toBinary(agentV1Common.AttemptIdentitySchema, facts.prepared.identity))
      .equals(toBinary(agentV1Common.AttemptIdentitySchema, spec.identity!))) && 'identity',
    !Buffer.from(facts.prepared.specSha256).equals(expectedPrepare.expectedSpecSha256) && 'spec digest',
    (facts.prepared.readyAtUnixMs <= 0n || facts.prepared.readyAtUnixMs > BigInt(Date.now())
      || facts.prepared.readyAtUnixMs >= spec.deadlineAtUnixMs || selected.provider !== spec.providerBinding?.effectiveProvider) && 'prepared authority',
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(`Native prepared receipt differs from its committed launch authority: ${mismatches.join(', ')}`);
  }
  const spawnedRecord = await repository.get('supervisorFact', supervisorFactId(context.attemptId, 'attemptProcessSpawned'));
  const containmentRecord = await repository.get('supervisorFact', supervisorFactId(context.attemptId, 'attemptContainmentReport'));
  if (!spawnedRecord || !containmentRecord) throw new Error('Native activation has no committed physical launch proof');
  const spawned = fromBinary(agentV1Supervisor.ManagementPayloadSchema, Buffer.from(String(spawnedRecord.data.encodedPayload), 'base64')).body;
  const containment = fromBinary(agentV1Supervisor.ManagementPayloadSchema, Buffer.from(String(containmentRecord.data.encodedPayload), 'base64')).body;
  if (spawned.case !== 'attemptProcessSpawned' || containment.case !== 'attemptContainmentReport'
    || spawned.value.runnerProvenance?.runtimeInstanceId !== facts.prepared.runtimeInstanceId
    || containment.value.runtimeInstanceId !== facts.prepared.runtimeInstanceId
    || spawned.value.runnerProvenance?.buildId !== selected.runtimeBuildId
    || Buffer.from(spawned.value.runnerProvenance.binarySha256).toString('hex') !== selected.runtimeBinarySha256
    || !containment.value.requestedBudget || !containment.value.effectiveContainment || !facts.prepared.effectiveContainment
    || !Buffer.from(toBinary(agentV1Common.ResourceBudgetSchema, containment.value.requestedBudget))
      .equals(toBinary(agentV1Common.ResourceBudgetSchema, spec.resourceBudget!))
    || !Buffer.from(toBinary(agentV1Common.ContainmentReportSchema, containment.value.effectiveContainment))
      .equals(toBinary(agentV1Common.ContainmentReportSchema, facts.prepared.effectiveContainment))) {
    throw new Error('Native prepared process differs from durable supervisor facts');
  }
  validatePreparedFacts(facts.prepared, {
    expectedSnapshots: expectedPrepare.expectedSnapshots,
    expectedArtifacts: [spec.task?.body.case === 'artifact' ? spec.task.body.value : undefined,
      ...(spec.task?.attachments ?? []), spec.checkpointInput, spec.transcriptInput].filter((value) => value !== undefined),
    resourceBudget: spec.resourceBudget!, requiredContainmentLevel: authority.requiredContainmentLevel,
    requiredEnforcedLimits: authority.requiredEnforcedLimits, runtimeInstanceId: facts.prepared.runtimeInstanceId,
    ownerSessionId: context.sessionId,
  });
  const activate = create(agentV1Runtime.ActivateAttemptSchema, {
    identity: spec.identity, agentRunVersion: BigInt(authority.agentRunVersion), attemptVersion: BigInt(authority.attemptVersion),
    deadlineAtUnixMs: spec.deadlineAtUnixMs, activationNonce: Uint8Array.from(nonce), specSha256: Uint8Array.from(expectedPrepare.expectedSpecSha256),
    idempotencyKey: `native-activate:${context.attemptId}`,
  });
  const data = { checkpointType: 'native-activation-v1', runtimeInstanceId: facts.prepared.runtimeInstanceId,
    connectionId: facts.connectionId, prepareMessageId: facts.prepareMessageId, preparedMessageId: facts.preparedMessageId,
    preparationSha256: hashControlPlanePayload(authority),
    preparedSha256: createHash('sha256').update(toBinary(agentV1Runtime.AttemptPreparedSchema, facts.prepared)).digest('hex'),
    activationSha256: createHash('sha256').update(toBinary(agentV1Runtime.ActivateAttemptSchema, activate)).digest('hex') };
  const id = nativeRecordId(context.attemptId, 'activate');
  const existing = await repository.get('nativeActivation', id);
  if (existing && hashControlPlanePayload(existing.data) !== hashControlPlanePayload(data)) {
    throw new Error('Native activation was already committed for different facts');
  }
  await input.assertCurrent();
  assertNativeActivationLive(control);
  if (!existing) await repository.create('nativeActivation', { id, operationId: id,
    relations: { session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId }, data });
  assertNativeActivationLive(control);
  await input.projectRunning(facts.prepared.runtimeInstanceId, authority.agentRunVersion, authority.attemptVersion);
  await input.assertCurrent();
  assertNativeActivationLive(control);
  return { connectionId: facts.connectionId, runtimeInstanceId: facts.prepared.runtimeInstanceId,
    prepareMessageId: facts.prepareMessageId, preparedMessageId: facts.preparedMessageId, activate };
}
