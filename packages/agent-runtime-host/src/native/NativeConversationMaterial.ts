import { createHash, randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Common as common, agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { AgentMessage, ContentBlock } from '@mcp/provider-sdk/wire.js';
import type { HostHydrationSource } from '../ipc/HostDataHydration.js';
import type { ProviderArtifactReaderPort } from '../provider-gateway/ProviderGatewayTypes.js';
import { validateProviderConversation } from './ProviderFrontierCodec.js';
import { validatePreparedUserContext } from './PreparedUserContext.js';
import { encodeNativeConversationMessage, readNativeConversationAttachment } from './NativeConversationMessage.js';

export interface NativeConversationMaterialOptions {
  readonly sessionId: string;
  readonly messages: readonly AgentMessage[];
  readonly preparedUserContext?: wire.ProviderPreparedUserContextV1;
  readonly maximumBytes: number;
  /** Product-authorized attachment reader for local document references. */
  readonly readDocument?: (block: Extract<ContentBlock, { type: 'document' }>, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
}

/** Owns one immutable prepared conversation and its attachments. It does not
 * read arbitrary paths, resolve models, or manufacture recovery authority. */
export async function createNativeConversationMaterial(options: NativeConversationMaterialOptions) {
  options = { ...options };
  if (!options.sessionId || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1
    || options.maximumBytes > 16 * 1024 * 1024 || !options.messages.length || options.messages.length > 100_000) {
    throw new Error('Native conversation bounds are invalid');
  }
  const input = structuredClone(options.messages);
  const preparedUserContext = options.preparedUserContext && structuredClone(options.preparedUserContext);
  const payloads = new Map<string, { reference: artifact.ArtifactRef; bytes: Uint8Array }>();
  let used = 0;
  const reserve = (bytes: number) => {
    used += bytes;
    if (used > options.maximumBytes) throw new Error('Native conversation exceeds its byte budget');
  };
  const attachment = async (block: Extract<ContentBlock, { type: 'image' | 'document' }>) => {
    const { reference, bytes } = await readNativeConversationAttachment(options.sessionId, block, options.maximumBytes, options.readDocument, options.signal);
    const previous = payloads.get(reference.artifactId);
    if (previous) {
      if (!Buffer.from(toBinary(artifact.ArtifactRefSchema, previous.reference)).equals(toBinary(artifact.ArtifactRefSchema, reference))) {
        throw new Error('Native attachment identity collision');
      }
      bytes.fill(0);
    } else { reserve(bytes.length); payloads.set(reference.artifactId, { reference, bytes }); }
    return reference;
  };
  const messages: wire.ProviderMessage[] = [];
  for (const message of input) {
    options.signal?.throwIfAborted();
    const encoded = await encodeNativeConversationMessage(message, attachment);
    reserve(toBinary(wire.ProviderMessageSchema, encoded).length); messages.push(encoded);
  }
  const last = messages.at(-1)!;
  if (last.role !== wire.ProviderMessageRole.USER || last.isMeta || last.content[0]?.body.case !== 'text'
    || last.content[0].body.value.body.case !== 'inlineUtf8'
    || last.content.slice(1).some((block) => block.body.case !== 'attachment')) {
    throw new Error('Native initial conversation must end with the prepared user task and attachments');
  }
  validateProviderConversation(messages);
  validatePreparedUserContext(preparedUserContext, messages);
  const encodedSnapshot = toBinary(wire.InitialConversationSnapshotV1Schema,
    create(wire.InitialConversationSnapshotV1Schema, { schemaVersion: 1, sessionId: options.sessionId, messages, preparedUserContext }));
  if (encodedSnapshot.length + [...payloads.values()].reduce((sum, entry) => sum + entry.bytes.length, 0) > options.maximumBytes) {
    throw new Error('Native conversation exceeds its encoded byte budget');
  }
  const reference = create(common.SnapshotRefSchema, { ref: `conversation:${randomUUID()}`, version: 1n,
    origin: 'coder-preparation', schemaId: 'codestudio.agent.v1.InitialConversationSnapshotV1', schemaVersion: 1,
    contentSha256: sha256(encodedSnapshot) });
  const currentAttachments = new Set(last.content.flatMap((block) => block.body.case === 'attachment' ? [block.body.value.artifactId] : []));
  const entries = [{ reference: { case: 'snapshot' as const, value: reference }, bytes: encodedSnapshot },
    ...[...payloads.values()].filter((entry) => currentAttachments.has(entry.reference.artifactId))
      .map((entry) => ({ reference: { case: 'artifact' as const, value: entry.reference }, bytes: entry.bytes }))];
  let closed = false;
  let hydrationClosed = false;
  const close = () => {
    if (closed) return;
    closed = true; hydrationClosed = true;
    for (const entry of entries) entry.bytes.fill(0);
    for (const entry of payloads.values()) entry.bytes.fill(0);
    entries.length = 0; payloads.clear();
  };
  const assertOpen = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (closed) throw new Error('Native conversation material is closed'); };
  const source: HostHydrationSource = {
    items: entries.map((entry) => ({ reference: structuredClone(entry.reference), byteLength: BigInt(entry.bytes.length) })),
    async readExact(ordinal, offset, length, signal) {
      assertOpen(signal); const entry = entries[ordinal];
      if (hydrationClosed || !entry || offset < 0n || !Number.isSafeInteger(length) || length < 1 || offset + BigInt(length) > BigInt(entry.bytes.length)) {
        throw new Error('Native conversation hydration read is outside its material');
      }
      return entry.bytes.slice(Number(offset), Number(offset) + length);
    },
    close(cause) {
      if (cause) { close(); return; }
      hydrationClosed = true; encodedSnapshot.fill(0); entries.length = 0;
    },
  };
  const artifactReader: ProviderArtifactReaderPort = { read(request, maximumBytes, signal) {
    assertOpen(signal); const entry = payloads.get(request.artifactId);
    if (!entry || !Buffer.from(toBinary(artifact.ArtifactRefSchema, request)).equals(toBinary(artifact.ArtifactRefSchema, entry.reference))
      || entry.bytes.length > maximumBytes) throw new Error('Native provider artifact is not owned by this material');
    return entry.bytes.slice();
  } };
  return { reference: fromBinary(common.SnapshotRefSchema, toBinary(common.SnapshotRefSchema, reference)), source, artifactReader, close,
    artifacts: [...payloads.values()].map(entry => structuredClone(entry.reference)),
    task: create(wire.TaskInputSchema, { body: { case: 'inlineUtf8', value: last.content[0].body.value.body.value },
      attachments: last.content.slice(1).map((block) => structuredClone((block.body as { case: 'attachment'; value: artifact.ArtifactRef }).value)) }) };
}

function sha256(bytes: Uint8Array) { return Uint8Array.from(createHash('sha256').update(bytes).digest()); }

