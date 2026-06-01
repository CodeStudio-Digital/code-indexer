/**
 * Project tools: detect containerization files in /projects/{id} and run a
 * project from its own Dockerfile/Containerfile (build → run with the project
 * bind-mounted at /app). Mirrors the company runtime's project→container model
 * (root_path → bind-mount) but for ad-hoc IDE runs.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { buildArgs, runArgs } from '@mcp/podman-core';
import { podman, ok, fail, details, optString, optBool } from './lib.js';

const CONTAINERFILES = ['Containerfile', 'Dockerfile'];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

interface PodmanDetect {
  containerfile: string | null;
  composeFile: string | null;
  exposedPorts: number[];
}

async function detect(ctx: PluginToolContext): Promise<PodmanDetect> {
  const out: PodmanDetect = { containerfile: null, composeFile: null, exposedPorts: [] };
  if (!ctx.fs) return out;
  for (const f of CONTAINERFILES) {
    if (await ctx.fs.exists(f)) {
      out.containerfile = f;
      try {
        out.exposedPorts = parseExpose(await ctx.fs.readFile(f));
      } catch {
        /* ignore unreadable Containerfile */
      }
      break;
    }
  }
  for (const f of COMPOSE_FILES) {
    if (await ctx.fs.exists(f)) {
      out.composeFile = f;
      break;
    }
  }
  return out;
}

/** Pull every numeric port out of `EXPOSE` lines (e.g. `EXPOSE 80 443/tcp`). */
function parseExpose(text: string): number[] {
  const ports: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*EXPOSE\s+(.+)$/i);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      const n = Number(tok.split('/')[0]);
      if (Number.isInteger(n) && n > 0 && !ports.includes(n)) ports.push(n);
    }
  }
  return ports;
}

function slug(name: string | null): string {
  return (name ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export const projectTools = [
  contributeTool({
    name: 'podman_detect',
    description:
      'Detect Podman/Docker containerization in the current project (Dockerfile, Containerfile, compose) and exposed ports',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const d = await detect(ctx);
      const found = d.containerfile || d.composeFile;
      if (!found) return ok('No container files found (no Dockerfile/Containerfile/compose).', { details: d });
      return ok(
        `Containerized project.\n- containerfile: ${d.containerfile ?? '-'}\n- compose: ${d.composeFile ?? '-'}\n- exposed: ${d.exposedPorts.join(', ') || '-'}`,
        { details: d },
      );
    },
  }),

  contributeTool({
    name: 'podman_project_run',
    description:
      'Build the project image from its Dockerfile/Containerfile and run it with the project bind-mounted at /app',
    riskLevel: 'execute',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'image tag (default podman-<project>:dev)' },
        name: { type: 'string', description: 'container name (default <project>)' },
        hostPort: { type: 'number', description: 'host port to publish onto the exposed port' },
        mount: { type: 'boolean', description: 'bind-mount the project at /app (default true)' },
        noCache: { type: 'boolean' },
      },
    },
    handler: async (a, ctx: PluginToolContext) => {
      const d = await detect(ctx);
      if (!d.containerfile) return fail('no Dockerfile/Containerfile in this project — nothing to build');
      const tag = optString(a, 'tag') ?? `podman-${slug(ctx.projectName)}:dev`;
      const built = await podman(
        ctx,
        buildArgs({ tag, file: d.containerfile, context: '.', noCache: optBool(a, 'noCache') }),
      );
      if (built.code !== 0) return fail(built.stdout.trim() || `build failed (exit ${built.code})`);

      const containerPort = d.exposedPorts[0];
      const hostPort = Number(a.hostPort) || containerPort;
      const ports = containerPort && hostPort ? [`${hostPort}:${containerPort}`] : [];
      const mount = a.mount === undefined ? true : optBool(a, 'mount');
      const run = await podman(
        ctx,
        runArgs({
          image: tag,
          name: optString(a, 'name') ?? slug(ctx.projectName),
          detach: true,
          ports,
          volumes: mount ? [`${ctx.cwd}:/app`] : [],
        }),
      );
      const out = run.stdout.trim();
      if (run.code !== 0) return fail(out || `run failed (exit ${run.code})`);
      const url = hostPort ? `\n- preview: http://localhost:${hostPort}` : '';
      return details(`Built ${tag} and started ${slug(ctx.projectName)} (${out.slice(0, 12)}).${url}`, {
        id: out,
        tag,
        ports,
      });
    },
  }),
];
