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
import type { ResolveMcpBearer } from '../../mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import { mcpAuthClientErrorMessage } from '../../mcp-client/auth/domain/errors.js';

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
 * Heuristic for recognising an OAuth-related error from the transport.
 * The MCP SDK surfaces these as JS Errors with the HTTP status in the
 * message; matching on 401/403 gives us a safe "try refresh & retry" signal.
 */
function looksLikeAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(msg);
}

/**
 * Heuristic for recognising a transient network failure — a server that's
 * temporarily down (process restart, container redeploy, Unity Editor's
 * AppDomain reload after a script change). These are exactly the cases where
 * a single retry after a fresh connection succeeds; treating them as
 * permanent disconnect — like the original code did — pinned the slot to
 * 'disconnected' for the rest of the session, forcing a manual restart of
 * the coder to recover.
 */
function looksLikeNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|\b503\b|\b502\b|\b504\b|fetch failed|socket hang up|connection refused|connection reset|server (?:closed|unavailable)|connect ECONN/i
    .test(msg);
}

/**
 * Build auth headers from config. Async because OAuth requires a resolver
 * that may refresh the access token from a remote AS.
 *
 * Returns empty object when auth_type=none OR when OAuth has no tokens
 * yet — connection then proceeds unauthenticated and the server's 401
 * prompts the user to connect via the dashboard.
 */
async function buildAuthHeaders(
  config: McpServerConfig,
  resolver: ResolveMcpBearer | null,
): Promise<Record<string, string>> {
  if (config.auth_type === 'oauth2') {
    if (!resolver) return {};
    const result = await resolver.execute(config.id);
    if (!result.ok) {
      console.warn(
        `[mcp-ext] OAuth bearer unavailable for "${config.id}": ${mcpAuthClientErrorMessage(result.error)}`,
      );
      return {};
    }
    return { Authorization: `Bearer ${result.value}` };
  }

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
 * Create the appropriate transport for a server config. Async because
 * auth header resolution (OAuth) may require remote calls.
 */
async function createTransport(config: McpServerConfig, resolver: ResolveMcpBearer | null) {
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
      const authHeaders = await buildAuthHeaders(config, resolver);
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
      const authHeaders = await buildAuthHeaders(config, resolver);
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
   * @param bearerResolver  Optional resolver for auth_type='oauth2' servers.
   *                        When null (e.g., transient "test" button), OAuth
   *                        servers attempt to connect unauthenticated and
   *                        the dashboard guides re-auth on failure.
   */
  constructor(private readonly bearerResolver: ResolveMcpBearer | null = null) {}

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
    const transport = await createTransport(config, this.bearerResolver);
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

          // Auto-flag polling-style tools so the runner's per-arg dup-call
          // cap doesn't refuse legitimate repeated calls. Pattern matches
          // the server-author convention: wait_for_compile_clean (Unity),
          // tail_logs, await_*, poll_*, monitor_*. The runner has its own
          // name-pattern fallback for safety, but setting the typed flag
          // here also exempts the tool from the post-call result-content
          // dedup which the runner gates on the same flag. Server authors
          // can opt non-conventional names in by renaming, or in the
          // future via per-server config (`repeatable_tools: [...]`).
          const repeatable = /^(?:wait_for|await|poll|tail|monitor)_/.test(t.name);

          allTools.push({
            name: prefixedName,
            description: t.description ?? '',
            parameters: schema,
            source: 'mcp_external',
            handler: this.createHandler(serverId, t.name),
            repeatable,
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
   *
   * Two layers of resilience on top of the bare callToolOnce:
   *
   *  1. **Pre-call lazy reconnect** — if the connection is already marked
   *     disconnected/error (from an earlier failed call), try ONE reconnect
   *     before refusing. Covers the case where the server was down, recovered
   *     in the background, but our cached state still says dead.
   *
   *  2. **Post-call retry on network error** — if a call fails with what
   *     looks like a transient network drop (ECONNREFUSED/RESET, 502/503/504,
   *     socket hang up), reconnect and retry once. Covers Unity Editor's
   *     AppDomain reload after a script compile (HttpListener dies for
   *     ~1-2s, comes back at the same port) and analogous container/process
   *     restarts on other MCP servers.
   *
   * OAuth 401/403 retains its own dedicated path (refresh token via the
   * resolver). Both retries use reconnectServer (close + connectServer +
   * patch local conn fields), which is the same primitive the existing OAuth
   * path uses.
   */
  private createHandler(serverId: string, toolName: string): CoderTool['handler'] {
    return async (args: Record<string, unknown>): Promise<ToolResult> => {
      const conn = this.connections.get(serverId);
      if (!conn) return err(`External MCP server "${serverId}" not found`);

      // Layer 1: pre-call lazy reconnect when state is stale.
      if (conn.state !== 'connected') {
        if (!(await this.lazyReconnect(conn))) {
          return err(`External MCP server "${serverId}" is ${conn.state}: ${conn.error ?? 'unknown error'}`);
        }
      }

      try {
        return await this.callToolOnce(conn, toolName, args);
      } catch (e) {
        // OAuth 401/403: refresh token + retry (existing behavior).
        if (conn.config.auth_type === 'oauth2' && this.bearerResolver && looksLikeAuthError(e)) {
          try {
            await this.reconnectServer(conn);
            return await this.callToolOnce(conn, toolName, args);
          } catch (e2) {
            conn.state = 'disconnected';
            conn.error = e2 instanceof Error ? e2.message : String(e2);
            return err(
              `External MCP server "${serverId}" OAuth reconnect failed: ${conn.error}. ` +
              'Please reconnect via the dashboard.',
            );
          }
        }

        // Layer 2: transient network drop → lazy reconnect + retry once.
        if (looksLikeNetworkError(e) && (await this.lazyReconnect(conn))) {
          try {
            return await this.callToolOnce(conn, toolName, args);
          } catch (e2) {
            conn.state = 'disconnected';
            conn.error = e2 instanceof Error ? e2.message : String(e2);
            return err(
              `External MCP server "${serverId}" reconnected but retry failed: ${conn.error}.`,
            );
          }
        }

        // Non-recoverable.
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
   * Best-effort reconnect of a single connection. Wraps reconnectServer so
   * createHandler can ignore exceptions and simply branch on the boolean
   * result. Sets conn.state to 'error' (with the failure message) when the
   * reconnect itself throws — keeps the cached state honest.
   */
  private async lazyReconnect(conn: ServerConnection): Promise<boolean> {
    try {
      await this.reconnectServer(conn);
      if (conn.state === 'connected') {
        console.log(`[mcp-ext] server "${conn.config.id}" reconnected (lazy)`);
        return true;
      }
      return false;
    } catch (e) {
      conn.state = 'error';
      conn.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** Single tool call with no retry logic — used by createHandler. */
  private async callToolOnce(
    conn: ServerConnection,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await conn.client.callTool({ name: toolName, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }> | undefined)
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n') ?? '';
    if (result.isError) return err(text || 'External MCP tool returned error');
    return ok(text);
  }

  /** Close and re-open the connection for a server (used on OAuth auth error). */
  private async reconnectServer(conn: ServerConnection): Promise<void> {
    try { await conn.client.close(); } catch { /* ignore */ }
    await this.connectServer(conn.config);
    const refreshed = this.connections.get(conn.config.id);
    if (refreshed) {
      conn.client = refreshed.client;
      conn.state = refreshed.state;
      conn.error = refreshed.error;
    }
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
