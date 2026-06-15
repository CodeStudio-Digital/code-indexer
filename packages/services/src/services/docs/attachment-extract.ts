/**
 * attachment-extract — server-side text extraction for document attachments
 * BEFORE they become model `DocumentBlock`s.
 *
 * Why this exists: every provider adapter (anthropic/gemini/chatgpt/openai/
 * kimi/bedrock) only serializes a DocumentBlock's `text` field (PDF base64 is
 * the lone exception, native on Anthropic/Gemini). A base64 Office/OpenDocument
 * file (docx/xlsx/pptx/odt/ods/odp) is therefore SILENTLY DROPPED — the model
 * never sees it. Here we decode those formats to plain text up-front so the
 * existing `<document>…</document>` serialization carries them across EVERY
 * provider, with zero adapter changes.
 *
 * Format routing (see `extractAttachmentText`):
 *   - image/*                       → passthrough (vision path owns it)
 *   - already has `text`            → passthrough
 *   - docx/xlsx/pptx/odt/ods/odp    → officeparser → text (base64 cleared)
 *   - rtf                           → minimal control-word stripper
 *   - pdf                           → passthrough base64 (Anthropic native)
 *   - any other base64              → passthrough (let the adapter decide)
 *
 * officeparser is pure JS (no native deps). The dynamic `import()` keeps it off
 * the cold-start path for sessions that never attach a document — same pattern
 * as `pdf-parser.ts`.
 */

/** Loose input shape — matches CoderAttachment / company AttachmentBody. */
export interface RawAttachment {
  name?: string;
  mediaType: string;
  base64?: string;
  text?: string;
}

/** Normalized output — `name` always present so it slots into DocumentBlock. */
export interface NormalizedAttachment {
  name: string;
  mediaType: string;
  base64?: string;
  text?: string;
}

/** Raw decoded ceiling. Above this we skip parsing (OOM / abuse guard). */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Extracted-text cap — a huge spreadsheet must not blow up the context. */
export const ATTACHMENT_MAX_TEXT_CHARS = 200_000;

const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
const OFFICE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

/**
 * Extract text from a single document attachment, returning a normalized one.
 * Best-effort: a parse failure produces a short `text` note (never a throw, and
 * never a silent drop) so the model knows a file was attached but unreadable.
 */
export async function extractAttachmentText(att: RawAttachment): Promise<NormalizedAttachment> {
  const name = att.name && att.name.trim() ? att.name : 'attachment';
  // Nothing to decode: an image, a pre-decoded text file, or no payload.
  if (att.text != null || att.mediaType.startsWith('image/') || !att.base64) {
    return { name, mediaType: att.mediaType, base64: att.base64, text: att.text };
  }

  const ext = extOf(name);
  const isOffice = OFFICE_EXTS.has(ext) || OFFICE_MIME.has(att.mediaType);
  const isRtf = ext === 'rtf' || att.mediaType === 'application/rtf' || att.mediaType === 'text/rtf';
  // PDFs (Anthropic-native) and unknown binaries pass through untouched.
  if (!isOffice && !isRtf) {
    return { name, mediaType: att.mediaType, base64: att.base64 };
  }

  const buf = Buffer.from(att.base64, 'base64');
  if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
    return note(name, att.mediaType, `too large (> ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB)`);
  }

  try {
    const raw = isRtf ? stripRtf(buf.toString('latin1')) : await parseOffice(buf);
    const text = truncate(raw.trim());
    // Drop the base64: the model reads the extracted text, not the zip bytes.
    return text
      ? { name, mediaType: att.mediaType, text }
      : note(name, att.mediaType, 'no extractable text');
  } catch (err) {
    return note(name, att.mediaType, err instanceof Error ? err.message : 'parse failed');
  }
}

/**
 * Normalize a whole attachment array for the model. Preserves `undefined`
 * (callers forward it verbatim). Per-item failures degrade to a note rather
 * than failing the batch.
 */
export async function normalizeAttachmentsForModel<T extends RawAttachment>(
  atts: ReadonlyArray<T> | undefined,
): Promise<NormalizedAttachment[] | undefined> {
  if (!atts || atts.length === 0) return undefined;
  return Promise.all(
    atts.map((a) =>
      extractAttachmentText(a).catch(() => ({
        name: a.name && a.name.trim() ? a.name : 'attachment',
        mediaType: a.mediaType,
        base64: a.base64,
        text: a.text,
      })),
    ),
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

async function parseOffice(buf: Buffer): Promise<string> {
  const mod = (await import('officeparser')) as unknown as {
    parseOfficeAsync?: (input: Buffer) => Promise<string>;
    default?: { parseOfficeAsync?: (input: Buffer) => Promise<string> };
  };
  const fn = mod.parseOfficeAsync ?? mod.default?.parseOfficeAsync;
  if (!fn) throw new Error('officeparser: parseOfficeAsync unavailable');
  const result = await fn(buf);
  return typeof result === 'string' ? result : String(result ?? '');
}

/**
 * Minimal RTF → text (officeparser does not handle rtf). Strips control words,
 * groups and braces — good enough to surface the prose; loses tables/styling.
 */
function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'[0-9a-fA-F]{2}/g, '')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text: string): string {
  if (text.length <= ATTACHMENT_MAX_TEXT_CHARS) return text;
  return `${text.slice(0, ATTACHMENT_MAX_TEXT_CHARS)}\n\n[… truncated at ${ATTACHMENT_MAX_TEXT_CHARS} chars]`;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function note(name: string, mediaType: string, reason: string): NormalizedAttachment {
  return { name, mediaType, text: `[attachment "${name}" could not be read: ${reason}]` };
}
