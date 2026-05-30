/**
 * DNS / Zones — list zones, and list/create DNS records in a zone. Zones are
 * account-agnostic in the path (/zones), records are /zones/:id/dns_records.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfFetch, ok, fail, list } from './lib.js';

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
}

export const dnsTools = [
  contributeTool({
    name: 'cf_zones_list',
    description: 'List zones (domains)',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const zs = await cfFetch<Zone[]>(ctx, '/zones?per_page=100');
      return list(zs, (z) => `- ${z.name} (${z.id})${z.status ? ` [${z.status}]` : ''}`, 'No zones.');
    },
  }),
  contributeTool({
    name: 'cf_dns_list',
    description: 'List DNS records in a zone (by id)',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { zoneId: { type: 'string' } },
      required: ['zoneId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const zoneId = String((a as { zoneId?: string }).zoneId ?? '');
      if (!zoneId) return fail('zoneId is required');
      const rs = await cfFetch<DnsRecord[]>(ctx, `/zones/${zoneId}/dns_records?per_page=100`);
      return list(
        rs,
        (r) => `- ${r.type} ${r.name} → ${r.content}${r.proxied ? ' (proxied)' : ''}`,
        'No DNS records.',
      );
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
      },
      required: ['zoneId', 'type', 'name', 'content'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { zoneId, type, name, content, proxied } = a as {
        zoneId?: string;
        type?: string;
        name?: string;
        content?: string;
        proxied?: boolean;
      };
      if (!zoneId || !type || !name || !content) {
        return fail('zoneId, type, name, content are required');
      }
      await cfFetch(ctx, `/zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type, name, content, proxied: proxied ?? false }),
      });
      return ok(`Created ${type} ${name} → ${content}.`);
    },
  }),
];
