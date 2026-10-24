import { createHash } from 'node:crypto';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Supervisor as wire, agentV1SupervisorBootstrap as bootstrap } from '@mcp/agent-runtime-contracts';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { nativeRecordId } from './native-attempt-preparation.js';
import { supervisorFactId } from './supervisor-fact-ledger.js';

/** Reconciles physical cleanup against the original durable launch. This is a
 * recovery checkpoint, not a fabricated management envelope or a Host-effect
 * receipt. It cannot authorize another mutation or release a workspace. */
export async function commitNativeSupervisorRecovery(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, expectedIdentity: agentV1Common.AttemptIdentity,
  entry: bootstrap.SupervisorLifecycleOutboxEntryV1) {
  const matchesIdentity = (identity: agentV1Common.AttemptIdentity | undefined) => identity && Buffer.from(
    toBinary(agentV1Common.AttemptIdentitySchema, identity)).equals(toBinary(agentV1Common.AttemptIdentitySchema, expectedIdentity));
  const exited = entry.exited;
  const reaped = entry.reaped;
  if (entry.schemaVersion !== 1 || !entry.connectionId || !exited || !reaped
    || !matchesIdentity(exited.identity) || !matchesIdentity(reaped.identity)
    || expectedIdentity.attemptId !== context.attemptId || expectedIdentity.sessionId !== context.sessionId) {
    throw new Error('Native recovery evidence differs from its durable attempt');
  }
  const route = await repository.get('runtimeRoute', context.attemptId);
  if ((route?.data.route as { runtimeGeneration?: string } | undefined)?.runtimeGeneration !== 'rust_v1') {
    throw new Error('Native recovery has no native runtime route');
  }
  const readFact = async (kind: 'attemptProcessSpawned' | 'attemptContainmentReport' | 'attemptProcessExited' | 'attemptProcessReaped') => {
    const record = await repository.get('supervisorFact', supervisorFactId(context.attemptId, kind));
    if (!record) return undefined;
    if (record.relations.attempt !== context.attemptId || record.relations.session !== context.sessionId
      || record.data.connectionId !== entry.connectionId || typeof record.data.encodedPayload !== 'string') {
      throw new Error('Native recovery predecessor belongs to another connection');
    }
    const bytes = Buffer.from(record.data.encodedPayload, 'base64');
    if (bytes.length > 64 * 1024 || createHash('sha256').update(bytes).digest('hex') !== record.data.contentSha256) {
      throw new Error('Native recovery predecessor digest differs');
    }
    const payload = fromBinary(wire.ManagementPayloadSchema, bytes).body;
    if (payload.case !== kind) throw new Error('Native recovery predecessor kind differs');
    return payload;
  };
  const spawned = await readFact('attemptProcessSpawned');
  const containment = await readFact('attemptContainmentReport');
  if (spawned?.case !== 'attemptProcessSpawned' || containment?.case !== 'attemptContainmentReport'
    || !matchesIdentity(spawned.value.identity) || !matchesIdentity(containment.value.identity)
    || !spawned.value.runnerProvenance || !exited.runnerProvenance
    || !Buffer.from(toBinary(agentV1Common.RuntimeProvenanceSchema, spawned.value.runnerProvenance))
      .equals(toBinary(agentV1Common.RuntimeProvenanceSchema, exited.runnerProvenance))
    || reaped.runtimeInstanceId !== spawned.value.runnerProvenance.runtimeInstanceId
    || reaped.runtimeInstanceId !== containment.value.runtimeInstanceId
    || reaped.resourceGroupId !== spawned.value.resourceGroupId
    || exited.exitedAtUnixMs < spawned.value.spawnedAtUnixMs || reaped.reapedAtUnixMs < exited.exitedAtUnixMs
    || reaped.releasedResources.length !== 2
    || !reaped.releasedResources.some(resource => resource.kind === wire.ReleasedResourceKind.PROCESS
      && resource.resourceId === `pid:${spawned.value.runnerProvenance!.pid}` && resource.releasedCount === 1n)
    || !reaped.releasedResources.some(resource => resource.kind === wire.ReleasedResourceKind.RESOURCE_GROUP
      && resource.resourceId === reaped.resourceGroupId && resource.releasedCount === 1n)) {
    throw new Error('Native cleanup evidence does not match the original process ownership');
  }
  const previousExit = await readFact('attemptProcessExited');
  const previousReap = await readFact('attemptProcessReaped');
  if ((previousExit?.case === 'attemptProcessExited' && !Buffer.from(toBinary(wire.AttemptProcessExitedSchema, previousExit.value))
    .equals(toBinary(wire.AttemptProcessExitedSchema, exited)))
    || (previousReap?.case === 'attemptProcessReaped' && !Buffer.from(toBinary(wire.AttemptProcessReapedSchema, previousReap.value))
      .equals(toBinary(wire.AttemptProcessReapedSchema, reaped)))
    || (entry.hostAcknowledged && (!previousExit || !previousReap))) {
    throw new Error('Native cleanup contradicts the durable Host receipts');
  }
  // ACK delivery can lag its Host commit. Hash the immutable physical facts,
  // keeping ACK state out of idempotency so later inspection still reconciles.
  const encoded = toBinary(bootstrap.SupervisorLifecycleOutboxEntryV1Schema, { ...entry, hostAcknowledged: false });
  const contentSha256 = createHash('sha256').update(encoded).digest('hex');
  const id = nativeRecordId(context.attemptId, 'physical-recovery');
  const existing = await repository.get('checkpoint', id);
  if (existing) {
    if (existing.data.checkpointType !== 'native-supervisor-recovery-v1' || existing.data.contentSha256 !== contentSha256) {
      throw new Error('Native physical recovery replay diverged');
    }
  } else await repository.create('checkpoint', { id, operationId: id,
    relations: { session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId },
    data: { checkpointType: 'native-supervisor-recovery-v1', connectionId: entry.connectionId,
      contentSha256, encodedEvidence: Buffer.from(encoded).toString('base64'), hostEffectsReconciled: false } });
  return { checkpointId: id, contentSha256, supervisorReaped: true as const, hostEffectsReconciled: false as const };
}
