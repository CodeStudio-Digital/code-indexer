import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface McpHttpConfig {
  /**
   * Extra CORS origins for the app's own HTTP API (MCP_HTTP_CORS_ORIGINS).
   * "mcp" is the project name here: the MCP server and its inbound auth
   * were removed; the key keeps its name so existing .env files still work.
   */
  corsOrigins: string[];
}

/**
 * Indexer profile — controls how aggressive the auto-mapper is.
 *
 *   `aggressive` — `on_demand` files (tests, docs, migrations, fixtures)
 *                  skip embeddings entirely. They still go into FTS via
 *                  symbols + summary, but consume zero embedding tokens.
 *   `balanced`   — every non-excluded file gets the full pipeline
 *                  (default; matches pre-mapper behavior for safety).
 *   `conservative` — same as balanced, reserved for future opt-out
 *                  hooks (e.g. embedding all symbols regardless of size).
 */
export type IndexProfile = 'aggressive' | 'balanced' | 'conservative';

export type FeatureFlags = Record<string, never>;

export interface IndexerConfig {
  dbPath: string;
  concurrency: number;
  maxFileSize: number;
  ignorePatterns: string[];
  budget?: number;
  /** Mapper aggressiveness (default: balanced). */
  indexProfile?: IndexProfile;
  features: FeatureFlags;
  dashboard: {
    port: number;
    host: string;
  };
  mcp: {
    http: McpHttpConfig;
  };
}

/**
 * Canonical MCP data directory — holds `index.db`, `exports/`, and
 * host-scaffolded projects (`projects/`). Single source of truth so the
 * various features stop re-joining `~/.mcp-code-indexer` independently.
 * Overridable with `MCP_DATA_DIR`.
 */
export function mcpDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_DATA_DIR?.trim();
  return override ? resolve(override) : join(homedir(), '.mcp-code-indexer');
}

/** Workspace effects belong to the OS user, not to a database/profile. Tests
 * and isolated installations may supply one common coordination directory;
 * changing MCP_DATA_DIR must never silently create another workspace owner. */
export function mcpRuntimeCoordinationDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_RUNTIME_COORDINATION_DIR?.trim();
  return override ? resolve(override) : join(homedir(), '.mcp-code-indexer', 'runtime-coordination-v1');
}

const DEFAULT_DATA_DIR = mcpDataDir();

/**
 * Tiered-hybrid per-project DB split flags (plan §10). All OFF by default, so a
 * fresh build behaves exactly as today. Each phase is independently gated and
 * reversible by flipping its flag.
 */
export interface ProjectDbFlags {
  /** Master switch. When false, every other flag is forced off. */
  enabled: boolean;
  /** P1 — new projects write their index/session data to their own DB. */
  newProjects: boolean;
  /** P2 — lazily backfill a project's INDEX tables into its own DB on open. */
  splitIndex: boolean;
  /** P3 — extend the lazy backfill to session-runtime + scope tables. */
  splitSessions: boolean;
  /**
   * P2b — flip the app's INDEX reads/writes to the per-project DB for migrated
   * projects. SEPARATE from `splitIndex` (which only copies+verifies): routing
   * requires threading projectId through every bare-id caller + the full
   * semantic pipeline, so it ships dark until that's complete + verified.
   * With this OFF, the engine still produces verified project DBs but the app
   * keeps reading/writing central (no behavior change, no bare-id breakage).
   */
  route: boolean;
  /** P5 — cross-project reads go through ATTACH/rollups. */
  crossRead: boolean;
  /**
   * C2 — trim the per-project DB to project-only tables (drop the ~93 central
   * tables it inherits from the full schema, recreate the few project tables
   * that carry a cross-DB FK without it). Defaults ON when the split is enabled
   * (kill-switch MCP_PROJECT_DB_TRIM=0). Touches ONLY per-project DBs; central
   * is never trimmed. Reversible: drop the project DB + re-split.
   */
  trim: boolean;
  /** Eagerly run all pending backfills at boot instead of on first open. */
  eagerMigrate: boolean;
  /** Force the central-dir fallback for every project DB (tests/read-only roots). */
  fallbackAll: boolean;
  /** When to delete a project's rows from the central DB after a verified split. */
  purgeMode: 'defer' | 'immediate';
  /** Max concurrently-open project DB handles per pool. */
  maxOpen: number;
  /** Idle TTL before a pooled project handle is checkpointed + closed (ms). */
  idleMs: number;
}

const envBool = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const v = env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
};

const envIntOr = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function projectDbFlags(env: NodeJS.ProcessEnv = process.env): ProjectDbFlags {
  const enabled = envBool(env, 'MCP_PROJECT_DB');
  const on = (name: string): boolean => enabled && envBool(env, name);
  // On unless explicitly disabled — for flags that default ON when the split is
  // enabled (C2 trim). Kill-switch: set to 0/false/off/no.
  const offValues = new Set(['0', 'false', 'off', 'no']);
  const onByDefault = (name: string): boolean =>
    enabled && !offValues.has(env[name]?.trim().toLowerCase() ?? '');
  return {
    enabled,
    newProjects: on('MCP_PROJECT_DB_NEW'),
    splitIndex: on('MCP_PROJECT_DB_SPLIT'),
    splitSessions: on('MCP_PROJECT_DB_SPLIT_SESSIONS'),
    route: on('MCP_PROJECT_DB_ROUTE'),
    crossRead: on('MCP_PROJECT_DB_XREAD'),
    trim: onByDefault('MCP_PROJECT_DB_TRIM'),
    eagerMigrate: on('MCP_PROJECT_DB_EAGER_MIGRATE'),
    fallbackAll: envBool(env, 'MCP_PROJECT_DB_FALLBACK_ALL'),
    purgeMode: env.MCP_DB_SPLIT_PURGE?.trim() === 'immediate' ? 'immediate' : 'defer',
    maxOpen: envIntOr(env, 'MCP_PROJECT_DB_MAX_OPEN', 8),
    idleMs: envIntOr(env, 'MCP_PROJECT_DB_IDLE_MS', 60_000),
  };
}

const DEFAULT_CONFIG: IndexerConfig = {
  dbPath: join(DEFAULT_DATA_DIR, 'index.db'),
  concurrency: 5,
  maxFileSize: 200,
  ignorePatterns: [],
  indexProfile: 'balanced',
  features: {},
  dashboard: {
    port: 7333,
    // Loopback by DEFAULT. This listener serves the whole IDE API — projects,
    // files, git, and the SSH host/secret tables — with no authentication of
    // its own, so binding it to every interface handed the LAN a copy of the
    // user's machine. Opt in explicitly with MCP_INDEX_HOST=0.0.0.0 (that is
    // what a container needs to publish a port).
    host: '127.0.0.1',
  },
  mcp: {
    http: {
      corsOrigins: [],
    },
  },
};

function applyEnvOverrides(config: IndexerConfig): void {
  if (process.env.MCP_INDEX_DB) {
    config.dbPath = process.env.MCP_INDEX_DB;
  }
  if (process.env.MCP_INDEX_PORT) {
    config.dashboard.port = parseInt(process.env.MCP_INDEX_PORT, 10);
  }
  // Escape hatch for containers / deliberate LAN exposure. See the default above.
  if (process.env.MCP_INDEX_HOST) {
    config.dashboard.host = process.env.MCP_INDEX_HOST.trim();
  }
  if (process.env.MCP_INDEX_CONCURRENCY) {
    config.concurrency = parseInt(process.env.MCP_INDEX_CONCURRENCY, 10);
  }
  if (process.env.MCP_INDEX_BUDGET) {
    config.budget = parseFloat(process.env.MCP_INDEX_BUDGET);
  }

  // CORS of the app's own HTTP API. The former MCP_HTTP_ENABLED/_PATH/_STATEFUL,
  // MCP_AUTH_* and MCP_OAUTH_* (except MCP_OAUTH_REDIRECT_BASE, read by the
  // outbound MCP OAuth) configured the removed MCP server and inbound auth;
  // an old .env that still sets them is ignored.
  if (process.env.MCP_HTTP_CORS_ORIGINS) {
    config.mcp.http.corsOrigins = process.env.MCP_HTTP_CORS_ORIGINS
      .split(',').map((s) => s.trim()).filter(Boolean);
  }
}

export function ensureDataDir(): string {
  const dataDir = DEFAULT_DATA_DIR;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export function loadConfig(cliOverrides?: Partial<IndexerConfig>): IndexerConfig {
  const config: IndexerConfig = structuredClone(DEFAULT_CONFIG);

  // Deprecation warning — .mcp-indexer.json is no longer read.
  const legacyPath = join(process.cwd(), '.mcp-indexer.json');
  if (existsSync(legacyPath)) {
    console.warn(
      '[deprecation] .mcp-indexer.json is no longer read. ' +
      'Settings are managed via the admin dashboard. You can safely delete this file.'
    );
  }

  applyEnvOverrides(config);

  if (cliOverrides) {
    Object.assign(config, cliOverrides);
  }

  // Ensure data directory exists
  const dbDir = resolve(config.dbPath, '..');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  return config;
}
