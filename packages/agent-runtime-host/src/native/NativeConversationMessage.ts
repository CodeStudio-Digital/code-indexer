import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { AgentMessage, ContentBlock } from '@mcp/provider-sdk/wire.js';

type Media = Extract<ContentBlock, { type: 'image' | 'document' }>;
export async function readNativeConversationAttachment(sessionId: string, block: Media, maximumBytes: number,
  readDocument?: (block: Extract<ContentBlock, { type: 'document' }>, signal?: AbortSignal) => Promise<Uint8Array>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let bytes: Uint8Array;
  if (block.type === 'document' && block.text !== undefined) bytes = new TextEncoder().encode(block.text);
  else if (block.base64 !== undefined) {
    if (block.base64.length > Math.ceil(maximumBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.base64)) throw new Error('Native attachment encoding is invalid');
    bytes = Uint8Array.from(Buffer.from(block.base64, 'base64'));
  } else if (block.type === 'document' && block.path && readDocument) bytes = Uint8Array.from(await readDocument(block, signal));
  else throw new Error('Native attachment requires content or a product-authorized reader');
  try {
    signal?.throwIfAborted();
    if (!bytes.length || bytes.length > maximumBytes || !block.mediaType) throw new Error('Native attachment is empty or excessive');
    const displayName = block.type === 'document' ? block.name : '';
    if (Buffer.byteLength(displayName) > 1024 || /[\\/\u0000-\u001f]/.test(displayName)) throw new Error('Native attachment display name is invalid');
    const reference = create(artifact.ArtifactRefSchema, { kind: block.type, contentSha256: hash(bytes), mediaType: block.mediaType,
      byteLength: BigInt(bytes.length), compression: artifact.ArtifactCompression.NONE,
      privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL, redactionPolicyVersion: 'product-attachment-v1', ownerSessionId: sessionId, displayName });
    const id = createHash('sha256').update('codestudio.session.attachment.v1\0').update(toBinary(artifact.ArtifactRefSchema, reference)).digest().subarray(0, 16);
    id[6] = (id[6]! & 15) | 0x50; id[8] = (id[8]! & 63) | 0x80;
    const hex = id.toString('hex'); reference.artifactId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { reference, bytes };
  } catch (cause) { bytes.fill(0); throw cause; }
}

/** Shared by initial hydration and incremental cold-history validation. */
export async function encodeNativeConversationMessage(message: AgentMessage, attachment: (block: Media) => Promise<artifact.ArtifactRef>): Promise<wire.ProviderMessage> {
  const role = { user: wire.ProviderMessageRole.USER, assistant: wire.ProviderMessageRole.ASSISTANT,
    tool: wire.ProviderMessageRole.TOOL }[message.role as 'user' | 'assistant' | 'tool'];
  if (!role) throw new Error('Native conversation system input belongs in the definition snapshot');
  const content: wire.ProviderContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'thinking') content.push(create(wire.ProviderContentBlockSchema,
      { body: { case: block.type, value: { body: { case: 'inlineUtf8', value: block.text } } } }));
    else if (block.type === 'tool_use') {
      const args = new TextEncoder().encode(JSON.stringify(block.input));
      content.push(create(wire.ProviderContentBlockSchema, { body: { case: 'toolUse', value: {
        toolUseId: block.id, capabilityName: block.name, encodedJsonArguments: args, argumentsSha256: hash(args) } } }));
    } else if (block.type === 'tool_result') {
      if (block.originalSize !== undefined && (!Number.isSafeInteger(block.originalSize) || block.originalSize < 0)) throw new Error('Native tool result original size is invalid');
      content.push(create(wire.ProviderContentBlockSchema, { body: { case: 'toolResult', value: {
        toolUseId: block.tool_use_id, content: { case: 'inlineUtf8', value: block.content }, isError: block.is_error,
        truncated: block.truncated, originalBytes: block.originalSize === undefined ? undefined : BigInt(block.originalSize),
      } } }));
    } else if (block.type === 'image' || block.type === 'document') content.push(create(wire.ProviderContentBlockSchema,
      { body: { case: 'attachment', value: await attachment(block) } }));
    else throw new Error(`Native conversation requires provider normalization for ${block.type}`);
  }
  return create(wire.ProviderMessageSchema, { role, content, isMeta: message.isMeta,
    phase: message.phase === 'commentary' ? wire.ProviderMessagePhase.COMMENTARY
      : message.phase === 'final_answer' ? wire.ProviderMessagePhase.FINAL_ANSWER : wire.ProviderMessagePhase.UNSPECIFIED });
}

function hash(bytes: Uint8Array) { return new Uint8Array(createHash('sha256').update(bytes).digest()); }
