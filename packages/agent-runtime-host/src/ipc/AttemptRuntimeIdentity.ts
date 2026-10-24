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
    case 'providerAccepted':
    case 'providerRequestChunk':
    case 'providerRequestChunkAccepted':
    case 'providerRequestCommit':
    case 'providerCheckpointCommitted':
    case 'engineEventProposal':
    case 'engineEventCommitted':
    case 'capabilityPrepare':
    case 'capabilityUpdate':
    case 'capabilityExecute':
    case 'capabilityExecutionResult':
    case 'capabilityReadBatchExecute':
    case 'capabilityReadBatchAccepted':
    case 'capabilityReadBatchResult':
      return payload.body.value.runtimeInstanceId;
    case 'prepareAttempt':
    case 'activateAttempt':
    case 'cancelAttempt':
    case 'fenceAttempt':
    case 'terminalCommitted':
    case 'hydrationManifest':
    case 'hydrationChunk':
    case 'hydrationComplete':
    case 'providerStart':
    case 'providerCheckpoint':
    case 'providerCancel':
    case 'providerEventConsumed':
    case 'providerTextDelta':
    case 'providerThinkingDelta':
    case 'providerToolCall':
    case 'providerUsage':
    case 'providerTerminal':
    case 'agentHello':
    case 'hostHello':
    case 'ack':
    case undefined:
      return undefined;
  }
}
