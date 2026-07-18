/**
 * rag_read_doc — full-content read of one indexed documentation section.
 *
 * `rag_search_docs` returns 480-char snippets; before this tool existed the
 * agent had no way to read the rest (a dead end unique to the doc corpus —
 * code search has read_file). It reads ONE chunk in full plus a preview of
 * the neighboring sections (same source, by `ord`) so multi-chunk passages
 * can be followed without re-searching.
 *
 * Shares the `setGlobalDocSearch` singleton with rag_search_docs — the
 * backend's optional `readChunk` verb backs this tool, and worker threads
 * reach it over the same MessageBridge shim (`docReadChunk`).
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getGlobalDocSearch, type DocChunkNeighborRef, type DocSectionRead } from './rag-search-docs.js';
import { stripUnpairedSurrogates } from '@mcp/code-agent/core/text-boundaries.js';

/** Neighbor previews are capped — the agent reads them in full by chunk_id. */
const NEIGHBOR_PREVIEW_CHARS = 1_200;
export const ragReadDocTool: CoderTool = {
  name: 'rag_read_doc',
  description:
    'Read one indexed documentation section IN FULL by chunk_id from rag_search_docs results.\n' +
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
          "Default 'chunk': this section + neighbor previews. 'section': the WHOLE heading reassembled from all its size-split parts (use when one section spans several chunks).",
      },
    },
    required: ['chunk_id'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  handler: async (args, _ctx: ToolContext): Promise<ToolResult> => {
    const chunkId = Number(args.chunk_id);
    if (!Number.isFinite(chunkId) || chunkId <= 0) {
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
      if (!backend.readSection) {
        return err("section mode is not available in this process — call rag_read_doc without mode to read this chunk + neighbors.");
      }
      let section;
      try {
        section = await backend.readSection({ chunk_id: chunkId });
      } catch (e) {
        return err(`doc section read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!section) {
        return err(
          `No doc chunk with id ${chunkId} — it may have been re-indexed since the search. Run rag_search_docs again for fresh chunk_ids.`,
        );
      }
      return ok(renderSection(section));
    }

    if (!backend.readChunk) {
      return err(
        'rag_read_doc is not available in this process (backend without readChunk). Use the rag_search_docs snippets instead.',
      );
    }
    const rawWindow = Number(args.window);
    const window = Number.isFinite(rawWindow) ? Math.max(0, Math.min(3, Math.trunc(rawWindow))) : 1;

    let read;
    try {
      read = await backend.readChunk({ chunk_id: chunkId, window });
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
    if (chunk.source_uri) lines.push(`Source: ${chunk.source_uri}${chunk.anchor ? `#${chunk.anchor}` : ''}`);
    if (chunk.api_signature) lines.push(`Signature: ${chunk.api_signature}`);
    else if (chunk.api_symbol) lines.push(`Symbol: ${chunk.api_symbol}`);
    lines.push(`chunk_id: ${chunk.chunk_id} · ~${chunk.token_count} tokens`);
    if (chunk.concepts.length > 0) lines.push(`Concepts: ${chunk.concepts.join(', ')}`);

    for (const n of prev) lines.push('', renderNeighbor(n, 'Previous', chunk.source_uri));
    lines.push('', '─── Section (full) ───', chunk.content.trim());
    for (const n of next) lines.push('', renderNeighbor(n, 'Next', chunk.source_uri));

    const cappedNeighbors = [...prev, ...next]
      .filter((neighbor) => neighbor.content.length > NEIGHBOR_PREVIEW_CHARS);
    return {
      content: lines.join('\n'),
      ...(cappedNeighbors.length > 0
        ? {
            sourceTruncations: [{
              technique: 'rag-neighbor-preview',
              inputSize: cappedNeighbors.reduce((sum, neighbor) => sum + neighbor.content.length, 0),
              outputSize: cappedNeighbors.reduce(
                (sum, neighbor) => sum + neighborPreviewPrefix(neighbor.content).length,
                0,
              ),
              unit: 'chars' as const,
              recoverable: true,
            }],
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
  const truncated = n.content.length > NEIGHBOR_PREVIEW_CHARS;
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
  lines.push(`# ${sec.heading_path ?? '(untitled)'} — ${sec.collection} [full section]`);
  if (sec.source_uri) lines.push(`Source: ${sec.source_uri}${sec.anchor ? `#${sec.anchor}` : ''}`);
  if (sec.api_signature) lines.push(`Signature: ${sec.api_signature}`);
  else if (sec.api_symbol) lines.push(`Symbol: ${sec.api_symbol}`);
  lines.push(
    `${sec.chunks.length} chunk(s) · ~${sec.total_tokens} tokens${sec.doc_type ? ` · ${sec.doc_type}` : ''}`,
  );
  lines.push('', sec.chunks.map((c) => c.content.trim()).join('\n\n'));
  return lines.join('\n');
}

export const ragReadDocTools: CoderTool[] = [ragReadDocTool];
