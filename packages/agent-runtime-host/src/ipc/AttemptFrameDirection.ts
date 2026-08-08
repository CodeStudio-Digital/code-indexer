import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import {
  AttemptFrameReceiverError,
} from './AttemptFrameReceiverError.js';
import type { AttemptTransportChannel } from './AttemptFrame.js';

export type FrameDirection = 'host_to_runner' | 'runner_to_host';

const HOST_TO_RUNNER_CONTROL = new Set([
  'prepareAttempt',
  'activateAttempt',
  'cancelAttempt',
  'fenceAttempt',
  'terminalCommitted',
  'ack',
]);

const RUNNER_TO_HOST_CONTROL = new Set([
  'attemptPrepared',
  'heartbeat',
  'terminalProposal',
  'ack',
]);

const HOST_TO_RUNNER_DATA = new Set([
  'bindAttemptChannel',
  'hydrationManifest',
  'hydrationChunk',
  'hydrationComplete',
  'providerAccepted',
  'providerTextDelta',
  'providerThinkingDelta',
  'providerToolCall',
  'providerUsage',
  'providerTerminal',
  'engineEventCommitted',
  'capabilityUpdate',
  'capabilityExecutionResult',
]);

const RUNNER_TO_HOST_DATA = new Set([
  'attemptChannelBound',
  'hydrationProgress',
  'hydrationCommitted',
  'providerStart',
  'providerCancel',
  'engineEventProposal',
  'capabilityPrepare',
  'capabilityExecute',
]);

export function assertPayloadDirection(
  direction: FrameDirection,
  channel: AttemptTransportChannel,
  payload: agentV1Runtime.FramePayload,
): void {
  const payloadCase = payload.body.case;
  let allowed = false;
  if (channel === agentV1Runtime.TransportChannel.CONTROL) {
    allowed = (
      direction === 'host_to_runner'
        ? HOST_TO_RUNNER_CONTROL
        : RUNNER_TO_HOST_CONTROL
    ).has(payloadCase ?? '');
  } else {
    allowed = (
      direction === 'runner_to_host'
        ? RUNNER_TO_HOST_DATA
        : HOST_TO_RUNNER_DATA
    ).has(payloadCase ?? '');
  }
  if (!allowed) {
    throw new AttemptFrameReceiverError(
      'direction_mismatch',
      `payload ${payloadCase ?? 'missing'} is forbidden for ${direction}`,
    );
  }
}
