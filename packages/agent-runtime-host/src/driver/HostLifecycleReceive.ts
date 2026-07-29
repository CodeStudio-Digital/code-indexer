import { clone } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type {
  EstablishedAttemptChannel,
  PendingInbound,
} from '../ipc/EstablishedAttemptChannel.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type {
  PreparedFactsExpectation,
} from './HostLifecycleTypes.js';
import { validatePreparedFacts } from './PreparedFactsValidation.js';

export interface CommittedPrepared {
  readonly messageId: string;
  readonly prepared: agentV1Runtime.AttemptPrepared;
}

export async function receiveCommittedPrepared(
  channel: EstablishedAttemptChannel,
  expected: PreparedFactsExpectation,
): Promise<CommittedPrepared> {
  const pending = await nextFresh(channel);
  const messageId = pending.header().messageId;
  const binding = pending.binding();
  const body = pending.takeBodyAndDigest().body;
  if (body.case !== 'attemptPrepared') {
    rejectUnexpected(channel, pending, body.case);
  }
  try {
    validatePreparedFacts(body.value, expected);
  } catch (cause) {
    rejectInvalid(channel, pending);
    throw cause;
  }
  const prepared = clone(
    agentV1Runtime.AttemptPreparedSchema,
    body.value,
  );
  const receipt = channel.commitAccepted(pending);
  if (!channel.receiptMatches(receipt, binding)) {
    throw new HostLifecycleDriverError(
      'invalid_channel_receipt',
      'AttemptPrepared commit receipt is not bound to its inbound frame',
    );
  }
  return Object.freeze({ messageId, prepared });
}

function rejectInvalid(
  channel: EstablishedAttemptChannel,
  pending: PendingInbound,
): void {
  try {
    channel.reject(pending);
  } catch {
    // The validation failure is surfaced after the receiver is poisoned.
  }
}

export async function receiveCommittedActivationAck(
  channel: EstablishedAttemptChannel,
): Promise<void> {
  const pending = await nextFresh(channel);
  const binding = pending.binding();
  const body = pending.takeBodyAndDigest().body;
  if (body.case !== 'ack') {
    rejectUnexpected(channel, pending, body.case);
  }
  const receipt = channel.commitAccepted(pending);
  if (!channel.receiptMatches(receipt, binding)) {
    throw new HostLifecycleDriverError(
      'invalid_channel_receipt',
      'activation Ack commit receipt is not bound to its inbound frame',
    );
  }
}

async function nextFresh(
  channel: EstablishedAttemptChannel,
): Promise<PendingInbound> {
  for (;;) {
    const outcome = await channel.beginReceive();
    if (outcome.kind === 'pending') return outcome.pending;
  }
}

function rejectUnexpected(
  channel: EstablishedAttemptChannel,
  pending: PendingInbound,
  payloadCase: string | undefined,
): never {
  try {
    channel.reject(pending);
  } catch {
    // The expected rejection poisons the shared channel before surfacing.
  }
  throw new HostLifecycleDriverError(
    'unexpected_payload',
    `lifecycle received unexpected payload ${payloadCase ?? 'missing'}`,
  );
}
