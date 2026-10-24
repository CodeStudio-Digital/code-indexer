import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_TEXT_CHARS, MAX_ATTACHMENTS_TOTAL_TEXT_CHARS, attachmentPayloadBytes, classifyAttachment } from '@mcp/shared/attachments/policy.js';
import type { AgentAttachment } from './types.js';
import { TEXT_LIKE_EXTS } from './constants.js';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? ` ${rm}m` : ''}`;
}

/** Read a Blob/File as base64 (strips the `data:<type>;base64,` prefix). */
export function readDataUrlBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.split(',', 2)[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

interface FileAttachmentOptions {
  /** Prefer a local path reference for files that do not require inline bytes. */
  preferFileReferences?: boolean;
  /** Pre-resolved by filesToAttachments so the bridge is called only once. */
  nativePath?: string;
}

/** Images and structured documents need bytes for vision/native parsers. */
function requiresInlinePayload(kind: ReturnType<typeof classifyAttachment>): boolean {
  return kind === 'image' || kind === 'pdf' || kind === 'office';
}

function nativeFileReference(file: File, prefer: boolean): string | undefined {
  if (!prefer) return undefined;
  try {
    const bridge = (globalThis as typeof globalThis & {
      electronAPI?: { getPathForFile?: (value: File) => string };
    }).electronAPI;
    const path = bridge?.getPathForFile?.(file)?.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

function fileToAttachment(
  file: File,
  options: FileAttachmentOptions = {},
): Promise<AgentAttachment> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const kind = classifyAttachment(file.name, file.type);
  const nativePath = options.nativePath
    ?? (!requiresInlinePayload(kind)
      ? nativeFileReference(file, options.preferFileReferences === true)
      : undefined);
  if (nativePath) {
    return Promise.resolve({
      name: file.name || nativePath.split(/[\\/]/).pop() || 'attachment',
      mediaType: file.type || 'application/octet-stream',
      path: nativePath,
    });
  }
  if (kind === 'unsupported') {
    return Promise.reject(new Error(`Unsupported attachment type: ${file.name}`));
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.reject(new Error(`${file.name} exceeds the 10 MB attachment limit.`));
  }
  const isImage = file.type.startsWith('image/');
  // RTF must reach the server-side office extractor as base64. Some browsers
  // report it as `text/rtf`, which would otherwise hit the text branch and
  // send raw RTF control-word markup to the model instead of clean text.
  const isRtf = ext === 'rtf' || file.type === 'text/rtf' || file.type === 'application/rtf';
  const isText =
    !isRtf &&
    (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_LIKE_EXTS.has(ext));
  if (isText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const text = String(reader.result ?? '');
        if (text.length > MAX_ATTACHMENT_TEXT_CHARS) {
          reject(new Error(`${file.name} exceeds the 200,000 character text limit.`));
          return;
        }
        resolve({ name: file.name, mediaType: file.type || 'text/plain', text });
      };
      reader.readAsText(file);
    });
  }
  return readDataUrlBase64(file).then((base64) => ({
    name: file.name,
    mediaType: file.type || (isImage ? 'image/png' : 'application/octet-stream'),
    base64,
  }));
}

/** Validate a complete selection before allocating base64 strings in the renderer. */
export async function filesToAttachments(
  files: FileList | File[],
  existing: AgentAttachment[] = [],
  options: Pick<FileAttachmentOptions, 'preferFileReferences'> = {},
): Promise<AgentAttachment[]> {
  const selected = Array.from(files);
  if (existing.length + selected.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
  }

  const planned = selected.map((file) => {
    const kind = classifyAttachment(file.name, file.type);
    const nativePath = !requiresInlinePayload(kind)
      ? nativeFileReference(file, options.preferFileReferences === true)
      : undefined;
    return { file, kind, nativePath };
  });

  let totalBytes = existing.reduce((sum, att) => sum + attachmentPayloadBytes(att), 0);
  for (const { file, kind, nativePath } of planned) {
    if (!nativePath && kind === 'unsupported') {
      throw new Error(`Unsupported attachment type: ${file.name}`);
    }
    if (!nativePath && file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds the 10 MB attachment limit.`);
    }
    if (!nativePath) totalBytes += file.size;
  }
  if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error('Attachments exceed the 25 MB combined limit.');
  }

  const converted = await Promise.all(planned.map(({ file, nativePath }) =>
    fileToAttachment(file, { ...options, nativePath })));
  const totalTextChars = [...existing, ...converted].reduce(
    (sum, att) => sum + (att.text?.length ?? 0),
    0,
  );
  if (totalTextChars > MAX_ATTACHMENTS_TOTAL_TEXT_CHARS) {
    throw new Error('Text attachments exceed the 400,000 character combined limit.');
  }
  return converted;
}
