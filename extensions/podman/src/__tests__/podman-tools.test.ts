import { describe, expect, it } from 'vitest';
import type { PluginToolContext } from '@mcp/plugin-sdk';
import { allTools } from '../all-tools.js';

interface ExecCall {
  cmd: string;
  args: string[];
}

/** Build a ctx whose exec records every call and replies from a canned table. */
function makeCtx(reply: (args: string[]) => { stdout: string; code: number }, files: Record<string, string> = {}) {
  const calls: ExecCall[] = [];
  const writes: Record<string, string> = {};
  const ctx: PluginToolContext = {
    projectName: 'demo',
    cwd: 'D:/projects/7',
    log: () => undefined,
    fetch: async () => new Response('null'),
    host: { invoke: async () => null },
    fs: {
      readFile: async (p: string) => files[p] ?? '',
      writeFile: async (p: string, c: string) => {
        writes[p] = c;
      },
      readdir: async () => [],
      exists: async (p: string) => p in files,
    },
    exec: {
      run: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return reply(args);
      },
    },
  };
  return { ctx, calls, writes };
}

function tool(name: string) {
  const t = allTools.find((c) => c.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

describe('podman plugin tools', () => {
  it('podman_ps parses JSON rows into summaries', async () => {
    const { ctx } = makeCtx(() => ({
      code: 0,
      stdout: JSON.stringify([
        { Id: 'c1', Names: ['web'], Image: 'nginx', State: 'running', Status: 'Up', Ports: [] },
      ]),
    }));
    const r = await tool('podman_ps').handler({}, ctx);
    expect((r.data as { rows: unknown[] }).rows).toHaveLength(1);
    expect(r.content).toContain('web');
  });

  it('podman_run assembles run argv with name, ports, env and command', async () => {
    const { ctx, calls } = makeCtx(() => ({ code: 0, stdout: 'abcdef123456' }));
    const r = await tool('podman_run').handler(
      { image: 'node:20', name: 'api', ports: ['3000:3000'], env: { NODE_ENV: 'dev' }, command: ['npm', 'run', 'dev'] },
      ctx,
    );
    expect(calls[0].cmd).toBe('podman');
    expect(calls[0].args).toEqual([
      'run', '-d', '--name', 'api',
      '-p', '3000:3000',
      '-e', 'NODE_ENV=dev',
      'node:20',
      'npm', 'run', 'dev',
    ]);
    expect(r.isError).toBeFalsy();
  });

  it('podman_pause maps to pause argv', async () => {
    const { ctx, calls } = makeCtx(() => ({ code: 0, stdout: '' }));
    await tool('podman_pause').handler({ container: 'c1' }, ctx);
    expect(calls[0].args).toEqual(['pause', 'c1']);
  });

  it('non-zero exit surfaces an error result', async () => {
    const { ctx } = makeCtx(() => ({ code: 125, stdout: 'no such container' }));
    const r = await tool('podman_stop').handler({ container: 'ghost' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no such container');
  });

  it('podman_detect reads EXPOSE from the Containerfile', async () => {
    const { ctx } = makeCtx(() => ({ code: 0, stdout: '' }), {
      Dockerfile: 'FROM node:20\nEXPOSE 8080 443/tcp\n',
    });
    const r = await tool('podman_detect').handler({}, ctx);
    expect((r.data as { details: { exposedPorts: number[] } }).details.exposedPorts).toEqual([8080, 443]);
  });

  it('podman_project_run builds then runs with a bind-mount and published port', async () => {
    const { ctx, calls } = makeCtx(() => ({ code: 0, stdout: 'deadbeefcafe' }), {
      Dockerfile: 'FROM node:20\nEXPOSE 5173\n',
    });
    await tool('podman_project_run').handler({}, ctx);
    expect(calls[0].args.slice(0, 3)).toEqual(['build', '-t', 'podman-demo:dev']);
    const runCall = calls[1].args;
    expect(runCall).toContain('-v');
    expect(runCall).toContain('D:/projects/7:/app');
    expect(runCall).toContain('5173:5173');
  });

  it('podman_containerize writes a non-root Containerfile + .dockerignore for a node project', async () => {
    const { ctx, writes } = makeCtx(() => ({ code: 0, stdout: '' }), {
      'package.json': JSON.stringify({ scripts: { start: 'node server.js', build: 'tsc' } }),
    });
    const r = await tool('podman_containerize').handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(writes['Containerfile']).toContain('USER node');
    expect(writes['Containerfile']).toContain('FROM node:20-alpine');
    expect(writes['.dockerignore']).toContain('node_modules');
  });

  it('podman_containerize refuses when a Containerfile already exists (no force)', async () => {
    const { ctx, writes } = makeCtx(() => ({ code: 0, stdout: '' }), { Containerfile: 'FROM scratch' });
    const r = await tool('podman_containerize').handler({}, ctx);
    expect(r.isError).toBe(true);
    expect(writes['Containerfile']).toBeUndefined();
  });

  it('podman_images expands references for the webview', async () => {
    const { ctx } = makeCtx(() => ({
      code: 0,
      stdout: JSON.stringify([{ Id: 'sha', Names: ['docker.io/library/node:20'], Size: 1048576 }]),
    }));
    const r = await tool('podman_images').handler({}, ctx);
    expect(r.content).toContain('docker.io/library/node:20');
  });
});
