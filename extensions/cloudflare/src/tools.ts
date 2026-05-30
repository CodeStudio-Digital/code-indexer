/**
 * Cloudflare plugin tools (vertical slice): detect → auth (token) → whoami →
 * deploy → D1 list/query. All one-shot (REST via ctx.fetch, deploy via
 * `npx wrangler` through ctx.exec). Live `wrangler tail` arrives with the
 * streaming-exec rail; it's intentionally absent here.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfFetch, wrangler, detectCloudflare, getToken, getAccountId } from './lib.js';

const ok = (content: string) => ({ content });
const err = (content: string) => ({ content, isError: true });

interface Account {
  id: string;
  name: string;
}
interface D1Database {
  uuid: string;
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
      return ok(
        `Cloudflare project detected.\n- config: ${d.configPath ?? '—'}\n- worker: ${d.workerName ?? '—'}\n- package: ${d.packageName ?? '—'}`,
      );
    },
  }),

  contributeTool({
    name: 'cf_set_token',
    description: 'Store a Cloudflare API token (scoped to this plugin) for REST + wrangler',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const token = String((a as { token?: string }).token ?? '').trim();
      if (!token) return err('empty token');
      if (!ctx.storage) return err('storage capability not granted');
      await ctx.storage.set('apiToken', token);
      return ok('Token saved. Run "whoami" to verify and pick an account.');
    },
  }),

  contributeTool({
    name: 'cf_whoami',
    description: 'Verify the API token and list accounts; selects the first account by default',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      if (!(await getToken(ctx))) return err('no token set — use cf_set_token first');
      const accounts = await cfFetch<Account[]>(ctx, '/accounts');
      if (!accounts?.length) return err('token valid but no accounts visible');
      const current = await getAccountId(ctx);
      if (!current && ctx.storage) await ctx.storage.set('accountId', accounts[0].id);
      const selected = current ?? accounts[0].id;
      const list = accounts
        .map((ac) => `${ac.id === selected ? '●' : '○'} ${ac.name} (${ac.id})`)
        .join('\n');
      return ok(`Authenticated. Accounts:\n${list}`);
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
      if (!id) return err('empty accountId');
      if (!ctx.storage) return err('storage capability not granted');
      await ctx.storage.set('accountId', id);
      return ok(`Account set to ${id}.`);
    },
  }),

  contributeTool({
    name: 'cf_deploy',
    description: 'Deploy the current Worker project with `wrangler deploy`',
    riskLevel: 'execute',
    mutates: true,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const d = await detectCloudflare(ctx);
      if (!d.isCloudflare) return err('not a Cloudflare project — nothing to deploy');
      const r = await wrangler(ctx, ['deploy']);
      return { content: r.stdout || '(no output)', isError: r.code !== 0 };
    },
  }),

  contributeTool({
    name: 'cf_d1_list',
    description: 'List D1 databases in the selected account',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const acct = await getAccountId(ctx);
      if (!acct) return err('no account selected — run cf_whoami first');
      const dbs = await cfFetch<D1Database[]>(ctx, `/accounts/${acct}/d1/database`);
      return {
        content: dbs?.length ? dbs.map((db) => `- ${db.name} (${db.uuid})`).join('\n') : 'No D1 databases.',
        data: { rows: dbs ?? [] },
      };
    },
  }),

  contributeTool({
    name: 'cf_d1_query',
    description: 'Run a read SQL query against a D1 database (by name)',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, sql: { type: 'string' } },
      required: ['database', 'sql'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { database, sql } = a as { database?: string; sql?: string };
      const acct = await getAccountId(ctx);
      if (!acct) return err('no account selected — run cf_whoami first');
      if (!database || !sql) return err('database and sql are required');
      const dbs = await cfFetch<D1Database[]>(ctx, `/accounts/${acct}/d1/database`);
      const db = dbs.find((d) => d.name === database);
      if (!db) return err(`database "${database}" not found`);
      const out = await cfFetch<Array<{ results?: unknown[] }>>(
        ctx,
        `/accounts/${acct}/d1/database/${db.uuid}/query`,
        { method: 'POST', body: JSON.stringify({ sql }) },
      );
      const rows = (out?.[0]?.results ?? []) as Array<Record<string, unknown>>;
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return {
        content: `${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`,
        data: { rows, columns },
      };
    },
  }),
];
