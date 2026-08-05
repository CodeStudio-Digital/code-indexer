import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import type {
  PendingSupervisorFact,
} from './HostSupervisorFactChannelTypes.js';
import {
  validateSupervisorFact,
} from './HostSupervisorFactValidation.js';

export function preparePendingSupervisorFact(
  header: agentV1Supervisor.ManagementFrameHeader,
  payload: agentV1Supervisor.ManagementPayload,
  observedAtUnixMs: bigint,
  handoff: HostSupervisorFactHandoff,
  envelopeSha256: Uint8Array,
  envelopeDigest: string,
): PendingSupervisorFact {
  return {
    fact: validateSupervisorFact(
      header,
      payload,
      observedAtUnixMs,
      handoff,
    ),
    binding: Object.freeze({
      connectionId: header.connectionId,
      messageId: header.messageId,
      replyToMessageId: header.replyToMessageId,
      streamSeq: header.streamSeq,
      payloadSha256: header.payloadSha256.slice(),
      envelopeSha256: envelopeSha256.slice(),
      observedAtUnixMs,
    }),
    headerSentAtUnixMs: header.sentAtUnixMs,
    envelopeDigest,
    token: {},
  };
}
