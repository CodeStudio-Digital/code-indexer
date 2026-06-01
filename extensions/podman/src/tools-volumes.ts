/**
 * Volume tools: list, create, inspect, remove.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  volumeLsArgs,
  volumeCreateArgs,
  volumeInspectArgs,
  volumeRmArgs,
  parseVolumes,
  type VolumeSummary,
} from '@mcp/podman-core';
import {
  podman,
  podmanJson,
  podmanRun,
  ok,
  fail,
  list,
  reqString,
  optString,
  optBool,
  toRecord,
} from './lib.js';

const renderVolume = (v: VolumeSummary) => `- ${v.name} · ${v.driver}${v.mountpoint ? ` · ${v.mountpoint}` : ''}`;

export const volumeTools = [
  contributeTool({
    name: 'podman_volume_ls',
    description: 'List Podman volumes',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const volumes = await podmanJson(ctx, volumeLsArgs(), parseVolumes);
      return list(volumes, renderVolume, 'No volumes.');
    },
  }),

  contributeTool({
    name: 'podman_volume_create',
    description: 'Create a named volume',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        driver: { type: 'string' },
        labels: { type: 'object' },
      },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(
        ctx,
        volumeCreateArgs(reqString(a, 'name'), { driver: optString(a, 'driver'), labels: toRecord(a.labels) }),
        (out) => `Created volume ${out || reqString(a, 'name')}.`,
      ),
  }),

  contributeTool({
    name: 'podman_volume_inspect',
    description: 'Inspect a volume and return its raw JSON',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (a, ctx: PluginToolContext) => {
      const r = await podman(ctx, volumeInspectArgs(reqString(a, 'name')));
      if (r.code !== 0) return fail(r.stdout.trim() || `podman volume inspect failed (exit ${r.code})`);
      return ok(r.stdout.trim());
    },
  }),

  contributeTool({
    name: 'podman_volume_rm',
    description: 'Remove a volume (force optional)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, force: { type: 'boolean' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(ctx, volumeRmArgs(reqString(a, 'name'), { force: optBool(a, 'force') }), () => 'Removed.'),
  }),
];
