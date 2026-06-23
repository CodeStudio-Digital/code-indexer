/**
 * Cache — purge a zone's cache (everything or specific URLs). REST:
 * POST /zones/:id/purge_cache.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfFetch, ok, fail } from './lib.js';

export const cacheTools = [
  contributeTool({
    name: 'cf_cache_purge',
    description: 'Purge a zone cache — all files, or a list of URLs',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        zoneId: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
      },
      required: ['zoneId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { zoneId, urls } = a as { zoneId?: string; urls?: string[] };
      if (!zoneId) return fail('zoneId is required');
      const body = urls?.length ? { files: urls } : { purge_everything: true };
      await cfFetch(ctx, `/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(urls?.length ? `Purged ${urls.length} URL(s).` : 'Purged the entire zone cache.');
    },
  }),
];
