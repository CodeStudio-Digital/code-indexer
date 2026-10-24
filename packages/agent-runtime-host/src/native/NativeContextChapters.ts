import { createHash } from 'node:crypto';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { commitNativeSessionAttachment, NativeSessionAttachments } from './NativeSessionAttachments.js';
import { validateProviderConversation } from './ProviderFrontierCodec.js';
import type { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import { validateRecoveryPage } from './NativeEngineEventRecovery.js';

const MAX_BYTES = 8 * 1024 * 1024;
const POLICY = 'native-context-chapter-v1';

function chapter(reference: artifact.ArtifactRef | undefined, bytes: Uint8Array, sessionId: string) {
  if (!reference || reference.ownerSessionId !== sessionId || reference.kind !== 'document'
    || reference.redactionPolicyVersion !== POLICY
    || reference.mediaType !== 'application/vnd.codestudio.context-chapter.v1+protobuf'
    || bytes.length === 0 || bytes.length > MAX_BYTES || reference.byteLength !== BigInt(bytes.length)
    || !createHash('sha256').update(bytes).digest().equals(reference.contentSha256)) throw new Error('Context chapter authority or digest diverged');
  // A Buffer is also a Uint8Array, but its .slice() aliases storage. Give
  // protobuf a plain typed-array view so clone below always owns byte fields.
  const value = fromBinary(wire.ProviderContextChapterV1Schema, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (value.schemaVersion !== 1 || value.sessionId !== sessionId
    || !Buffer.from(toBinary(wire.ProviderContextChapterV1Schema, value)).equals(bytes)) throw new Error('Context chapter is not canonical');
  validateProviderConversation(value.messages);
  // Protobuf byte fields may borrow the input buffer. Recovery clears its
  // temporary read buffer, so retained tool arguments need their own storage.
  return clone(wire.ProviderContextChapterV1Schema, value);
}

/** All content receipts precede the frontier; failed/unknown commits fence its writer. */
export async function commitContextChapters(client: Pick<NativeSessionStoreBridgeClient, 'request'>,
  handle: string, authority: journal.SessionStoreAuthority, sessionId: string,
  start: wire.ProviderStart, signal: AbortSignal): Promise<wire.ProviderStart> {
  if (start.pendingChapters.length > 1) throw new Error('Too many pending context chapters');
  for (const pending of start.pendingChapters) {
    chapter(pending.reference, pending.encodedChapter, sessionId);
    const matches = start.messages.filter(message => message.compactedChapter?.artifactId === pending.reference!.artifactId);
    if (matches.length !== 1 || matches[0]!.role !== wire.ProviderMessageRole.ASSISTANT || !matches[0]!.isMeta
      || matches[0]!.content.length !== 1 || matches[0]!.content[0]!.body.case !== 'text'
      || !Buffer.from(toBinary(artifact.ArtifactRefSchema, matches[0]!.compactedChapter!))
        .equals(toBinary(artifact.ArtifactRefSchema, pending.reference!))) throw new Error('Context chapter replacement diverged');
    await commitNativeSessionAttachment(client, handle, authority, sessionId, pending.reference!,
      { read: () => pending.encodedChapter }, signal);
  }
  return { ...start, pendingChapters: [] };
}

/** Expand only to verify the public transcript during cold recovery. The provider
 * continues from the bounded authenticated frontier, never from this full view. */
export async function expandContextChapters(store: EngineEventRecoveryStorePort, sessionId: string,
  messages: readonly wire.ProviderMessage[], signal = new AbortController().signal): Promise<wire.ProviderMessage[]> {
  if (!messages.some(m => m.compactedChapter)) return [...messages];
  const attachments = new NativeSessionAttachments(sessionId, { chaptersOnly: true });
  try {
    let cursor = 0n, count = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = await store.list(cursor, 256);
      validateRecoveryPage(page, sessionId, cursor, 256);
      for (const receipt of page.records) {
        if (++count > 1_000_000) throw new Error('Context chapter recovery record limit');
        cursor = receipt.globalSequence;
        if (receipt.kind === journal.SessionRecordKind.ATTACHMENT) attachments.append(receipt, await store.read(receipt));
      }
      if (page.complete) break;
      if (!page.records.length || page.nextGlobalSequence !== cursor) throw new Error('Context chapter recovery cursor diverged');
    }
    const output: wire.ProviderMessage[] = [];
    let bytes = 0, decodedBytes = 0;
    const path = new Set<string>();
    const stack: Array<{ items: readonly wire.ProviderMessage[]; index: number; chapterId?: string }> = [{ items: messages, index: 0 }];
    while (stack.length) {
      signal.throwIfAborted();
      const frame = stack.at(-1)!;
      if (frame.index === frame.items.length) {
        stack.pop(); if (frame.chapterId) path.delete(frame.chapterId); continue;
      }
      const message = frame.items[frame.index++]!, ref = message.compactedChapter;
      if (!ref) {
        bytes += toBinary(wire.ProviderMessageSchema, message).length;
        if (output.length >= 100_000 || bytes > 64 * 1024 * 1024) throw new Error('Expanded context exceeds transcript bounds');
        output.push(message); continue;
      }
      if (path.has(ref.artifactId)) throw new Error('Context chapter cycle');
      const encoded = attachments.read(ref, MAX_BYTES, signal);
      try {
        // Bound repeated DAG expansion as well as retained transcript bytes.
        // The attachment projection already limits distinct chapters to 1024
        // and 64 MiB; nesting itself is not another conversation limit.
        decodedBytes += encoded.length;
        if (decodedBytes > 64 * 1024 * 1024) throw new Error('Expanded context exceeds transcript bounds');
        const value = chapter(ref, encoded, sessionId);
        path.add(ref.artifactId);
        stack.push({ items: value.messages, index: 0, chapterId: ref.artifactId });
      } finally { encoded.fill(0); }
    }
    validateProviderConversation(output);
    return output;
  } finally { attachments.close(); }
}
