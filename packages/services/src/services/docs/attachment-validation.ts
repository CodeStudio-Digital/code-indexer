import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_ATTACHMENTS_TOTAL_TEXT_CHARS,
  attachmentExtension,
  attachmentPayloadBytes,
  classifyAttachment,
  type AttachmentKind,
} from '@mcp/shared';

export interface AttachmentInput {
  name?: string;
  mediaType?: string;
  path?: string;
  base64?: string;
  text?: string;
}

export interface ValidatedAttachment {
  name: string;
  mediaType: string;
  path?: string;
  base64?: string;
  text?: string;
}

export interface AttachmentValidationOptions {
  /** Local coder sessions may pass exact file references instead of payloads. */
  allowFileReferences?: boolean;
}

export type AttachmentValidationResult =
  | { ok: true; value: ValidatedAttachment[] | undefined }
  | { ok: false; status: 400 | 413 | 415; code: string; error: string };

const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;
const MAX_PDF_PAGES = 1_000;

/**
 * Validate and normalize untrusted attachment JSON before extraction or
 * persistence. This is intentionally shared by coder + company routes so the
 * same file cannot be accepted on one chat surface and rejected on another.
 */
export function validateAttachments(
  input: unknown,
  options: AttachmentValidationOptions = {},
): AttachmentValidationResult {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!Array.isArray(input)) return invalid(400, 'ATTACHMENTS_INVALID', 'attachments must be an array');
  if (input.length === 0) return { ok: true, value: undefined };

  const out: ValidatedAttachment[] = [];
  let totalBytes = 0;
  let totalTextChars = 0;

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') {
      return invalid(400, 'ATTACHMENT_INVALID', `attachments[${i}] must be an object`);
    }
    const a = raw as Record<string, unknown>;
    const rawPath = typeof a.path === 'string' && a.path.trim() ? a.path.trim() : undefined;
    const name = sanitizeDisplayName(
      typeof a.name === 'string'
        ? a.name
        : rawPath ?? `attachment-${i + 1}`,
    );
    const declaredMediaType = typeof a.mediaType === 'string'
      ? a.mediaType.toLowerCase().split(';', 1)[0]!.trim()
      : '';
    const base64 = typeof a.base64 === 'string' && a.base64.length > 0 ? a.base64.replace(/\s/g, '') : undefined;
    const text = typeof a.text === 'string' && a.text.length > 0 ? a.text : undefined;
    const representations = Number(!!rawPath) + Number(!!base64) + Number(!!text);

    if (representations === 0) {
      return invalid(400, 'ATTACHMENT_EMPTY', `attachments[${i}] must have path, base64 or text`);
    }
    if (representations > 1) {
      return invalid(400, 'ATTACHMENT_AMBIGUOUS', `attachments[${i}] must contain exactly one of path, base64 or text`);
    }

    if (rawPath) {
      if (!options.allowFileReferences) {
        return invalid(
          400,
          'ATTACHMENT_REFERENCE_UNSUPPORTED',
          `attachments[${i}] local file references are not supported on this surface`,
        );
      }
      const reference = canonicalizeFileReference(rawPath);
      if (!reference.ok) {
        return invalid(400, 'ATTACHMENT_REFERENCE_INVALID', `attachments[${i}] ${reference.reason}`);
      }
      const kind = classifyAttachment(name, declaredMediaType);
      out.push({
        name,
        mediaType: kind === 'unsupported'
          ? declaredMediaType || 'application/octet-stream'
          : canonicalMediaType(kind, name, declaredMediaType),
        path: reference.path,
      });
      continue;
    }

    const extKind = classifyAttachment(name, undefined);
    const kind = extKind !== 'unsupported' ? extKind : classifyAttachment(name, declaredMediaType);
    if (kind === 'unsupported') {
      return invalid(415, 'ATTACHMENT_UNSUPPORTED', `attachments[${i}] has an unsupported file type`);
    }

    if (text) {
      if (kind !== 'text') {
        return invalid(400, 'ATTACHMENT_ENCODING_INVALID', `attachments[${i}] must be sent as base64`);
      }
      if (text.length > MAX_ATTACHMENT_TEXT_CHARS) {
        return invalid(413, 'ATTACHMENT_TOO_LARGE', `attachments[${i}] text is too large`);
      }
      totalTextChars += text.length;
      totalBytes += attachmentPayloadBytes({ text });
      if (totalTextChars > MAX_ATTACHMENTS_TOTAL_TEXT_CHARS) {
        return invalid(413, 'ATTACHMENTS_TOO_LARGE', 'combined attachment text is too large');
      }
      if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
        return invalid(413, 'ATTACHMENTS_TOO_LARGE', 'combined attachments exceed 25 MB');
      }
      out.push({ name, mediaType: canonicalMediaType(kind, name, declaredMediaType), text });
      continue;
    }

    if (kind === 'text') {
      return invalid(400, 'ATTACHMENT_ENCODING_INVALID', `attachments[${i}] text files must use the text payload`);
    }

    if (!isCanonicalBase64(base64!)) {
      return invalid(400, 'ATTACHMENT_BASE64_INVALID', `attachments[${i}].base64 is invalid`);
    }
    const bytes = attachmentPayloadBytes({ base64 });
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return invalid(413, 'ATTACHMENT_TOO_LARGE', `attachments[${i}] exceeds 10 MB`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
      return invalid(413, 'ATTACHMENTS_TOO_LARGE', 'combined attachments exceed 25 MB');
    }

    const payload = Buffer.from(base64!, 'base64');
    const signatureError = validateSignature(kind, name, declaredMediaType, payload);
    if (signatureError) {
      return invalid(415, 'ATTACHMENT_CONTENT_MISMATCH', `attachments[${i}] ${signatureError}`);
    }
    if (kind === 'pdf') {
      const pdfError = validatePdf(payload);
      if (pdfError) return invalid(415, 'PDF_UNSUPPORTED', `attachments[${i}] ${pdfError}`);
    }
    if (kind === 'office' && officeFormat(name, declaredMediaType) !== 'rtf') {
      const zipError = validateZipEnvelope(payload, name, declaredMediaType);
      if (zipError) return invalid(415, 'ATTACHMENT_ARCHIVE_UNSAFE', `attachments[${i}] ${zipError}`);
    }

    out.push({
      name,
      mediaType: canonicalMediaType(kind, name, declaredMediaType, payload),
      base64,
    });
  }

  return { ok: true, value: out };
}

function canonicalizeFileReference(
  rawPath: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (rawPath.length > 4_096 || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    return { ok: false, reason: 'path is malformed' };
  }
  if (!isAbsolute(rawPath)) return { ok: false, reason: 'path must be absolute' };
  try {
    const path = realpathSync(resolve(rawPath));
    if (!statSync(path).isFile()) return { ok: false, reason: 'path must reference a regular file' };
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      reason: `file is not accessible: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function sanitizeDisplayName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? 'attachment';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  return clean || 'attachment';
}

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function canonicalMediaType(kind: AttachmentKind, name: string, declared: string, payload?: Buffer): string {
  const ext = attachmentExtension(name);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'image') {
    const detected = payload ? sniffImageMediaType(payload) : null;
    if (detected) return detected;
    if (ext === 'jpg' || ext === 'jpeg' || declared === 'image/jpeg') return 'image/jpeg';
    if (ext === 'gif' || declared === 'image/gif') return 'image/gif';
    if (ext === 'webp' || declared === 'image/webp') return 'image/webp';
    return 'image/png';
  }
  if (kind === 'text') return declared || 'text/plain';
  const office: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
  };
  return office[officeFormat(name, declared)] ?? declared;
}

function validateSignature(kind: AttachmentKind, name: string, declared: string, buf: Buffer): string | null {
  const ext = attachmentExtension(name);
  if (kind === 'pdf') return buf.subarray(0, 5).toString('ascii') === '%PDF-' ? null : 'is not a valid PDF';
  if (kind === 'image') {
    const detected = sniffImageMediaType(buf);
    if (!detected) return 'does not match a supported image signature';
    const extensionType: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const expected = extensionType[ext]
      ?? (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(declared) ? declared : undefined);
    return expected && expected !== detected
      ? `content is ${detected}, which does not match ${expected}`
      : null;
  }
  if (kind === 'office') {
    if (officeFormat(name, declared) === 'rtf') {
      return buf.subarray(0, 5).toString('ascii').toLowerCase() === '{\\rtf' ? null : 'is not valid RTF';
    }
    const zip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && [0x03, 0x05, 0x07].includes(buf[2]!) && [0x04, 0x06, 0x08].includes(buf[3]!);
    return zip ? null : 'is not a valid Office/OpenDocument archive';
  }
  return null;
}

function sniffImageMediaType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function validatePdf(buf: Buffer): string | null {
  const latin = buf.toString('latin1');
  if (/\/Encrypt\b/.test(latin)) return 'is encrypted or password protected';
  const pages = latin.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  return pages > MAX_PDF_PAGES ? `has too many pages (max ${MAX_PDF_PAGES})` : null;
}

/** Read ZIP central-directory metadata without expanding any entry. */
function validateZipEnvelope(buf: Buffer, name: string, declared: string): string | null {
  let entries = 0;
  let compressedTotal = 0;
  let expandedTotal = 0;
  const entryNames: string[] = [];
  for (let i = 0; i + 46 <= buf.length;) {
    if (buf.readUInt32LE(i) !== 0x02014b50) {
      i++;
      continue;
    }
    const compressed = buf.readUInt32LE(i + 20);
    const expanded = buf.readUInt32LE(i + 24);
    if (compressed === 0xffffffff || expanded === 0xffffffff) return 'uses unsupported ZIP64 metadata';
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    entries++;
    compressedTotal += compressed;
    expandedTotal += expanded;
    entryNames.push(buf.subarray(i + 46, i + 46 + nameLen).toString('utf8').replace(/\\/g, '/').toLowerCase());
    if (entries > MAX_ZIP_ENTRIES) return `contains too many archive entries (max ${MAX_ZIP_ENTRIES})`;
    if (expandedTotal > MAX_ZIP_EXPANDED_BYTES) return 'expands beyond the 100 MB safety limit';
    i += 46 + nameLen + extraLen + commentLen;
  }
  if (entries === 0) return 'has no readable ZIP central directory';
  if (compressedTotal === 0 && expandedTotal > 0) return 'has inconsistent archive sizes';
  if (compressedTotal > 0 && expandedTotal / compressedTotal > MAX_ZIP_COMPRESSION_RATIO) {
    return `has a suspicious compression ratio (> ${MAX_ZIP_COMPRESSION_RATIO}:1)`;
  }
  const ext = officeFormat(name, declared);
  if (['docx', 'xlsx', 'pptx'].includes(ext)) {
    const root = ext === 'docx' ? 'word/' : ext === 'xlsx' ? 'xl/' : 'ppt/';
    if (!entryNames.includes('[content_types].xml') || !entryNames.some((entry) => entry.startsWith(root))) {
      return `does not contain the expected ${ext.toUpperCase()} document structure`;
    }
  } else if (['odt', 'ods', 'odp'].includes(ext)) {
    if (!entryNames.includes('mimetype') || !entryNames.includes('content.xml')) {
      return `does not contain the expected ${ext.toUpperCase()} document structure`;
    }
  }
  return null;
}

function officeFormat(name: string, declared: string): string {
  const ext = attachmentExtension(name);
  if (OFFICE_FORMATS.has(ext)) return ext;
  return OFFICE_MIME_FORMAT[declared] ?? '';
}

const OFFICE_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const OFFICE_MIME_FORMAT: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
};

function invalid(
  status: 400 | 413 | 415,
  code: string,
  error: string,
): Extract<AttachmentValidationResult, { ok: false }> {
  return { ok: false, status, code, error };
}
