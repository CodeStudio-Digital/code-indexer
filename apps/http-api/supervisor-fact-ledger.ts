import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type { DurableSupervisorFactCommitControl, SupervisorFactBinding, SupervisorLifecycleFact } from '@mcp/agent-runtime-host';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';

const PREVIOUS = {
  launchAccepted: undefined, launchRejected: undefined,
  attemptProcessSpawned: 'launchAccepted', attemptContainmentReport: 'attemptProcessSpawned',
  attemptProcessExited: 'attemptContainmentReport', attemptProcessReaped: 'attemptProcessExited',
} as const;

export interface SupervisorFactRecord {
  checkpointType: 'supervisor-fact-v1';
  factCase: SupervisorLifecycleFact['case'];
  encodedPayload: string;
  contentSha256: string;
  connectionId: string;
  messageId: string;
  replyToMessageId: string | null;
  streamSeq: string;
  payloadSha256: string;
  envelopeSha256: string;
  idempotencyKey: string;
}

export function assertSupervisorCommitLive(control: DurableSupervisorFactCommitControl): void {
  control.signal.throwIfAborted();
  if (control.deadlineAtUnixMs <= BigInt(Date.now())) throw new Error('Supervisor fact commit deadline expired');
}

/** Snapshot before joining the session queue; callers cannot change bytes while
 * waiting. The authenticated management driver remains the wire authority. */
export function supervisorFactRecord(fact: SupervisorLifecycleFact, binding: SupervisorFactBinding,
  control: DurableSupervisorFactCommitControl): SupervisorFactRecord {
  assertSupervisorCommitLive(control);
  if (!Object.hasOwn(PREVIOUS, fact.case)) throw new Error('Unsupported supervisor fact');
  for (const value of [binding.connectionId, binding.messageId, binding.replyToMessageId ?? 'none']) {
    if (!value || value.length > 512) throw new Error('Invalid supervisor fact binding');
  }
  if (binding.streamSeq <= 0n || binding.streamSeq > (1n << 64n) - 1n
    || binding.payloadSha256.length !== 32 || binding.envelopeSha256.length !== 32) {
    throw new Error('Invalid supervisor fact sequence or digest');
  }
  const envelopeSha256 = Buffer.from(binding.envelopeSha256).toString('hex');
  if (control.idempotencyKey !== `management-supervisor-fact:v1:${envelopeSha256}`) {
    throw new Error('Supervisor fact idempotency key does not bind its envelope');
  }
  const payload = toBinary(agentV1Supervisor.ManagementPayloadSchema,
    create(agentV1Supervisor.ManagementPayloadSchema, { body: fact }));
  if (payload.byteLength > 1024 * 1024) throw new Error('Supervisor fact exceeds durable record limit');
  return {
    checkpointType: 'supervisor-fact-v1', factCase: fact.case,
    encodedPayload: Buffer.from(payload).toString('base64'),
    contentSha256: createHash('sha256').update(payload).digest('hex'),
    connectionId: binding.connectionId, messageId: binding.messageId,
    replyToMessageId: binding.replyToMessageId ?? null, streamSeq: String(binding.streamSeq),
    payloadSha256: Buffer.from(binding.payloadSha256).toString('hex'), envelopeSha256,
    idempotencyKey: control.idempotencyKey,
  };
}

export function supervisorFactId(attemptId: string, factCase: SupervisorLifecycleFact['case']): string {
  const hex = createHash('sha256').update(`supervisor-fact:v1:${attemptId}:${factCase}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One immutable record per physical phase, under the session mutation queue.
 * A late fsync may succeed after cancellation; exact replay reconciles that
 * record but never restores the failed channel or starts another executor. */
export async function commitSupervisorFact(repository: ControlPlaneFileRepository,
  context: ControlPlaneRunContext, record: SupervisorFactRecord,
  control: DurableSupervisorFactCommitControl): Promise<void> {
  const id = supervisorFactId(context.attemptId, record.factCase);
  const existing = await repository.get('supervisorFact', id);
  if (existing) {
    if (Object.keys(existing.data).length !== Object.keys(record).length
      || Object.entries(record).some(([key, value]) => existing.data[key] !== value)) {
      throw new Error('Supervisor phase was already committed with different bytes or binding');
    }
    assertSupervisorCommitLive(control);
    return;
  }
  const previousCase = PREVIOUS[record.factCase];
  if (previousCase) {
    const previous = await repository.get('supervisorFact', supervisorFactId(context.attemptId, previousCase));
    if (!previous || previous.data.connectionId !== record.connectionId
      || BigInt(String(previous.data.streamSeq)) >= BigInt(record.streamSeq)
      || previous.data.messageId === record.messageId) {
      throw new Error('Supervisor fact has no matching durable predecessor');
    }
  } else {
    const opposite = record.factCase === 'launchAccepted' ? 'launchRejected' : 'launchAccepted';
    if (await repository.get('supervisorFact', supervisorFactId(context.attemptId, opposite))) {
      throw new Error('Supervisor launch outcome was already committed');
    }
  }
  assertSupervisorCommitLive(control);
  await repository.create('supervisorFact', { id, operationId: id,
    relations: { session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId },
    data: { ...record } });
  assertSupervisorCommitLive(control);
}
