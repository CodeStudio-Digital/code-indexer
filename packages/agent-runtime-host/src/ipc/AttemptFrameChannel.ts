import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptFrameError } from './AttemptFrameError.js';
import type { AttemptTransportChannel } from './AttemptFrameLimits.js';

type FramePayloadCase = Exclude<
  agentV1Runtime.FramePayload['body']['case'],
  undefined
>;

const CONTROL_CASES: ReadonlySet<FramePayloadCase> = new Set([
  'agentHello',
  'hostHello',
  'prepareAttempt',
  'attemptPrepared',
  'activateAttempt',
  'heartbeat',
  'cancelAttempt',
  'fenceAttempt',
  'terminalProposal',
  'terminalCommitted',
  'ack',
]);

const DATA_CASES: ReadonlySet<FramePayloadCase> = new Set([
  'bindAttemptChannel',
  'attemptChannelBound',
  'hydrationManifest',
  'hydrationProgress',
  'hydrationChunk',
  'hydrationComplete',
  'hydrationCommitted',
  'providerStart',
  'providerRequestChunk',
  'providerRequestChunkAccepted',
  'providerRequestCommit',
  'providerCheckpoint',
  'providerCheckpointCommitted',
  'providerAccepted',
  'providerCancel',
  'providerEventConsumed',
  'providerTextDelta',
  'providerThinkingDelta',
  'providerToolCall',
  'providerUsage',
  'providerTerminal',
  'engineEventProposal',
  'engineEventCommitted',
  'capabilityPrepare',
  'capabilityUpdate',
  'capabilityExecute',
  'capabilityExecutionResult',
  'capabilityReadBatchExecute',
  'capabilityReadBatchAccepted',
  'capabilityReadBatchResult',
]);

export function assertPayloadAllowed(
  channel: AttemptTransportChannel,
  payload: agentV1Runtime.FramePayload,
): void {
  const payloadCase = payload.body.case;
  if (payloadCase === undefined) {
    throw new AttemptFrameError(
      'missing_payload_body',
      'attempt frame payload body is required',
    );
  }
  const allowed = channel === agentV1Runtime.TransportChannel.CONTROL
    ? CONTROL_CASES
    : DATA_CASES;
  if (!allowed.has(payloadCase)) {
    throw new AttemptFrameError(
      'payload_not_allowed_on_channel',
      `payload ${payloadCase} is forbidden on channel ${channel}`,
    );
  }
}

export function assertAttemptChannel(
  channel: number,
): asserts channel is AttemptTransportChannel {
  if (
    channel !== agentV1Runtime.TransportChannel.CONTROL
    && channel !== agentV1Runtime.TransportChannel.DATA
  ) {
    throw new AttemptFrameError(
      'unsupported_channel',
      `channel ${channel} does not use the attempt frame envelope`,
    );
  }
}
