import { ArtifactStore, type ArtifactRef, type SessionLocation } from '@mcp/session-storage';
import type { ProjectedStoredMessage } from './conversation-codec.js';

export interface SessionAttachment {
  seq: number; index: number; name: string; media_type: string; size: number | null;
  created_at: string; source_path: string | null; downloadable: boolean;
  origin: 'sent' | 'generated' | 'tool';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function attachmentMetadata(message: ProjectedStoredMessage, index: number): SessionAttachment | null {
  if (!['user', 'assistant'].includes(message.role) || !Array.isArray(message.content)) return null;
  const block = record(message.content[index]);
  if (!block || !['artifact_ref', 'image', 'document'].includes(String(block.type))) return null;
  if (block.type === 'artifact_ref' && !['image', 'document'].includes(String(block.source_type))) return null;
  const artifact = record(block.artifact);
  const name = String(block.name ?? artifact?.logical_name ?? `image-${index}`);
  return {
    seq: message.seq, index, name, created_at: message.committed_at,
    origin: message.role === 'assistant' ? 'generated' : message.content.some(value => {
      const item = record(value);
      return item?.type === 'text' && item.text === '(Image(s) attached from the tool call above.)';
    }) ? 'tool' : 'sent',
    media_type: String(block.media_type ?? block.mediaType ?? 'application/octet-stream'),
    size: typeof artifact?.size === 'number' ? artifact.size : typeof block.text === 'string'
      ? Buffer.byteLength(block.text) : typeof block.base64 === 'string' ? Buffer.byteLength(block.base64, 'base64') : null,
    source_path: typeof block.path === 'string' ? block.path : null,
    downloadable: artifact !== null || typeof block.text === 'string' || typeof block.base64 === 'string',
  };
}

export function attachmentPage(messages: Iterable<ProjectedStoredMessage>, offset: number, limit: number) {
  const all: SessionAttachment[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    message.content.forEach((_, index) => {
      const item = attachmentMetadata(message, index);
      if (item) all.push(item);
    });
  }
  const start = Math.max(0, Math.trunc(offset));
  const end = start + Math.max(1, Math.min(100, Math.trunc(limit)));
  return { items: all.slice(start, end), total: all.length, next_offset: end < all.length ? end : null };
}

export async function readAttachment(location: SessionLocation, message: ProjectedStoredMessage, index: number) {
  const metadata = attachmentMetadata(message, index);
  if (!metadata?.downloadable || !Array.isArray(message.content)) return null;
  const block = record(message.content[index])!;
  const bytes = block.type === 'artifact_ref'
    ? await new ArtifactStore({ bundlePath: location.bundle_path, sessionId: location.session_id }).readAsync(block.artifact as ArtifactRef)
    : typeof block.base64 === 'string' ? Buffer.from(block.base64, 'base64') : Buffer.from(String(block.text), 'utf8');
  return { ...metadata, bytes };
}
