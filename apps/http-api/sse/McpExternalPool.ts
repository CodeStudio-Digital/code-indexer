/**
 * McpExternalPool — single shared instance of `McpServerManager`
 * that lives for the entire http-api process. Every coder worker
 * (one per active chat session) proxies through this pool via
 * `RemoteMcpServerManager`, so we pay the connection cost once at
 * boot instead of N times per worker spawn.
 *
 * Previously each `runCoder()` invocation built its own
 * `McpServerManager` and reconnected every enabled server
 * (~500ms-1.5s × N servers). With 6 Cloudflare MCPs + Context7
 * that's ~5-10s of cold-start lag PER new chat session.
 *
 * Design:
 *   - One `McpServerManager` instance. It already retries, refreshes
 *     OAuth, and reconnects lazily on transient network drops, so we
 *     don't re-implement any of that here.
 *   - Boot reads the active server list from `McpServerStore`. After
 *     that the pool exposes a `serializeSnapshot()` that workers grab
 *     via RPC.
 *   - Health re-check on an interval covers the long-uptime case
 *     where a server goes down between calls; the in-handler lazy
 *     reconnect still handles the "agent makes a call right after a
 *     drop" path.
 *   - `refresh()` rebuilds connections when the operator enables /
 *     disables / edits a server in the admin UI.
 */
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { McpServerStore, type McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { IMcpServerManager } from '@mcp/code-agent/tools/mcp-server-manager-interface.js';

/**
 * Wire-shape that crosses the worker bridge. Plain JSON only — no
 * functions, classes, or Map instances (those get rehydrated on the
 * receiving side). Mirrors what `McpServerManager.listAllTools()`
 * returns plus the per-server state the worker reconstructs into a
 * `ConnectionState` map.
 */
export interface McpExternalSnapshot {
  /** One entry per tool, prefixed with `ext_<serverId>__`. */
  tools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    repeatable: boolean;
    /** The owning MCP server id — used to route callTool RPCs. */
    serverId: string;
    /** The raw tool name (without the `ext_<serverId>__` prefix). */
    toolName: string;
  }>;
  /** Tier assignment per prefixed tool name. */
  tierMap: Array<[string, ToolTier]>;
  /** Connection state per server id, for the admin dashboard. */
  states: Array<[string, { state: 'connected' | 'disconnected' | 'error'; error?: string }]>;
  /** Non-core tier summary for `expand_toolset` dynamic enum. */
  customTierSummary: Array<[string, { displayName: string; toolCount: number }]>;
  /**
   * Subset of the enabled server configs that runCoder needs for the
   * subordinate-tier path. We narrow to id+name+default_tier so the
   * worker doesn't have to round-trip the DB.
   */
  enabledServers: Array<{ id: string; name: string; default_tier: ToolTier }>;
  /** Count of currently-connected servers — drives the boot log. */
  connectedCount: number;
}

/**
 * Health-check cadence. We don't ping (the SDK doesn't expose one) —
 * instead we call `listTools()` again on every connected server. If
 * the call errors out, the connection is marked disconnected and the
 * lazy reconnect inside `createHandler` recovers on next use. 60s is
 * a balance: faster catches dead servers sooner, slower keeps the
 * external API quota cleaner.
 */
const HEALTH_CHECK_INTERVAL_MS = 60_000;

/**
 * The pool itself implements `IMcpServerManager` for non-worker consumers.
 * The interface methods all delegate to the underlying
 * `McpServerManager`, so the pool is essentially a long-lived wrapper.
 *
 * Worker-thread callers (where worker_threads can't share heap) talk
 * through `RemoteMcpServerManager` over the bridge instead — same
 * interface, RPC-backed implementation.
 */
export class McpExternalPool implements IMcpServerManager {
  private readonly manager: McpServerManager;
  private readonly dbPath: string;
  private readonly bearerResolver: ResolveMcpBearer | null;
  private snapshot: McpExternalSnapshot | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private booted = false;
  private shuttingDown = false;

  constructor(opts: {
    dbPath: string;
    bearerResolver?: ResolveMcpBearer | null;
  }) {
    this.dbPath = opts.dbPath;
    this.bearerResolver = opts.bearerResolver ?? null;
    this.manager = new McpServerManager(this.bearerResolver);
  }

  /**
   * Connect every enabled server once. Safe to call multiple times —
   * subsequent calls are treated as `refresh()` so the admin "save"
   * path can re-trigger boot without restarting the process.
   */
  async boot(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.booted) return this.refresh();
    const store = new McpServerStore(this.dbPath);
    try {
      const enabled = store.listServers({ enabled: true });
      if (this.shuttingDown) return;
      if (enabled.length === 0) {
        this.snapshot = this.emptySnapshot();
        this.booted = true;
        console.log('[mcp-ext-pool] no external MCP servers enabled — skipping boot');
        return;
      }
      console.log(
        `[mcp-ext-pool] booting pool with ${enabled.length} server(s): ${enabled
          .map((s) => s.id)
          .join(', ')}`,
      );
      await this.manager.connectAll(enabled);
      if (this.shuttingDown) {
        await this.manager.closeAll();
        return;
      }
      this.snapshot = await this.buildSnapshot(enabled);
      this.booted = true;
      this.scheduleHealthCheck();
      console.log(
        `[mcp-ext-pool] boot complete: ${this.manager.connectedCount}/${enabled.length} servers, ` +
          `${this.snapshot.tools.length} external tools cached (shared across all sessions)`,
      );
    } finally {
      store.close();
    }
  }

  /**
   * Reload server list from the DB and reconcile. Tearing down and
   * rebuilding all connections is the simplest correct behaviour;
   * the optimization (diff old vs new and only reconnect changed
   * servers) can come later if boot becomes a bottleneck.
   */
  async refresh(): Promise<void> {
    if (this.shuttingDown) return;
    await this.manager.closeAll();
    this.booted = false;
    await this.boot();
  }

  /**
   * Serialise the current state into a worker-shippable snapshot. The
   * pool caches the last build so repeated `getSnapshot()` calls
   * (every new worker boot) are cheap — only a real connection event
   * (boot / refresh / health flap) invalidates it.
   */
  getSnapshot(): McpExternalSnapshot {
    return this.snapshot ?? this.emptySnapshot();
  }

  /**
   * Invoke a tool on a specific external server. Routed here by the
   * `mcpExt.callTool` worker RPC; the pool resolves the cached
   * handler so the in-process retry/reconnect logic stays in play.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    // Look up the prefixed tool by reconstructing the name. The
    // cached snapshot already has handlers attached, but we can't
    // serialize them across the bridge — so we re-resolve on the
    // pool's manager which holds the live `Client`.
    //
    // We rebuild a fresh per-call handler via `listAllTools()`-style
    // logic by reaching into the manager. That's slightly indirect
    // but keeps a single source of truth for the retry/auth machinery.
    const handler = await this.resolveLiveHandler(serverId, toolName);
    if (!handler) {
      return {
        ok: false,
        text: `External MCP server "${serverId}" or tool "${toolName}" not found in the live pool.`,
      };
    }
    const result = await handler(args);
    // CoderTool's handler returns `{ content, isError? }` — translate
    // back to the worker-friendly `{ ok, text }` envelope. The pool's
    // contract is "ok=true unless the server itself flagged an error
    // OR the transport threw" (mcp-server-manager already converts
    // thrown errors into `err(...)` content).
    return {
      ok: !result.isError,
      text: result.content,
    };
  }

  // ── IMcpServerManager surface ─────────────────────────────────────
  // Non-worker consumers reuse the same warm transports. Coder workers
  // continue to go through the RPC proxy.

  /**
   * No-op in pool mode — boot() already connected everything during
   * server startup. Logging here makes it visible in the dashboard
   * console that we're skipping the per-session reconnect that the
   * pre-pool code path used to do.
   *
   * If boot() hasn't finished yet (race: first session arrives during
   * boot), wait up to 15s — that covers a worst-case ~6 Cloudflare
   * servers × handshake. After that, fall through with whatever's in
   * the snapshot; the runner uses external tools when present and
   * proceeds without them otherwise.
   */
  async connectAll(_configs: McpServerConfig[]): Promise<void> {
    if (!this.booted && this.snapshot === null) {
      await this.waitForBoot(15_000);
    }
    if (this.booted) {
      console.log(
        `[mcp-ext-pool] reusing ${this.manager.connectedCount} live connection(s) ` +
          '(per-session reconnect avoided)',
      );
    }
  }

  /**
   * Rebuild the catalogue from the manager. Cheap (in-memory) once
   * the pool is booted; the manager already keeps live `Client`
   * instances, so this is just a `listTools()` per connected server.
   * Workers use the cached snapshot via `getSnapshot()` instead.
   */
  async listAllTools(): Promise<{ tools: CoderTool[]; tierMap: Map<string, ToolTier> }> {
    return this.manager.listAllTools();
  }

  /** Delegates to the inner manager — non-core tiers from connected servers. */
  getCustomTierSummary(): Map<string, { displayName: string; toolCount: number }> {
    return this.manager.getCustomTierSummary();
  }

  /**
   * In-process callers use `shutdown()` to tear down the pool at
   * process exit. Implementing `closeAll()` as a no-op here is
   * critical: runCoder calls it in its `.finally()` block, and we
   * MUST NOT actually close the shared transports — every other
   * concurrent / future session needs them.
   */
  async closeAll(): Promise<void> {
    // intentional no-op — shared pool, lifecycle owned by server.ts
  }

  /** Pass-through to the inner manager so runCoder's status log is honest. */
  get connectedCount(): number {
    return this.manager.connectedCount;
  }

  /**
   * Short polling helper for the connectAll() race. Boots are usually
   * <2s but the very first session can land before that — we'd rather
   * pay a tiny wait than silently fall through to "0 external tools".
   */
  private async waitForBoot(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (this.booted) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Stop the health-check loop and close every connection. Called on
   * process shutdown. Idempotent.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    await this.manager.closeAll();
    this.snapshot = null;
    this.booted = false;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Look up the handler for `serverId/toolName` from the cached
   * snapshot, then reach into the live manager to invoke it. Returns
   * `null` for unknown server/tool pairs (covers "admin disabled the
   * server but a worker still has the old snapshot").
   */
  private async resolveLiveHandler(
    serverId: string,
    toolName: string,
  ): Promise<((args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>) | null> {
    const prefixedName = `ext_${serverId}__${toolName}`;
    const cached = this.snapshot?.tools.find((t) => t.name === prefixedName);
    if (!cached) return null;
    // The manager rebuilds handlers on every listAllTools() — call it
    // once to grab the fresh handler bound to the live transport.
    // This is cheap (in-memory) once the connection is up.
    const { tools } = await this.manager.listAllTools();
    const live = tools.find((t) => t.name === prefixedName);
    if (!live) return null;
    // `CoderTool.handler` declares `(args, ctx) => Promise<ToolResult>`
    // but the McpServerManager-built handlers ignore the `ctx` and use
    // their captured Client. We pass an empty stub so the typesystem
    // is satisfied without forging a ToolContext that wouldn't be read.
    const stubCtx = {} as ToolContext;
    return (args) => live.handler(args, stubCtx);
  }

  private async buildSnapshot(configs: McpServerConfig[]): Promise<McpExternalSnapshot> {
    const { tools, tierMap } = await this.manager.listAllTools();
    const states = [...this.manager.getConnectionStates().entries()] as Array<
      [string, { state: 'connected' | 'disconnected' | 'error'; error?: string }]
    >;
    const customTierSummary = [...this.manager.getCustomTierSummary().entries()] as Array<
      [string, { displayName: string; toolCount: number }]
    >;
    return {
      tools: tools.map((t) => {
        // Strip the `ext_<serverId>__` prefix so the worker can route
        // callTool back without re-parsing.
        const m = t.name.match(/^ext_(.+?)__(.+)$/);
        const serverId = m?.[1] ?? '';
        const toolName = m?.[2] ?? t.name;
        return {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          repeatable: !!t.repeatable,
          serverId,
          toolName,
        };
      }),
      tierMap: [...tierMap.entries()] as Array<[string, ToolTier]>,
      states,
      customTierSummary,
      enabledServers: configs.map((c) => ({
        id: c.id,
        name: c.name,
        default_tier: c.default_tier,
      })),
      connectedCount: this.manager.connectedCount,
    };
  }

  private emptySnapshot(): McpExternalSnapshot {
    return {
      tools: [],
      tierMap: [],
      states: [],
      customTierSummary: [],
      enabledServers: [],
      connectedCount: 0,
    };
  }

  private scheduleHealthCheck(): void {
    if (this.shuttingDown) return;
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => {
      // Fire-and-forget; we don't await so a long listTools doesn't
      // pile up timer queues.
      void this.refreshSnapshotFromHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
    // Unref so the timer doesn't keep Node alive past graceful exit.
    if (typeof (this.healthCheckTimer as { unref?: () => void }).unref === 'function') {
      (this.healthCheckTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Re-run listAllTools so any newly-disconnected server flips state.
   * `McpServerManager.listAllTools` already marks the connection as
   * error when listTools throws — we just consume the side-effect and
   * rebuild the snapshot.
   */
  private async refreshSnapshotFromHealthCheck(): Promise<void> {
    if (!this.booted || this.shuttingDown) return;
    const store = new McpServerStore(this.dbPath);
    try {
      const enabled = store.listServers({ enabled: true });
      this.snapshot = await this.buildSnapshot(enabled);
    } catch (e) {
      console.warn(
        `[mcp-ext-pool] health check failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      store.close();
    }
  }
}

/**
 * Process-level singleton — set by `apps/http-api/server.ts` after
 * the pool boots. Read by `CoderWorkerPool` to wire the bridge
 * handlers. Plain mutable box so server.ts owns lifecycle (boot,
 * shutdown) without an extra ceremony.
 */
let globalPool: McpExternalPool | null = null;

export function setGlobalMcpExternalPool(pool: McpExternalPool | null): void {
  globalPool = pool;
}

export function getGlobalMcpExternalPool(): McpExternalPool | null {
  return globalPool;
}

/** Identity helpers re-exported so worker / pool stay in sync. */
export type { CoderTool };
