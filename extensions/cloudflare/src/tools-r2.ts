/**
 * R2 bucket/object management. Object read/write is text-oriented in the UI;
 * binary workflows should continue to use S3-compatible tooling.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, cfAcctText, fail, list, ok, optString, parseJson, reqString } from './lib.js';

interface R2Bucket {
  name: string;
  creation_date?: string;
  location?: string;
  storage_class?: string;
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
    name: 'cf_r2_get',
    description: 'Get R2 bucket details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = reqString(a, 'name');
      const b = await cfAcct<R2Bucket>(ctx, `/r2/buckets/${encodeURIComponent(name)}`);
      return ok(`R2 bucket ${name}.`, { details: b });
    },
  }),
  contributeTool({
    name: 'cf_r2_create',
    description: 'Create an R2 bucket',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, location: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const body: Record<string, unknown> = { name: reqString(a, 'name') };
      const location = optString(a, 'location');
      if (location) body.location = location;
      const created = await cfAcct(ctx, '/r2/buckets', { method: 'POST', body: JSON.stringify(body) });
      return ok(`Created R2 bucket "${body.name}".`, { details: created });
    },
  }),
  contributeTool({
    name: 'cf_r2_update',
    description: 'Patch R2 bucket settings using Cloudflare bucket patch fields',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' }, body: { type: 'object' } }, required: ['name', 'body'] },
    handler: async (a, ctx) => {
      const name = reqString(a, 'name');
      const r = await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok(`Updated R2 bucket "${name}".`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_r2_delete',
    description: 'Delete an empty R2 bucket',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx) => {
      const name = reqString(a, 'name');
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
      properties: { bucket: { type: 'string' }, prefix: { type: 'string' }, delimiter: { type: 'string' }, cursor: { type: 'string' } },
      required: ['bucket'],
    },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const qs = new URLSearchParams();
      for (const key of ['prefix', 'delimiter', 'cursor']) {
        const v = optString(a, key);
        if (v) qs.set(key, v);
      }
      const q = qs.toString() ? `?${qs.toString()}` : '';
      const r = await cfAcct<{ objects?: Array<{ key: string; size: number; uploaded?: string }>; truncated?: boolean; cursor?: string }>(
        ctx,
        `/r2/buckets/${encodeURIComponent(bucket)}/objects${q}`,
      );
      return {
        content: r.objects?.length ? r.objects.map((o) => `- ${o.key} (${o.size} bytes)`).join('\n') : 'No objects.',
        data: { rows: r.objects ?? [], details: { truncated: r.truncated, cursor: r.cursor } },
      };
    },
  }),
  contributeTool({
    name: 'cf_r2_object_get',
    description: 'Read an R2 object as text',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { bucket: { type: 'string' }, key: { type: 'string' } }, required: ['bucket', 'key'] },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const key = reqString(a, 'key');
      const value = await cfAcctText(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`);
      return ok(value, { details: { bucket, key, value } });
    },
  }),
  contributeTool({
    name: 'cf_r2_object_put',
    description: 'Write an R2 text object',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { bucket: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' }, contentType: { type: 'string' } },
      required: ['bucket', 'key', 'value'],
    },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const key = reqString(a, 'key');
      await cfAcctText(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': optString(a, 'contentType') ?? 'text/plain' },
        body: String(a.value ?? ''),
      });
      return ok(`Wrote R2 object ${key}.`);
    },
  }),
  contributeTool({
    name: 'cf_r2_object_delete',
    description: 'Delete an R2 object',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { bucket: { type: 'string' }, key: { type: 'string' } }, required: ['bucket', 'key'] },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const key = reqString(a, 'key');
      await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`, { method: 'DELETE' });
      return ok(`Deleted R2 object ${key}.`);
    },
  }),
  contributeTool({
    name: 'cf_r2_cors_get',
    description: 'Get R2 bucket CORS rules',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { bucket: { type: 'string' } }, required: ['bucket'] },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const r = await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/cors`);
      return ok(`CORS for ${bucket}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_r2_cors_put',
    description: 'Replace R2 bucket CORS rules',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { bucket: { type: 'string' }, rules: { type: 'array' } }, required: ['bucket', 'rules'] },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const rules = parseJson(a.rules, []);
      if (!Array.isArray(rules)) return fail('rules must be an array');
      const r = await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/cors`, {
        method: 'PUT',
        body: JSON.stringify({ rules }),
      });
      return ok(`Updated CORS for ${bucket}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_r2_lifecycle_get',
    description: 'Get R2 bucket lifecycle rules',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { bucket: { type: 'string' } }, required: ['bucket'] },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const r = await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`);
      return ok(`Lifecycle for ${bucket}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_r2_lifecycle_put',
    description: 'Replace R2 bucket lifecycle rules',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { bucket: { type: 'string' }, rules: { type: 'array' } }, required: ['bucket', 'rules'] },
    handler: async (a, ctx) => {
      const bucket = reqString(a, 'bucket');
      const rules = parseJson(a.rules, []);
      if (!Array.isArray(rules)) return fail('rules must be an array');
      const r = await cfAcct(ctx, `/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`, {
        method: 'PUT',
        body: JSON.stringify({ rules }),
      });
      return ok(`Updated lifecycle for ${bucket}.`, { details: r });
    },
  }),
];
