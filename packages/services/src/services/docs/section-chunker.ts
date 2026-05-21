/**
 * Section-aware chunker for Markdown documentation.
 *
 * Splits on heading boundaries (`#`, `##`, `###`) and packs the body of each
 * section into chunks of at most `MAX_TOKENS` (rough char-based estimate;
 * good enough for the relevance gate's purposes — exact tokenization happens
 * later inside the embedder).
 *
 * Each emitted chunk carries:
 *   - `heading_path`: " > "-joined heading ancestry ("Guide > Components > Button")
 *   - `content`:     the section body (trimmed, paragraph-preserving)
 *   - `ord`:         monotonic ordinal so neighbor hydration can reconstruct context
 */

/** Approximate cap per chunk — ~1500 tokens × 4 chars/token. */
export const MAX_CHUNK_CHARS = 6_000;
/** Don't emit chunks shorter than this — they're almost never useful retrieval units. */
export const MIN_CHUNK_CHARS = 60;

export interface SectionChunk {
  ord: number;
  heading_path: string;
  content: string;
  /** Coarse-grained token estimate. Embedder may recompute. */
  token_count: number;
}

export interface ChunkOptions {
  /** Default name when the document has no `<h1>` (e.g. PDF page-only docs). */
  defaultRootTitle?: string;
  /** Override the per-chunk char cap. */
  maxChars?: number;
}

/**
 * Convert a markdown document into a stream of section-aware chunks.
 * Chunks larger than `maxChars` are split at paragraph boundaries; the
 * resulting fragments share the same `heading_path`.
 */
export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): SectionChunk[] {
  const maxChars = opts.maxChars ?? MAX_CHUNK_CHARS;
  const defaultRoot = opts.defaultRootTitle ?? 'Document';

  const lines = markdown.split(/\r?\n/);
  const sections: { headingPath: string; lines: string[] }[] = [];
  const stack: string[] = [defaultRoot];
  let currentLines: string[] = [];

  const pushSection = () => {
    if (currentLines.length === 0) return;
    sections.push({ headingPath: stack.join(' > '), lines: currentLines });
    currentLines = [];
  };

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      pushSection();
      const { level, text } = heading;
      // Pop stack to match the new level (level=1 → keep [root], replace top with text)
      while (stack.length > level) stack.pop();
      while (stack.length < level) stack.push(text);
      stack[stack.length - 1] = text;
      continue;
    }
    currentLines.push(line);
  }
  pushSection();

  // Materialize chunks, splitting overly long sections at paragraph boundaries.
  const chunks: SectionChunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    const body = sec.lines.join('\n').trim();
    if (body.length < MIN_CHUNK_CHARS) continue;
    for (const piece of splitByParagraphs(body, maxChars)) {
      chunks.push({
        ord: ord++,
        heading_path: sec.headingPath,
        content: piece,
        token_count: estimateTokens(piece),
      });
    }
  }
  return chunks;
}

function parseHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1]!.length, text: m[2]!.trim() };
}

/**
 * Split `body` into pieces of at most `maxChars`, breaking at paragraph
 * boundaries (`\n\n`). If a single paragraph itself exceeds `maxChars`,
 * it's hard-split into char windows.
 */
function splitByParagraphs(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body];
  const paragraphs = body.split(/\n{2,}/);
  const pieces: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length <= maxChars) {
      buf = candidate;
      continue;
    }
    if (buf) pieces.push(buf);
    if (p.length <= maxChars) {
      buf = p;
    } else {
      // Pathological single paragraph — hard-split.
      for (let i = 0; i < p.length; i += maxChars) {
        pieces.push(p.slice(i, i + maxChars));
      }
      buf = '';
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

/** Rough token estimate — char count divided by 4 (English-ish heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
