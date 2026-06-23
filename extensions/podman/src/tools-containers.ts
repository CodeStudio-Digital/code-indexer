/**
 * Container tools: list, custom run, pause/unpause, start/stop, remove, logs,
 * inspect. Run flags are assembled by @mcp/podman-core's `runArgs` so a run
 * launched here is identical to one the company runtime would build.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  psArgs,
  runArgs,
  pauseArgs,
  unpauseArgs,
  startArgs,
  stopArgs,
  rmArgs,
  logsArgs,
  inspectArgs,
  parseContainers,
  type RunSpec,
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
  optNumber,
  optBool,
  toList,
  toRecord,
} from './lib.js';

const renderContainer = (c: { names: string[]; image: string; state: string; status: string; ports: string }) =>
  `- ${c.names[0] ?? '(unnamed)'} · ${c.image} · ${c.state}${c.ports ? ` · ${c.ports}` : ''} · ${c.status}`;

export const containerTools = [
  contributeTool({
    name: 'podman_ps',
    description: 'List Podman containers (running by default; pass all=true for every state)',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { all: { type: 'boolean' } } },
    handler: async (a, ctx: PluginToolContext) => {
      const containers = await podmanJson(ctx, psArgs({ all: optBool(a, 'all') }), parseContainers);
      return list(containers, renderContainer, 'No containers.');
    },
  }),

  contributeTool({
    name: 'podman_run',
    description:
      'Run a container from an image with custom name, ports, env, volumes and command (detached by default)',
    riskLevel: 'execute',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string' },
        name: { type: 'string' },
        ports: { type: 'array', items: { type: 'string' }, description: 'host:container entries' },
        env: { type: 'object', description: 'KEY/VALUE environment map' },
        volumes: { type: 'array', items: { type: 'string' }, description: '/host:/container mounts' },
        workdir: { type: 'string' },
        network: { type: 'string' },
        command: { type: 'array', items: { type: 'string' } },
        detach: { type: 'boolean', description: 'default true' },
        remove: { type: 'boolean', description: '--rm on exit' },
      },
      required: ['image'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const spec: RunSpec = {
        image: reqString(a, 'image'),
        name: optString(a, 'name'),
        detach: a.detach === undefined ? true : optBool(a, 'detach'),
        remove: optBool(a, 'remove'),
        ports: toList(a.ports),
        env: toRecord(a.env),
        volumes: toList(a.volumes),
        workdir: optString(a, 'workdir'),
        network: optString(a, 'network'),
        command: toList(a.command),
      };
      const r = await podman(ctx, runArgs(spec));
      const out = r.stdout.trim();
      if (r.code !== 0) return fail(out || `podman run failed (exit ${r.code})`);
      return ok(`Started ${spec.name ?? spec.image}${out ? ` (${out.slice(0, 12)})` : ''}.`, {
        details: { id: out, image: spec.image, name: spec.name },
      });
    },
  }),

  lifecycle('podman_pause', 'Pause a running container', 'write', (id) => pauseArgs(id), 'Paused'),
  lifecycle('podman_unpause', 'Resume a paused container', 'write', (id) => unpauseArgs(id), 'Resumed'),
  lifecycle('podman_start', 'Start a stopped container', 'write', (id) => startArgs(id), 'Started'),

  contributeTool({
    name: 'podman_stop',
    description: 'Stop a running container (optional grace seconds)',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { container: { type: 'string' }, graceSeconds: { type: 'number' } },
      required: ['container'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(ctx, stopArgs(reqString(a, 'container'), optNumber(a, 'graceSeconds')), () => 'Stopped.'),
  }),

  contributeTool({
    name: 'podman_rm',
    description: 'Remove a container (force + volumes optional)',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        force: { type: 'boolean' },
        volumes: { type: 'boolean' },
      },
      required: ['container'],
    },
    handler: async (a, ctx: PluginToolContext) =>
      podmanRun(
        ctx,
        rmArgs(reqString(a, 'container'), { force: optBool(a, 'force'), volumes: optBool(a, 'volumes') }),
        () => 'Removed.',
      ),
  }),

  contributeTool({
    name: 'podman_logs',
    description: 'Fetch a container’s recent logs',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { container: { type: 'string' }, tail: { type: 'number' } },
      required: ['container'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const r = await podman(ctx, logsArgs(reqString(a, 'container'), { tail: optNumber(a, 'tail') ?? 200 }));
      if (r.code !== 0) return fail(r.stdout.trim() || `podman logs failed (exit ${r.code})`);
      return ok(r.stdout.trim() || '(no output)');
    },
  }),

  contributeTool({
    name: 'podman_inspect',
    description: 'Inspect a container and return its raw JSON',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { container: { type: 'string' } },
      required: ['container'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const r = await podman(ctx, inspectArgs(reqString(a, 'container')));
      if (r.code !== 0) return fail(r.stdout.trim() || `podman inspect failed (exit ${r.code})`);
      return ok(r.stdout.trim(), { details: safeJson(r.stdout) });
    },
  }),
];

/** Small factory for the single-arg `container` lifecycle verbs. */
function lifecycle(
  name: string,
  description: string,
  riskLevel: 'read' | 'write' | 'execute' | 'admin',
  toArgs: (id: string) => string[],
  verb: string,
) {
  return contributeTool({
    name,
    description,
    riskLevel,
    mutates: true,
    parameters: {
      type: 'object',
      properties: { container: { type: 'string' } },
      required: ['container'],
    },
    handler: async (a: Record<string, unknown>, ctx: PluginToolContext) =>
      podmanRun(ctx, toArgs(reqString(a, 'container')), () => `${verb}.`),
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
