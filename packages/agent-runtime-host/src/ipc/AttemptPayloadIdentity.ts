import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { AttemptFrameError } from './AttemptFrameError.js';
import {
  attemptIdentityEqual,
  validateAttemptIdentity,
} from './FrameHeaderValidation.js';

export function validatePayloadIdentity(
  payload: agentV1Runtime.FramePayload,
  headerIdentity: agentV1Common.AttemptIdentity,
): void {
  const selected = payloadIdentity(payload);
  if (!selected) return;
  if (!selected.identity) {
    throw new AttemptFrameError(
      'missing_payload_identity',
      `payload ${selected.name} is missing attempt identity`,
    );
  }
  try {
    validateAttemptIdentity(selected.identity);
  } catch (cause) {
    throw new AttemptFrameError(
      'invalid_payload_identity',
      `payload ${selected.name} has invalid attempt identity`,
      { cause },
    );
  }
  if (!attemptIdentityEqual(selected.identity, headerIdentity)) {
    throw new AttemptFrameError(
      'payload_identity_mismatch',
      `payload ${selected.name} identity does not match its frame header`,
    );
  }
}

function payloadIdentity(
  payload: agentV1Runtime.FramePayload,
): {
  name: string;
  identity: agentV1Common.AttemptIdentity | undefined;
} | undefined {
  switch (payload.body.case) {
    case 'prepareAttempt':
    case 'attemptPrepared':
    case 'activateAttempt':
    case 'heartbeat':
    case 'cancelAttempt':
    case 'fenceAttempt':
    case 'terminalProposal':
    case 'terminalCommitted':
    case 'bindAttemptChannel':
    case 'attemptChannelBound':
    case 'hydrationManifest':
    case 'hydrationProgress':
    case 'hydrationChunk':
    case 'hydrationComplete':
    case 'hydrationCommitted':
    case 'providerStart':
    case 'providerAccepted':
    case 'providerCancel':
    case 'providerTextDelta':
    case 'providerThinkingDelta':
    case 'providerToolCall':
    case 'providerUsage':
    case 'providerTerminal':
    case 'engineEventProposal':
    case 'engineEventCommitted':
    case 'capabilityPrepare':
    case 'capabilityUpdate':
    case 'capabilityExecute':
    case 'capabilityExecutionResult':
      return {
        name: payload.body.case,
        identity: payload.body.value.identity,
      };
    case 'agentHello':
    case 'hostHello':
    case 'ack':
    case undefined:
      return undefined;
  }
}
