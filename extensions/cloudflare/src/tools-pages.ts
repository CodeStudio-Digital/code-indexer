/**
 * Pages — list projects + their recent deployments. REST:
 * /accounts/:id/pages/projects.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list } from './lib.js';

interface PagesProject {
  name: string;
  subdomain?: string;
  latest_deployment?: { created_on?: string; url?: string };
}

export const pagesTools = [
  contributeTool({
    name: 'cf_pages_list',
    description: 'List Pages projects',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ps = await cfAcct<PagesProject[]>(ctx, '/pages/projects');
      return list(
        ps,
        (p) => `- ${p.name}${p.subdomain ? ` (${p.subdomain})` : ''}`,
        'No Pages projects.',
      );
    },
  }),
  contributeTool({
    name: 'cf_pages_deployments',
    description: 'List recent deployments for a Pages project',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const project = String((a as { project?: string }).project ?? '');
      if (!project) return fail('project is required');
      const ds = await cfAcct<Array<{ id: string; created_on?: string; url?: string }>>(
        ctx,
        `/pages/projects/${encodeURIComponent(project)}/deployments`,
      );
      return list(
        ds?.slice(0, 15),
        (d) => `- ${d.created_on ?? '?'} ${d.url ?? ''} (${d.id})`,
        'No deployments.',
      );
    },
  }),
];
