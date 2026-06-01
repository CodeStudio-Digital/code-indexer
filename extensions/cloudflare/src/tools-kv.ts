/**
 * Workers KV namespace/key management.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, cfAcctPaged, cfAcctText, fail, list, ok, parseJson, reqString } from './lib.js';

interface KvNamespace {
  id: string;
  title: string;
  supports_url_encoding?: boolean;
}

export const kvTools = [
  contributeTool({
    name: 'cf_kv_list',
    description: 'List KV namespaces',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ns = await cfAcctPaged<KvNamespace>(ctx, '/storage/kv/namespaces');
      return list(ns, (n) => `- ${n.title} (${n.id})`, 'No KV namespaces.');
    },
  }),
  contributeTool({
    name: 'cf_kv_get_namespace',
    description: 'Get KV namespace details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { namespaceId: { type: 'string' } }, required: ['namespaceId'] },
    handler: async (a, ctx) => {
      const ns = await cfAcct<KvNamespace>(ctx, `/storage/kv/namespaces/${reqString(a, 'namespaceId')}`);
      return ok(`KV namespace ${ns.title}.`, { details: ns });
    },
  }),
  contributeTool({
    name: 'cf_kv_create',
    description: 'Create a KV namespace',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    handler: async (a, ctx) => {
      const n = await cfAcct<KvNamespace>(ctx, '/storage/kv/namespaces', {
        method: 'POST',
        body: JSON.stringify({ title: reqString(a, 'title') }),
      });
      return ok(`Created KV namespace "${n.title}" (${n.id}).`, { details: n });
    },
  }),
  contributeTool({
    name: 'cf_kv_update',
    description: 'Rename a KV namespace',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' }, title: { type: 'string' } },
      required: ['namespaceId', 'title'],
    },
    handler: async (a, ctx) => {
      const ns = await cfAcct<KvNamespace>(ctx, `/storage/kv/namespaces/${reqString(a, 'namespaceId')}`, {
        method: 'PUT',
        body: JSON.stringify({ title: reqString(a, 'title') }),
      });
      return ok(`Renamed KV namespace to "${ns.title}".`, { details: ns });
    },
  }),
  contributeTool({
    name: 'cf_kv_delete',
    description: 'Delete a KV namespace',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { namespaceId: { type: 'string' } }, required: ['namespaceId'] },
    handler: async (a, ctx) => {
      const id = reqString(a, 'namespaceId');
      await cfAcct(ctx, `/storage/kv/namespaces/${id}`, { method: 'DELETE' });
      return ok(`Deleted KV namespace ${id}.`);
    },
  }),
  contributeTool({
    name: 'cf_kv_keys',
    description: 'List keys in a KV namespace',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' }, prefix: { type: 'string' }, limit: { type: 'number' } },
      required: ['namespaceId'],
    },
    handler: async (a, ctx) => {
      const id = reqString(a, 'namespaceId');
      const qs = new URLSearchParams();
      qs.set('limit', String(Math.min(Number(a.limit ?? 100), 1000)));
      if (a.prefix) qs.set('prefix', String(a.prefix));
      const keys = await cfAcct<Array<{ name: string; expiration?: number; metadata?: unknown }>>(
        ctx,
        `/storage/kv/namespaces/${id}/keys?${qs.toString()}`,
      );
      return list(keys, (k) => `- ${k.name}`, 'No keys.');
    },
  }),
  contributeTool({
    name: 'cf_kv_get',
    description: 'Read a text value from a KV namespace',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' }, key: { type: 'string' } },
      required: ['namespaceId', 'key'],
    },
    handler: async (a, ctx) => {
      const id = reqString(a, 'namespaceId');
      const key = reqString(a, 'key');
      const value = await cfAcctText(ctx, `/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`);
      return ok(value, { details: { key, value } });
    },
  }),
  contributeTool({
    name: 'cf_kv_metadata',
    description: 'Read metadata for a KV key',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' }, key: { type: 'string' } },
      required: ['namespaceId', 'key'],
    },
    handler: async (a, ctx) => {
      const id = reqString(a, 'namespaceId');
      const key = reqString(a, 'key');
      const meta = await cfAcct(ctx, `/storage/kv/namespaces/${id}/metadata/${encodeURIComponent(key)}`);
      return ok(`Metadata for ${key}.`, { details: meta });
    },
  }),
  contributeTool({
    name: 'cf_kv_put',
    description: 'Write a text value to a KV key',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        namespaceId: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        metadata: { type: 'object' },
        expiration_ttl: { type: 'number' },
      },
      required: ['namespaceId', 'key', 'value'],
    },
    handler: async (a, ctx) => {
      const id = reqString(a, 'namespaceId');
      const key = reqString(a, 'key');
      const qs = new URLSearchParams();
      if (a.metadata) qs.set('metadata', JSON.stringify(parseJson(a.metadata)));
      if (a.expiration_ttl) qs.set('expiration_ttl', String(a.expiration_ttl));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      await cfAcctText(ctx, `/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}${suffix}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: String(a.value ?? ''),
      });
      return ok(`Wrote "${key}".`);
    },
  }),
  contributeTool({
    name: 'cf_kv_delete_key',
    description: 'Delete a KV key',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { namespaceId: { type: 'string' }, key: { type: 'string' } },
      required: ['namespaceId', 'key'],
    },
    handler: async (a, ctx) => {
      const id = reqString(a, 'namespaceId');
      const key = reqString(a, 'key');
      await cfAcct(ctx, `/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`, { method: 'DELETE' });
      return ok(`Deleted key "${key}".`);
    },
  }),
  contributeTool({
    name: 'cf_kv_bulk_put',
    description: 'Bulk write KV entries using the Cloudflare bulk payload shape',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { namespaceId: { type: 'string' }, entries: { type: 'array' } }, required: ['namespaceId', 'entries'] },
    handler: async (a, ctx) => {
      const entries = parseJson(a.entries, []);
      if (!Array.isArray(entries)) return fail('entries must be an array');
      await cfAcct(ctx, `/storage/kv/namespaces/${reqString(a, 'namespaceId')}/bulk`, {
        method: 'PUT',
        body: JSON.stringify(entries),
      });
      return ok(`Wrote ${entries.length} KV entr${entries.length === 1 ? 'y' : 'ies'}.`);
    },
  }),
  contributeTool({
    name: 'cf_kv_bulk_delete',
    description: 'Bulk delete KV keys',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { namespaceId: { type: 'string' }, keys: { type: 'array' } }, required: ['namespaceId', 'keys'] },
    handler: async (a, ctx) => {
      const keys = parseJson(a.keys, []);
      if (!Array.isArray(keys)) return fail('keys must be an array');
      await cfAcct(ctx, `/storage/kv/namespaces/${reqString(a, 'namespaceId')}/bulk/delete`, {
        method: 'POST',
        body: JSON.stringify(keys),
      });
      return ok(`Deleted ${keys.length} KV key(s).`);
    },
  }),
];
