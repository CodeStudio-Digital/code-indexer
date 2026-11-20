/**
 * docs_list_sources — introspection over the corpus.
 *
 * Returns the collections in the corpus + (optionally) the sources within
 * a named collection. The DocsAgent calls this on turn 1 when the caller
 * didn't pre-scope collections, so the agent knows which buckets exist
 * before formulating its first docs_search query.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { DocStore } from '@mcp/store/doc-store.js';

export interface DocsListSourcesToolDeps {
  scopeIds?: ReadonlySet<number>;
  docStore: DocStore;
}

export function makeDocsListSourcesTool(deps: DocsListSourcesToolDeps): CoderTool {
  return {
    name: 'docs_list_sources',
    description:
      'Lists indexed collections (and optionally their sources). Use this on the FIRST turn when you don\'t know which collection covers the query topic.\n' +
      'Pass `collection: "<name>"` to drill into a specific collection and see its individual sources (PDFs/URLs).\n' +
      'Returns chunk counts so you can prefer the bigger, more developed collections when both are plausible.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'Optional. When set, also lists the sources within this collection.',
        },
      },
      additionalProperties: false,
    },
    mutates: false,
    parallelSafe: true,
    riskLevel: 'read',
    handler: async (args): Promise<ToolResult> => {
      const collectionName = typeof args.collection === 'string' ? args.collection.trim() : '';

      const collections = deps.docStore.listCollections().filter(c => !deps.scopeIds || deps.scopeIds.has(c.id));
      if (collections.length === 0) {
        if (deps.scopeIds) return ok('No collections are available in the scope of this task.');
        return ok('No collections are indexed yet. The doc corpus is empty — emit docs_finish with confidence=\'low\' explaining the docs aren\'t available.');
      }

      const header = `# Indexed collections (${collections.length})`;
      const lines: string[] = [header];
      for (const c of collections) {
        const desc = c.description ? ` — ${c.description}` : '';
        const status = c.status !== 'idle' ? ` [status: ${c.status}${c.status_message ? `: ${c.status_message}` : ''}]` : '';
        lines.push(
          `- **${c.name}** (${c.chunk_count} chunks, ${c.source_count} sources)${status}${desc}`,
        );
      }

      if (!collectionName) {
        return ok(lines.join('\n'));
      }

      // Drill into a specific collection.
      const target = collections.find((c) => c.name === collectionName);
      if (!target) {
        return err(`Collection "${collectionName}" not found. Available: ${collections.map((c) => c.name).join(', ')}`);
      }
      const sources = deps.docStore.listSourcesByCollection(target.id);
      if (sources.length === 0) {
        return ok(`${lines.join('\n')}\n\n# Sources in "${collectionName}"\n\n_(no sources indexed yet)_`);
      }
      const sourceLines = sources.map((s) => {
        const title = s.title ?? '(untitled)';
        const last = s.last_indexed_at ? ` — indexed ${s.last_indexed_at}` : '';
        return `- [${s.id}] ${s.type.toUpperCase()} **${title}** (${s.chunk_count} chunks)${last}\n      ${s.uri}`;
      });
      return ok(`${lines.join('\n')}\n\n# Sources in "${collectionName}" (${sources.length})\n${sourceLines.join('\n')}`);
    },
  };
}
