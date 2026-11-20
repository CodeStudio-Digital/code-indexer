/**
 * PDF parsing — wraps `unpdf` (modern, serverless-friendly, no native deps)
 * to extract per-page text and the document outline (when present).
 *
 * Output: an array of `RawPage` ready to feed the relevance gate + chunker.
 * Each page is a separate candidate so the gate can drop noisy pages (TOC,
 * index, copyright) without losing the rest.
 */
import type { RawPage } from './types.js';

/** 50 MB hard cap to protect the indexer from OOM on malicious PDFs. */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;

export interface ParsePdfOptions {
  /** Stable identifier of the source row — used in the candidate URI. */
  sourceId: number;
  /** Original URI of the PDF (file path or remote URL). Stored on each page. */
  sourceUri: string;
  /** Title hint (file name without extension). Replaces page title fallback. */
  titleHint?: string;
}

/**
 * Parse a PDF byte buffer into a list of `RawPage`. Throws if the buffer
 * exceeds `PDF_MAX_BYTES`.
 *
 * Page title resolution order:
 *   1. PDF outline node whose `dest` lands on this page (when available)
 *   2. First non-empty line of the page text
 *   3. `${titleHint} — page N`
 */
export async function parsePdf(bytes: Uint8Array, opts: ParsePdfOptions): Promise<RawPage[]> {
  if (bytes.byteLength > PDF_MAX_BYTES) {
    throw new Error(`PDF too large: ${bytes.byteLength} bytes (max ${PDF_MAX_BYTES})`);
  }

  // Dynamic import keeps unpdf out of the cold-start path for users who
  // never touch the docs feature.
  const { extractText, getDocumentProxy } = await import('unpdf');

  const pdf = await getDocumentProxy(bytes);
  const totalPages = pdf.numPages;

  const outlineTitles = await safeExtractOutlineTitles(pdf);

  // `extractText({ mergePages: false })` returns an array of per-page strings.
  // Some unpdf versions return `{ text: string[] }` shape — handle both.
  const extracted = await extractText(pdf, { mergePages: false });
  const perPageRaw: string[] = normalizeExtractedText(extracted, totalPages);

  const pages: RawPage[] = [];
  for (let i = 0; i < totalPages; i++) {
    const raw = (perPageRaw[i] ?? '').trim();
    const pageNumber = i + 1;
    const title = outlineTitles.get(pageNumber) ?? firstNonEmptyLine(raw) ?? `${opts.titleHint ?? 'Page'} — p.${pageNumber}`;
    const body = paragraphsToMarkdown(raw);
    // Very short extracted pages still have an independently citable parent page.
    const markdown = body && body.length < 500
      ? '# ' + (outlineTitles.get(pageNumber) ?? opts.titleHint ?? 'Page ' + pageNumber) + '\n\n' + body
      : body;
    const folderPage = opts.sourceUri.startsWith('folder://') && opts.sourceUri.includes('#file=');
    const uri = folderPage
      ? opts.sourceUri + '&page=' + pageNumber
      : opts.sourceUri.split('#', 1)[0] + '#page=' + pageNumber;
    pages.push({
      candidateId: folderPage ? uri : `pdf://${opts.sourceId}#page=${pageNumber}`,
      uri,
      title,
      markdown,
      source: 'pdf',
      bytes: raw.length,
      ...(raw ? {} : { extraction_gap: 'no_extractable_text' as const }),
    });
  }
  return pages;
}

function normalizeExtractedText(extracted: unknown, totalPages: number): string[] {
  // unpdf returns `{ text: string | string[], totalPages }` depending on the version.
  if (extracted && typeof extracted === 'object' && 'text' in extracted) {
    const t = (extracted as { text: unknown }).text;
    if (Array.isArray(t)) return t.map((s) => (typeof s === 'string' ? s : ''));
    if (typeof t === 'string') {
      // Single concatenated string with mergePages=false should still be split;
      // if the lib gave us one string, treat it as a single page.
      return [t];
    }
  }
  // Pad to totalPages so callers can rely on length.
  return new Array(totalPages).fill('');
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length >= 3 && trimmed.length <= 200) return trimmed;
  }
  return null;
}

/**
 * Cheap, opinionated text→markdown converter. PDFs lose all structure; we
 * just collapse multi-line wraps and preserve paragraph breaks. Section
 * detection is left to the chunker.
 */
function paragraphsToMarkdown(raw: string): string {
  const paragraphs = raw
    .split(/\n{2,}/)
    .map((p) => p.split(/\n/).map((l) => l.trim()).join(' ').trim())
    .filter((p) => p.length > 0);
  return paragraphs.join('\n\n');
}

interface PdfOutlineItem {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
}

interface PdfDocumentProxy {
  numPages: number;
  getOutline(): Promise<PdfOutlineItem[] | null>;
  getDestination?(dest: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
}

/**
 * Best-effort outline → page-number map. Returns an empty Map if the PDF
 * has no outline or the API throws — outline extraction is a nice-to-have,
 * not a blocker.
 */
async function safeExtractOutlineTitles(pdf: PdfDocumentProxy): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const outline = await pdf.getOutline?.();
    if (!outline || outline.length === 0) return out;
    await walkOutline(outline, pdf, out);
  } catch {
    /* outline unavailable — fall through to first-line heuristic */
  }
  return out;
}

async function walkOutline(
  items: PdfOutlineItem[],
  pdf: PdfDocumentProxy,
  out: Map<number, string>,
): Promise<void> {
  for (const item of items) {
    if (item.title && item.dest) {
      const page = await resolveDestinationPage(item.dest, pdf);
      if (page && !out.has(page)) out.set(page, item.title.trim());
    }
    if (item.items && item.items.length > 0) {
      await walkOutline(item.items, pdf, out);
    }
  }
}

async function resolveDestinationPage(
  dest: unknown,
  pdf: PdfDocumentProxy,
): Promise<number | null> {
  try {
    let arr: unknown[] | null = null;
    if (Array.isArray(dest)) arr = dest;
    else if (typeof dest === 'string' && pdf.getDestination) {
      arr = await pdf.getDestination(dest);
    }
    if (!arr || arr.length === 0 || !pdf.getPageIndex) return null;
    const ref = arr[0];
    const idx = await pdf.getPageIndex(ref);
    return idx + 1;
  } catch {
    return null;
  }
}
