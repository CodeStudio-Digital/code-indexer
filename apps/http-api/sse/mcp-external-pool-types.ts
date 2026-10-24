import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';

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
    /** Opaque binding to this exact configuration and tool definition. */
    catalogueRevision?: string;
    transport?: 'stdio' | 'sse' | 'streamable_http';
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
export const HEALTH_CHECK_INTERVAL_MS = 60_000;
