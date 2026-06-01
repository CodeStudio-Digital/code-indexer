/**
 * Core Cloudflare plugin tools: project detection, auth/account selection, and
 * wrangler deploy. Resource-specific management lives in tools-*.ts modules.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  cfPaged,
  detectCloudflare,
  getAccountId,
  getToken,
  ok,
  fail,
  wrangler,
} from './lib.js';

interface Account {
  id: string;
  name: string;
}

export const tools = [
  contributeTool({
    name: 'cf_detect',
    description: 'Detect whether the current project is a Cloudflare Worker/Pages project',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const d = await detectCloudflare(ctx);
      if (!d.isCloudflare) return ok('Not a Cloudflare project (no wrangler config / deps found).');
      const kindLabel =
        d.deployKind === 'opennext'
          ? 'Next.js (OpenNext)'
          : d.deployKind === 'pages'
            ? 'Pages'
            : 'Worker';
      return ok(
        `Cloudflare project detected.\n- type: ${kindLabel}\n- config: ${d.configPath ?? d.openNextConfig ?? '-'}\n- worker: ${d.workerName ?? '-'}\n- package: ${d.packageName ?? '-'}`,
        { details: d },
      );
    },
  }),

  contributeTool({
    name: 'cf_set_token',
    description: 'Store a Cloudflare API token scoped to this plugin',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const token = String((a as { token?: string }).token ?? '').trim();
      if (!token) return fail('empty token');
      if (!ctx.storage) return fail('storage capability not granted');
      await ctx.storage.set('apiToken', token);
      return ok('Token saved. Run cf_whoami to verify and choose an account.');
    },
  }),

  contributeTool({
    name: 'cf_whoami',
    description: 'Verify the API token, list accounts, and select the first account by default',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      if (!(await getToken(ctx))) return fail('no token set — use cf_set_token first');
      const accounts = await cfPaged<Account>(ctx, '/accounts');
      if (!accounts.length) return fail('token valid but no accounts visible');
      const current = await getAccountId(ctx);
      if (!current && ctx.storage) await ctx.storage.set('accountId', accounts[0].id);
      const selected = current ?? accounts[0].id;
      const content = accounts
        .map((ac) => `${ac.id === selected ? '*' : '-'} ${ac.name} (${ac.id})`)
        .join('\n');
      return {
        content: `Authenticated. Accounts:\n${content}`,
        data: {
          rows: accounts.map((ac) => ({ id: ac.id, name: ac.name, selected: ac.id === selected })),
          selected,
        },
      };
    },
  }),

  contributeTool({
    name: 'cf_set_account',
    description: 'Select which Cloudflare account this project targets',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { accountId: { type: 'string' } },
      required: ['accountId'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const id = String((a as { accountId?: string }).accountId ?? '').trim();
      if (!id) return fail('empty accountId');
      if (!ctx.storage) return fail('storage capability not granted');
      await ctx.storage.set('accountId', id);
      return ok(`Account set to ${id}.`);
    },
  }),

  contributeTool({
    name: 'cf_deploy',
    description:
      'Deploy the current project. Routes by framework: OpenNext (Next.js) runs ' +
      'opennextjs-cloudflare build && deploy; a plain Worker runs wrangler deploy. ' +
      'For live build output prefer the panel (streamed); this one-shot returns at the end.',
    riskLevel: 'execute',
    mutates: true,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const d = await detectCloudflare(ctx);
      if (!d.isCloudflare) return fail('not a Cloudflare project — nothing to deploy');
      if (d.deployKind === 'opennext') {
        if (!ctx.exec) return fail('exec capability not granted');
        const build = await ctx.exec.run('npx', ['opennextjs-cloudflare', 'build'], { cwd: ctx.cwd });
        if (build.code !== 0) return { content: build.stdout || 'build failed', isError: true };
        const dep = await ctx.exec.run('npx', ['opennextjs-cloudflare', 'deploy'], { cwd: ctx.cwd });
        return {
          content: `${build.stdout}\n--- deploy ---\n${dep.stdout || '(no output)'}`,
          isError: dep.code !== 0,
        };
      }
      const r = await wrangler(ctx, ['deploy']);
      return { content: r.stdout || '(no output)', isError: r.code !== 0 };
    },
  }),

  contributeTool({
    name: 'cf_build',
    description: 'Build the project for Cloudflare (OpenNext: opennextjs-cloudflare build).',
    riskLevel: 'execute',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const d = await detectCloudflare(ctx);
      if (!ctx.exec) return fail('exec capability not granted');
      if (d.deployKind === 'opennext') {
        const r = await ctx.exec.run('npx', ['opennextjs-cloudflare', 'build'], { cwd: ctx.cwd });
        return { content: r.stdout || '(no output)', isError: r.code !== 0 };
      }
      return fail('build step only applies to OpenNext (Next.js) projects');
    },
  }),

  contributeTool({
    name: 'cf_preview',
    description: 'Build + run a local Cloudflare preview (OpenNext: opennextjs-cloudflare preview).',
    riskLevel: 'execute',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const d = await detectCloudflare(ctx);
      if (!ctx.exec) return fail('exec capability not granted');
      if (d.deployKind === 'opennext') {
        const b = await ctx.exec.run('npx', ['opennextjs-cloudflare', 'build'], { cwd: ctx.cwd });
        if (b.code !== 0) return { content: b.stdout || 'build failed', isError: true };
        const p = await ctx.exec.run('npx', ['opennextjs-cloudflare', 'preview'], { cwd: ctx.cwd });
        return { content: `${b.stdout}\n--- preview ---\n${p.stdout || '(no output)'}`, isError: p.code !== 0 };
      }
      const r = await wrangler(ctx, ['dev']);
      return { content: r.stdout || '(no output)', isError: r.code !== 0 };
    },
  }),
];
