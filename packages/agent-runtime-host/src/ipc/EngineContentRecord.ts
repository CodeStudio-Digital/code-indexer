import { createHash, timingSafeEqual } from 'node:crypto';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { HostDataChannelError } from './HostDataChannelError.js';

export function engineRecordStorage(record: wire.EngineEventRecordV1) {
  const { SessionRecordKind: Kind, SessionDurabilityClass: Durability, EngineContentKindV1: Content } = wire;
  const body = record.body;
  if (body.case === 'content') {
    switch (body.value.kind) {
      case Content.TRANSCRIPT: return { kind: Kind.CONVERSATION, durability: Durability.COALESCED };
      case Content.TOOL_INPUT: return { kind: Kind.INPUT, durability: Durability.AUTHORITATIVE };
      case Content.TOOL_RESULT: return { kind: Kind.TOOL_OUTPUT, durability: Durability.AUTHORITATIVE };
      default: throw new HostDataChannelError('provider_failure', 'invalid content kind');
    }
  }
  const durability = body.case === 'providerDelta' ? Durability.COALESCED
    : ['capabilityBoundary', 'capabilityDispatchStarted', 'capabilityTerminal', 'capabilityRefused', 'terminal'].includes(body.case ?? '')
      ? Durability.AUTHORITATIVE : Durability.DURABLE;
  return { kind: Kind.LIFECYCLE_EVENT, durability };
}

export function validateEngineContent(content: wire.EngineContentRecordV1): void {
  const transcript = content.kind === wire.EngineContentKindV1.TRANSCRIPT;
  const size = BigInt(content.encodedChunk.byteLength);
  if (![wire.EngineContentKindV1.TRANSCRIPT, wire.EngineContentKindV1.TOOL_INPUT,
    wire.EngineContentKindV1.TOOL_RESULT].includes(content.kind)
    || !content.contentId || content.contentId.length > 1_100
    || !content.contentSchemaId || content.contentSchemaId.length > 1_024
    || content.contentSchemaVersion === 0 || content.contentSha256.byteLength !== 32
    || content.totalBytes <= 0n || content.totalBytes > 16n * 1024n * 1024n
    || size === 0n || size > 128n * 1024n || content.chunkOffset + size > content.totalBytes
    || (transcript ? content.toolUseId !== '' || content.contentSchemaId !== 'text/utf8'
      : !content.toolUseId || content.toolUseId.length > 1_024 || content.thinking)
  ) throw new HostDataChannelError('provider_failure', 'invalid durable content chunk');
  if (content.chunkOffset === 0n && size === content.totalBytes
    && !timingSafeEqual(createHash('sha256').update(content.encodedChunk).digest(), content.contentSha256)) {
    throw new HostDataChannelError('provider_failure', 'durable content hash mismatch');
  }
}
