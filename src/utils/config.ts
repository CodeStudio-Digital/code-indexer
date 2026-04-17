import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface McpHttpConfig {
  enabled: boolean;
  path: string;
  stateful: boolean;
  corsOrigins: string[];
}

export interface McpAuthConfig {
  enabled: boolean;
  rateLimitPerMin: number;
}

export interface McpOAuthConfig {
  enabled: boolean;
  issuer: string;
  jwtSecret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  allowDcr: boolean;
}

export interface IndexerConfig {
  dbPath: string;
  concurrency: number;
  maxFileSize: number;
  ignorePatterns: string[];
  budget?: number;
  dashboard: {
    port: number;
    host: string;
  };
  mcp: {
    http: McpHttpConfig;
    auth: McpAuthConfig;
    oauth: McpOAuthConfig;
  };
}

const DEFAULT_DATA_DIR = join(homedir(), '.mcp-code-indexer');

const DEFAULT_CONFIG: IndexerConfig = {
  dbPath: join(DEFAULT_DATA_DIR, 'index.db'),
  concurrency: 5,
  maxFileSize: 200,
  ignorePatterns: [],
  dashboard: {
    port: 3333,
    host: '0.0.0.0',
  },
  mcp: {
    http: {
      enabled: false,
      path: '/mcp',
      stateful: false,
      corsOrigins: [],
    },
    auth: {
      enabled: false,
      rateLimitPerMin: 120,
    },
    oauth: {
      enabled: false,
      issuer: '',
      jwtSecret: '',
      accessTtlSec: 3600,
      refreshTtlSec: 30 * 24 * 3600,
      allowDcr: true,
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
  if (process.env.MCP_INDEX_CONCURRENCY) {
    config.concurrency = parseInt(process.env.MCP_INDEX_CONCURRENCY, 10);
  }
  if (process.env.MCP_INDEX_BUDGET) {
    config.budget = parseFloat(process.env.MCP_INDEX_BUDGET);
  }

  // MCP HTTP
  if (process.env.MCP_HTTP_ENABLED) {
    config.mcp.http.enabled = process.env.MCP_HTTP_ENABLED === 'true';
  }
  if (process.env.MCP_HTTP_PATH) {
    config.mcp.http.path = process.env.MCP_HTTP_PATH;
  }
  if (process.env.MCP_HTTP_STATEFUL) {
    config.mcp.http.stateful = process.env.MCP_HTTP_STATEFUL === 'true';
  }
  if (process.env.MCP_HTTP_CORS_ORIGINS) {
    config.mcp.http.corsOrigins = process.env.MCP_HTTP_CORS_ORIGINS
      .split(',').map((s) => s.trim()).filter(Boolean);
  }

  // MCP auth (API tokens)
  if (process.env.MCP_AUTH_ENABLED) {
    config.mcp.auth.enabled = process.env.MCP_AUTH_ENABLED === 'true';
  }
  if (process.env.MCP_AUTH_RATE_LIMIT) {
    config.mcp.auth.rateLimitPerMin = parseInt(process.env.MCP_AUTH_RATE_LIMIT, 10);
  }

  // MCP OAuth
  if (process.env.MCP_OAUTH_ENABLED) {
    config.mcp.oauth.enabled = process.env.MCP_OAUTH_ENABLED === 'true';
  }
  if (process.env.MCP_OAUTH_ISSUER) {
    config.mcp.oauth.issuer = process.env.MCP_OAUTH_ISSUER;
  }
  if (process.env.MCP_OAUTH_JWT_SECRET) {
    config.mcp.oauth.jwtSecret = process.env.MCP_OAUTH_JWT_SECRET;
  }
  if (process.env.MCP_OAUTH_ACCESS_TTL) {
    config.mcp.oauth.accessTtlSec = parseInt(process.env.MCP_OAUTH_ACCESS_TTL, 10);
  }
  if (process.env.MCP_OAUTH_REFRESH_TTL) {
    config.mcp.oauth.refreshTtlSec = parseInt(process.env.MCP_OAUTH_REFRESH_TTL, 10);
  }
  if (process.env.MCP_OAUTH_ALLOW_DCR) {
    config.mcp.oauth.allowDcr = process.env.MCP_OAUTH_ALLOW_DCR === 'true';
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
