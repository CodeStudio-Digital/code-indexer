/**
 * Pod + compose tools: pod ps/create/start/stop/rm and a compose passthrough
 * (up/down/ps). Compose discovers `compose.yaml` in the project dir unless a
 * file is given.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  podPsArgs,
  podCreateArgs,
  podStartArgs,
  podStopArgs,
  podRmArgs,
  composeArgs,
  parsePods,
  type PodSummary,
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
  toList,
  toRecord,
} from './lib.js';

const renderPod = (p: PodSummary) => `- ${p.name} · ${p.status} · ${p.containers} container(s)`;

export const podTools = [
  contributeTool({
    name: 'podman_pod_ps',
    description: 'List Podman pods',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const pods = await podmanJson(ctx, podPsArgs(), parsePods);
      return list(pods, renderPod, 'No pods.');
    },
  }),

  contributeTool({
    name: 'podman_pod_create',
    description: 'Create a pod (optional published ports + labels)',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        ports: { type: 'array', items: { type: 'string' } },
        labels: { type: 'object' },
      },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(
        ctx,
        podCreateArgs(reqString(a, 'name'), { ports: toList(a.ports), labels: toRecord(a.labels) }),
        (out) => `Created pod ${out || reqString(a, 'name')}.`,
      ),
  }),

  podLifecycle('podman_pod_start', 'Start a pod', (id) => podStartArgs(id), 'Started'),
  podLifecycle('podman_pod_stop', 'Stop a pod', (id) => podStopArgs(id), 'Stopped'),

  contributeTool({
    name: 'podman_pod_rm',
    description: 'Remove a pod (force optional)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { pod: { type: 'string' }, force: { type: 'boolean' } },
      required: ['pod'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(ctx, podRmArgs(reqString(a, 'pod'), { force: optBool(a, 'force') }), () => 'Removed.'),
  }),

  contributeTool({
    name: 'podman_compose',
    description: 'Run podman compose up/down/ps for the project (optional compose file)',
    riskLevel: 'execute',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'ps'] },
        file: { type: 'string' },
        detach: { type: 'boolean', description: 'default true for up' },
      },
      required: ['action'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const action = reqString(a, 'action') as 'up' | 'down' | 'ps';
      if (!['up', 'down', 'ps'].includes(action)) return fail('action must be up, down or ps');
      const detach = a.detach === undefined ? true : optBool(a, 'detach');
      const r = await podman(ctx, composeArgs(action, { file: optString(a, 'file'), detach }));
      if (r.code !== 0) return fail(r.stdout.trim() || `podman compose ${action} failed (exit ${r.code})`);
      return ok(r.stdout.trim() || `compose ${action} done.`);
    },
  }),
];

function podLifecycle(name: string, description: string, toArgs: (id: string) => string[], verb: string) {
  return contributeTool({
    name,
    description,
    riskLevel: 'write' as const,
    mutates: true,
    parameters: { type: 'object', properties: { pod: { type: 'string' } }, required: ['pod'] },
    handler: async (a: Record<string, unknown>, ctx: PluginToolContext) =>
      podmanRun(ctx, toArgs(reqString(a, 'pod')), () => `${verb}.`),
  });
}
