/**
 * attachment-extract — server-side text (and embedded-image) extraction for
 * document attachments BEFORE they become model blocks.
 *
 * Why this exists: every provider adapter (anthropic/gemini/chatgpt/openai/
 * kimi/bedrock) only serializes a DocumentBlock's `text` field (PDF base64 is
 * the lone exception, native on Anthropic/Gemini). A base64 Office/OpenDocument
 * file (docx/xlsx/pptx/odt/ods/odp/rtf) is therefore SILENTLY DROPPED — the
 * model never sees it. Here we decode those formats to plain text up-front so
 * the existing `<document>…</document>` serialization carries them across EVERY
 * provider, with zero adapter changes.
 *
 * Embedded images (`opts.extractImages`): when the active model can see images,
 * we also pull the figures out of the document and emit them as separate image
 * attachments → `attachmentsToBlocks` turns each into an `ImageBlock`, which the
 * model reads natively (or the vision-fallback describes). Mirrors how Anthropic
 * handles a PDF (text + page images). Off when the model is blind, to avoid
 * surprise vision-fallback cost.
 *
 * Format routing (see `extractAttachmentText`):
 *   - image/*                          → passthrough (vision path owns it)
 *   - already has `text`               → passthrough
 *   - docx/xlsx/pptx/odt/ods/odp/rtf   → officeparser → text (+ images) ; base64 cleared
 *   - pdf                              → passthrough base64 (Anthropic native)
 *   - any other base64                 → passthrough (let the adapter decide)
 *
 * officeparser is pure JS (no native deps; OCR is off, so no tesseract workers).
 * The dynamic `import()` keeps it off the cold-start path for sessions that
 * never attach a document — same pattern as `pdf-parser.ts`.
 */

import { parsePdf } from './pdf-parser.js';

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

export interface ExtractOptions {
  /** Pull embedded figures out as image attachments (vision models only). */
  extractImages?: boolean;
  /**
   * Extract PDF text server-side and DROP the base64. Set by the route for
   * providers whose adapter does NOT render a base64 PDF (everyone except
   * Anthropic/Gemini), so the model gets `<document>text</document>` instead of
   * a silently-dropped block — and we don't keep dead base64 in history.
   */
  extractPdfText?: boolean;
}

/** Raw decoded ceiling. Above this we skip parsing (OOM / abuse guard). */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Extracted-text cap — a huge spreadsheet must not blow up the context. */
export const ATTACHMENT_MAX_TEXT_CHARS = 200_000;
/** Embedded-image guards: only raster the providers can see, skip icons, cap. */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_MIN_BYTES = 4 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_DOC = 6;

const PARSEABLE_EXTS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const PARSEABLE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
]);

/**
 * Provider kinds whose chat adapter natively renders a base64 PDF
 * (`anthropic.ts` document source / `gemini.ts` inlineData). For every other
 * provider the PDF base64 block is silently dropped, so the route must extract
 * the text instead. Default (unknown kind) → NOT native → extract (safe).
 */
const PDF_NATIVE_KINDS = new Set(['anthropic', 'claude-code', 'gemini', 'google-oauth']);

/** True when the provider's adapter reads a base64 PDF directly. */
export function pdfHandledNatively(providerKind?: string | null): boolean {
  return PDF_NATIVE_KINDS.has((providerKind ?? '').toLowerCase());
}

/**
 * Extract a single attachment into one OR MORE normalized attachments: the
 * text document plus, when `extractImages` is set, its embedded figures.
 * Best-effort: a parse failure produces a short `text` note (never a throw, and
 * never a silent drop).
 */
export async function extractAttachmentText(
  att: RawAttachment,
  opts?: ExtractOptions,
): Promise<NormalizedAttachment[]> {
  const name = att.name && att.name.trim() ? att.name : 'attachment';
  // Nothing to decode: an image, a pre-decoded text file, or no payload.
  if (att.text != null || att.mediaType.startsWith('image/') || !att.base64) {
    return [{ name, mediaType: att.mediaType, base64: att.base64, text: att.text }];
  }

  const ext = extOf(name);

  // PDF — provider-aware. Native providers (Anthropic/Gemini) keep the base64
  // and read it directly. Everyone else can't, so extract the text via unpdf
  // and DROP the base64 (don't carry a block the model will never read).
  if (att.mediaType === 'application/pdf' || ext === 'pdf') {
    if (!opts?.extractPdfText) {
      return [{ name, mediaType: att.mediaType, base64: att.base64 }];
    }
    if (Math.floor((att.base64.length * 3) / 4) > ATTACHMENT_MAX_BYTES) {
      return [note(name, att.mediaType, `too large (> ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB)`)];
    }
    try {
      const text = truncate((await parsePdfText(att.base64, name)).trim());
      return text
        ? [{ name, mediaType: att.mediaType, text }]
        : [note(name, att.mediaType, 'no extractable text (scanned PDF without a text layer?)')];
    } catch (err) {
      return [note(name, att.mediaType, err instanceof Error ? err.message : 'pdf parse failed')];
    }
  }

  const parseable = PARSEABLE_EXTS.has(ext) || PARSEABLE_MIME.has(att.mediaType);
  // Unknown binaries pass through untouched.
  if (!parseable) {
    return [{ name, mediaType: att.mediaType, base64: att.base64 }];
  }

  // Estimate decoded size from the base64 length BEFORE allocating the buffer,
  // so an oversized payload is skipped without the large heap allocation.
  if (Math.floor((att.base64.length * 3) / 4) > ATTACHMENT_MAX_BYTES) {
    return [note(name, att.mediaType, `too large (> ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB)`)];
  }
  const buf = Buffer.from(att.base64, 'base64');

  try {
    const { text: raw, images } = await parseOffice(buf, opts?.extractImages === true);
    const parts: NormalizedAttachment[] = [];
    const text = truncate(raw.trim());
    // Drop the base64: the model reads the extracted text, not the zip bytes.
    if (text) parts.push({ name, mediaType: att.mediaType, text });
    parts.push(...imageAttachmentsFrom(name, images));
    return parts.length ? parts : [note(name, att.mediaType, 'no extractable content')];
  } catch (err) {
    return [note(name, att.mediaType, err instanceof Error ? err.message : 'parse failed')];
  }
}

/**
 * Normalize a whole attachment array for the model. Preserves `undefined`
 * (callers forward it verbatim). Per-item failures degrade to a passthrough
 * rather than failing the batch. The result is flattened — one document may
 * expand into a text part plus several image parts.
 */
export async function normalizeAttachmentsForModel<T extends RawAttachment>(
  atts: ReadonlyArray<T> | undefined,
  opts?: ExtractOptions,
): Promise<NormalizedAttachment[] | undefined> {
  if (!atts || atts.length === 0) return undefined;
  const groups = await Promise.all(
    atts.map((a) =>
      extractAttachmentText(a, opts).catch(() => [
        {
          name: a.name && a.name.trim() ? a.name : 'attachment',
          mediaType: a.mediaType,
          base64: a.base64,
          text: a.text,
        } as NormalizedAttachment,
      ]),
    ),
  );
  return groups.flat();
}

// ─── helpers ─────────────────────────────────────────────────────────

interface OfficeImage {
  type: 'image' | 'chart';
  mimeType: string;
  data: string;
  name?: string;
}

type OfficeParseFn = (
  input: Buffer,
  config?: { extractAttachments?: boolean; outputErrorToConsole?: boolean },
) => Promise<{ toText(): string; attachments?: OfficeImage[] }>;

async function parseOffice(
  buf: Buffer,
  withImages: boolean,
): Promise<{ text: string; images: OfficeImage[] }> {
  const mod = (await import('officeparser')) as unknown as {
    parseOffice?: OfficeParseFn;
    default?: { parseOffice?: OfficeParseFn };
  };
  const fn = mod.parseOffice ?? mod.default?.parseOffice;
  if (!fn) throw new Error('officeparser: parseOffice unavailable');
  const ast = await fn(buf, { extractAttachments: withImages, outputErrorToConsole: false });
  const text = typeof ast?.toText === 'function' ? ast.toText() : '';
  const images = withImages
    ? (ast.attachments ?? []).filter((a) => a.type === 'image')
    : [];
  return { text, images };
}

/** Decode a base64 PDF and join its per-page text via the shared `parsePdf`. */
async function parsePdfText(base64: string, name: string): Promise<string> {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  const pages = await parsePdf(bytes, { sourceId: 0, sourceUri: name, titleHint: name });
  return pages.map((p) => p.markdown).join('\n\n');
}

/** Filter embedded figures to vision-readable rasters, skip icons, cap count. */
function imageAttachmentsFrom(docName: string, images: OfficeImage[]): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const img of images) {
    if (out.length >= MAX_IMAGES_PER_DOC) break;
    if (!IMAGE_MIME.has(img.mimeType) || !img.data) continue;
    const bytes = Math.floor((img.data.length * 3) / 4);
    if (bytes < IMAGE_MIN_BYTES || bytes > IMAGE_MAX_BYTES) continue;
    out.push({
      name: `${docName} › ${img.name && img.name.trim() ? img.name : `image${out.length + 1}`}`,
      mediaType: img.mimeType,
      base64: img.data,
    });
  }
  return out;
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
