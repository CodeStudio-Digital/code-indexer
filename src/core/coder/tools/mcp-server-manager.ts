/**
 * McpServerManager — manages connections to N external MCP servers and
 * aggregates their tools into CoderTool[] with `ext_<server_id>__` prefix.
 *
 * Lifecycle: instantiate → connectAll() → listAllTools() → closeAll().
 * Used inside runCoder() alongside the internal McpToolBridge.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../../../store/mcp-server-store.js';
import type { CoderTool, ToolResult, JsonSchema } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { CORE_TIER_NAMES, type ToolTier } from './tiers.js';

/** Per-server connection state. */
export type McpConnectionState = 'connected' | 'disconnected' | 'error';

interface ServerConnection {
  client: Client;
  config: McpServerConfig;
  state: McpConnectionState;
  error?: string;
}

/** Connect timeout per server (ms). */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Build auth headers from config. Returns empty object for auth_type=none.
 */
function buildAuthHeaders(config: McpServerConfig): Record<string, string> {
  if (!config.auth_token) return {};
  switch (config.auth_type) {
    case 'bearer':
      return { Authorization: `Bearer ${config.auth_token}` };
    case 'api_key': {
      // Default header name is X-API-Key, but can be overridden via config.headers
      const headerName =
        (config.config as Record<string, unknown>).api_key_header_name as string | undefined ??
        'X-API-Key';
      return { [headerName]: config.auth_token };
    }
    default:
      return {};
  }
}

/**
 * Create the appropriate transport for a server config.
 */
function createTransport(config: McpServerConfig) {
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) throw new Error(`stdio server "${config.id}" requires a command`);
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
      });
    }
    case 'sse': {
      if (!config.url) throw new Error(`sse server "${config.id}" requires a url`);
      const authHeaders = buildAuthHeaders(config);
      const extraHeaders = (config.config as Record<string, unknown>).headers as
        | Record<string, string>
        | undefined ?? {};
      const headers = { ...extraHeaders, ...authHeaders };
      const hasHeaders = Object.keys(headers).length > 0;
      // SSE transport needs headers on both the EventSource (GET) and POST requests.
      // eventSourceInit.fetch wraps the SSE GET; requestInit covers recurring POSTs.
      const opts: Record<string, unknown> = {};
      if (hasHeaders) {
        opts.requestInit = { headers };
        opts.eventSourceInit = {
          fetch: (url: string | URL, init: Record<string, unknown>) =>
            globalThis.fetch(url, {
              ...(init as RequestInit),
              headers: { ...(init?.headers as Record<string, string> ?? {}), ...headers },
            }),
        };
      }
      return new SSEClientTransport(new URL(config.url), opts as never);
    }
    case 'streamable_http': {
      if (!config.url) throw new Error(`streamable_http server "${config.id}" requires a url`);
      const authHeaders = buildAuthHeaders(config);
      const extraHeaders = (config.config as Record<string, unknown>).headers as
        | Record<string, string>
        | undefined ?? {};
      const headers = { ...extraHeaders, ...authHeaders };
      const hasHeaders = Object.keys(headers).length > 0;
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: hasHeaders ? { headers } : undefined,
      });
    }
    default:
      throw new Error(`Unsupported transport "${config.transport}" for server "${config.id}"`);
  }
}

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();

  /**
   * Connect to all provided server configs in parallel, with per-server timeout.
   * Failures are isolated — a failing server logs a warning but doesn't block others.
   */
  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map((cfg) => this.connectServer(cfg)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const cfg = configs[i];
        console.warn(
          `[mcp-ext] server "${cfg.id}" failed to connect: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    }
  }

  /**
   * Connect to a single external MCP server.
   */
  async connectServer(config: McpServerConfig): Promise<void> {
    const transport = createTransport(config);
    const client = new Client(
      { name: `coder-ext-${config.id}`, version: '0.1.0' },
      { capabilities: {} },
    );

    // Connect with timeout
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Connect timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
    );

    try {
      await Promise.race([connectPromise, timeoutPromise]);
      this.connections.set(config.id, {
        client,
        config,
        state: 'connected',
      });
      console.log(`[mcp-ext] server "${config.id}" connected (${config.transport})`);
    } catch (e) {
      this.connections.set(config.id, {
        client,
        config,
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      // Try to clean up the failed transport
      try { await client.close(); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * List tools from all connected servers, aggregated and prefixed.
   * Returns both the CoderTool array and a tier map for filterByTiers.
   */
  async listAllTools(): Promise<{ tools: CoderTool[]; tierMap: Map<string, ToolTier> }> {
    const allTools: CoderTool[] = [];
    const tierMap = new Map<string, ToolTier>();

    for (const [serverId, conn] of this.connections) {
      if (conn.state !== 'connected') continue;

      try {
        const res = await conn.client.listTools();
        const sorted = [...res.tools].sort((a, b) => a.name.localeCompare(b.name));

        this.toolCountCache.set(serverId, sorted.length);

        for (const t of sorted) {
          const prefixedName = `ext_${serverId}__${t.name}`;
          const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as unknown as JsonSchema;

          tierMap.set(prefixedName, conn.config.default_tier);

          allTools.push({
            name: prefixedName,
            description: t.description ?? '',
            parameters: schema,
            source: 'mcp_external',
            handler: this.createHandler(serverId, t.name),
          });
        }
      } catch (e) {
        console.warn(
          `[mcp-ext] failed to list tools from "${serverId}": ${e instanceof Error ? e.message : String(e)}`,
        );
        conn.state = 'error';
        conn.error = e instanceof Error ? e.message : String(e);
      }
    }

    // Sort all external tools by name for prefix-cache stability
    allTools.sort((a, b) => a.name.localeCompare(b.name));

    return { tools: allTools, tierMap };
  }

  /**
   * Create a tool call handler for a specific server + tool combination.
   */
  private createHandler(serverId: string, toolName: string): CoderTool['handler'] {
    return async (args: Record<string, unknown>): Promise<ToolResult> => {
      const conn = this.connections.get(serverId);
      if (!conn) return err(`External MCP server "${serverId}" not found`);
      if (conn.state !== 'connected') {
        return err(`External MCP server "${serverId}" is ${conn.state}: ${conn.error ?? 'unknown error'}`);
      }

      try {
        const result = await conn.client.callTool({ name: toolName, arguments: args });
        const text = (result.content as Array<{ type: string; text?: string }> | undefined)
          ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text!)
          .join('\n') ?? '';
        if (result.isError) return err(text || 'External MCP tool returned error');
        return ok(text);
      } catch (e) {
        // Mark server as disconnected on transport errors
        conn.state = 'disconnected';
        conn.error = e instanceof Error ? e.message : String(e);
        return err(
          `External MCP server "${serverId}" disconnected: ${conn.error}. ` +
          'The server may have crashed. Inform the user.',
        );
      }
    };
  }

  /**
   * Get connection states for all servers (for admin dashboard status display).
   */
  getConnectionStates(): Map<string, { state: McpConnectionState; error?: string; toolCount?: number }> {
    const states = new Map<string, { state: McpConnectionState; error?: string }>();
    for (const [id, conn] of this.connections) {
      states.set(id, { state: conn.state, error: conn.error });
    }
    return states;
  }

  /**
   * Build a summary of custom (non-core) tiers from connected servers.
   * Used to populate expand_toolset's dynamic enum and the system prompt hint.
   *
   * Returns a map from custom tier name to { displayName, toolCount }.
   * Multiple servers sharing the same custom tier are merged.
   */
  getCustomTierSummary(): Map<string, { displayName: string; toolCount: number }> {
    const summary = new Map<string, { displayName: string; toolCount: number }>();
    for (const conn of this.connections.values()) {
      if (conn.state !== 'connected') continue;
      const tier = conn.config.default_tier;
      if (CORE_TIER_NAMES.has(tier)) continue; // core tiers don't count as custom

      const existing = summary.get(tier);
      if (existing) {
        // Merge: multiple servers under the same custom tier
        existing.toolCount += this.countToolsForServer(conn.config.id);
        if (!existing.displayName.includes(conn.config.name)) {
          existing.displayName += ` + ${conn.config.name}`;
        }
      } else {
        summary.set(tier, {
          displayName: conn.config.name,
          toolCount: this.countToolsForServer(conn.config.id),
        });
      }
    }
    return summary;
  }

  /** Count how many tools a specific server contributed (from last listAllTools). */
  private toolCountCache = new Map<string, number>();
  private countToolsForServer(serverId: string): number {
    return this.toolCountCache.get(serverId) ?? 0;
  }

  /**
   * Close all connections gracefully.
   */
  async closeAll(): Promise<void> {
    const closePromises = [...this.connections.entries()].map(async ([id, conn]) => {
      try {
        await conn.client.close();
      } catch {
        // ignore close errors
      }
      console.log(`[mcp-ext] server "${id}" closed`);
    });
    await Promise.allSettled(closePromises);
    this.connections.clear();
  }

  /**
   * Close a single server connection.
   */
  async closeServer(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    try {
      await conn.client.close();
    } catch { /* ignore */ }
    this.connections.delete(serverId);
  }

  /** Number of successfully connected servers. */
  get connectedCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.state === 'connected') count++;
    }
    return count;
  }
}
