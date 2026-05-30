/**
 * Vectorize — list/create/delete vector indexes. REST:
 * /accounts/:id/vectorize/v2/indexes.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list } from './lib.js';

interface VectorIndex {
  name: string;
  config?: { dimensions?: number; metric?: string };
}

export const vectorizeTools = [
  contributeTool({
    name: 'cf_vectorize_list',
    description: 'List Vectorize indexes',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ix = await cfAcct<VectorIndex[]>(ctx, '/vectorize/v2/indexes');
      return list(
        ix,
        (i) => `- ${i.name} (dim ${i.config?.dimensions ?? '?'}, ${i.config?.metric ?? '?'})`,
        'No Vectorize indexes.',
      );
    },
  }),
  contributeTool({
    name: 'cf_vectorize_create',
    description: 'Create a Vectorize index',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dimensions: { type: 'number' },
        metric: { type: 'string', enum: ['cosine', 'euclidean', 'dot-product'] },
      },
      required: ['name', 'dimensions', 'metric'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { name, dimensions, metric } = a as {
        name?: string;
        dimensions?: number;
        metric?: string;
      };
      if (!name || !dimensions || !metric) return fail('name, dimensions, metric required');
      await cfAcct(ctx, '/vectorize/v2/indexes', {
        method: 'POST',
        body: JSON.stringify({ name, config: { dimensions, metric } }),
      });
      return ok(`Created Vectorize index "${name}" (dim ${dimensions}, ${metric}).`);
    },
  }),
  contributeTool({
    name: 'cf_vectorize_delete',
    description: 'Delete a Vectorize index (by name)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const name = String((a as { name?: string }).name ?? '');
      if (!name) return fail('name is required');
      await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      return ok(`Deleted Vectorize index "${name}".`);
    },
  }),
];
