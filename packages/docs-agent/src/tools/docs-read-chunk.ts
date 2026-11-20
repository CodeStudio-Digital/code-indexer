/**
 * docs_read_chunk — reads a chunk's FULL content (no 480-char snippet
 * truncation) plus optional N adjacent chunks for surrounding context.
 *
 * The search tool returns 480-char snippets to keep response sizes
 * reasonable. When the agent finds a promising chunk and the snippet
 * doesn't cover what it needs, it calls this to fetch the whole thing
 * (typically ~6000 chars). With `include_neighbors`, it also pulls
 * `ord-N` through `ord+N` chunks from the same source — useful for
 * code examples that span multiple sections.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import { docPassageUri } from '@mcp/shared/doc-passage-uri.js';
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { DocStore, DocChunk } from '@mcp/store/doc-store.js';
import type { DocsEvidenceLedger } from './evidence-ledger.js';

export interface DocsReadChunkToolDeps {
  scopeIds?: ReadonlySet<number>;
  docStore: DocStore;
  /** Increment-on-call counter the DocsAgent uses for telemetry. */
  onCall?: () => void;
  ledger?: DocsEvidenceLedger;
}

/** Hard cap on neighbors to prevent the agent from blowing context. */
const MAX_NEIGHBOR_WINDOW = 1;

export function makeDocsReadChunkTool(deps: DocsReadChunkToolDeps): CoderTool {
  return {
    name: 'docs_read_chunk',
    description:
      'Reads a doc chunk in pages. When next_char_offset appears, pass it as char_offset to continue.\n' +
      'USE when a search hit looks promising but the snippet is truncated or lacks code/details you need.\n' +
      'Pass `include_neighbors: N` to also fetch the N chunks before and after (same source) — useful for code examples that span sections.\n' +
      'Get chunk_id from a prior docs_search call.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        chunk_id: {
          type: 'number',
          description: 'The chunk_id returned by docs_search.',
        },
        include_neighbors: {
          type: 'number',
          description: 'Include one adjacent chunk on each side. Default 0.',
        },
        char_offset: { type: 'integer', minimum: 0, description: 'Resume the target chunk at its next_char_offset.' },
      },
      required: ['chunk_id'],
      additionalProperties: false,
    },
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read',
    handler: async (args): Promise<ToolResult> => {
      if (deps.ledger && !deps.ledger.canRead()) {
        return err(`read budget exhausted (${deps.ledger.maxReads}); synthesize from the evidence already read.`);
      }
      deps.onCall?.();
      const chunkId = Number(args.chunk_id);
      if (!Number.isFinite(chunkId) || chunkId <= 0) {
        return err('chunk_id must be a positive integer');
      }
      const rawWindow = Number(args.include_neighbors);
      const window = Number.isFinite(rawWindow)
        ? Math.max(0, Math.min(MAX_NEIGHBOR_WINDOW, Math.floor(rawWindow)))
        : 0;

      let chunks: DocChunk[];
      try {
        chunks = window > 0
          ? deps.docStore.getChunkNeighbors(chunkId, window)
          : (() => {
              const seed = deps.docStore.getChunk(chunkId);
              return seed ? [seed] : [];
            })();
      } catch (e) {
        return err(`docs_read_chunk failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (chunks.length === 0) {
        return err(`chunk_id=${chunkId} not found — verify it came from a recent docs_search result.`);
      }
      if (deps.scopeIds && chunks.some(chunk => !deps.scopeIds!.has(chunk.collection_id))) {
        return err('Passage outside this task’s documentation scope.');
      }
      const offset = Number(args.char_offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return err('char_offset must be a nonnegative integer');

      const seed = chunks.find((c) => c.id === chunkId) ?? chunks[0]!;
      const collection = deps.docStore.getCollection(seed.collection_id);
      if (offset > seed.content.length) return err('char_offset exceeds the target length');
      const parts: Array<{ id: number; hash: string; start: number; end: number; total: number }> = [];
      const blocks = chunks.map((c) => {
        if (c.id !== seed.id && deps.ledger?.readChunkIds.has(c.id) && !deps.ledger.contentChanged(c.id, c.content_hash)) {
          return '[chunk_id=' + c.id + ' previously read in full]';
        }
        const marker = c.id === chunkId ? ' (target)' : '';
        const lines: string[] = [];
        lines.push(`## chunk_id=${c.id} ord=${c.ord}${marker} — ${c.heading_path ?? '(untitled)'}`);
        if (c.source_uri) lines.push(`Source: ${docPassageUri(c.source_uri, c.anchor)}`);
        if (c.summary) lines.push(`Summary: ${c.summary}`);
        if (c.concepts.length > 0) lines.push(`Concepts: ${c.concepts.join(', ')}`);
        lines.push('');
        const start = c.id === seed.id ? offset : 0;
        let end = Math.min(c.content.length, start + 6_000);
        if (end < c.content.length && /[\uD800-\uDBFF]/.test(c.content[end - 1]!)) end--;
        lines.push(c.content.slice(start, end));
        if (end < c.content.length) lines.push(`[chunk_id=${c.id} next_char_offset=${end} total=${c.content.length}]`);
        parts.push({ id: c.id, hash: c.content_hash, start, end, total: c.content.length });
        return lines.join('\n');
      });

      deps.ledger?.recordPassages(parts);
      const header = window > 0
        ? `Read chunk ${chunkId} with ${window} neighbor${window === 1 ? '' : 's'} (${chunks.length} chunks total) from collection "${collection?.name ?? '(unknown)'}"`
        : `Read chunk ${chunkId} from collection "${collection?.name ?? '(unknown)'}"`;

      return ok(`${header}\n\n${blocks.join('\n\n---\n\n')}`);
    },
  };
}
