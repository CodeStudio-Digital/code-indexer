import { createHash } from 'node:crypto';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import type { ProviderArtifactReaderPort } from '../provider-gateway/ProviderGatewayTypes.js';
import { verifyArtifact } from '../provider-gateway/ProviderGatewayValidation.js';
import type { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';

const CHUNK_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 64 * 1024 * 1024;

function validateReference(reference: artifact.ArtifactRef, sessionId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(reference.artifactId) || reference.ownerSessionId !== sessionId
    || !['image', 'document'].includes(reference.kind) || !reference.mediaType || reference.mediaType.length > 256
    || reference.byteLength <= 0n || reference.byteLength > BigInt(MAX_ARTIFACT_BYTES)
    || reference.contentSha256.length !== 32 || reference.compression !== artifact.ArtifactCompression.NONE
    || reference.privacyClass <= 0 || reference.privacyClass > artifact.ArtifactPrivacyClass.RESTRICTED
    || Buffer.byteLength(reference.displayName) > 1024 || /[\\/\u0000-\u001f]/.test(reference.displayName)
    || !reference.redactionPolicyVersion || reference.redactionPolicyVersion.length > 256) {
    throw new Error('Native attachment reference is invalid or crosses sessions');
  }
}

/** Publishes bounded content-only records through the already authorized writer.
 * A provider frontier may reference the artifact only after every chunk commits. */
export async function commitNativeSessionAttachment(client: Pick<NativeSessionStoreBridgeClient, 'request'>,
  writerHandle: string, authority: wire.SessionStoreAuthority, sessionId: string,
  reference: artifact.ArtifactRef, reader: ProviderArtifactReaderPort, signal: AbortSignal): Promise<void> {
  reference = clone(artifact.ArtifactRefSchema, reference);
  validateReference(reference, sessionId);
  signal.throwIfAborted();
  const bytes = await reader.read(reference, MAX_ARTIFACT_BYTES, signal);
  verifyArtifact(reference, bytes, MAX_ARTIFACT_BYTES);
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    signal.throwIfAborted();
    const payload = toBinary(wire.SessionAttachmentChunkV1Schema, create(wire.SessionAttachmentChunkV1Schema, {
      schemaVersion: 1, reference, chunkOffset: BigInt(offset), encodedChunk: bytes.slice(offset, offset + CHUNK_BYTES),
    }));
    const digest = createHash('sha256').update(payload).digest();
    const operationId = attachmentOperationId(reference.artifactId, offset);
    const response = await client.request({ case: 'commitSessionRecord', value: create(wire.CommitSessionRecordSchema, {
      writerHandle, authority, operationId, kind: wire.SessionRecordKind.ATTACHMENT,
      durability: wire.SessionDurabilityClass.AUTHORITATIVE, encodedPayload: payload, expectedPayloadSha256: digest,
    }) });
    if (response.case !== 'commitSessionRecordReceipt' || response.value.sessionId !== sessionId
      || response.value.operationId !== operationId || response.value.kind !== wire.SessionRecordKind.ATTACHMENT
      || response.value.durability !== wire.SessionDurabilityClass.AUTHORITATIVE
      || response.value.payloadBytes !== BigInt(payload.length) || !Buffer.from(response.value.payloadSha256).equals(digest)
      || !validReceiptAuthority(response.value.authority, authority)) {
      throw new Error('Native attachment commit receipt diverged');
    }
  }
}

function validReceiptAuthority(receipt: wire.SessionStoreAuthority | undefined, current: wire.SessionStoreAuthority): boolean {
  // The authenticated current writer validates replay against its journal's
  // operation index. An exact older receipt is content reuse, not a new effect.
  return !!receipt && receipt.storageGeneration === current.storageGeneration
    && /^[a-f0-9-]{36}$/i.test(receipt.writerId) && receipt.leaseEpoch > 0n && receipt.leaseEpoch <= current.leaseEpoch
    && (receipt.leaseEpoch < current.leaseEpoch || receipt.writerId === current.writerId);
}

/** Bounded rebuildable attachment reader. Partial groups never authorize reads;
 * no pathname or hash alone can be used in place of the exact reference. */
export class NativeSessionAttachments implements ProviderArtifactReaderPort {
  private readonly entries = new Map<string, { reference: Uint8Array; bytes: Uint8Array; offset: number; complete: boolean }>();
  private reserved = 0;
  constructor(private readonly sessionId: string, private readonly options: { includeToolOutputs?: boolean; chaptersOnly?: boolean } = {}) {}

  append(receipt: wire.CommitSessionRecordReceipt, payload: Uint8Array): void {
    if (receipt.sessionId !== this.sessionId || receipt.kind !== wire.SessionRecordKind.ATTACHMENT
      || receipt.durability !== wire.SessionDurabilityClass.AUTHORITATIVE
      || payload.length > CHUNK_BYTES + 4096 || receipt.payloadBytes !== BigInt(payload.length)
      || !createHash('sha256').update(payload).digest().equals(receipt.payloadSha256)) {
      throw new Error('Native attachment receipt is invalid');
    }
    const chunk = fromBinary(wire.SessionAttachmentChunkV1Schema, payload);
    if (chunk.schemaVersion !== 1 || !chunk.reference || !chunk.encodedChunk.length || chunk.encodedChunk.length > CHUNK_BYTES
      || !Buffer.from(toBinary(wire.SessionAttachmentChunkV1Schema, chunk)).equals(payload)) {
      throw new Error('Native attachment chunk is invalid');
    }
    const reference = chunk.reference;
    validateReference(reference, this.sessionId);
    if (this.options.chaptersOnly ? reference.redactionPolicyVersion !== 'native-context-chapter-v1'
      : reference.redactionPolicyVersion === 'native-context-chapter-v1') return;
    // Recovery spill files are durable attachments, but never provider media.
    // A long session must not retain all historical spills in the chat cache.
    if (reference.redactionPolicyVersion === 'native-tool-output-v1' && !this.options.includeToolOutputs) return;
    const encodedReference = toBinary(artifact.ArtifactRefSchema, reference);
    let entry = this.entries.get(reference.artifactId);
    if (!entry) {
      if (chunk.chunkOffset !== 0n || this.entries.size >= 1024
        || this.reserved + Number(reference.byteLength) > MAX_PROJECTION_BYTES) throw new Error('Native attachment projection exceeds its bounds');
      this.reserved += Number(reference.byteLength);
      entry = { reference: encodedReference, bytes: new Uint8Array(Number(reference.byteLength)), offset: 0, complete: false };
      this.entries.set(reference.artifactId, entry);
    }
    if (entry.complete || chunk.chunkOffset !== BigInt(entry.offset) || !Buffer.from(entry.reference).equals(encodedReference)
      || entry.offset + chunk.encodedChunk.length > entry.bytes.length) throw new Error('Native attachment group diverged');
    entry.bytes.set(chunk.encodedChunk, entry.offset); entry.offset += chunk.encodedChunk.length;
    if (entry.offset === entry.bytes.length) {
      verifyArtifact(reference, entry.bytes, MAX_ARTIFACT_BYTES);
      entry.complete = true;
    }
  }

  read(reference: artifact.ArtifactRef, maximumBytes: number, signal: AbortSignal): Uint8Array {
    signal.throwIfAborted();
    validateReference(reference, this.sessionId);
    const entry = this.entries.get(reference.artifactId);
    if (!entry?.complete || entry.bytes.length > maximumBytes
      || !Buffer.from(entry.reference).equals(toBinary(artifact.ArtifactRefSchema, reference))) {
      throw new Error('Native attachment is missing, incomplete or belongs to another authority');
    }
    return entry.bytes.slice();
  }

  close(): void {
    for (const entry of this.entries.values()) entry.bytes.fill(0);
    this.entries.clear(); this.reserved = 0;
  }
}

export function attachmentOperationId(id: string, offset: number): string {
  const bytes = createHash('sha256').update('codestudio.agent.attachment-chunk.v1\0').update(id).update(`:${offset}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50; bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
