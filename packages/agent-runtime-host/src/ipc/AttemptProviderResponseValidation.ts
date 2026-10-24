import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { PendingSnapshot } from './AttemptFrameTransaction.js';
import { outboundError, sameDigest, timestampAfterLocalPeerStart } from './AttemptCorrelationPrimitives.js';

export function assertProviderOutboundResponse(
  payload: agentV1Runtime.FramePayload, inbound: PendingSnapshot, responseSentAtUnixMs: bigint,
): boolean {
  if (
    (inbound.payloadCase === 'providerStart' && payload.body.case === 'providerAccepted')
    || (inbound.payloadCase === 'providerCheckpoint' && payload.body.case === 'providerCheckpointCommitted')
    || (inbound.payloadCase === 'providerRequestChunk' && payload.body.case === 'providerRequestChunkAccepted')
    || (inbound.payloadCase === 'providerRequestCommit'
      && ((inbound.providerCheckpointOnly === true && payload.body.case === 'providerCheckpointCommitted')
        || (inbound.providerCheckpointOnly === false && payload.body.case === 'providerAccepted')))
  ) {
    if (payload.body.value.operationId !== inbound.providerOperationId) {
      throw outboundError('ProviderAccepted operation contradicts its ProviderStart');
    }
    if (!sameDigest(
      payload.body.value.requestPayloadSha256,
      inbound.payloadDigest,
    )) throw outboundError('ProviderAccepted digest contradicts its ProviderStart');
    if (!timestampAfterLocalPeerStart(
      payload.body.value.acceptedAtUnixMs,
      inbound.sentAtUnixMs,
      responseSentAtUnixMs,
    )) throw outboundError(
      `ProviderAccepted timestamp ${payload.body.value.acceptedAtUnixMs}`
        + ` is outside ${inbound.sentAtUnixMs}..${responseSentAtUnixMs}`,
    );
    return true;
  }
  return false;
}
