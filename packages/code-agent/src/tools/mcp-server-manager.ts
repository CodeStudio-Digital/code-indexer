import { mcpResultToToolResult } from './mcp-result.js';
import type { ExternalMcpContent } from './mcp-content-types.js';
import { mcpServerConfigurationKey } from './mcp-transport.js';
import type { EmbeddedMcpConfig, McpConnectionState, McpRuntimeConfig, ServerConnection } from './mcp-connection-types.js';
export type { McpConnectionState, ServerConnection } from './mcp-connection-types.js';
import { terminateSession, createTransport } from './mcp-transport.js';
import { listToolsFromConnection } from './mcp-catalog-listing.js';
import { DeferredMcpValidator } from './deferred-mcp-validator.js';
/**
 * McpServerManager — manages connections to N external MCP servers and
 * aggregates their tools into CoderTool[] with `ext_<server_id>__` prefix.
 *
 * Lifecycle: instantiate → connectAll() → listAllTools() → closeAll().
 * Used inside runCoder() alongside the internal McpToolBridge.
 */

import { awaitMcpConnection } from './mcp-connection-wait.js';
import { McpDispatchRejected, withMcpWireDispatch } from './mcp-wire-dispatch.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { CoderTool, ToolResult, ToolContext, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import type { ContentBlock } from '@mcp/code-agent/core/messages.js';
import { CORE_TIER_NAMES, type ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';

import { sanitizeUntrustedCapabilityMetadata } from '@mcp/code-agent/core/capability-catalog.js';

/** Connect timeout per server (ms). */
// Package runners (npx/uvx) and OAuth refresh may legitimately exceed 10s on
// cold start. Keep a bounded, cancellable budget for all three transports.
const CONNECT_TIMEOUT_MS = 30_000;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connecting = new Map<string, { key: string; controller: AbortController; promise: Promise<void> }>();
  private retiring = new Map<string, Promise<void>>();
  private cleanupFailures = new Map<string, Error>();
  private reconnecting = new WeakMap<ServerConnection, Promise<boolean>>();

  /**
   * @param bearerResolver  Optional resolver for auth_type='oauth2' servers.
   *                        When null (e.g., transient "test" button), OAuth
   *                        servers attempt to connect unauthenticated and
   *                        the dashboard guides re-auth on failure.
   */
  constructor(
    private readonly bearerResolver: ResolveMcpBearer | null = null,
    private readonly connectEmbedded?: (config: EmbeddedMcpConfig) => Promise<Transport>,
  ) {}

  /**
   * Connect to all provided server configs in parallel, with per-server timeout.
   * Failures are isolated — a failing server logs a warning but doesn't block others.
   */
  async connectAll(configs: McpRuntimeConfig[]): Promise<void> {
    if (new Set(configs.map(config => config.id)).size !== configs.length) throw new Error('Duplicate MCP server ids');
    const results = await mapMcpSources(configs, cfg => this.connectServer(cfg));
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
  connectServer(config: McpRuntimeConfig): Promise<void> {
    const cleanupFailure = this.cleanupFailures.get(config.id);
    if (cleanupFailure) return Promise.reject(cleanupFailure);
    const frozen = structuredClone(config);
    const key = mcpServerConfigurationKey(frozen);
    const existing = this.connecting.get(config.id);
    if (existing?.key === key && !existing.controller.signal.aborted) return existing.promise;
    // closeServer invalidates the previous attempt synchronously, including
    // a handshake still awaiting OAuth. Its late completion cannot publish.
    const retired = this.closeServer(config.id);
    const controller = new AbortController();
    const attempt = { key, controller, promise: Promise.resolve() };
    this.connecting.set(config.id, attempt);
    attempt.promise = this.openConnection(frozen, attempt, retired);
    return attempt.promise;
  }

  private async openConnection(config: McpRuntimeConfig,
    attempt: { key: string; controller: AbortController; promise: Promise<void> },
    retired: Promise<void>): Promise<void> {
    const { signal } = attempt.controller;
    const timer = setTimeout(() => attempt.controller.abort(new Error('External MCP connection deadline elapsed')), CONNECT_TIMEOUT_MS);
    timer.unref();
    let client: Client | undefined;
    let transport: Transport | undefined;
    try {
      await awaitMcpConnection(retired, signal);
      signal.throwIfAborted();
      const cleanupFailure = this.cleanupFailures.get(config.id);
      if (cleanupFailure) throw cleanupFailure;
      const opened = config.transport === 'embedded'
        ? this.connectEmbedded?.(config)
        : createTransport(config, this.bearerResolver);
      if (!opened) throw new Error(`Embedded MCP server "${config.id}" is unavailable`);
      transport = await awaitMcpConnection<Transport>(opened.then(async transport => {
        if (signal.aborted) { await this.closeTransport(config.id, transport); signal.throwIfAborted(); }
        return transport;
      }), signal);
      // No asynchronous boundary between the last authority check and connect.
      signal.throwIfAborted();
      client = new Client({ name: 'coder-ext-' + config.id, version: '0.1.0' }, {
        capabilities: {}, jsonSchemaValidator: new DeferredMcpValidator(),
      });
      await awaitMcpConnection(client.connect(transport), signal);
      signal.throwIfAborted();
      if (this.connecting.get(config.id) !== attempt) throw new Error('External MCP connection superseded');
      this.connections.set(config.id, { client, transport, config, state: 'connected',
        stdio: transport instanceof StdioClientTransport
          ? transport as StdioClientTransport : undefined });
      console.log('[mcp-ext] server "' + config.id + '" connected (' + config.transport + ')');
    } catch (error) {
      if (client && transport && this.connecting.get(config.id) === attempt && !signal.aborted) {
        this.connections.set(config.id, { client, transport, config, state: 'error',
          error: error instanceof Error ? error.message : String(error) });
      }
      if (transport) await this.closeTransport(config.id, transport);
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.connecting.get(config.id) === attempt) this.connecting.delete(config.id);
    }
  }

  /**
   * List tools from all connected servers, aggregated and prefixed.
   * Returns both the CoderTool array and a tier map for filterByTiers.
   */
  async listAllTools(options: { serverId?: string } = {}): Promise<{ tools: CoderTool[]; tierMap: Map<string, ToolTier> }> {
    const allTools: CoderTool[] = [];
    const tierMap = new Map<string, ToolTier>();

    await mapMcpSources([...this.connections], async ([serverId, conn]) => {
      if (options.serverId && options.serverId !== serverId) return;
      if (conn.state !== 'connected') return;

      try {
        const listed = await listToolsFromConnection(serverId, conn);
        const sorted = [...listed].sort((a, b) => a.name.localeCompare(b.name));

        this.toolCountCache.set(serverId, sorted.length);

        for (const t of sorted) {
          const prefixedName = `ext_${serverId}__${t.name}`;
          const sanitized = sanitizeUntrustedCapabilityMetadata(
            t.description,
            t.inputSchema ?? { type: 'object', properties: {} },
          );
          if (sanitized.schemaError) {
            console.warn(`[mcp-ext] omitted tool "${prefixedName}": ${sanitized.schemaError}`);
            continue;
          }
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
            handler: this.createHandler(serverId, t.name, mcpServerConfigurationKey(conn.config)),
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
    });

    // Sort all external tools by name for prefix-cache stability
    allTools.sort((a, b) => a.name.localeCompare(b.name));

    return { tools: allTools, tierMap };
  }

  /** Reconcile by source. Unchanged transports (and their in-flight calls) survive. */
  async refreshAll(configs: McpRuntimeConfig[]): Promise<void> {
    const next = new Map(configs.map(config => [config.id, config]));
    if (next.size !== configs.length) throw new Error('Duplicate MCP server ids in configuration');
    const removed = [...new Set([...this.connections.keys(), ...this.connecting.keys()])].filter(id => !next.has(id));
    await Promise.all(removed.map(id => this.closeServer(id)));
    await this.connectAll(configs.filter(config => !this.isConnectedWith(config)));
  }

  isConnectedWith(config: McpRuntimeConfig): boolean {
    const current = this.connections.get(config.id);
    return current?.state === 'connected'
      && mcpServerConfigurationKey(current.config) === mcpServerConfigurationKey(config);
  }

  /** Reconnect only before dispatch. A lost response never authorizes a replay. */
  private createHandler(serverId: string, toolName: string, configKey: string): CoderTool['handler'] {
    return async (args, ctx): Promise<ToolResult> => {
      if (ctx.signal?.aborted) return err('External MCP call cancelled before dispatch.');
      let conn = this.connections.get(serverId);
      if (conn && mcpServerConfigurationKey(conn.config) !== configKey) return err('External MCP configuration changed; refresh the catalogue before dispatch.');
      if (!conn) return err(`External MCP server "${serverId}" not found`);
      if (conn.state !== 'connected' && !(await this.lazyReconnect(conn))) {
        return err(`External MCP server "${serverId}" is ${conn.state}: ${conn.error ?? 'unknown error'}`);
      }
      conn = this.connections.get(serverId);
      if (!conn || conn.state !== 'connected' || mcpServerConfigurationKey(conn.config) !== configKey) {
        return err('External MCP connection closed or changed before dispatch.');
      }
      if (ctx.signal?.aborted) return err('External MCP call cancelled before dispatch.');
      try { ctx.assertExternalMcpDispatch?.(); }
      catch { return err('External MCP run authority expired before dispatch.'); }
      try {
        const admitted = conn;
        return await withMcpWireDispatch(() => {
          if (ctx.signal?.aborted || this.connections.get(serverId) !== admitted || admitted.state !== 'connected'
            || mcpServerConfigurationKey(admitted.config) !== configKey) throw new Error('MCP connection retired.');
          ctx.assertExternalMcpDispatch?.();
        }, () => this.callToolOnce(admitted, toolName, args, ctx));
      } catch (e) {
        if (e instanceof McpDispatchRejected) return err(e.message);
        conn.state = 'disconnected';
        conn.error = e instanceof Error ? e.message : String(e);
        return unknownToolOutcome(
          `External MCP result unknown for "${serverId}/${toolName}": ${conn.error}. ` +
          'The operation may have taken effect. It was not retried; reconcile it before another mutation.',
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
  private lazyReconnect(conn: ServerConnection): Promise<boolean> {
    const pending = this.reconnecting.get(conn);
    if (pending) return pending;
    const reconnect = this.reconnectServer(conn).then(() => true, error => {
      conn.state = 'error';
      conn.error = error instanceof Error ? error.message : String(error);
      return false;
    });
    this.reconnecting.set(conn, reconnect);
    void reconnect.finally(() => this.reconnecting.delete(conn));
    return reconnect;
  }

  /** Single tool call with no retry logic — used by createHandler. */
  private async callToolOnce(
    conn: ServerConnection,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const { signal, deadlineAtEpochMs, projectId } = ctx;
    const remaining = Math.min(60_000, (deadlineAtEpochMs ?? Date.now() + 60_000) - Date.now());
    if (remaining <= 0) throw new Error("MCP deadline expired before dispatch");
    const meta = conn.config.transport === 'embedded' && projectId != null
      ? { _meta: { 'codestudio/projectId': projectId } } : {};
    const result = await conn.client.callTool({ name: toolName, arguments: args, ...meta }, undefined, { signal, timeout: remaining });
    return mcpResultToToolResult(result, toolName);
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
    return this.createHandler(serverId, toolName, mcpServerConfigurationKey(conn.config))(args, {
      cwd: process.cwd(), projectName: 'MCP control plane',
    });
  }

  /** Close and re-open a connection before a new dispatch. */
  private async reconnectServer(conn: ServerConnection): Promise<void> {
    if (this.connections.get(conn.config.id) !== conn) throw new Error('External MCP connection was retired');
    await this.connectServer(conn.config);
  }

  /**
   * Get connection states for all servers (for admin dashboard status display).
   */
  getConnectionStates(): Map<string, { state: McpConnectionState; error?: string; toolCount?: number }> {
    const states = new Map<string, { state: McpConnectionState; error?: string }>();
    for (const [id, conn] of this.connections) {
      states.set(id, { state: conn.state, error: conn.error });
    }
    for (const [id, error] of this.cleanupFailures) states.set(id, { state: 'error', error: error.message });
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
    const ids = new Set([...this.connections.keys(), ...this.connecting.keys(),
      ...this.retiring.keys(), ...this.cleanupFailures.keys()]);
    const results = await Promise.allSettled([...ids].map(id => this.closeServer(id)));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'External MCP cleanup is unproven');
  }

  /** Keep the transport reference: SDK onclose discards it before physical reap. */
  private async closeTransport(serverId: string, transport: Transport): Promise<void> {
    await terminateSession(transport);
    try { await transport.close(); }
    catch (cause) {
      const failure = new Error('External MCP cleanup is unproven for "' + serverId + '"; reconnect is blocked', { cause });
      this.cleanupFailures.set(serverId, failure);
      throw failure;
    }
  }

  /** Retire synchronously, then serialize cleanup even across competing reconnects. */
  closeServer(serverId: string): Promise<void> {
    const previous = this.retiring.get(serverId);
    const pending = this.connecting.get(serverId);
    const conn = this.connections.get(serverId);
    this.connecting.delete(serverId);
    this.connections.delete(serverId);
    this.toolCountCache.delete(serverId);
    pending?.controller.abort(new Error('External MCP connection closed'));
    const cleanup = (async () => {
      const results = await Promise.allSettled([
        ...(previous ? [previous] : []),
        // Aborted handshakes are expected. Their cleanup failures are sticky below.
        ...(pending ? [pending.promise.catch(() => {})] : []),
        ...(conn ? [this.closeTransport(serverId, conn.transport)] : []),
      ]);
      const failure = this.cleanupFailures.get(serverId);
      if (failure) throw failure;
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    })();
    this.retiring.set(serverId, cleanup);
    void cleanup.finally(() => {
      if (this.retiring.get(serverId) === cleanup) this.retiring.delete(serverId);
    }).catch(() => {});
    return cleanup;
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

/** Independent sources have a fixed admission ceiling, including failed peers. */
async function mapMcpSources<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await action(items[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

/** Bind handlers to the complete persisted configuration, without exposing credentials. */
export { mcpServerConfigurationKey } from './mcp-transport.js';
