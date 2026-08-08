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
import { ResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { CoderTool, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { ContentBlock } from '@mcp/code-agent/core/messages.js';
import { CORE_TIER_NAMES, type ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import { mcpAuthClientErrorMessage } from '@mcp/services/mcp-client/auth/domain/errors.js';
import { sanitizeUntrustedCapabilityMetadata } from '@mcp/code-agent/core/capability-catalog.js';

/** Per-server connection state. */
export type McpConnectionState = 'connected' | 'disconnected' | 'error';

interface ServerConnection {
  client: Client;
  config: McpServerConfig;
  state: McpConnectionState;
  error?: string;
  /** Kept only for stdio servers, so their child pid stays discoverable. */
  stdio?: StdioClientTransport;
  /**
   * The server returned at least one malformed tool definition. Once detected,
   * bypass the SDK's all-or-nothing list validator for this connection and
   * validate each tool independently.
   */
  lenientToolListing?: boolean;
  /** Avoid repeating the same malformed-tool warning on every health check. */
  reportedInvalidToolSignature?: string;
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

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

interface ExternalMcpContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

interface ValidationIssueLike {
  path?: unknown;
  message?: unknown;
}

/**
 * The MCP SDK validates `tools/list` as one Zod object. One malformed tool
 * therefore rejects every valid sibling before callers can isolate it.
 */
function isToolListValidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.some((issue) => {
    const path = (issue as ValidationIssueLike | null)?.path;
    return Array.isArray(path) && path[0] === 'tools';
  });
}

function rawToolName(value: unknown, index: number): string {
  if (value && typeof value === 'object') {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return `#${index}`;
}

function firstValidationMessage(issues: readonly ValidationIssueLike[]): string {
  for (const issue of issues) {
    if (typeof issue.message === 'string' && issue.message.trim()) return issue.message;
  }
  return 'invalid MCP tool definition';
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
        stdio: transport instanceof StdioClientTransport ? transport : undefined,
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
        const listed = await this.listToolsFromConnection(serverId, conn);
        const sorted = [...listed].sort((a, b) => a.name.localeCompare(b.name));

        this.toolCountCache.set(serverId, sorted.length);

        for (const t of sorted) {
          const prefixedName = `ext_${serverId}__${t.name}`;
          const sanitized = sanitizeUntrustedCapabilityMetadata(
            t.description,
            t.inputSchema ?? { type: 'object', properties: {} },
          );
          const schema = sanitized.schema as unknown as JsonSchema;

          tierMap.set(prefixedName, conn.config.default_tier);

          // Compatibility bridge for older MCP servers that cannot declare
          // repeat metadata. Resolve the convention once at registration;
          // runtime guards consume only the explicit repeatPolicy field.
          // the server-author convention: wait_for_compile_clean (Unity),
          // tail_logs, await_*, poll_*, monitor_*. The runner has its own
          // Server authors can opt non-conventional names in through future
          // MCP metadata without changing guard code.
          const repeatable = /^(?:wait_for|await|poll|tail|monitor)_/.test(t.name);
          allTools.push({
            name: prefixedName,
            description: sanitized.description,
            parameters: schema,
            source: 'mcp_external',
            capabilityProvenance: {
              kind: 'mcp_external',
              providerId: 'mcp-external',
              serverId,
              provenanceRef: `mcp-server:${serverId}`,
            },
            handler: this.createHandler(serverId, t.name),
            repeatPolicy: repeatable ? 'pollable' : 'stable',
            mutates: true,
            parallelSafe: false,
            riskLevel: 'write',
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

  /** Rebuild every transport from the latest persisted configuration. */
  async refreshAll(configs: McpServerConfig[]): Promise<void> {
    await this.closeAll();
    await this.connectAll(configs);
  }

  /**
   * Keep the SDK's strict path for conforming servers so its output/task
   * metadata cache remains populated. If that path proves the server has a
   * malformed tool definition, fetch the same result through the SDK's loose
   * base result schema and validate each definition independently.
   */
  private async listToolsFromConnection(
    serverId: string,
    conn: ServerConnection,
  ): Promise<ListedTool[]> {
    if (!conn.lenientToolListing) {
      try {
        return (await conn.client.listTools()).tools;
      } catch (error) {
        if (!isToolListValidationError(error)) throw error;
        conn.lenientToolListing = true;
        console.warn(
          `[mcp-ext] server "${serverId}" returned a malformed tools/list catalogue; ` +
            'switching this connection to per-tool validation',
        );
      }
    }

    const raw = await conn.client.request({ method: 'tools/list' }, ResultSchema);
    if (!Array.isArray(raw.tools)) {
      throw new Error(`External MCP server "${serverId}" returned tools/list without a tools array`);
    }

    const valid: ListedTool[] = [];
    const invalid: string[] = [];
    for (let index = 0; index < raw.tools.length; index++) {
      const candidate = raw.tools[index];
      const parsed = ToolSchema.safeParse(candidate);
      if (parsed.success) {
        valid.push(parsed.data);
        continue;
      }
      invalid.push(
        `${rawToolName(candidate, index)} (${firstValidationMessage(parsed.error.issues)})`,
      );
    }

    const signature = invalid.join('|');
    if (invalid.length > 0 && signature !== conn.reportedInvalidToolSignature) {
      conn.reportedInvalidToolSignature = signature;
      console.warn(
        `[mcp-ext] server "${serverId}" skipped ${invalid.length} invalid tool definition(s): ` +
          invalid.join(', '),
      );
    }
    return valid;
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
    const blocks = (result.content ?? []) as ExternalMcpContent[];
    const textParts: string[] = [];
    const extraUserBlocks: ContentBlock[] = [];

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        continue;
      }
      if (block.type === 'image' && typeof block.data === 'string') {
        extraUserBlocks.push({
          type: 'image',
          mediaType: block.mimeType || 'image/png',
          base64: block.data,
        });
        continue;
      }
      if (block.type === 'audio' && typeof block.data === 'string') {
        extraUserBlocks.push({
          type: 'document',
          name: `${toolName}-audio`,
          mediaType: block.mimeType || 'audio/mpeg',
          base64: block.data,
        });
        continue;
      }
      if (block.type === 'resource' && block.resource) {
        const resource = block.resource;
        const mediaType = resource.mimeType || 'application/octet-stream';
        if (typeof resource.blob === 'string' && mediaType.startsWith('image/')) {
          extraUserBlocks.push({ type: 'image', mediaType, base64: resource.blob });
        } else {
          extraUserBlocks.push({
            type: 'document',
            name: resource.uri || `${toolName}-resource`,
            mediaType,
            text: resource.text,
            base64: resource.blob,
          });
        }
        continue;
      }
      if (block.type === 'resource_link' && typeof block.uri === 'string') {
        textParts.push(`[resource] ${block.name ? `${block.name}: ` : ''}${block.uri}`);
      }
    }

    const structuredData = result.structuredContent;
    if (textParts.length === 0 && structuredData !== undefined) {
      textParts.push(JSON.stringify(structuredData));
    }
    if (textParts.length === 0 && extraUserBlocks.length > 0) {
      textParts.push(
        `External MCP tool returned ${extraUserBlocks.length} attachment` +
        `${extraUserBlocks.length === 1 ? '' : 's'}.`,
      );
    }
    const text = textParts.join('\n') || 'External MCP tool returned no content.';
    const base = result.isError ? err(text) : ok(text);
    return {
      ...base,
      ...(structuredData !== undefined ? { structuredData } : {}),
      ...(extraUserBlocks.length > 0 ? { extraUserBlocks } : {}),
      ...(textParts.length === 1 && structuredData !== undefined && blocks.length === 0
        ? { contentFormat: 'json' as const }
        : {}),
    };
  }

  /**
   * Call a raw tool on an already connected server. Used by control-plane
   * health checks that must distinguish catalogue discovery from a usable
   * downstream route.
   */
  async callServerTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.state !== 'connected') {
      throw new Error(
        `External MCP server "${serverId}" is ${conn?.state ?? 'not connected'}: ` +
        `${conn?.error ?? 'no active connection'}`,
      );
    }
    return this.callToolOnce(conn, toolName, args);
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
   * OS pids of stdio-transport servers, for the task manager's process tree.
   * Remote transports (SSE/HTTP) have no local process and are skipped.
   */
  listStdioProcesses(): Array<{ serverId: string; name: string; pid: number }> {
    const out: Array<{ serverId: string; name: string; pid: number }> = [];
    for (const [id, conn] of this.connections) {
      const pid = conn.stdio?.pid;
      if (typeof pid === 'number' && pid > 0) {
        out.push({ serverId: id, name: conn.config.name || id, pid });
      }
    }
    return out;
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
