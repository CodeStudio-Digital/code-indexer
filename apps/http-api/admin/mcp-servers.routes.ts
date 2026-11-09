/**
 * /mcp-servers CRUD + connectivity test + tool enumeration.
 *
 * Thin wrappers around McpServerStore. auth_token values returned on list/get
 * are masked; write endpoints accept the full value. The `/test` endpoint
 * connects to the MCP server, lists its tools, and disconnects.
 */
import { Hono } from 'hono';
import { McpServerStore, type McpTransport, type McpAuthType, type McpDefaultTier, type McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { maskKey } from './shared/mask.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import type { ToolMeta } from '@mcp/code-agent/tools/tiers.js';
import { getGlobalMcpExternalPool } from '../sse/McpExternalPool.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';

interface ExternalToolInfo {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
  tier: string;
}

/** Keep the process-wide catalogue in lockstep with persisted admin changes. */
export async function refreshGlobalMcpExternalPool(serverId?: string): Promise<void> {
  const pool = getGlobalMcpExternalPool();
  if (pool) {
    if (serverId) await pool.refreshServer(serverId);
    else await pool.refresh();
  }
}

export function brokerRouteReadiness(status: unknown): {
  ready: boolean;
  error?: string;
} {
  if (!status || typeof status !== 'object') {
    return { ready: false, error: 'Unity broker returned an invalid status payload.' };
  }
  const value = status as Record<string, unknown>;
  if (value.bridgeConnected !== true) {
    return { ready: false, error: 'Unity broker is online, but no Unity bridge is connected.' };
  }
  if (value.routeReady === false) {
    return {
      ready: false,
      error: typeof value.routeError === 'string' && value.routeError
        ? value.routeError
        : 'Unity broker has no ready active project route.',
    };
  }
  return { ready: true };
}

/**
 * Read cached external tools from the DB. No server connections needed —
 * tools are cached when the user clicks "Test" on a server.
 *
 * Returns ToolMeta[] compatible with getAllKnownToolsMeta() output.
 */
export function enumerateExternalTools(dbPath: string): {
  tools: ToolMeta[];
  details: ExternalToolInfo[];
} {
  const store = new McpServerStore(dbPath);
  try {
    const cached = store.getAllCachedExternalTools();
    const tools: ToolMeta[] = cached.map((t) => ({
      name: t.name,
      tier: t.tier,
      source: 'mcp_external',
      description: t.description,
    }));
    const details: ExternalToolInfo[] = cached.map((t) => ({
      name: t.name,
      description: t.description,
      serverId: t.serverId,
      serverName: t.serverName,
      tier: t.tier,
    }));
    return { tools, details };
  } finally {
    store.close();
  }
}

const RESERVED_HEADER_NAMES = new Set(['authorization', 'cookie', 'mcp-session-id']);

/**
 * Reject attempts to set reserved HTTP headers via the admin API.
 * Returns the offending name (lowercased) if one is found.
 *
 * Authorization is driven by auth_type; Cookie and Mcp-Session-Id are
 * owned by the MCP transport. Allowing overrides here would cause either
 * silent breakage or subtle auth bugs.
 */
function findReservedHeader(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const headers = (config as Record<string, unknown>).headers;
  if (!headers || typeof headers !== 'object') return null;
  for (const key of Object.keys(headers as Record<string, unknown>)) {
    if (RESERVED_HEADER_NAMES.has(key.trim().toLowerCase())) return key;
  }
  return null;
}

function publicServer(s: McpServerConfig) {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    enabled: s.enabled,
    url: s.url,
    command: s.command,
    args: s.args,
    env: s.env,
    auth_type: s.auth_type,
    auth_token_masked: maskKey(s.auth_token),
    has_token: !!s.auth_token,
    default_tier: s.default_tier,
    config: s.config,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export interface McpAdminRuntime { dbPath?: string; bearerResolver?: ResolveMcpBearer; }

export function mcpServersRouter(runtime: McpAdminRuntime = {}): Hono {
  const app = new Hono();

  function getStore() {
    return new McpServerStore(runtime.dbPath ?? loadConfig().dbPath);
  }

  app.get('/mcp-servers', (c) => {
    const store = getStore();
    try {
      return c.json({ servers: store.listServers().map(publicServer) });
    } finally {
      store.close();
    }
  });

  app.get('/mcp-servers/:id', (c) => {
    const store = getStore();
    try {
      const s = store.getServer(c.req.param('id'));
      if (!s) return c.json({ error: 'not found' }, 404);
      return c.json(publicServer(s));
    } finally {
      store.close();
    }
  });

  app.post('/mcp-servers', async (c) => {
    const body = await c.req.json<{
      id: string;
      name: string;
      transport: McpTransport;
      enabled?: boolean;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      auth_type?: McpAuthType;
      auth_token?: string;
      default_tier?: McpDefaultTier;
      config?: Record<string, unknown>;
    }>();
    if (!body.id || !body.name || !body.transport) {
      return c.json({ error: 'id, name, transport required' }, 400);
    }
    const reserved = findReservedHeader(body.config);
    if (reserved) {
      return c.json({ error: `reserved header "${reserved}" cannot be set` }, 400);
    }
    const store = getStore();
    let server: McpServerConfig;
    try {
      server = store.upsertServer(body);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    } finally {
      store.close();
    }
    await refreshGlobalMcpExternalPool(server.id).catch(() => undefined);
    return c.json(publicServer(server), 201);
  });

  app.patch('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const store = getStore();
    let server: McpServerConfig;
    try {
      const existing = store.getServer(id);
      if (!existing) return c.json({ error: 'not found' }, 404);

      const body = await c.req.json<{
        name?: string;
        transport?: McpTransport;
        enabled?: boolean;
        url?: string | null;
        command?: string | null;
        args?: string[];
        env?: Record<string, string>;
        auth_type?: McpAuthType;
        auth_token?: string | null;
        default_tier?: McpDefaultTier;
        config?: Record<string, unknown>;
      }>();

      const reserved = body.config !== undefined ? findReservedHeader(body.config) : null;
      if (reserved) {
        return c.json({ error: `reserved header "${reserved}" cannot be set` }, 400);
      }
      server = store.upsertServer({
        id,
        name: body.name ?? existing.name,
        transport: body.transport ?? existing.transport,
        enabled: body.enabled ?? existing.enabled,
        url: body.url !== undefined ? body.url : existing.url,
        command: body.command !== undefined ? body.command : existing.command,
        args: body.args ?? existing.args,
        env: body.env ?? existing.env,
        auth_type: body.auth_type ?? existing.auth_type,
        auth_token: body.auth_token !== undefined ? body.auth_token : existing.auth_token,
        default_tier: body.default_tier ?? existing.default_tier,
        config: body.config ?? existing.config,
      });
    } finally {
      store.close();
    }
    await refreshGlobalMcpExternalPool(server.id).catch(() => undefined);
    return c.json(publicServer(server));
  });

  app.delete('/mcp-servers/:id', async (c) => {
    const store = getStore();
    try {
      store.deleteServer(c.req.param('id'));
    } finally {
      store.close();
    }
    await refreshGlobalMcpExternalPool(c.req.param('id'));
    return c.json({ ok: true });
  });

  /**
   * POST /mcp-servers/:id/test — connectivity test.
   * Connects to the server, lists tools, disconnects. Returns tool count + latency.
   */
  app.post('/mcp-servers/:id/test', async (c) => {
    const store = getStore();
    try {
      const server = store.getServer(c.req.param('id'));
      if (!server) return c.json({ error: 'not found' }, 404);

      const pool = getGlobalMcpExternalPool();
      if (pool && server.enabled) {
        const start = Date.now();
        try {
          const snapshot = await pool.refreshServer(server.id);
          const tools = snapshot.tools.filter(t => t.serverId === server.id)
            .map(t => ({ name: t.toolName, description: t.description }));
          if (tools.some(t => t.name === 'broker_get_status')) {
            const status = await pool.callTool(server.id, 'broker_get_status', {});
            const readiness = status.ok ? brokerRouteReadiness(status.result.structuredData) : { ready: false, error: status.text };
            if (!readiness.ready) return c.json({ ok: false, tools, toolCount: tools.length, latencyMs: Date.now() - start, error: readiness.error });
          }
          store.replaceServerTools(server.id, tools);
          return c.json({ ok: true, transportReady: true, tools, toolCount: tools.length, latencyMs: Date.now() - start });
        } catch (e) {
          return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start });
        }
      }

      const manager = new McpServerManager(runtime.bearerResolver ?? null);
      const start = Date.now();
      try {
        await manager.connectServer(server);
        const { tools } = await manager.listAllTools();
        const state = manager.getConnectionStates().get(server.id);
        if (state?.state !== 'connected') throw new Error(state?.error ?? 'MCP tool discovery failed');
        // Strip the ext_<id>__ prefix for raw tool names
        const prefix = `ext_${server.id}__`;
        const toolList = tools.map((t) => ({
          name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
          description: t.description,
        }));
        // Cache discovered tools in the DB for instant access by tools/session panels
        store.replaceServerTools(server.id, toolList);
        if (toolList.some((tool) => tool.name === 'broker_get_status')) {
          const statusResult = await manager.callServerTool(server.id, 'broker_get_status', {});
          const readiness = statusResult.isError
            ? { ready: false, error: statusResult.content }
            : brokerRouteReadiness(statusResult.structuredData);
          if (!readiness.ready) {
            await manager.closeAll();
            return c.json({
              ok: false,
              toolCount: tools.length,
              latencyMs: Date.now() - start,
              tools: toolList,
              error: readiness.error,
            });
          }
        }
        await manager.closeAll();
        if (server.enabled) await refreshGlobalMcpExternalPool(server.id);
        return c.json({
          ok: true,
          transportReady: true,
          toolCount: tools.length,
          latencyMs: Date.now() - start,
          tools: toolList,
        });
      } catch (e) {
        await manager.closeAll();
        return c.json({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          latencyMs: Date.now() - start,
        });
      }
    } finally {
      store.close();
    }
  });

  /**
   * GET /mcp-servers/:id/tools — list tools exposed by a server.
   * Connects, enumerates, disconnects. Slower than /test but returns full metadata.
   */
  app.get('/mcp-servers/:id/tools', async (c) => {
    const store = getStore();
    try {
      const server = store.getServer(c.req.param('id'));
      if (!server) return c.json({ error: 'not found' }, 404);

      const manager = new McpServerManager(runtime.bearerResolver ?? null);
      try {
        await manager.connectServer(server);
        const { tools } = await manager.listAllTools();
        const state = manager.getConnectionStates().get(server.id);
        if (state?.state !== 'connected') throw new Error(state?.error ?? 'MCP tool discovery failed');
        const toolList = tools.map((t) => ({
          name: t.name,
          description: t.description,
          tier: server.default_tier,
        }));
        await manager.closeAll();
        return c.json({ tools: toolList });
      } catch (e) {
        await manager.closeAll();
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    } finally {
      store.close();
    }
  });

  return app;
}
