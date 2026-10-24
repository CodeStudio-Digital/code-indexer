import type { agentV1Common, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { InboundBinding } from './AttemptInboundBinding.js';

export interface PendingState {
  receiverBinding: object;
  token: bigint;
  messageId: string;
  streamSeq: bigint;
  payloadCase: agentV1Runtime.FramePayload['body']['case'];
  replyToMessageId?: string;
  deadlineAtUnixMs?: bigint;
  sentAtUnixMs: bigint;
  terminalPayloadSha256?: Uint8Array;
  providerOperationId?: string;
  providerCheckpointOnly?: boolean;
  capabilityOperationId?: string;
  capabilityToolUseId?: string;
  capabilityGrantId?: string;
  capabilityBatchId?: string;
  engineEventPayloadSha256?: Uint8Array;
  engineEventLocalSequence?: bigint;
  engineEventRuntimeInstanceId?: string;
  envelopeDigest: Uint8Array;
  header: agentV1Runtime.FrameHeader;
  identity: agentV1Common.AttemptIdentity;
  payload?: agentV1Runtime.FramePayload;
  payloadDigest: Uint8Array;
  inboundBinding?: InboundBinding;
}

export type PendingSnapshot = Omit<PendingState,
  'receiverBinding' | 'header' | 'identity' | 'payload' | 'inboundBinding'>;
