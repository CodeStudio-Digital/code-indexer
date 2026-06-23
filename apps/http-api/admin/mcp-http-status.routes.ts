/**
 * Admin route exposing the runtime status of the MCP HTTP endpoint —
 * what URL clients should hit, how many tools each tier sees, whether
 * auth is on, etc. The admin panel polls this so we don't hard-code
 * any of those answers in the dashboard bundle (they're config-driven
 * on the server).
 */
import { Hono } from 'hono';
import { allTools } from '@apps/mcp-server/tools/index.js';
import { getToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { McpTool } from '@apps/mcp-server/tool.js';

interface ToolSummary {
  name: string;
  tier: string;
  description: string;
}

function resolveTier(toolName: string): string {
  // Same heuristic as the HTTP transport — try the agent's prefixed
  // name (`mcp__<name>`) first so navigate/admin tools resolve, then
  // fall back to the bare name (covers `rag_search_docs` and friends).
  const prefixed = getToolTier(`mcp__${toolName}`);
  if (prefixed !== 'bootstrap') return prefixed;
  return getToolTier(toolName);
}

export function createMcpHttpStatusRouter(config: IndexerConfig): Hono {
  const app = new Hono();

  app.get('/mcp-http/status', (c) => {
    // Compute on every request because the tool catalogue is static
    // per process and the cost is trivial (~150 lookups). Saves us
    // from invalidating a cache on hot-reload.
    const tools: ToolSummary[] = (allTools as readonly McpTool[]).map((t) => ({
      name: t.name,
      tier: resolveTier(t.name),
      description: t.description.split('\n')[0].slice(0, 160),
    }));

    const byTier = tools.reduce<Record<string, number>>((acc, t) => {
      acc[t.tier] = (acc[t.tier] ?? 0) + 1;
      return acc;
    }, {});

    // Dashboard host + port + mcp.http.path → the URL clients use.
    // We render localhost explicitly because the host may be 0.0.0.0
    // for the LAN bind, but the endpoint guard rejects non-loopback
    // peers anyway — showing 127.0.0.1 here is the truthful answer.
    const port = config.dashboard.port;
    const endpoint = `http://127.0.0.1:${port}${config.mcp.http.path}`;

    return c.json({
      enabled: config.mcp.http.enabled,
      authEnabled: config.mcp.auth.enabled,
      stateful: config.mcp.http.stateful,
      endpoint,
      port,
      path: config.mcp.http.path,
      tools,
      counts: {
        total: tools.length,
        bootstrap: byTier.bootstrap ?? 0,
        navigate: byTier.navigate ?? 0,
        admin: byTier.admin ?? 0,
      },
    });
  });

  return app;
}
