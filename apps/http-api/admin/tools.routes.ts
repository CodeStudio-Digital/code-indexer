/**
 * /tools — list all known tools with global disabled state, toggle individual
 * or batch disable/enable. Includes external MCP server tools.
 */
import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { getAllKnownToolsMeta, getToolTier } from '@mcp/code-agent/tools/tiers.js';
import { enumerateExternalTools } from './mcp-servers.routes.js';
import { loadConfig } from '@mcp/shared/utils/config.js';

export function toolsRouter(store: ProviderStore): Hono {
  const app = new Hono();

  /** List all known tools (built-in + external MCP) with global disabled state. */
  app.get('/tools', (c) => {
    const allTools = getAllKnownToolsMeta();
    const disabledSet = new Set(store.listGlobalDisabledTools());

    // Include cached external MCP server tools (populated by test/connect)
    let externalTools: ReturnType<typeof enumerateExternalTools>['tools'] = [];
    try {
      const config = loadConfig();
      const result = enumerateExternalTools(config.dbPath);
      externalTools = result.tools;
    } catch {
      // External server enumeration is best-effort — don't break the tools list
    }

    const tools = [...allTools, ...externalTools].map((t) => ({
      name: t.name,
      tier: t.tier,
      source: t.source,
      description: t.description,
      globallyDisabled: disabledSet.has(t.name),
    }));
    return c.json({ tools });
  });

  /** Toggle a single tool's global disabled state. */
  app.put('/tools/:name/disabled', async (c) => {
    const toolName = c.req.param('name');
    const body = await c.req.json<{ disabled: boolean }>();
    if (typeof body.disabled !== 'boolean') {
      return c.json({ error: 'disabled (boolean) required' }, 400);
    }
    const tier = getToolTier(toolName);
    const source = toolName.startsWith('ext_') ? 'mcp_external' : toolName.startsWith('mcp__') ? 'index' : 'native';
    store.setGlobalToolDisabled(toolName, body.disabled, { tier, source });
    return c.json({ ok: true });
  });

  /** Batch toggle global disabled state. */
  app.put('/tools/bulk-disabled', async (c) => {
    const body = await c.req.json<{
      tools: Array<{ name: string; disabled: boolean }>;
    }>();
    if (!Array.isArray(body.tools)) {
      return c.json({ error: 'tools array required' }, 400);
    }
    const items = body.tools.map((t) => ({
      tool_name: t.name,
      disabled: t.disabled,
      tier: getToolTier(t.name),
      source: t.name.startsWith('ext_') ? 'mcp_external' : t.name.startsWith('mcp__') ? 'index' : 'native',
    }));
    store.bulkSetGlobalDisabled(items);
    return c.json({ ok: true });
  });

  return app;
}
