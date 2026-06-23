/**
 * Worker secrets + vars. Secrets are write-only via the API (you can list
 * names, set, delete — never read the value back), so we list names + put +
 * delete. Plain (non-secret) vars live in the wrangler config; editing those is
 * the bindings tool's job. Secrets use the per-script secrets endpoint, so they
 * need the worker (script) name — resolved from the project's wrangler config.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, ok, fail, list, detectCloudflare } from './lib.js';

async function scriptName(ctx: PluginToolContext, override?: string): Promise<string | null> {
  if (override) return override;
  const d = await detectCloudflare(ctx);
  return d.workerName;
}

interface Secret {
  name: string;
  type?: string;
}

export const secretTools = [
  contributeTool({
    name: 'cf_secrets_list',
    description: 'List Worker secret names (values are never readable)',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { script: { type: 'string' } },
    },
    handler: async (a, ctx: PluginToolContext) => {
      const script = await scriptName(ctx, (a as { script?: string }).script);
      if (!script) return fail('could not resolve the Worker name (pass script)');
      const secrets = await cfAcct<Secret[]>(ctx, `/workers/scripts/${script}/secrets`);
      return list(secrets, (s) => `- ${s.name}`, 'No secrets.');
    },
  }),
  contributeTool({
    name: 'cf_secret_put',
    description: 'Create or update a Worker secret',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        script: { type: 'string' },
      },
      required: ['name', 'value'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { name, value } = a as { name?: string; value?: string; script?: string };
      const script = await scriptName(ctx, (a as { script?: string }).script);
      if (!script) return fail('could not resolve the Worker name (pass script)');
      if (!name) return fail('name is required');
      await cfAcct(ctx, `/workers/scripts/${script}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ name, text: value ?? '', type: 'secret_text' }),
      });
      return ok(`Set secret "${name}" on ${script}.`);
    },
  }),
  contributeTool({
    name: 'cf_secret_delete',
    description: 'Delete a Worker secret',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, script: { type: 'string' } },
      required: ['name'],
    },
    handler: async (a, ctx: PluginToolContext) => {
      const { name } = a as { name?: string; script?: string };
      const script = await scriptName(ctx, (a as { script?: string }).script);
      if (!script) return fail('could not resolve the Worker name (pass script)');
      if (!name) return fail('name is required');
      await cfAcct(ctx, `/workers/scripts/${script}/secrets/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      return ok(`Deleted secret "${name}" from ${script}.`);
    },
  }),
];
