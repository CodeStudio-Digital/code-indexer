/**
 * Network tools: list, create, inspect, remove.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  networkLsArgs,
  networkCreateArgs,
  networkInspectArgs,
  networkRmArgs,
  parseNetworks,
  type NetworkSummary,
} from '@mcp/podman-core';
import { podman, podmanJson, podmanRun, ok, fail, list, reqString, optString, optBool } from './lib.js';

const renderNetwork = (n: NetworkSummary) => `- ${n.name} · ${n.driver}${n.id ? ` · ${n.id.slice(0, 12)}` : ''}`;

export const networkTools = [
  contributeTool({
    name: 'podman_network_ls',
    description: 'List Podman networks',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const networks = await podmanJson(ctx, networkLsArgs(), parseNetworks);
      return list(networks, renderNetwork, 'No networks.');
    },
  }),

  contributeTool({
    name: 'podman_network_create',
    description: 'Create a network (optional driver + subnet)',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        driver: { type: 'string' },
        subnet: { type: 'string' },
      },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(
        ctx,
        networkCreateArgs(reqString(a, 'name'), { driver: optString(a, 'driver'), subnet: optString(a, 'subnet') }),
        (out) => `Created network ${out || reqString(a, 'name')}.`,
      ),
  }),

  contributeTool({
    name: 'podman_network_inspect',
    description: 'Inspect a network and return its raw JSON',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx: PluginToolContext) => {
      const r = await podman(ctx, networkInspectArgs(reqString(a, 'name')));
      if (r.code !== 0) return fail(r.stdout.trim() || `podman network inspect failed (exit ${r.code})`);
      return ok(r.stdout.trim());
    },
  }),

  contributeTool({
    name: 'podman_network_rm',
    description: 'Remove a network (force optional)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, force: { type: 'boolean' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(ctx, networkRmArgs(reqString(a, 'name'), { force: optBool(a, 'force') }), () => 'Removed.'),
  }),
];
