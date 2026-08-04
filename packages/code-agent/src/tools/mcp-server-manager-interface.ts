/**
 * Common interface for an external-MCP server manager — kept narrow to
 * the surface `runCoder()` actually consumes.
 *
 * Two implementations live in the workspace:
 *
 *   - `McpServerManager` (this folder) — opens real transports per call
 *     site. Used in tests, detached runs, and main-process pool.
 *   - `RemoteMcpServerManager` (apps/http-api/workers/) — RPC proxy
 *     that delegates to a single shared `McpExternalPool` running in
 *     the main http-api process. The pool connects once at boot and
 *     every coder worker reuses it through this proxy, so a new chat
 *     session pays the IPC round-trip cost instead of a fresh TLS
 *     handshake + listTools call per server.
 *
 * The interface deliberately omits `connectServer` / `closeServer` etc.
 * — those are pool-management concerns the runner doesn't touch. Adding
 * a method here means runCoder will start to depend on it.
 */
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';

export interface IMcpServerManager {
  /**
   * Bring up connections for these server configs. The pool-backed
   * proxy makes this a no-op (the pool is already up); the in-process
   * implementation opens transports here.
   */
  connectAll(configs: McpServerConfig[]): Promise<void>;

  /**
   * Reconcile the live connections and tool catalogue with the latest server
   * configs. Unlike `connectAll`, this is safe to call after an earlier
   * connection attempt failed or after an admin edit changed the server set.
   */
  refreshAll(configs: McpServerConfig[]): Promise<void>;

  /**
   * Snapshot of all tools across all currently-connected servers,
   * with a tier map so runCoder can override visibility per-server
   * for subordinate agents.
   */
  listAllTools(): Promise<{ tools: CoderTool[]; tierMap: Map<string, ToolTier> }>;

  /**
   * Aggregate non-core tiers contributed by external servers — used to
   * populate `expand_toolset`'s dynamic enum + the system-prompt hint.
   */
  getCustomTierSummary(): Map<string, { displayName: string; toolCount: number }>;

  /**
   * Release any resources held by this manager. The pool-backed proxy
   * is a no-op; the in-process implementation tears down its clients.
   */
  closeAll(): Promise<void>;

  /** How many servers report `state === 'connected'` right now. */
  readonly connectedCount: number;
}
