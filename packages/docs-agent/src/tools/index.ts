/**
 * buildDocsToolset — assembles the CoderTool[] the DocsAgent's CoderRunner
 * will run with. Deliberately NARROW — no fs, no shell, no git, no MCP
 * bridges, no skill tools. Only the docs-specific surface so the agent
 * stays on-task and can't accidentally edit the user's codebase.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { DocHybridSearch } from '@mcp/services/services/docs/index.js';
import type {
  PipelineProviderResolver,
  ResolveContext,
} from '@mcp/services/pipelines/index.js';
import { makeDocsSearchTool } from './docs-search-chunks.js';
import { makeDocsReadChunkTool } from './docs-read-chunk.js';
import { makeDocsListSourcesTool } from './docs-list-sources.js';
import { makeDocsSynthesizeTool } from './docs-synthesize.js';
import { makeDocsFinishTool, type DocsFinishSlot } from './docs-finish.js';

export type { DocsFinishPayload, DocsFinishSlot } from './docs-finish.js';

export interface DocsToolsetCounters {
  searches: number;
  chunks_read: number;
  synthesizes: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface BuildDocsToolsetInput {
  docStore: DocStore;
  docHybridSearch: DocHybridSearch;
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Caller-scoped collections — used as docs_search default when omitted. */
  scopedCollections?: string[];
  /** Slot the docs_finish handler writes into; the wrapper reads it post-run. */
  finishSlot: DocsFinishSlot;
  /** Live counters the wrapper inspects to persist telemetry. */
  counters: DocsToolsetCounters;
}

export function buildDocsToolset(input: BuildDocsToolsetInput): CoderTool[] {
  return [
    makeDocsListSourcesTool({ docStore: input.docStore }),
    makeDocsSearchTool({
      docHybridSearch: input.docHybridSearch,
      resolveContext: input.resolveContext,
      scopedCollections: input.scopedCollections,
      onCall: () => {
        input.counters.searches++;
      },
    }),
    makeDocsReadChunkTool({
      docStore: input.docStore,
      onCall: () => {
        input.counters.chunks_read++;
      },
    }),
    makeDocsSynthesizeTool({
      docStore: input.docStore,
      resolver: input.resolver,
      resolveContext: input.resolveContext,
      onCall: () => {
        input.counters.synthesizes++;
      },
      onUsage: (usage) => {
        input.counters.input_tokens += usage.input_tokens;
        input.counters.output_tokens += usage.output_tokens;
        if (usage.cost_usd != null) input.counters.cost_usd += usage.cost_usd;
      },
    }),
    makeDocsFinishTool({ slot: input.finishSlot }),
  ];
}
