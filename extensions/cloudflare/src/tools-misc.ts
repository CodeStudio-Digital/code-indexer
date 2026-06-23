/**
 * Durable Objects, Workers AI, Hyperdrive, and Cron triggers.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, cfAcctPaged, detectCloudflare, fail, list, ok, parseJson, reqString } from './lib.js';

interface DurableObjectNamespace {
  id: string;
  name: string;
  class?: string;
}

async function scriptName(ctx: PluginToolContext, override?: unknown): Promise<string | null> {
  const explicit = String(override ?? '').trim();
  return explicit || (await detectCloudflare(ctx)).workerName;
}

export const miscTools = [
  contributeTool({
    name: 'cf_do_namespaces',
    description: 'List Durable Object namespaces',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ns = await cfAcctPaged<DurableObjectNamespace>(ctx, '/workers/durable_objects/namespaces');
      return list(ns, (n) => `- ${n.name}${n.class ? ` [${n.class}]` : ''} (${n.id})`, 'No Durable Object namespaces.');
    },
  }),
  contributeTool({
    name: 'cf_do_objects',
    description: 'List Durable Object object IDs in a namespace; Cloudflare does not expose internal storage here',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { namespaceId: { type: 'string' } }, required: ['namespaceId'] },
    handler: async (a, ctx) => {
      const rows = await cfAcctPaged<Record<string, unknown>>(
        ctx,
        `/workers/durable_objects/namespaces/${reqString(a, 'namespaceId')}/objects`,
      );
      return list(rows, (o) => `- ${String(o.id ?? o.object_id ?? JSON.stringify(o))}`, 'No Durable Object objects.');
    },
  }),
  contributeTool({
    name: 'cf_ai_models',
    description: 'List available Workers AI models',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { search: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const search = String((a as { search?: string }).search ?? '').toLowerCase();
      const models = await cfAcctPaged<{ name: string; task?: { name: string } }>(
        ctx,
        '/ai/models/search',
        200,
      );
      const filtered = search ? models.filter((m) => m.name.toLowerCase().includes(search)) : models;
      return list(filtered, (m) => `- ${m.name}${m.task ? ` (${m.task.name})` : ''}`, 'No models.');
    },
  }),
  contributeTool({
    name: 'cf_hyperdrive_list',
    description: 'List Hyperdrive configs',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const cfgs = await cfAcctPaged<{ id: string; name: string }>(ctx, '/hyperdrive/configs');
      return list(cfgs, (c) => `- ${c.name} (${c.id})`, 'No Hyperdrive configs.');
    },
  }),
  contributeTool({
    name: 'cf_hyperdrive_get',
    description: 'Get Hyperdrive config details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { configId: { type: 'string' } }, required: ['configId'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/hyperdrive/configs/${reqString(a, 'configId')}`);
      return ok('Hyperdrive config details.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_hyperdrive_create',
    description: 'Create a Hyperdrive config using the Cloudflare config body',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { body: { type: 'object' } }, required: ['body'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, '/hyperdrive/configs', { method: 'POST', body: JSON.stringify(parseJson(a.body, {})) });
      return ok('Hyperdrive config created.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_hyperdrive_update',
    description: 'Update a Hyperdrive config using the Cloudflare config body',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { configId: { type: 'string' }, body: { type: 'object' } }, required: ['configId', 'body'] },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/hyperdrive/configs/${reqString(a, 'configId')}`, {
        method: 'PUT',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok('Hyperdrive config updated.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_hyperdrive_delete',
    description: 'Delete a Hyperdrive config',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { configId: { type: 'string' } }, required: ['configId'] },
    handler: async (a, ctx) => {
      await cfAcct(ctx, `/hyperdrive/configs/${reqString(a, 'configId')}`, { method: 'DELETE' });
      return ok('Hyperdrive config deleted.');
    },
  }),
  contributeTool({
    name: 'cf_cron_list',
    description: 'List Cron Triggers for a Worker',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const script = await scriptName(ctx, a.script);
      if (!script) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct<{ schedules?: Array<{ cron: string }> }>(ctx, `/workers/scripts/${script}/schedules`);
      return list(r?.schedules, (s) => `- ${s.cron}`, 'No cron triggers.');
    },
  }),
  contributeTool({
    name: 'cf_cron_update',
    description: 'Replace Cron Triggers for a Worker',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { script: { type: 'string' }, schedules: { type: 'array' } }, required: ['schedules'] },
    handler: async (a, ctx: PluginToolContext) => {
      const script = await scriptName(ctx, a.script);
      if (!script) return fail('could not resolve the Worker name (pass script)');
      const schedules = parseJson(a.schedules, []);
      if (!Array.isArray(schedules)) return fail('schedules must be an array');
      const r = await cfAcct(ctx, `/workers/scripts/${script}/schedules`, {
        method: 'PUT',
        body: JSON.stringify({ schedules }),
      });
      return ok(`Updated cron triggers for ${script}.`, { details: r });
    },
  }),
];
