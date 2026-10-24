import { toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import type { NativeSessionReader } from '@mcp/agent-runtime-host';
import { NativeSessionAttachments, attachmentOperationId } from '../../../packages/agent-runtime-host/src/native/NativeSessionAttachments.js';
import { NATIVE_SESSION_MAX_RECORDS } from '../../../packages/agent-runtime-host/src/native/NativeSessionStoreLimits.js';
export function referencedArtifacts(context: wire.ProviderResumeContextV1): artifact.ArtifactRef[] {
  const references = new Map<string, artifact.ArtifactRef>();
  for (const message of context.context!.messages) for (const block of message.content) {
    const body = block.body;
    const reference = body.case === 'attachment' ? body.value
      : (body.case === 'text' || body.case === 'thinking') && body.value.body.case === 'artifact' ? body.value.body.value
        : body.case === 'toolResult' && body.value.content.case === 'artifact' ? body.value.content.value : undefined;
    if (!reference) continue;
    if (reference.byteLength <= 0n || reference.byteLength > 16n * 1024n * 1024n
      || references.size >= 1024 && !references.has(reference.artifactId)) throw new Error('Native continuation attachments exceed bounds');
    const previous = references.get(reference.artifactId);
    if (previous && !Buffer.from(toBinary(artifact.ArtifactRefSchema, previous)).equals(toBinary(artifact.ArtifactRefSchema, reference))) {
      throw new Error('Native child resume attachment reference diverged');
    }
    references.set(reference.artifactId, reference);
  }
  return [...references.values()];
}

export async function readSelectedAttachments(reader: NativeSessionReader, references: readonly artifact.ArtifactRef[],
  attachments: NativeSessionAttachments, signal: AbortSignal) {
  const wanted = new Set<string>();
  let total = 0n;
  for (const reference of references) {
    total += reference.byteLength;
    if (total > 64n * 1024n * 1024n) throw new Error('Native child resume attachment budget exceeded');
    for (let offset = 0; offset < Number(reference.byteLength); offset += 128 * 1024) wanted.add(attachmentOperationId(reference.artifactId, offset));
  }
  let cursor = 0n, scanned = 0;
  while (wanted.size) {
    signal.throwIfAborted();
    if (scanned >= NATIVE_SESSION_MAX_RECORDS) throw new Error('Native child resume attachment scan exceeds bounds');
    const page = await reader.store.list(cursor, Math.min(256, NATIVE_SESSION_MAX_RECORDS - scanned));
    for (const receipt of page.records) {
      if (receipt.sessionId !== reader.state.sessionId || receipt.globalSequence <= cursor) throw new Error('Native child resume attachment cursor diverged');
      cursor = receipt.globalSequence; scanned++;
      if (!wanted.has(receipt.operationId)) continue;
      if (receipt.kind !== journal.SessionRecordKind.ATTACHMENT) throw new Error('Native child resume attachment operation diverged');
      signal.throwIfAborted(); attachments.append(receipt, await reader.store.read(receipt)); wanted.delete(receipt.operationId);
    }
    if (page.complete) break;
    if (!page.records.length || page.nextGlobalSequence !== cursor) throw new Error('Native child resume attachment cursor stalled');
  }
  if (wanted.size) throw new Error('Native child resume attachments are incomplete');
  for (const reference of references) attachments.read(reference, 16 * 1024 * 1024, signal).fill(0);
}
