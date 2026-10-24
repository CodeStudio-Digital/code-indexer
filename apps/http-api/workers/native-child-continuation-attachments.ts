import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import type { NativeSessionReader } from '@mcp/agent-runtime-host';
import { NativeSessionAttachments, attachmentOperationId } from '../../../packages/agent-runtime-host/src/native/NativeSessionAttachments.js';
import { validateRecoveryPage } from '../../../packages/agent-runtime-host/src/native/NativeEngineEventRecovery.js';
import { validateProviderConversation } from '../../../packages/agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { NATIVE_SESSION_MAX_RECORDS } from '../../../packages/agent-runtime-host/src/native/NativeSessionStoreLimits.js';
import { readSelectedAttachments, referencedArtifacts } from './native-continuation-attachments.js';

const CHAPTER = 'native-context-chapter-v1';
const MAX_BYTES = 64 * 1024 * 1024;

/** A child continuation moves to a new journal. Its authenticated model window
 * must carry the entire reachable chapter graph, including historical media. */
export class NativeChildContinuationAttachments {
  private readonly chapters: NativeSessionAttachments;
  private readonly media: NativeSessionAttachments;
  private readonly references = new Map<string, artifact.ArtifactRef>();
  private readonly chapterReferences = new Map<string, artifact.ArtifactRef>();
  private projectionBytes = 0;
  private closureBytes = 0;
  private constructor(private readonly sessionId: string) {
    this.chapters = new NativeSessionAttachments(sessionId, { chaptersOnly: true });
    this.media = new NativeSessionAttachments(sessionId, { includeToolOutputs: true });
  }
  get artifacts(): readonly artifact.ArtifactRef[] { return [...this.references.values()]; }

  static async open(reader: NativeSessionReader, context: wire.ProviderResumeContextV1, signal: AbortSignal) {
    const projection = new NativeChildContinuationAttachments(reader.state.sessionId);
    try { await projection.load(reader, context, signal); return projection; }
    catch (cause) { projection.close(); throw cause; }
  }

  private async load(reader: NativeSessionReader, context: wire.ProviderResumeContextV1, signal: AbortSignal) {
    if (!context.context!.messages.some(message => message.compactedChapter)) {
      for (const reference of referencedArtifacts(context)) this.add(reference);
      await readSelectedAttachments(reader, this.artifacts, this.media, signal);
      return;
    }
    // Scan once: chapters are bounded content projections; other attachments
    // retain only their receipt index until the transitive references are known.
    const receipts = new Map<string, journal.CommitSessionRecordReceipt>();
    let cursor = 0n, scanned = 0;
    for (;;) {
      signal.throwIfAborted();
      if (scanned >= NATIVE_SESSION_MAX_RECORDS) throw new Error('Native child chapter attachment scan exceeds bounds');
      const limit = Math.min(256, NATIVE_SESSION_MAX_RECORDS - scanned);
      const page = await reader.store.list(cursor, limit);
      validateRecoveryPage(page, this.sessionId, cursor, limit);
      for (const receipt of page.records) {
        cursor = receipt.globalSequence; scanned++;
        if (receipt.kind !== journal.SessionRecordKind.ATTACHMENT) continue;
        signal.throwIfAborted();
        const payload = await reader.store.read(receipt);
        try {
          this.chapters.append(receipt, payload);
          const chunk = fromBinary(journal.SessionAttachmentChunkV1Schema, payload), reference = chunk.reference!;
          if (reference.redactionPolicyVersion === CHAPTER) {
            if (!this.chapterReferences.has(reference.artifactId)) {
              this.chapterReferences.set(reference.artifactId, reference);
              this.projectionBytes += Number(reference.byteLength);
            }
          } else {
            if (receipts.has(receipt.operationId)) throw new Error('Native child attachment receipt is duplicated');
            receipts.set(receipt.operationId, receipt);
          }
        } finally { payload.fill(0); }
      }
      if (page.complete) break;
      if (!page.records.length || page.nextGlobalSequence !== cursor) throw new Error('Native child attachment cursor stalled');
    }
    const path = new Set<string>(), visited = new Set<string>();
    const stack: Array<{ messages: readonly wire.ProviderMessage[]; index: number; id?: string }> = [
      { messages: context.context!.messages, index: 0 },
    ];
    while (stack.length) {
      signal.throwIfAborted();
      const frame = stack.at(-1)!;
      if (frame.index === frame.messages.length) {
        stack.pop(); if (frame.id) { path.delete(frame.id); visited.add(frame.id); } continue;
      }
      const message = frame.messages[frame.index++]!;
      for (const reference of referencedArtifacts(create(wire.ProviderResumeContextV1Schema, { context: { messages: [message] } }))) this.add(reference);
      const reference = message.compactedChapter;
      if (!reference) continue;
      this.add(reference);
      if (path.has(reference.artifactId)) throw new Error('Native child context chapter cycle');
      if (visited.has(reference.artifactId)) continue;
      const encoded = this.chapters.read(reference, 8 * 1024 * 1024, signal);
      try {
        const value = fromBinary(wire.ProviderContextChapterV1Schema, encoded);
        if (reference.redactionPolicyVersion !== CHAPTER || reference.kind !== 'document'
          || reference.mediaType !== 'application/vnd.codestudio.context-chapter.v1+protobuf'
          || value.schemaVersion !== 1 || value.sessionId !== this.sessionId
          || !Buffer.from(toBinary(wire.ProviderContextChapterV1Schema, value)).equals(encoded)) throw new Error('Native child context chapter diverged');
        validateProviderConversation(value.messages);
        // Retain only references, not protobuf byte fields that borrow encoded.
        const owned = fromBinary(wire.ProviderContextChapterV1Schema, encoded.slice());
        path.add(reference.artifactId);
        stack.push({ messages: owned.messages, index: 0, id: reference.artifactId });
      } finally { encoded.fill(0); }
    }
    const mediaReferences = [...this.references.values()].filter(reference => reference.redactionPolicyVersion !== CHAPTER);
    if (this.chapterReferences.size + mediaReferences.length > 1024) throw new Error('Native child attachment projection exceeds bounds');
    for (const reference of mediaReferences) {
      if (reference.redactionPolicyVersion === CHAPTER) continue;
      this.projectionBytes += Number(reference.byteLength);
      if (this.projectionBytes > MAX_BYTES) {
        throw new Error('Native child attachment projection exceeds bounds');
      }
      for (let offset = 0; offset < Number(reference.byteLength); offset += 128 * 1024) {
        signal.throwIfAborted();
        const receipt = receipts.get(attachmentOperationId(reference.artifactId, offset));
        if (!receipt) throw new Error('Native child resume attachments are incomplete');
        const payload = await reader.store.read(receipt);
        try { this.media.append(receipt, payload); } finally { payload.fill(0); }
      }
      this.media.read(reference, 16 * 1024 * 1024, signal).fill(0);
    }
  }

  private add(reference: artifact.ArtifactRef) {
    const previous = this.references.get(reference.artifactId);
    if (previous) {
      if (!Buffer.from(toBinary(artifact.ArtifactRefSchema, previous)).equals(toBinary(artifact.ArtifactRefSchema, reference))) {
        throw new Error('Native child resume attachment reference diverged');
      }
      return;
    }
    this.closureBytes += Number(reference.byteLength);
    if (reference.ownerSessionId !== this.sessionId || reference.byteLength <= 0n || reference.byteLength > 16n * 1024n * 1024n
      || this.references.size >= 1024 || this.closureBytes > MAX_BYTES) throw new Error('Native child resume attachment closure exceeds bounds');
    this.references.set(reference.artifactId, reference);
  }

  read(reference: artifact.ArtifactRef, maximumBytes: number, signal: AbortSignal): Uint8Array {
    return (reference.redactionPolicyVersion === CHAPTER ? this.chapters : this.media).read(reference, maximumBytes, signal);
  }
  close() { this.chapters.close(); this.media.close(); this.references.clear(); this.chapterReferences.clear(); }
}
