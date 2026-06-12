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
import { getGlobalDocSearch, type DocChunkNeighborRef } from './rag-search-docs.js';

/** Neighbor previews are capped — the agent reads them in full by chunk_id. */
const NEIGHBOR_PREVIEW_CHARS = 1_200;

export const ragReadDocTool: CoderTool = {
  name: 'rag_read_doc',
  description:
    'Read one indexed documentation section IN FULL by chunk_id (from rag_search_docs results), with a preview of the previous/next sections of the same document.\n' +
    'USE: whenever a rag_search_docs snippet looks relevant but is cut off — never answer from a truncated snippet when the full section is one call away.\n' +
    'USE: to follow a passage across sections — neighbor previews carry their own chunk_id; call rag_read_doc on those to keep reading.\n' +
    "DON'T: guess chunk_ids — they come from rag_search_docs output.",
  source: 'native',
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
          'How many neighboring sections to preview on each side (same document). Default 1; clamped to [0, 3].',
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
    if (chunk.source_uri) lines.push(`Source: ${chunk.source_uri}`);
    lines.push(`chunk_id: ${chunk.chunk_id} · ~${chunk.token_count} tokens`);
    if (chunk.concepts.length > 0) lines.push(`Concepts: ${chunk.concepts.join(', ')}`);

    for (const n of prev) lines.push('', renderNeighbor(n, 'Previous'));
    lines.push('', '─── Section (full) ───', chunk.content.trim());
    for (const n of next) lines.push('', renderNeighbor(n, 'Next'));

    return ok(lines.join('\n'));
  },
};

function renderNeighbor(n: DocChunkNeighborRef, label: 'Previous' | 'Next'): string {
  const truncated = n.content.length > NEIGHBOR_PREVIEW_CHARS;
  const body = truncated ? n.content.slice(0, NEIGHBOR_PREVIEW_CHARS) + '…' : n.content;
  const tail = truncated ? `\n[truncated — rag_read_doc({chunk_id: ${n.chunk_id}}) for the rest]` : '';
  return `─── ${label} section — chunk_id ${n.chunk_id}${n.heading_path ? ` (${n.heading_path})` : ''} ───\n${body.trim()}${tail}`;
}

export const ragReadDocTools: CoderTool[] = [ragReadDocTool];
