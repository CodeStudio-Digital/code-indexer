/**
 * Vectorize index management and vector operations.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, fail, list, ok, parseJson, reqString } from './lib.js';

interface VectorIndex {
  name: string;
  config?: { dimensions?: number; metric?: string };
}

function indexName(args: Record<string, unknown>): string {
  const value = String(args.name ?? args.index ?? '').trim();
  if (!value) throw new Error('name is required');
  return value;
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
      return list(ix, (i) => `- ${i.name} (dim ${i.config?.dimensions ?? '?'}, ${i.config?.metric ?? '?'})`, 'No Vectorize indexes.');
    },
  }),
  contributeTool({
    name: 'cf_vectorize_get',
    description: 'Get Vectorize index details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}`);
      return ok(`Vectorize index ${name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_info',
    description: 'Get Vectorize index info/stats',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/info`);
      return ok(`Vectorize info for ${name}.`, { details: r });
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
    handler: async (a, ctx) => {
      const name = indexName(a);
      const dimensions = Number(a.dimensions);
      const metric = String(a.metric ?? '');
      if (!dimensions || !metric) return fail('name, dimensions, metric required');
      const r = await cfAcct(ctx, '/vectorize/v2/indexes', {
        method: 'POST',
        body: JSON.stringify({ name, config: { dimensions, metric } }),
      });
      return ok(`Created Vectorize index "${name}".`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_delete',
    description: 'Delete a Vectorize index by name',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      return ok(`Deleted Vectorize index "${name}".`);
    },
  }),
  contributeTool({
    name: 'cf_vectorize_vectors_list',
    description: 'List vectors in a Vectorize index',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const qs = new URLSearchParams();
      if (a.cursor) qs.set('cursor', String(a.cursor));
      if (a.limit) qs.set('limit', String(a.limit));
      const r = await cfAcct<{ vectors?: unknown[]; count?: number; cursor?: string }>(
        ctx,
        `/vectorize/v2/indexes/${encodeURIComponent(name)}/list${qs.toString() ? `?${qs}` : ''}`,
      );
      return { content: `${r.vectors?.length ?? 0} vector(s).`, data: { rows: r.vectors ?? [], details: r } };
    },
  }),
  contributeTool({
    name: 'cf_vectorize_get_by_ids',
    description: 'Get vectors by IDs',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' }, ids: { type: 'array' } }, required: ['name', 'ids'] },
    handler: async (a, ctx) => {
      const ids = parseJson(a.ids, []);
      if (!Array.isArray(ids)) return fail('ids must be an array');
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/get_by_ids`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      return ok(`Fetched ${ids.length} vector(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_query',
    description: 'Query a Vectorize index using a Cloudflare query body',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' }, body: { type: 'object' } }, required: ['name', 'body'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/query`, {
        method: 'POST',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok(`Vectorize query complete for ${name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_insert',
    description: 'Insert vectors into a Vectorize index',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, vectors: { type: 'array' } }, required: ['name', 'vectors'] },
    handler: async (a, ctx) => {
      const vectors = parseJson(a.vectors, []);
      if (!Array.isArray(vectors)) return fail('vectors must be an array');
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/insert`, {
        method: 'POST',
        body: JSON.stringify({ vectors }),
      });
      return ok(`Inserted ${vectors.length} vector(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_upsert',
    description: 'Upsert vectors into a Vectorize index',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, vectors: { type: 'array' } }, required: ['name', 'vectors'] },
    handler: async (a, ctx) => {
      const vectors = parseJson(a.vectors, []);
      if (!Array.isArray(vectors)) return fail('vectors must be an array');
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/upsert`, {
        method: 'POST',
        body: JSON.stringify({ vectors }),
      });
      return ok(`Upserted ${vectors.length} vector(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_delete_by_ids',
    description: 'Delete vectors from a Vectorize index by IDs',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, ids: { type: 'array' } }, required: ['name', 'ids'] },
    handler: async (a, ctx) => {
      const ids = parseJson(a.ids, []);
      if (!Array.isArray(ids)) return fail('ids must be an array');
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/delete_by_ids`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      return ok(`Deleted ${ids.length} vector(s).`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_metadata_index_list',
    description: 'List Vectorize metadata indexes',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/list`);
      return ok(`Metadata indexes for ${name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_metadata_index_create',
    description: 'Create a Vectorize metadata index',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, body: { type: 'object' } }, required: ['name', 'body'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/create`, {
        method: 'POST',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok(`Created metadata index for ${name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_vectorize_metadata_index_delete',
    description: 'Delete a Vectorize metadata index',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, propertyName: { type: 'string' } }, required: ['name', 'propertyName'] },
    handler: async (a, ctx) => {
      const name = indexName(a);
      const r = await cfAcct(ctx, `/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index/delete`, {
        method: 'POST',
        body: JSON.stringify({ propertyName: reqString(a, 'propertyName') }),
      });
      return ok(`Deleted metadata index for ${name}.`, { details: r });
    },
  }),
];
