/**
 * McpServerStore — persists external MCP server configurations.
 *
 * Schema is owned by migration 015. This class handles CRUD for the
 * `mcp_server_configs` table, following the same patterns as ProviderStore.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type McpTransport = 'stdio' | 'sse' | 'streamable_http';
export type McpAuthType = 'none' | 'api_key' | 'bearer';
/**
 * Default tier for a server's tools. Can be a core tier ('bootstrap',
 * 'navigate', 'admin') or a custom tier name (e.g., 'cloudflare').
 * Custom tiers are unlocked on-demand via expand_toolset.
 */
export type McpDefaultTier = string;

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  auth_type: McpAuthType;
  auth_token: string | null;
  default_tier: McpDefaultTier;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UpsertMcpServerInput {
  id: string;
  name: string;
  transport: McpTransport;
  enabled?: boolean;
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  auth_type?: McpAuthType;
  auth_token?: string | null;
  default_tier?: McpDefaultTier;
  config?: Record<string, unknown>;
}

interface McpServerRaw {
  id: string;
  name: string;
  transport: string;
  enabled: number;
  url: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  auth_type: string;
  auth_token: string | null;
  default_tier: string;
  config: string;
  created_at: string;
  updated_at: string;
}

/** Server ID must be alphanumeric + hyphens, 1-32 chars. */
const SERVER_ID_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Custom tier name: lowercase alphanumeric + hyphens/underscores. */
const CUSTOM_TIER_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Core tier names that custom tiers must not shadow. */
const CORE_TIERS = new Set(['bootstrap', 'navigate', 'admin']);

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function hydrate(r: McpServerRaw): McpServerConfig {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport as McpTransport,
    enabled: !!r.enabled,
    url: r.url,
    command: r.command,
    args: parseJson<string[]>(r.args, []),
    env: parseJson<Record<string, string>>(r.env, {}),
    auth_type: r.auth_type as McpAuthType,
    auth_token: r.auth_token,
    default_tier: r.default_tier as McpDefaultTier,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class McpServerStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  listServers(filter?: { enabled?: boolean }): McpServerConfig[] {
    const clauses: string[] = [];
    if (filter?.enabled !== undefined) clauses.push(`enabled = ${filter.enabled ? 1 : 0}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM mcp_server_configs ${where} ORDER BY name`)
      .all() as McpServerRaw[];
    return rows.map(hydrate);
  }

  getServer(id: string): McpServerConfig | null {
    const row = this.db
      .prepare('SELECT * FROM mcp_server_configs WHERE id = ?')
      .get(id) as McpServerRaw | undefined;
    return row ? hydrate(row) : null;
  }

  upsertServer(input: UpsertMcpServerInput): McpServerConfig {
    if (!SERVER_ID_RE.test(input.id)) {
      throw new Error(
        `Invalid MCP server ID "${input.id}": must be 1-32 lowercase alphanumeric + hyphens`,
      );
    }

    // Validate custom tier name if not a core tier
    const tier = input.default_tier ?? 'navigate';
    if (!CORE_TIERS.has(tier) && !CUSTOM_TIER_RE.test(tier)) {
      throw new Error(
        `Invalid custom tier name "${tier}": must be lowercase alphanumeric + hyphens/underscores`,
      );
    }

    const now = new Date().toISOString();
    const existing = this.getServer(input.id);

    if (existing) {
      this.db
        .prepare(
          `UPDATE mcp_server_configs SET
             name = ?, transport = ?, enabled = ?, url = ?, command = ?,
             args = ?, env = ?, auth_type = ?, auth_token = ?,
             default_tier = ?, config = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.transport,
          (input.enabled ?? existing.enabled) ? 1 : 0,
          input.url ?? existing.url,
          input.command ?? existing.command,
          JSON.stringify(input.args ?? existing.args),
          JSON.stringify(input.env ?? existing.env),
          input.auth_type ?? existing.auth_type,
          input.auth_token ?? existing.auth_token,
          input.default_tier ?? existing.default_tier,
          JSON.stringify(input.config ?? existing.config),
          now,
          input.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO mcp_server_configs
             (id, name, transport, enabled, url, command, args, env,
              auth_type, auth_token, default_tier, config, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.transport,
          (input.enabled ?? true) ? 1 : 0,
          input.url ?? null,
          input.command ?? null,
          JSON.stringify(input.args ?? []),
          JSON.stringify(input.env ?? {}),
          input.auth_type ?? 'none',
          input.auth_token ?? null,
          input.default_tier ?? 'navigate',
          JSON.stringify(input.config ?? {}),
          now,
          now,
        );
    }

    return this.getServer(input.id)!;
  }

  deleteServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_server_configs WHERE id = ?').run(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE mcp_server_configs SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(enabled ? 1 : 0, id);
  }

  // ─── Tool cache ──────────────────────────────────────────────

  /**
   * Replace the cached tool list for a server. Called after a successful
   * test or connect. Tools are stored without the `ext_<id>__` prefix —
   * the prefix is added at read time.
   */
  replaceServerTools(serverId: string, tools: Array<{ name: string; description: string }>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mcp_server_tools WHERE server_id = ?').run(serverId);
      const insert = this.db.prepare(
        'INSERT INTO mcp_server_tools (server_id, tool_name, description) VALUES (?, ?, ?)',
      );
      for (const t of tools) {
        insert.run(serverId, t.name, t.description);
      }
    });
    tx();
  }

  /**
   * Get cached tools for a server. Returns raw tool names (no prefix).
   */
  getServerTools(serverId: string): Array<{ name: string; description: string }> {
    const rows = this.db
      .prepare('SELECT tool_name, description FROM mcp_server_tools WHERE server_id = ? ORDER BY tool_name')
      .all(serverId) as Array<{ tool_name: string; description: string }>;
    return rows.map((r) => ({ name: r.tool_name, description: r.description }));
  }

  /**
   * Get cached tools for ALL enabled servers, prefixed with `ext_<serverId>__`.
   * Used by admin tools panel and session tools dialog — instant, no server connection needed.
   */
  getAllCachedExternalTools(): Array<{
    name: string;
    description: string;
    serverId: string;
    serverName: string;
    tier: string;
    source: 'mcp_external';
  }> {
    const rows = this.db
      .prepare(`
        SELECT t.server_id, t.tool_name, t.description, s.name AS server_name, s.default_tier
        FROM mcp_server_tools t
        JOIN mcp_server_configs s ON s.id = t.server_id
        WHERE s.enabled = 1
        ORDER BY t.server_id, t.tool_name
      `)
      .all() as Array<{
        server_id: string;
        tool_name: string;
        description: string;
        server_name: string;
        default_tier: string;
      }>;
    return rows.map((r) => ({
      name: `ext_${r.server_id}__${r.tool_name}`,
      description: r.description,
      serverId: r.server_id,
      serverName: r.server_name,
      tier: r.default_tier,
      source: 'mcp_external' as const,
    }));
  }
}
