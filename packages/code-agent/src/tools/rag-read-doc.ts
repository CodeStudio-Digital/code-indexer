/**
 * rag_read_doc — full-content read of one indexed documentation section.
 *
 * `rag_search_docs` returns 480-char snippets; before this tool existed the
 * agent had no way to read the rest (a dead end unique to the doc corpus —
 * code search has read_file). It reads a bounded chunk page plus a preview of
 * the neighboring sections (same source, by `ord`) so multi-chunk passages
 * can be followed without re-searching.
 *
 * Shares the `setGlobalDocSearch` singleton with rag_search_docs — the
 * backend's optional `readChunk` verb backs this tool. Agent workers read
 * on their own SQLite connection, outside the Electron main process.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalDocSearch, type DocChunkNeighborRef, type DocSectionRead } from './rag-search-docs.js';
import { stripUnpairedSurrogates } from '@mcp/code-agent/core/text-boundaries.js';
import { docPageArgs } from './doc-page.js';
import { docPassageUri } from '@mcp/shared/doc-passage-uri.js';

/** Neighbor previews are capped — the agent reads them in full by chunk_id. */
const NEIGHBOR_PREVIEW_CHARS = 1_200;
export const ragReadDocTool: CoderTool = {
  name: 'rag_read_doc',
  description:
    'Read indexed documentation by chunk_id from rag_search_docs. Large chunks/sections are paginated; follow the next offsets to recover the remaining text.\n' +
    'Includes a preview of the previous/next sections of the same document.\n' +
    'USE: whenever a rag_search_docs snippet looks relevant but is cut off — never answer from a truncated snippet when the full section is one call away.\n' +
    'USE: to follow a passage across sections — neighbor previews carry their own chunk_id; call rag_read_doc on those to keep reading.\n' +
    "USE mode:'section' to reassemble a heading that was split into several chunks into ONE contiguous read (no neighbor previews).\n" +
    "DON'T: guess chunk_ids — they come from rag_search_docs output.",
  source: 'native',
  outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store' },
  parameters: {
    type: 'object',
    properties: {
      char_offset: { type: 'number', description: 'Chunk-mode offset in Unicode characters (default 0).' },
      max_chars: { type: 'number', description: 'Chunk-mode character limit (default 65536, max 200000).' },
      offset: { type: 'number', description: 'Section-mode chunk offset from the previous page (default 0).' },
      limit: { type: 'number', description: 'Section-mode chunks per page (default 32, max 64).' },
      chunk_id: {
        type: 'number',
        description: 'The chunk_id of the section to read, as printed by rag_search_docs.',
      },
      window: {
        type: 'number',
        description:
          "How many neighboring sections to preview on each side (same document). Default 1; clamped to [0, 3]. Ignored when mode='section'.",
      },
      mode: {
        type: 'string',
        enum: ['chunk', 'section'],
        description:
          "Default 'chunk': one content page + neighbor previews. 'section': a page of the heading's size-split parts; follow next offsets to read the whole section.",
      },
    },
    required: ['chunk_id'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const chunkId = Number(args.chunk_id);
    if (!Number.isSafeInteger(chunkId) || chunkId <= 0) {
      return err('chunk_id must be a positive number — take it from rag_search_docs results.');
    }
    const backend = getGlobalDocSearch();
    if (!backend) {
      return err(
        'rag_read_doc is not configured: the doc corpus backend is not wired into this process. Ask the user to ensure the Documentação feature is enabled.',
      );
    }

    // ── Whole-section mode ────────────────────────────────────────────
    if (args.mode === 'section') {
      const page = docPageArgs(args, 32, 64); if ('error' in page) return page.error;
      if (!backend.readSection) {
        return err("section mode is not available in this process — call rag_read_doc without mode to read this chunk + neighbors.");
      }
      let section;
      try {
        ctx.signal?.throwIfAborted();
        section = await backend.readSection({ chunk_id: chunkId, ...page }, ctx.signal);
        ctx.signal?.throwIfAborted();
      } catch (e) {
        return err(`doc section read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!section) {
        return err(
          `No doc chunk with id ${chunkId} — it may have been re-indexed since the search. Run rag_search_docs again for fresh chunk_ids.`,
        );
      }
      const partial = section.chunks.filter(c => c.next_char_offset != null);
      return { content: renderSection(section), ...((section.next_offset != null || section.offset || partial.length) ? { sourceTruncations: [
        ...(partial.length ? [{ technique: 'rag-section-content',
          inputSize: partial.reduce((sum, c) => sum + (c.content_length ?? c.content.length), 0),
          outputSize: partial.reduce((sum, c) => sum + [...c.content].length, 0), unit: 'chars' as const, recoverable: true }] : []),
        ...((section.next_offset != null || section.offset) ? [{
        technique: 'rag-section-page', inputSize: (section.offset ?? 0) + section.chunks.length + (section.next_offset != null ? 1 : 0), inputSizeExact: section.next_offset == null,
        outputSize: section.chunks.length, unit: 'items' as const, recoverable: true }] : [])] } : {}) };
    }

    if (!backend.readChunk) {
      return err(
        'rag_read_doc is not available in this process (backend without readChunk). Use the rag_search_docs snippets instead.',
      );
    }
    const rawWindow = Number(args.window);
    const window = Number.isFinite(rawWindow) ? Math.max(0, Math.min(3, Math.trunc(rawWindow))) : 1;
    const chars = docPageArgs({ offset: args.char_offset, limit: args.max_chars }, 65536, 200000);
    if ('error' in chars) return chars.error;

    let read;
    try {
      ctx.signal?.throwIfAborted();
      read = await backend.readChunk({ chunk_id: chunkId, window, char_offset: chars.offset, max_chars: chars.limit }, ctx.signal);
      ctx.signal?.throwIfAborted();
    } catch (e) {
      return err(`doc read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!read) {
      return err(
        `No doc chunk with id ${chunkId} — it may have been re-indexed since the search. Run rag_search_docs again for fresh chunk_ids.`,
      );
    }

    const { chunk, prev, next } = read;
    const lines: string[] = [];
    lines.push(`# ${chunk.heading_path ?? '(untitled)'} — ${chunk.collection}`);
    if (chunk.source_uri) lines.push(`Source: ${docPassageUri(chunk.source_uri, chunk.anchor)}`);
    if (chunk.api_signature) lines.push(`Signature: ${chunk.api_signature}`);
    else if (chunk.api_symbol) lines.push(`Symbol: ${chunk.api_symbol}`);
    lines.push(`chunk_id: ${chunk.chunk_id} · ~${chunk.token_count} tokens`);
    if (chunk.concepts.length > 0) lines.push(`Concepts: ${chunk.concepts.join(', ')}`);

    for (const n of prev) lines.push('', renderNeighbor(n, 'Previous', chunk.source_uri));
    lines.push('', chunk.next_char_offset != null || chunk.char_offset ? '─── Content page ───' : '─── Section (full) ───', chunk.content.trim());
    if (chunk.next_char_offset != null) lines.push(`\nContinue: rag_read_doc({chunk_id:${chunk.chunk_id},char_offset:${chunk.next_char_offset}}).`);
    for (const n of next) lines.push('', renderNeighbor(n, 'Next', chunk.source_uri));

    const cappedNeighbors = [...prev, ...next]
      .filter((neighbor) => (neighbor.content_length ?? neighbor.content.length) > NEIGHBOR_PREVIEW_CHARS);
    return {
      content: lines.join('\n'),
      ...(cappedNeighbors.length > 0 || chunk.next_char_offset != null || chunk.char_offset
        ? {
            sourceTruncations: [...(chunk.next_char_offset != null || chunk.char_offset ? [{
              technique: 'rag-chunk-page', inputSize: chunk.content_length ?? chunk.content.length,
              outputSize: [...chunk.content].length, unit: 'chars' as const, recoverable: true,
            }] : []), ...(cappedNeighbors.length ? [{
              technique: 'rag-neighbor-preview',
              inputSize: cappedNeighbors.reduce((sum, neighbor) => sum + (neighbor.content_length ?? neighbor.content.length), 0),
              outputSize: cappedNeighbors.reduce(
                (sum, neighbor) => sum + neighborPreviewPrefix(neighbor.content).length,
                0,
              ),
              unit: 'chars' as const,
              recoverable: true,
            }] : [])],
          }
        : {}),
    };
  },
};

function renderNeighbor(
  n: DocChunkNeighborRef,
  label: 'Previous' | 'Next',
  mainUri: string | null,
): string {
  const truncated = (n.content_length ?? n.content.length) > NEIGHBOR_PREVIEW_CHARS;
  const body = truncated ? neighborPreviewPrefix(n.content) + '…' : n.content;
  const tail = truncated ? `\n[truncated — rag_read_doc({chunk_id: ${n.chunk_id}}) for the rest]` : '';
  // Neighbors are by ord within the SOURCE, which on a multi-page crawl can
  // cross a page boundary — flag that so the agent doesn't treat it as part
  // of the same page's flow.
  const otherPage = n.source_uri && n.source_uri !== mainUri ? `\n(different page: ${n.source_uri})` : '';
  return `─── ${label} section — chunk_id ${n.chunk_id}${n.heading_path ? ` (${n.heading_path})` : ''} ───${otherPage}\n${body.trim()}${tail}`;
}

function neighborPreviewPrefix(content: string): string {
  return stripUnpairedSurrogates(content.slice(0, NEIGHBOR_PREVIEW_CHARS));
}

/** Render a whole-section read (mode:'section') — all size-split parts joined. */
function renderSection(sec: DocSectionRead): string {
  const lines: string[] = [];
  lines.push(`# ${sec.heading_path ?? '(untitled)'} — ${sec.collection} [${sec.next_offset != null || sec.offset || sec.chunks.some(c => c.next_char_offset != null) ? 'section page' : 'full section'}]`);
  if (sec.source_uri) lines.push(`Source: ${docPassageUri(sec.source_uri, sec.anchor)}`);
  if (sec.api_signature) lines.push(`Signature: ${sec.api_signature}`);
  else if (sec.api_symbol) lines.push(`Symbol: ${sec.api_symbol}`);
  lines.push(
    `${sec.chunks.length} chunk(s) · ~${sec.total_tokens} tokens${sec.doc_type ? ` · ${sec.doc_type}` : ''}`,
  );
  lines.push('', sec.chunks.map(c => c.content.trim() + (c.next_char_offset == null ? '' :
    `\n[Chunk continues: rag_read_doc({chunk_id:${c.chunk_id},char_offset:${c.next_char_offset}}).]`)).join('\n\n'));
  if (sec.next_offset != null) lines.push(`\nContinue section: rag_read_doc({chunk_id:${sec.chunks[0]?.chunk_id},mode:"section",offset:${sec.next_offset}}).`);
  return lines.join('\n');
}

export const ragReadDocTools: CoderTool[] = [ragReadDocTool];
