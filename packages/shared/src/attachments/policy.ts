/**
 * Attachment limits shared by the browser and HTTP routes.
 *
 * Keep this module browser-safe: server-only payload inspection lives in
 * `@mcp/services/services/docs/attachment-validation`.
 */

// Bound payload bytes rather than arbitrarily limiting the number of images.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 200_000;
export const MAX_ATTACHMENTS_TOTAL_TEXT_CHARS = 400_000;
export const DEFAULT_ATTACHMENT_PROMPT = 'Analyze the attached files.';

/** Base64 expands raw bytes by 4/3; leave a small envelope for JSON metadata. */
export const MAX_ATTACHMENT_REQUEST_BYTES = 36 * 1024 * 1024;

export const RASTER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const PDF_EXTENSIONS = new Set(['pdf']);
export const OFFICE_DOCUMENT_EXTENSIONS = new Set([
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
]);
export const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'csv',
  'xml',
  'html',
  'css',
  'svg',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'sql',
  'toml',
  'ini',
  'env',
  'log',
]);

export type AttachmentKind = 'image' | 'pdf' | 'office' | 'text' | 'unsupported';

export function attachmentExtension(name: string | undefined | null): string {
  const clean = (name ?? '').split(/[\\/]/).pop() ?? '';
  const i = clean.lastIndexOf('.');
  return i >= 0 ? clean.slice(i + 1).toLowerCase() : '';
}

export function classifyAttachment(name: string | undefined, mediaType: string | undefined): AttachmentKind {
  const ext = attachmentExtension(name);
  const mime = (mediaType ?? '').toLowerCase().split(';', 1)[0].trim();
  if (RASTER_IMAGE_EXTENSIONS.has(ext) || ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    return 'image';
  }
  if (PDF_EXTENSIONS.has(ext) || mime === 'application/pdf') return 'pdf';
  if (OFFICE_DOCUMENT_EXTENSIONS.has(ext) || OFFICE_MEDIA_TYPES.has(mime)) return 'office';
  if (
    TEXT_ATTACHMENT_EXTENSIONS.has(ext)
    || mime.startsWith('text/')
    || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime)
  ) {
    return 'text';
  }
  return 'unsupported';
}

/** Exact raw byte count for a canonical, unprefixed base64 string. */
export function decodedBase64Bytes(base64: string): number {
  const compact = base64.replace(/\s/g, '');
  if (!compact) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

export function attachmentPayloadBytes(att: { base64?: string; text?: string }): number {
  if (att.base64) return decodedBase64Bytes(att.base64);
  return att.text ? new TextEncoder().encode(att.text).byteLength : 0;
}

const OFFICE_MEDIA_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
]);
