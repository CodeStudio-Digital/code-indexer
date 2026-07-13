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
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DocStore, DocChunk } from '@mcp/store/doc-store.js';
import type { DocsEvidenceLedger } from './evidence-ledger.js';

export interface DocsReadChunkToolDeps {
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
      'Reads the FULL content of a doc chunk (the search tool returns 480-char snippets — call this to get the rest).\n' +
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
          description: 'How many adjacent chunks to include on each side. Default 0; clamped to [0, 3].',
        },
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
      deps.ledger?.recordRead(chunks.map((chunk) => chunk.id));

      const seed = chunks.find((c) => c.id === chunkId) ?? chunks[0]!;
      const collection = deps.docStore.getCollection(seed.collection_id);
      const blocks = chunks.map((c) => {
        const marker = c.id === chunkId ? ' (target)' : '';
        const lines: string[] = [];
        lines.push(`## chunk_id=${c.id} ord=${c.ord}${marker} — ${c.heading_path ?? '(untitled)'}`);
        if (c.source_uri) lines.push(`Source: ${c.source_uri}`);
        if (c.summary) lines.push(`Summary: ${c.summary}`);
        if (c.concepts.length > 0) lines.push(`Concepts: ${c.concepts.join(', ')}`);
        lines.push('');
        lines.push(c.content.slice(0, 6_000));
        return lines.join('\n');
      });

      const header = window > 0
        ? `Read chunk ${chunkId} with ${window} neighbor${window === 1 ? '' : 's'} (${chunks.length} chunks total) from collection "${collection?.name ?? '(unknown)'}"`
        : `Read chunk ${chunkId} from collection "${collection?.name ?? '(unknown)'}"`;

      return ok(`${header}\n\n${blocks.join('\n\n---\n\n')}`);
    },
  };
}
