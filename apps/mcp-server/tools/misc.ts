import { defineTool, mcpAccess, type McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import type { ProviderName, ExportSection } from '@mcp/shared/types.js';
import { withProject } from './_helpers.js';

const get_costs = defineTool({
  name: 'get_costs',
  tier: 'admin',
  ...mcpAccess('read'),
  description:
    'Read the historical provider-cost ledger (USD and tokens). Local structural indexing, ONNX embeddings and local reranking have no provider charge and are not represented as indexer cost here. ' +
    'Scope to one project via project_name or omit it for the global total; pass since (ISO date) to bound the window.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, since: { type: 'string' } },
  },
  handler: (args, { db, costTracker }) => {
    if (args.project_name) {
      const project = resolveProject(db, args.project_name as string);
      return JSON.stringify(costTracker.getProjectCosts(project.id, args.since as string | undefined), null, 2);
    }
    return JSON.stringify(costTracker.getGlobalCosts(args.since as string | undefined), null, 2);
  },
});

const export_docs = defineTool({
  name: 'export_docs',
  tier: 'admin',
  ...mcpAccess('admin'),
  description:
    'Export structural project documentation (overview, directory tree, files, symbols and optional snapshots) as one document.\n' +
    'Default format is markdown; pass format="json" for structured output, and sections to limit which parts are included.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      format: { type: 'string', enum: ['markdown', 'json'] },
      sections: { type: 'array', items: { type: 'string' } },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { exportService }, project) => {
    return exportService.export({
      projectId: project.id,
      projectName: project.name,
      format: (args.format as 'markdown' | 'json') ?? 'markdown',
      sections: (args.sections as ExportSection[]) ?? [],
      includeSnapshots: true,
      includeCosts: false,
    });
  }),
});

const list_models = defineTool({
  name: 'list_models',
  tier: 'admin',
  ...mcpAccess('read'),
  description:
    'List LLM models known to the configured providers, one line per model.\n' +
    'Filter with provider; pass live=true to query provider APIs for fresh listings instead of the cached catalog.',
  inputSchema: {
    type: 'object',
    properties: { provider: { type: 'string' }, live: { type: 'boolean' } },
  },
  handler: async (args, { modelDiscovery }) => {
    const models = await modelDiscovery.discoverModels(
      args.provider as ProviderName | undefined,
      args.live as boolean | undefined,
    );
    return models.map(m => `[${m.provider}] ${m.id} — ${m.name}`).join('\n');
  },
});

export const miscTools: McpTool[] = [get_costs, export_docs, list_models];
