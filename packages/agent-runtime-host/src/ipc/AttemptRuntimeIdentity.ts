import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

export function validatePayloadRuntimeInstance(
  payload: agentV1Runtime.FramePayload,
  expectedRuntimeInstanceId: string,
): void {
  const actual = runtimeInstanceId(payload);
  if (actual !== undefined && actual !== expectedRuntimeInstanceId) {
    throw new AttemptFrameReceiverError(
      'runtime_instance_mismatch',
      `payload ${payload.body.case} runtime instance mismatches launch`,
    );
  }
}

function runtimeInstanceId(
  payload: agentV1Runtime.FramePayload,
): string | undefined {
  switch (payload.body.case) {
    case 'attemptPrepared':
    case 'heartbeat':
    case 'terminalProposal':
    case 'bindAttemptChannel':
    case 'attemptChannelBound':
    case 'hydrationProgress':
    case 'hydrationCommitted':
      return payload.body.value.runtimeInstanceId;
    case 'prepareAttempt':
    case 'activateAttempt':
    case 'cancelAttempt':
    case 'fenceAttempt':
    case 'terminalCommitted':
    case 'hydrationManifest':
    case 'hydrationChunk':
    case 'hydrationComplete':
    case 'agentHello':
    case 'hostHello':
    case 'ack':
    case undefined:
      return undefined;
  }
}
