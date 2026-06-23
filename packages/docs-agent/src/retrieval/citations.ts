/**
 * Citation utilities — extract footnote markers from synthesized markdown
 * and map them back to chunk ids.
 *
 * The synthesize tool emits markdown with footnotes like `[^1]`, `[^2]`,
 * where N is the 1-based index into the chunk array passed to the tool.
 * We extract the unique N values to compute the final `chunks_cited`
 * list — this is what gets persisted on `docs_research_sessions
 * .final_chunk_ids_json` and surfaced to the caller.
 */
import type { DocChunk } from '@mcp/store/doc-store.js';

/** Match `[^123]` markers. The pattern intentionally excludes `[^a]` etc. */
const FOOTNOTE_RE = /\[\^(\d+)\]/g;

/**
 * Walk the markdown and return the unique 1-based footnote indices,
 * in the order they first appear. Useful when the synthesizer is sloppy
 * and the caller wants to render footnotes in citation order.
 */
export function extractCitedIndices(markdown: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const match of markdown.matchAll(FOOTNOTE_RE)) {
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n < 1) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Map cited footnote indices back to chunk ids. Indices out of range are
 * silently dropped (defensive — the synthesizer occasionally fabricates
 * [^99] markers when it loses track of how many passages it received).
 */
export function resolveCitedChunkIds(markdown: string, chunks: DocChunk[]): number[] {
  const indices = extractCitedIndices(markdown);
  const out: number[] = [];
  for (const idx of indices) {
    const chunk = chunks[idx - 1]; // 1-based to 0-based
    if (chunk) out.push(chunk.id);
  }
  return out;
}

/**
 * Build a single citation line for a chunk (used by the docs_finish payload
 * preview surfaced in the dashboard timeline).
 */
export function formatCitation(chunk: DocChunk, footnoteIndex: number): string {
  const heading = chunk.heading_path ?? '(untitled)';
  const source = chunk.source_uri ?? '(local)';
  return `[^${footnoteIndex}]: \`${heading}\` — ${source}`;
}

/**
 * Build a complete bibliography section for a list of chunks. Emitted at
 * the end of the synthesized markdown by the synthesis prompt. Useful
 * when the caller wants to render a separate "Sources" panel.
 */
export function buildBibliography(chunks: DocChunk[]): string {
  if (chunks.length === 0) return '';
  return chunks.map((c, i) => formatCitation(c, i + 1)).join('\n');
}
