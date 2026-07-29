import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
  isCanonicalUuid,
  unpackProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { AttemptFrameError } from './AttemptFrameError.js';

export const MAX_FRAME_IDENTIFIER_BYTES = 512;

export interface ValidatedFrameHeader {
  header: agentV1Runtime.FrameHeader;
  protocolVersion: number;
  connectionId: string;
  messageId: string;
  identity: agentV1Common.AttemptIdentity;
}

export function validateFrameHeader(
  header: agentV1Runtime.FrameHeader,
): ValidatedFrameHeader {
  let protocol;
  try {
    protocol = unpackProtocolVersion(header.protocolVersion);
  } catch (cause) {
    throw new AttemptFrameError(
      'invalid_protocol_version',
      `frame protocol version ${header.protocolVersion} is invalid`,
      { cause },
    );
  }
  if (protocol.major === 0) {
    throw new AttemptFrameError(
      'invalid_protocol_version',
      `frame protocol version ${header.protocolVersion} is invalid`,
    );
  }
  assertFrameIdentifier(header.connectionId, 'connection_id');
  assertFrameIdentifier(header.messageId, 'message_id');
  assertOptionalIdentifier(header.replyToMessageId, 'reply_to_message_id');
  assertOptionalIdentifier(header.operationId, 'operation_id');
  assertOptionalIdentifier(header.toolUseId, 'tool_use_id');
  if (header.fencingEpoch <= 0n) {
    throw new AttemptFrameError(
      'invalid_fencing_epoch',
      'frame fencing epoch must be positive',
    );
  }
  if (header.streamSeq <= 0n) {
    throw new AttemptFrameError(
      'invalid_stream_seq',
      'frame stream sequence must be positive',
    );
  }
  if (header.sentAtUnixMs <= 0n) {
    throw new AttemptFrameError(
      'invalid_sent_at',
      'frame sent timestamp must be positive',
    );
  }
  if (
    header.deadlineAtUnixMs !== undefined
    && (
      header.deadlineAtUnixMs <= 0n
      || header.deadlineAtUnixMs <= header.sentAtUnixMs
    )
  ) {
    throw new AttemptFrameError(
      'invalid_deadline',
      'frame deadline must be positive and strictly follow sent_at',
    );
  }

  const identity = create(agentV1Common.AttemptIdentitySchema, {
    sessionId: header.sessionId,
    commandId: header.commandId,
    agentRunId: header.agentRunId,
    attemptId: header.attemptId,
    executorOwnerId: header.executorOwnerId,
    fencingEpoch: header.fencingEpoch,
    correlationId: header.correlationId,
    rootAgentRunId: header.rootAgentRunId,
    ownerAgentRunId: header.ownerAgentRunId,
    parentAgentRunId: header.parentAgentRunId,
  });
  validateAttemptIdentity(identity);
  return {
    header,
    protocolVersion: header.protocolVersion,
    connectionId: header.connectionId,
    messageId: header.messageId,
    identity,
  };
}

export function validateAttemptIdentity(
  identity: agentV1Common.AttemptIdentity,
): void {
  assertOperationalUuid(identity.sessionId, 'session_id');
  assertOperationalUuid(identity.commandId, 'command_id');
  assertOperationalUuid(identity.agentRunId, 'agent_run_id');
  assertOperationalUuid(identity.attemptId, 'attempt_id');
  assertFrameIdentifier(identity.executorOwnerId, 'executor_owner_id');
  assertOperationalUuid(identity.correlationId, 'correlation_id');
  assertOperationalUuid(identity.rootAgentRunId, 'root_agent_run_id');
  assertOptionalOperationalUuid(identity.ownerAgentRunId, 'owner_agent_run_id');
  assertOptionalOperationalUuid(identity.parentAgentRunId, 'parent_agent_run_id');
  if (identity.fencingEpoch <= 0n) {
    throw new AttemptFrameError(
      'invalid_fencing_epoch',
      'attempt identity fencing epoch must be positive',
    );
  }
}

export function attemptIdentityEqual(
  left: agentV1Common.AttemptIdentity,
  right: agentV1Common.AttemptIdentity,
): boolean {
  return left.sessionId === right.sessionId
    && left.commandId === right.commandId
    && left.agentRunId === right.agentRunId
    && left.attemptId === right.attemptId
    && left.executorOwnerId === right.executorOwnerId
    && left.fencingEpoch === right.fencingEpoch
    && left.correlationId === right.correlationId
    && left.rootAgentRunId === right.rootAgentRunId
    && left.ownerAgentRunId === right.ownerAgentRunId
    && left.parentAgentRunId === right.parentAgentRunId;
}

export function assertFrameIdentifier(value: string, field: string): void {
  if (
    value.trim().length === 0
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_FRAME_IDENTIFIER_BYTES
  ) {
    throw new AttemptFrameError(
      'invalid_header_identifier',
      `frame identifier ${field} is missing or invalid`,
    );
  }
}

function assertOperationalUuid(value: string, field: string): void {
  assertFrameIdentifier(value, field);
  if (!isCanonicalUuid(value)) {
    throw new AttemptFrameError(
      'invalid_header_identifier',
      `frame identifier ${field} must be a canonical UUID`,
    );
  }
}

function assertOptionalIdentifier(
  value: string | undefined,
  field: string,
): void {
  if (value !== undefined) {
    assertFrameIdentifier(value, field);
  }
}

function assertOptionalOperationalUuid(
  value: string | undefined,
  field: string,
): void {
  if (value !== undefined) {
    assertOperationalUuid(value, field);
  }
}
