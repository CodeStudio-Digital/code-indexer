import { defineTool, type McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import type { ProviderName, ExportSection } from '../../../types.js';

const get_costs = defineTool({
  name: 'get_costs',
  description: 'Get cost summary',
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
  description: 'Estimate indexing cost',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
    required: ['project_name'],
  },
  handler: (args, { db, config, costTracker }) => {
    const project = resolveProject(db, args.project_name as string);
    const stats = db.getStats(project.id);
    const estimate = costTracker.estimateCost({
      fileCount: stats.file_count || 100,
      provider: (args.provider as string) ?? config.provider ?? 'zai',
      model: (args.model as string) ?? config.model ?? 'glm-5.1',
      embeddingsEnabled: config.embeddings.enabled,
    });
    return `Estimated cost: $${estimate.estimatedCostUsd.toFixed(4)}\nAnalysis tokens: ${estimate.analysisTokens.toLocaleString()}\nEmbedding tokens: ${estimate.embeddingTokens.toLocaleString()}`;
  },
});

const get_diff = defineTool({
  name: 'get_diff',
  description: 'Get diff between indexing runs',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      run_before: { type: 'number' },
      run_after: { type: 'number' },
    },
    required: ['project_name'],
  },
  handler: (args, { db, diffService }) => {
    const project = resolveProject(db, args.project_name as string);
    const diff = args.run_before && args.run_after
      ? diffService.diff(project.id, args.run_before as number, args.run_after as number)
      : diffService.diffLatest(project.id);
    if (!diff) return 'Not enough runs to compare.';
    return diffService.formatDiff(diff);
  },
});

const export_docs = defineTool({
  name: 'export_docs',
  description: 'Export project documentation',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      format: { type: 'string', enum: ['markdown', 'json'] },
      sections: { type: 'array', items: { type: 'string' } },
    },
    required: ['project_name'],
  },
  handler: (args, { db, exportService }) => {
    const project = resolveProject(db, args.project_name as string);
    return exportService.export({
      projectId: project.id,
      projectName: project.name,
      format: (args.format as 'markdown' | 'json') ?? 'markdown',
      sections: (args.sections as ExportSection[]) ?? [],
      includeSnapshots: true,
      includeCosts: true,
    });
  },
});

const list_models = defineTool({
  name: 'list_models',
  description: 'List available LLM models',
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
