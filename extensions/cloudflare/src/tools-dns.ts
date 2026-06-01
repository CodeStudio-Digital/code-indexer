/**
 * DNS zones and records.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfFetch, cfPaged, cfText, fail, list, ok, parseJson, reqString } from './lib.js';

interface Zone {
  id: string;
  name: string;
  status?: string;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

export const dnsTools = [
  contributeTool({
    name: 'cf_zones_list',
    description: 'List zones/domains',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const zs = await cfPaged<Zone>(ctx, '/zones');
      return list(zs, (z) => `- ${z.name} (${z.id})${z.status ? ` [${z.status}]` : ''}`, 'No zones.');
    },
  }),
  contributeTool({
    name: 'cf_zone_get',
    description: 'Get zone details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { zoneId: { type: 'string' } }, required: ['zoneId'] },
    handler: async (a, ctx) => {
      const z = await cfFetch<Zone>(ctx, `/zones/${reqString(a, 'zoneId')}`);
      return ok(`Zone ${z.name}.`, { details: z });
    },
  }),
  contributeTool({
    name: 'cf_dns_list',
    description: 'List DNS records in a zone',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { zoneId: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' }, search: { type: 'string' } },
      required: ['zoneId'],
    },
    handler: async (a, ctx) => {
      const qs = new URLSearchParams();
      for (const key of ['type', 'name', 'search']) if (a[key]) qs.set(key, String(a[key]));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const rs = await cfPaged<DnsRecord>(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records${suffix}`);
      return list(rs, (r) => `- ${r.type} ${r.name} -> ${r.content}${r.proxied ? ' (proxied)' : ''}`, 'No DNS records.');
    },
  }),
  contributeTool({
    name: 'cf_dns_get',
    description: 'Get DNS record details',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { zoneId: { type: 'string' }, recordId: { type: 'string' } },
      required: ['zoneId', 'recordId'],
    },
    handler: async (a, ctx) => {
      const r = await cfFetch<DnsRecord>(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/${reqString(a, 'recordId')}`);
      return ok(`DNS record ${r.type} ${r.name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_dns_create',
    description: 'Create a DNS record in a zone',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        zoneId: { type: 'string' },
        type: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
        proxied: { type: 'boolean' },
        ttl: { type: 'number' },
      },
      required: ['zoneId', 'type', 'name', 'content'],
    },
    handler: async (a, ctx) => {
      const body: Record<string, unknown> = {
        type: reqString(a, 'type'),
        name: reqString(a, 'name'),
        content: reqString(a, 'content'),
      };
      if (a.proxied != null) body.proxied = Boolean(a.proxied);
      if (a.ttl != null) body.ttl = Number(a.ttl);
      const r = await cfFetch<DnsRecord>(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(`Created ${r.type} ${r.name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_dns_update',
    description: 'Patch a DNS record',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { zoneId: { type: 'string' }, recordId: { type: 'string' }, body: { type: 'object' } },
      required: ['zoneId', 'recordId', 'body'],
    },
    handler: async (a, ctx) => {
      const r = await cfFetch<DnsRecord>(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/${reqString(a, 'recordId')}`, {
        method: 'PATCH',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok(`Updated ${r.type} ${r.name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_dns_delete',
    description: 'Delete a DNS record',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { zoneId: { type: 'string' }, recordId: { type: 'string' } },
      required: ['zoneId', 'recordId'],
    },
    handler: async (a, ctx) => {
      await cfFetch(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/${reqString(a, 'recordId')}`, { method: 'DELETE' });
      return ok('DNS record deleted.');
    },
  }),
  contributeTool({
    name: 'cf_dns_export',
    description: 'Export a zone file',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { zoneId: { type: 'string' } }, required: ['zoneId'] },
    handler: async (a, ctx) => {
      const text = await cfText(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/export`);
      return ok(text, { details: { zoneFile: text } });
    },
  }),
  contributeTool({
    name: 'cf_dns_batch',
    description: 'Apply a DNS record batch using Cloudflare batch body',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { zoneId: { type: 'string' }, body: { type: 'object' } }, required: ['zoneId', 'body'] },
    handler: async (a, ctx) => {
      const r = await cfFetch(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/batch`, {
        method: 'POST',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok('DNS batch applied.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_dns_scan_trigger',
    description: 'Trigger DNS record scan for a zone',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { zoneId: { type: 'string' } }, required: ['zoneId'] },
    handler: async (a, ctx) => {
      const r = await cfFetch(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/scan/trigger`, { method: 'POST', body: JSON.stringify({}) });
      return ok('DNS scan triggered.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_dns_scan_review',
    description: 'List DNS scan review records',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { zoneId: { type: 'string' } }, required: ['zoneId'] },
    handler: async (a, ctx) => {
      const rows = await cfPaged<Record<string, unknown>>(ctx, `/zones/${reqString(a, 'zoneId')}/dns_records/scan/review`);
      return list(rows, (r) => `- ${String(r.name ?? r.type ?? JSON.stringify(r))}`, 'No review records.');
    },
  }),
];
