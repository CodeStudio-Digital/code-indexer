/**
 * Deployment history + last-deploy info for the current Worker, and account
 * analytics. Worker deployments: /accounts/:id/workers/scripts/:script/
 * deployments. Uses the project's wrangler config to resolve the script name.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list, detectCloudflare } from './lib.js';

interface Deployment {
  id: string;
  created_on?: string;
  author_email?: string;
  source?: string;
}

async function script(ctx: PluginToolContext, override?: string): Promise<string | null> {
  return override ?? (await detectCloudflare(ctx)).workerName;
}

export const deployTools = [
  contributeTool({
    name: 'cf_deployments',
    description: 'List recent deployments of the current Worker',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const s = await script(ctx, (a as { script?: string }).script);
      if (!s) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct<{ deployments?: Deployment[] }>(
        ctx,
        `/workers/scripts/${s}/deployments`,
      );
      return list(
        r?.deployments?.slice(0, 15),
        (d) => `- ${d.created_on ?? '?'} ${d.source ?? ''} ${d.author_email ?? ''} (${d.id})`,
        'No deployments.',
      );
    },
  }),
  contributeTool({
    name: 'cf_last_deploy',
    description: 'Show the most recent deployment of the current Worker',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const s = await script(ctx, (a as { script?: string }).script);
      if (!s) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct<{ deployments?: Deployment[] }>(
        ctx,
        `/workers/scripts/${s}/deployments`,
      );
      const d = r?.deployments?.[0];
      if (!d) return ok('No deployments yet.');
      return ok(
        `Last deploy of ${s}:\n- when: ${d.created_on ?? '?'}\n- by: ${d.author_email ?? '?'}\n- source: ${d.source ?? '?'}\n- id: ${d.id}`,
      );
    },
  }),
];
