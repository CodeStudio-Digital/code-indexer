/**
 * Smaller resource groups: Durable Objects, Workers AI, Hyperdrive, Cron
 * triggers. Each is read-oriented (list) with a couple of actions where the
 * API is simple. All reuse cfAcct + list.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list, detectCloudflare } from './lib.js';

export const miscTools = [
  // ── Durable Objects ──
  contributeTool({
    name: 'cf_do_namespaces',
    description: 'List Durable Object namespaces',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ns = await cfAcct<Array<{ id: string; name: string; class?: string }>>(
        ctx,
        '/workers/durable_objects/namespaces',
      );
      return list(ns, (n) => `- ${n.name}${n.class ? ` [${n.class}]` : ''} (${n.id})`, 'No Durable Object namespaces.');
    },
  }),

  // ── Workers AI ──
  contributeTool({
    name: 'cf_ai_models',
    description: 'List available Workers AI models',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { search: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const search = String((a as { search?: string }).search ?? '').toLowerCase();
      const models = await cfAcct<Array<{ name: string; task?: { name: string } }>>(
        ctx,
        '/ai/models/search?per_page=100',
      );
      const filtered = search ? models.filter((m) => m.name.toLowerCase().includes(search)) : models;
      return list(filtered, (m) => `- ${m.name}${m.task ? ` (${m.task.name})` : ''}`, 'No models.');
    },
  }),

  // ── Hyperdrive ──
  contributeTool({
    name: 'cf_hyperdrive_list',
    description: 'List Hyperdrive configs',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const cfgs = await cfAcct<Array<{ id: string; name: string }>>(ctx, '/hyperdrive/configs');
      return list(cfgs, (c) => `- ${c.name} (${c.id})`, 'No Hyperdrive configs.');
    },
  }),

  // ── Cron triggers (per worker) ──
  contributeTool({
    name: 'cf_cron_list',
    description: 'List Cron Triggers for the current Worker',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { script: { type: 'string' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const override = (a as { script?: string }).script;
      const script = override ?? (await detectCloudflare(ctx)).workerName;
      if (!script) return fail('could not resolve the Worker name (pass script)');
      const r = await cfAcct<{ schedules?: Array<{ cron: string }> }>(
        ctx,
        `/workers/scripts/${script}/schedules`,
      );
      return list(r?.schedules, (s) => `- ${s.cron}`, 'No cron triggers.');
    },
  }),
];
