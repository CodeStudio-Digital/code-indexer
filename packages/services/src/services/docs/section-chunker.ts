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

import { packSections } from './chunk-packer.js';

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
  /** Heading-level deep-link fragment (`{#id}` from the HTML→MD converter), or null. */
  anchor: string | null;
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
  const sections: { headingPath: string; anchor: string | null; lines: string[] }[] = [];
  const stack: string[] = [defaultRoot];
  let currentLines: string[] = [];
  // Anchor of the heading that opened the section currently being accumulated.
  let currentAnchor: string | null = null;

  const pushSection = () => {
    if (currentLines.length === 0) return;
    sections.push({ headingPath: stack.join(' > '), anchor: currentAnchor, lines: currentLines });
    currentLines = [];
  };

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      pushSection();
      const { level, text, anchor } = heading;
      // Pop stack to match the new level (level=1 → keep [root], replace top with text)
      while (stack.length > level) stack.pop();
      while (stack.length < level) stack.push(text);
      stack[stack.length - 1] = text;
      currentAnchor = anchor;
      continue;
    }
    currentLines.push(line);
  }
  pushSection();

  // Materialize chunks. Long sections are split by the code/table-aware packer
  // so a fenced block or table is never severed; fragments share heading + anchor.
  const chunks: SectionChunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    const body = sec.lines.join('\n').trim();
    if (body.length < MIN_CHUNK_CHARS) continue;
    for (const piece of packSections(body, maxChars)) {
      chunks.push({
        ord: ord++,
        heading_path: sec.headingPath,
        content: piece,
        token_count: estimateTokens(piece),
        anchor: sec.anchor,
      });
    }
  }
  return chunks;
}

function parseHeading(line: string): { level: number; text: string; anchor: string | null } | null {
  const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  let text = m[2]!.trim();
  let anchor: string | null = null;
  // Pandoc-style `{#id}` appended by the HTML→MD converter — pull it off the
  // heading TEXT and surface it as the section anchor for deep-link citations.
  const anchorMatch = /\s*\{#([^}]+)\}\s*$/.exec(text);
  if (anchorMatch) {
    anchor = anchorMatch[1]!.trim() || null;
    text = text.slice(0, anchorMatch.index).trim();
  }
  return { level: m[1]!.length, text, anchor };
}

/** Rough token estimate — char count divided by 4 (English-ish heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
