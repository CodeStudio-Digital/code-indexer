import { ArtifactStore, SESSION_ARTIFACT_ROOTS, asSessionId } from '@mcp/session-storage';
import type { BoardAttachment } from '@mcp/company-contracts';
import type { CompanySessionFiles } from './CompanySessionFiles.js';

/** Preserve originals independently of model-specific extraction/vision conversion. */
export async function persistBoardAttachments(files: CompanySessionFiles, attachments?: readonly {
  name?: string; mediaType: string; base64?: string; text?: string;
}[]): Promise<BoardAttachment[] | undefined> {
  if (!attachments?.length) return undefined;
  const store = new ArtifactStore({ bundlePath: files.location.bundle_path, sessionId: asSessionId(files.companySessionId) });
  const result: BoardAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.base64 == null && attachment.text == null) continue;
    const name = attachment.name || `attachment-${result.length + 1}`;
    const ref = await store.put({ kind: 'attachment', media_type: attachment.mediaType, logical_name: name,
      data: attachment.base64 != null ? Buffer.from(attachment.base64, 'base64') : attachment.text! });
    result.push({ name, mediaType: attachment.mediaType, size: ref.size, sha256: ref.sha256 });
  }
  return result.length ? result : undefined;
}

export async function readBoardAttachment(files: CompanySessionFiles, attachment: BoardAttachment): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(attachment.sha256) || !Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    throw new Error('Invalid board attachment reference');
  }
  const hash = attachment.sha256;
  const store = new ArtifactStore({ bundlePath: files.location.bundle_path, sessionId: asSessionId(files.companySessionId) });
  return store.readAsync({ kind: 'attachment', artifact_id: `sha256:${hash}`, sha256: hash, size: attachment.size,
    relative_path: [...SESSION_ARTIFACT_ROOTS.attachment, hash.slice(0, 2), hash].join('/'),
    media_type: attachment.mediaType, logical_name: attachment.name });
}
