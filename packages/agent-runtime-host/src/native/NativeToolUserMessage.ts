import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';

/** Optional v1 Host result field: canonical ProviderMessage bytes in lowercase
 * hex. Images/documents are durable ArtifactRefs, never inline binary payloads.
 * The same bytes are used by Rust, the live projection and transcript replay. */
export function decodeNativeToolUserMessage(encoded: unknown): wire.ProviderMessage {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 512 * 1024
    || !/^(?:[0-9a-f]{2})+$/.test(encoded)) throw new Error('Invalid native tool user message encoding');
  const bytes = Buffer.from(encoded, 'hex');
  const message = fromBinary(wire.ProviderMessageSchema, bytes, { readUnknownFields: false });
  if (!Buffer.from(toBinary(wire.ProviderMessageSchema, message)).equals(bytes)
    || message.role !== wire.ProviderMessageRole.USER || message.isMeta
    || message.phase !== wire.ProviderMessagePhase.UNSPECIFIED
    || !message.content.length || message.content.length > 64
    || message.content.some(({ body }) => body.case !== 'attachment'
      && !(body.case === 'text' && body.value.body.case === 'inlineUtf8'))) {
    throw new Error('Invalid native tool user message content');
  }
  return message;
}

export function encodeNativeToolUserMessage(message: wire.ProviderMessage): string {
  const encoded = Buffer.from(toBinary(wire.ProviderMessageSchema, message)).toString('hex');
  decodeNativeToolUserMessage(encoded);
  return encoded;
}
