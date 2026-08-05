import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type {
  CommittedOutbound,
  EstablishedAttemptChannel,
} from '../ipc/EstablishedAttemptChannel.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';

export function sendPrepareAttempt(
  channel: EstablishedAttemptChannel,
  value: agentV1Runtime.PrepareAttempt,
  timeoutMs: number,
): Promise<CommittedOutbound> {
  return send(
    channel,
    create(agentV1Runtime.FramePayloadSchema, {
      body: { case: 'prepareAttempt', value },
    }),
    timeoutMs,
    'PrepareAttempt',
  );
}

export function sendActivateAttempt(
  channel: EstablishedAttemptChannel,
  value: agentV1Runtime.ActivateAttempt,
  timeoutMs: number,
): Promise<CommittedOutbound> {
  return send(
    channel,
    create(agentV1Runtime.FramePayloadSchema, {
      body: { case: 'activateAttempt', value },
    }),
    timeoutMs,
    'ActivateAttempt',
  );
}

export function sendCancelAttempt(
  channel: EstablishedAttemptChannel,
  value: agentV1Runtime.CancelAttempt,
  timeoutMs: number,
): Promise<CommittedOutbound> {
  return send(
    channel,
    create(agentV1Runtime.FramePayloadSchema, {
      body: { case: 'cancelAttempt', value },
    }),
    timeoutMs,
    'CancelAttempt',
  );
}

export function sendFenceAttempt(
  channel: EstablishedAttemptChannel,
  value: agentV1Runtime.FenceAttempt,
  timeoutMs: number,
): Promise<CommittedOutbound> {
  return send(
    channel,
    create(agentV1Runtime.FramePayloadSchema, {
      body: { case: 'fenceAttempt', value },
    }),
    timeoutMs,
    'FenceAttempt',
  );
}

async function send(
  channel: EstablishedAttemptChannel,
  payload: agentV1Runtime.FramePayload,
  timeoutMs: number,
  label: string,
): Promise<CommittedOutbound> {
  const outbound = await channel.sendNew(payload, { timeoutMs });
  if (!channel.outboundReceiptMatches(outbound)) {
    throw new HostLifecycleDriverError(
      'invalid_channel_receipt',
      `${label} outbound commit is foreign`,
    );
  }
  return outbound;
}
