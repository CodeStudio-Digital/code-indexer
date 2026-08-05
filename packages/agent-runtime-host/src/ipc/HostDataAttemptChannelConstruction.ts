import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptCorrelationAuthority } from './AttemptCorrelationAuthority.js';
import { AttemptFrameReceiver } from './AttemptFrameReceiver.js';
import { mintNegotiatedSeed } from './AttemptFrameSeed.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import { handoffEstablishedAttemptChannel } from './EstablishedAttemptChannelHandoff.js';
import type {
  HostDataAttemptChannelProvision,
} from './HostDataAttemptChannel.js';
import {
  type HostDataBoundContext,
  validateHostDataProvision,
} from './HostDataAttemptChannelValidation.js';
import { OutboundHeaderAuthority } from './OutboundHeaderAuthority.js';

const DATA_TOMBSTONE_ID = '00000000-0000-4000-8000-000000000000';
const DATA_REPLAY_ENTRIES = 8;

interface ConstructedHostDataChannel {
  readonly channel: EstablishedAttemptChannel;
  readonly context: HostDataBoundContext;
}

export function constructHostDataAttemptChannel(
  provision: HostDataAttemptChannelProvision,
): ConstructedHostDataChannel {
  const context = validateHostDataProvision(provision);
  const correlations = new AttemptCorrelationAuthority(provision.maxIpcFrames);
  const replayCapacity = Math.min(DATA_REPLAY_ENTRIES, provision.maxIpcFrames);
  const receiver = new AttemptFrameReceiver(mintNegotiatedSeed({
    protocolVersion: provision.protocolVersion,
    connectionId: provision.connectionId,
    runtimeInstanceId: provision.runtimeInstanceId,
    identity: provision.identity,
    channel: agentV1Runtime.TransportChannel.DATA,
    direction: 'runner_to_host',
    maximumFrameBytes: Number(context.limits.maxFrameBytes),
    streamWatermark: 0n,
    bootstrapMessageId: DATA_TOMBSTONE_ID,
    bootstrapBinding: {},
  }), {
    replayCapacity,
    totalIdentityCapacity: provision.maxIpcFrames,
    maxReplayBytes: Number(context.limits.maxFrameBytes) * replayCapacity,
  }, correlations);
  const sender = new OutboundHeaderAuthority({
    protocolVersion: provision.protocolVersion,
    connectionId: provision.connectionId,
    identity: provision.identity,
    channel: agentV1Runtime.TransportChannel.DATA,
    direction: 'host_to_runner',
    maximumFrameBytes: Number(context.limits.maxFrameBytes),
    committedStreamSeq: 0n,
    maximumResponseTimeoutMs: context.timeoutMs,
    hardDeadlineAtUnixMs: provision.hardDeadlineAtUnixMs,
    clock: provision.clock,
    correlations,
  });
  return {
    context,
    channel: handoffEstablishedAttemptChannel(
      provision.transport,
      receiver,
      sender,
      {},
      provision.clock,
      provision.hardDeadlineAtUnixMs,
      context.timeoutMs,
      provision.failureObserver,
    ),
  };
}
