/**
 * Workers scripts, settings, and deployments. Actual project deploy remains
 * cf_deploy in tools.ts via wrangler deploy.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, cfAcctPaged, detectCloudflare, fail, list, ok, parseJson, reqString } from './lib.js';

interface Deployment {
  id: string;
  created_on?: string;
  author_email?: string;
  source?: string;
}

async function script(ctx: PluginToolContext, override?: unknown): Promise<string | null> {
  const explicit = String(override ?? '').trim();
  return explicit || (await detectCloudflare(ctx)).workerName;
}

export const deployTools = [
  contributeTool({
    name: 'cf_workers_list',
    description: 'List Workers scripts',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx) => {
      const rows = await cfAcctPaged<Record<string, unknown>>(ctx, '/workers/scripts');
      return list(rows, (w) => `- ${String(w.id ?? w.name ?? w.script_name ?? 'worker')}`, 'No Workers scripts.');
    },
  }),
  contributeTool({
    name: 'cf_worker_get',
    description: 'Get Worker script metadata',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/workers/scripts/${reqString(a, 'script')}`);
      return ok('Worker script details.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_worker_settings',
    description: 'Get Worker script settings',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/workers/scripts/${reqString(a, 'script')}/settings`);
      return ok('Worker settings.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_worker_settings_update',
    description: 'Patch Worker script settings',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { script: { type: 'string' }, body: { type: 'object' } }, required: ['script', 'body'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/workers/scripts/${reqString(a, 'script')}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok('Worker settings updated.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_worker_delete',
    description: 'Delete a Worker script',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
    handler: async (a, ctx) => {
      await cfAcct(ctx, `/workers/scripts/${reqString(a, 'script')}`, { method: 'DELETE' });
      return ok('Worker script deleted.');
    },
  }),
  contributeTool({
    name: 'cf_deployments',
    description: 'List recent deployments of a Worker',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const s = await script(ctx, a.script);
      if (!s) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct<{ deployments?: Deployment[] }>(ctx, `/workers/scripts/${s}/deployments`);
      return list(r?.deployments?.slice(0, 50), (d) => `- ${d.created_on ?? '?'} ${d.source ?? ''} ${d.author_email ?? ''} (${d.id})`, 'No deployments.');
    },
  }),
  contributeTool({
    name: 'cf_deployment_get',
    description: 'Get Worker deployment details',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { script: { type: 'string' }, deploymentId: { type: 'string' } },
      required: ['deploymentId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const s = await script(ctx, a.script);
      if (!s) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct(ctx, `/workers/scripts/${s}/deployments/${reqString(a, 'deploymentId')}`);
      return ok('Worker deployment details.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_deployment_delete',
    description: 'Delete a Worker deployment',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { script: { type: 'string' }, deploymentId: { type: 'string' } },
      required: ['deploymentId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const s = await script(ctx, a.script);
      if (!s) return fail('could not resolve the Worker name (pass script)');
      await cfAcct(ctx, `/workers/scripts/${s}/deployments/${reqString(a, 'deploymentId')}`, { method: 'DELETE' });
      return ok('Worker deployment deleted.');
    },
  }),
  contributeTool({
    name: 'cf_last_deploy',
    description: 'Show the most recent deployment of the current Worker',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const s = await script(ctx, a.script);
      if (!s) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct<{ deployments?: Deployment[] }>(ctx, `/workers/scripts/${s}/deployments`);
      const d = r?.deployments?.[0];
      if (!d) return ok('No deployments yet.');
      return ok(`Last deploy of ${s}:\n- when: ${d.created_on ?? '?'}\n- by: ${d.author_email ?? '?'}\n- source: ${d.source ?? '?'}\n- id: ${d.id}`, { details: d });
    },
  }),
];
