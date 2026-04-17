/**
 * /mcp-servers CRUD + connectivity test + tool enumeration.
 *
 * Thin wrappers around McpServerStore. auth_token values returned on list/get
 * are masked; write endpoints accept the full value. The `/test` endpoint
 * connects to the MCP server, lists its tools, and disconnects.
 */
import { Hono } from 'hono';
import { McpServerStore, type McpTransport, type McpAuthType, type McpDefaultTier, type McpServerConfig } from '../../../store/mcp-server-store.js';
import { McpServerManager } from '../../../core/coder/tools/mcp-server-manager.js';
import { maskKey } from './shared/mask.js';
import { loadConfig } from '../../../utils/config.js';
import type { ToolMeta } from '../../../core/coder/tools/tiers.js';

export interface ExternalToolInfo {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
  tier: string;
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

export function mcpServersRouter(): Hono {
  const app = new Hono();

  function getStore() {
    const config = loadConfig();
    return new McpServerStore(config.dbPath);
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
    try {
      const server = store.upsertServer(body);
      return c.json(publicServer(server), 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    } finally {
      store.close();
    }
  });

  app.patch('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const store = getStore();
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
      const server = store.upsertServer({
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
      return c.json(publicServer(server));
    } finally {
      store.close();
    }
  });

  app.delete('/mcp-servers/:id', (c) => {
    const store = getStore();
    try {
      store.deleteServer(c.req.param('id'));
      return c.json({ ok: true });
    } finally {
      store.close();
    }
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

      const manager = new McpServerManager();
      const start = Date.now();
      try {
        await manager.connectServer(server);
        const { tools } = await manager.listAllTools();
        const latencyMs = Date.now() - start;
        // Strip the ext_<id>__ prefix for raw tool names
        const prefix = `ext_${server.id}__`;
        const toolList = tools.map((t) => ({
          name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
          description: t.description,
        }));
        // Cache discovered tools in the DB for instant access by tools/session panels
        store.replaceServerTools(server.id, toolList);
        await manager.closeAll();
        return c.json({ ok: true, toolCount: tools.length, latencyMs, tools: toolList });
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

      const manager = new McpServerManager();
      try {
        await manager.connectServer(server);
        const { tools } = await manager.listAllTools();
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
