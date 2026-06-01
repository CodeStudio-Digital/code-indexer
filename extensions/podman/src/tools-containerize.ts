/**
 * Containerize tool — generate a secure, multi-stage Containerfile (+ .dockerignore)
 * for a project that doesn't ship one yet. Detection facts are read via the
 * granted fs capability; the actual content comes from @mcp/podman-core's pure
 * generator so it stays testable and consistent with the assistant's advice.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  chooseStack,
  renderContainerfile,
  renderDockerignore,
  type ContainerStack,
  type StackFacts,
} from '@mcp/podman-core';
import { ok, fail, optString, optNumber, optBool } from './lib.js';

const STACKS: ContainerStack[] = ['node', 'python', 'go', 'static'];
const DEFAULT_PORT: Record<ContainerStack, number> = { node: 3000, python: 8000, go: 8080, static: 8080 };

async function exists(ctx: PluginToolContext, path: string): Promise<boolean> {
  return ctx.fs ? ctx.fs.exists(path) : false;
}

async function gatherFacts(ctx: PluginToolContext): Promise<StackFacts> {
  const facts: StackFacts = {
    hasPackageJson: await exists(ctx, 'package.json'),
    hasRequirements: await exists(ctx, 'requirements.txt'),
    hasPyproject: await exists(ctx, 'pyproject.toml'),
    hasGoMod: await exists(ctx, 'go.mod'),
    hasIndexHtml: await exists(ctx, 'index.html'),
  };
  if (facts.hasPackageJson && ctx.fs) {
    try {
      const pkg = JSON.parse(await ctx.fs.readFile('package.json')) as { scripts?: Record<string, string> };
      facts.scripts = pkg.scripts ?? {};
    } catch {
      /* unreadable/!json package.json — detection falls back to file presence */
    }
  }
  return facts;
}

export const containerizeTools = [
  contributeTool({
    name: 'podman_containerize',
    description:
      'Generate a secure multi-stage Containerfile + .dockerignore for a project that has none (auto-detects node/python/go/static)',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        stack: { type: 'string', enum: STACKS, description: 'override detection' },
        port: { type: 'number', description: 'container port to EXPOSE' },
        filename: { type: 'string', enum: ['Containerfile', 'Dockerfile'], description: 'default Containerfile' },
        force: { type: 'boolean', description: 'overwrite an existing Containerfile/Dockerfile' },
      },
    },
    handler: async (a, ctx: PluginToolContext) => {
      if (!ctx.fs) return fail('fs capability not granted');
      const filename = optString(a, 'filename') === 'Dockerfile' ? 'Dockerfile' : 'Containerfile';
      if (!optBool(a, 'force') && ((await exists(ctx, 'Containerfile')) || (await exists(ctx, 'Dockerfile')))) {
        return fail('project already has a Dockerfile/Containerfile — pass force:true to overwrite');
      }

      const facts = await gatherFacts(ctx);
      const override = optString(a, 'stack') as ContainerStack | undefined;
      if (override && !STACKS.includes(override)) return fail(`unknown stack "${override}"`);
      const choice = override
        ? { stack: override, port: optNumber(a, 'port') ?? DEFAULT_PORT[override] }
        : chooseStack(facts);
      if (!choice) return fail('could not detect a stack — pass stack: node | python | go | static');

      const port = optNumber(a, 'port') ?? choice.port;
      const content = renderContainerfile(choice.stack, {
        port,
        hasBuild: !!facts.scripts?.build,
        hasPackageJson: facts.hasPackageJson,
      });
      const dockerignore = renderDockerignore(choice.stack);
      await ctx.fs.writeFile(filename, content);
      await ctx.fs.writeFile('.dockerignore', dockerignore);
      return ok(
        `Containerized as ${choice.stack} → wrote ${filename} + .dockerignore (EXPOSE ${port}). Review it, then build with podman_project_run.`,
        { details: { stack: choice.stack, port, filename, containerfile: content, dockerignore } },
      );
    },
  }),
];
