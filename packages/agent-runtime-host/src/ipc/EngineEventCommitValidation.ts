import { createHash, timingSafeEqual } from 'node:crypto';
import { clone, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import type { DurableEngineEventCommitRequest } from './DurableEngineEventCommitPort.js';
import { attemptIdentityEqual } from './FrameHeaderValidation.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import { HostDataChannelError } from './HostDataChannelError.js';

export function validateEngineEventProposal(
  proposal: agentV1Runtime.EngineEventProposal,
  context: HostDataBoundContext,
): DurableEngineEventCommitRequest {
  const record = proposal.record;
  if (
    !proposal.identity
    || !record?.identity
    || !attemptIdentityEqual(proposal.identity, context.identity)
    || !attemptIdentityEqual(record.identity, context.identity)
    || proposal.runtimeInstanceId !== context.runtimeInstanceId
    || record.runtimeInstanceId !== context.runtimeInstanceId
    || record.schemaVersion !== 1
    || record.localSequence <= 0n
    || record.body.case === undefined
  ) throw invalid('EngineEventProposal authority is incomplete');
  const encoded = toBinary(agentV1SessionStore.EngineEventRecordV1Schema, record);
  const digest = createHash('sha256').update(encoded).digest();
  if (!sameDigest(proposal.expectedPayloadSha256, digest)) {
    throw invalid('EngineEventProposal record digest mismatches canonical bytes');
  }
  validateRecordBody(record);
  return Object.freeze({
    identity: clone(agentV1Common.AttemptIdentitySchema, context.identity),
    runtimeInstanceId: context.runtimeInstanceId,
    record: clone(agentV1SessionStore.EngineEventRecordV1Schema, record),
    expectedPayloadSha256: digest,
  });
}

export function validateEngineEventReceipt(
  receipt: agentV1SessionStore.CommitSessionRecordReceipt,
  request: DurableEngineEventCommitRequest,
): agentV1SessionStore.CommitSessionRecordReceipt {
  const encoded = toBinary(
    agentV1SessionStore.EngineEventRecordV1Schema,
    request.record,
  );
  if (
    receipt.sessionId !== request.identity.sessionId
    || receipt.operationId.length === 0
    || !receipt.authority
    || receipt.authority.storageGeneration
      === agentV1SessionStore.StorageGeneration.UNSPECIFIED
    || receipt.authority.leaseEpoch === 0n
    || receipt.authority.writerId.length === 0
    || receipt.globalSequence === 0n
    || receipt.kind !== agentV1SessionStore.SessionRecordKind.LIFECYCLE_EVENT
    || receipt.durability !== expectedDurability(request.record)
    || receipt.payloadBytes !== BigInt(encoded.byteLength)
    || !sameDigest(receipt.payloadSha256, request.expectedPayloadSha256)
    || receipt.previousCommitSha256.byteLength !== 32
    || receipt.commitSha256.byteLength !== 32
  ) throw invalid('native engine-event receipt contradicts its proposal');
  return clone(agentV1SessionStore.CommitSessionRecordReceiptSchema, receipt);
}

function validateRecordBody(record: agentV1SessionStore.EngineEventRecordV1): void {
  const body = record.body;
  const operationId = body.case === undefined || body.case === 'terminal'
    ? undefined
    : body.value.operationId;
  if (operationId !== undefined && (operationId.length === 0 || operationId.length > 1_024)) {
    throw invalid('engine event operation identity is invalid');
  }
  if (body.case === 'providerDelta') {
    if (body.value.utf8Bytes === 0n || body.value.contentSha256.byteLength !== 32) {
      throw invalid('engine provider delta metadata is invalid');
    }
  }
  if (body.case === 'providerUsage') {
    const usage = body.value.usage;
    if (!usage || usage.cachedInputTokens > usage.inputTokens) {
      throw invalid('engine provider usage is invalid');
    }
  }
  if (body.case === 'capabilityDispatchStarted') {
    const started = body.value;
    if (
      started.toolUseId.length === 0
      || started.grantId.length === 0
      || started.effectiveInputSha256.byteLength !== 32
      || started.startedAtUnixMs <= 0n
    ) throw invalid('engine capability started record is invalid');
  }
  if (body.case === 'capabilityTerminal') {
    const terminal = body.value;
    const succeeded = terminal.classification
      === agentV1SessionStore.EngineCapabilityTerminalClassificationV1.SUCCEEDED;
    if (
      terminal.toolUseId.length === 0
      || terminal.grantId.length === 0
      || terminal.classification
        === agentV1SessionStore.EngineCapabilityTerminalClassificationV1.UNSPECIFIED
      || terminal.reasonCode.length === 0
      || terminal.reasonCode.length > 1_024
      || terminal.completedAtUnixMs <= 0n
      || (succeeded && (
        terminal.resultSchemaId.length === 0
        || terminal.resultSchemaVersion === 0
        || terminal.resultSha256.byteLength !== 32
        || terminal.resultBytes === 0n
        || terminal.bytesEmitted !== terminal.resultBytes
      ))
      || (!succeeded && (
        terminal.resultSchemaId.length !== 0
        || terminal.resultSchemaVersion !== 0
        || terminal.resultSha256.byteLength !== 0
        || terminal.resultBytes !== 0n
      ))
    ) throw invalid('engine capability terminal record is invalid');
  }
  if (body.case === 'terminal') {
    const terminal = body.value;
    if (
      terminal.classification
        === agentV1SessionStore.EngineTerminalClassificationV1.UNSPECIFIED
      || terminal.reasonCode.length === 0
      || terminal.reasonCode.length > 1_024
      || (terminal.usage !== undefined
        && terminal.usage.cachedInputTokens > terminal.usage.inputTokens)
    ) throw invalid('engine terminal record is invalid');
  }
}

function expectedDurability(record: agentV1SessionStore.EngineEventRecordV1) {
  if (record.body.case === 'providerDelta') {
    return agentV1SessionStore.SessionDurabilityClass.COALESCED;
  }
  if (
    record.body.case === 'capabilityBoundary'
    || record.body.case === 'capabilityDispatchStarted'
    || record.body.case === 'capabilityTerminal'
    || record.body.case === 'terminal'
  ) {
    return agentV1SessionStore.SessionDurabilityClass.AUTHORITATIVE;
  }
  return agentV1SessionStore.SessionDurabilityClass.DURABLE;
}

function sameDigest(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
}

function invalid(message: string): HostDataChannelError {
  return new HostDataChannelError('provider_failure', message);
}
