/**
 * KV namespaces — list/create/delete namespaces and read/write/list keys.
 * REST: /accounts/:id/storage/kv/namespaces. All reads need a token + account.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list } from './lib.js';

interface KvNamespace {
  id: string;
  title: string;
}

export const kvTools = [
  contributeTool({
    name: 'cf_kv_list',
    description: 'List KV namespaces',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ns = await cfAcct<KvNamespace[]>(ctx, '/storage/kv/namespaces?per_page=100');
      return list(ns, (n) => `- ${n.title} (${n.id})`, 'No KV namespaces.');
    },
  }),
  contributeTool({
    name: 'cf_kv_create',
    description: 'Create a KV namespace',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const title = String((a as { title?: string }).title ?? '').trim();
      if (!title) return fail('title is required');
      const n = await cfAcct<KvNamespace>(ctx, '/storage/kv/namespaces', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      return ok(`Created KV namespace "${n.title}" (${n.id}).`);
    },
  }),
  contributeTool({
    name: 'cf_kv_keys',
    description: 'List keys in a KV namespace (by id)',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' } },
      required: ['namespaceId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const id = String((a as { namespaceId?: string }).namespaceId ?? '');
      if (!id) return fail('namespaceId is required');
      const keys = await cfAcct<Array<{ name: string }>>(
        ctx,
        `/storage/kv/namespaces/${id}/keys?limit=100`,
      );
      return list(keys, (k) => `- ${k.name}`, 'No keys.');
    },
  }),
  contributeTool({
    name: 'cf_kv_get',
    description: 'Read a value from a KV namespace',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' }, key: { type: 'string' } },
      required: ['namespaceId', 'key'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { namespaceId, key } = a as { namespaceId?: string; key?: string };
      if (!namespaceId || !key) return fail('namespaceId and key are required');
      // KV value endpoint returns raw text, not the JSON envelope.
      const val = await cfAcct<string>(
        ctx,
        `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      ).catch(() => null);
      return val === null ? ok('(key not found)') : ok(String(val));
    },
  }),
  contributeTool({
    name: 'cf_kv_put',
    description: 'Write a value to a KV namespace',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        namespaceId: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['namespaceId', 'key', 'value'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { namespaceId, key, value } = a as {
        namespaceId?: string;
        key?: string;
        value?: string;
      };
      if (!namespaceId || !key) return fail('namespaceId and key are required');
      await cfAcct(ctx, `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: value ?? '',
      });
      return ok(`Wrote "${key}".`);
    },
  }),
];
