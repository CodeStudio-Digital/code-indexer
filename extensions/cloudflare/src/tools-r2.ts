/**
 * R2 — list/create/delete buckets and list objects in a bucket.
 * REST: /accounts/:id/r2/buckets. Object listing uses the bucket's S3-ish
 * list endpoint exposed under the same account path.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list } from './lib.js';

interface R2Bucket {
  name: string;
  creation_date?: string;
}

export const r2Tools = [
  contributeTool({
    name: 'cf_r2_list',
    description: 'List R2 buckets',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const r = await cfAcct<{ buckets: R2Bucket[] }>(ctx, '/r2/buckets');
      return list(r?.buckets, (b) => `- ${b.name}${b.creation_date ? ` (since ${b.creation_date})` : ''}`, 'No R2 buckets.');
    },
  }),
  contributeTool({
    name: 'cf_r2_create',
    description: 'Create an R2 bucket',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const name = String((a as { name?: string }).name ?? '').trim();
      if (!name) return fail('name is required');
      await cfAcct(ctx, '/r2/buckets', { method: 'POST', body: JSON.stringify({ name }) });
      return ok(`Created R2 bucket "${name}".`);
    },
  }),
  contributeTool({
    name: 'cf_r2_delete',
    description: 'Delete an empty R2 bucket',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const name = String((a as { name?: string }).name ?? '').trim();
      if (!name) return fail('name is required');
      await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      return ok(`Deleted R2 bucket "${name}".`);
    },
  }),
  contributeTool({
    name: 'cf_r2_objects',
    description: 'List objects in an R2 bucket',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { bucket: { type: 'string' }, prefix: { type: 'string' } },
      required: ['bucket'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { bucket, prefix } = a as { bucket?: string; prefix?: string };
      if (!bucket) return fail('bucket is required');
      const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
      const r = await cfAcct<{ objects?: Array<{ key: string; size: number }> }>(
        ctx,
        `/r2/buckets/${encodeURIComponent(bucket)}/objects${q}`,
      );
      return list(r?.objects, (o) => `- ${o.key} (${o.size} bytes)`, 'No objects.');
    },
  }),
];
