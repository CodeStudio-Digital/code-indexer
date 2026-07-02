import { defineTool, type McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import type { ProviderName, ExportSection } from '@mcp/shared/types.js';
import { withProject } from './_helpers.js';

const get_costs = defineTool({
  name: 'get_costs',
  description:
    'Summarize LLM spend (USD and tokens) recorded by the indexer.\n' +
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

const estimate_cost = defineTool({
  name: 'estimate_cost',
  description:
    'Estimate the USD cost of indexing a project before running index_project.\n' +
    "Uses the project's file count and the configured default provider/model unless provider/model are passed; includes embedding tokens when embeddings are enabled.",
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { db, providerStore, costTracker }, project) => {
    const stats = db.getStats(project.id);
    const defaults = providerStore.getDefaultProviderAndModel();
    const embeddingCfg = providerStore.getDefaultEmbedding();
    const estimate = costTracker.estimateCost({
      fileCount: stats.file_count || 100,
      provider: (args.provider as string) ?? defaults.kind,
      model: (args.model as string) ?? defaults.model ?? 'glm-5.1',
      embeddingsEnabled: !!embeddingCfg,
    });
    return `Estimated cost: $${estimate.estimatedCostUsd.toFixed(4)}\nAnalysis tokens: ${estimate.analysisTokens.toLocaleString()}\nEmbedding tokens: ${estimate.embeddingTokens.toLocaleString()}`;
  }),
});

const get_diff = defineTool({
  name: 'get_diff',
  description:
    'Compare two indexing runs of a project and report files added, changed, and removed.\n' +
    "Pass run_before + run_after for specific runs; omit both to diff the two most recent. Returns 'Not enough runs' when the project has fewer than two.",
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      run_before: { type: 'number' },
      run_after: { type: 'number' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, { diffService }, project) => {
    const diff = args.run_before && args.run_after
      ? diffService.diff(project.id, args.run_before as number, args.run_after as number)
      : diffService.diffLatest(project.id);
    if (!diff) return 'Not enough runs to compare.';
    return diffService.formatDiff(diff);
  }),
});

const export_docs = defineTool({
  name: 'export_docs',
  description:
    'Export the indexed project documentation (overview, architecture, files, snapshots, costs) as one document.\n' +
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
      includeCosts: true,
    });
  }),
});

const list_models = defineTool({
  name: 'list_models',
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

export const miscTools: McpTool[] = [get_costs, estimate_cost, get_diff, export_docs, list_models];
