import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface EmbeddingsConfig {
  enabled: boolean;
  workerUrl: string;
  workerToken: string;
  model: string;
  dimensions: number;
}

export interface WatcherConfig {
  enabled: boolean;
  debounce: number;
  autoIndex: boolean;
}

export interface WebhookConfigEntry {
  url: string;
  events: string[];
  secret?: string;
}

export interface IndexerConfig {
  dbPath: string;
  provider?: string;
  model?: string;
  concurrency: number;
  maxFileSize: number;
  ignorePatterns: string[];
  embeddings: EmbeddingsConfig;
  watcher: WatcherConfig;
  webhooks: WebhookConfigEntry[];
  costTracking: boolean;
  budget?: number;
  dashboard: {
    port: number;
    host: string;
  };
}

const DEFAULT_DATA_DIR = join(homedir(), '.mcp-code-indexer');

const DEFAULT_CONFIG: IndexerConfig = {
  dbPath: join(DEFAULT_DATA_DIR, 'index.db'),
  concurrency: 5,
  maxFileSize: 200,
  ignorePatterns: [],
  embeddings: {
    enabled: false,
    workerUrl: '',
    workerToken: '',
    model: '@cf/baai/bge-m3',
    dimensions: 1024,
  },
  watcher: {
    enabled: false,
    debounce: 2000,
    autoIndex: true,
  },
  webhooks: [],
  costTracking: true,
  dashboard: {
    port: 3333,
    host: '0.0.0.0',
  },
};

function loadJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function applyEnvOverrides(config: IndexerConfig): void {
  if (process.env.MCP_INDEX_DB) {
    config.dbPath = process.env.MCP_INDEX_DB;
  }
  if (process.env.MCP_INDEX_PROVIDER) {
    config.provider = process.env.MCP_INDEX_PROVIDER;
  }
  if (process.env.MCP_INDEX_MODEL) {
    config.model = process.env.MCP_INDEX_MODEL;
  }
  if (process.env.MCP_INDEX_PORT) {
    config.dashboard.port = parseInt(process.env.MCP_INDEX_PORT, 10);
  }
  if (process.env.MCP_INDEX_WORKER_URL) {
    config.embeddings.workerUrl = process.env.MCP_INDEX_WORKER_URL;
  }
  if (process.env.MCP_INDEX_WORKER_TOKEN) {
    config.embeddings.workerToken = process.env.MCP_INDEX_WORKER_TOKEN;
  }
  if (process.env.MCP_INDEX_EMBEDDINGS === 'true') {
    config.embeddings.enabled = true;
  } else if (process.env.MCP_INDEX_EMBEDDINGS === 'false') {
    config.embeddings.enabled = false;
  }
  if (process.env.MCP_INDEX_CONCURRENCY) {
    config.concurrency = parseInt(process.env.MCP_INDEX_CONCURRENCY, 10);
  }
  if (process.env.MCP_INDEX_BUDGET) {
    config.budget = parseFloat(process.env.MCP_INDEX_BUDGET);
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

  // Load from cwd first, then home dir
  const cwdConfig = loadJsonFile(join(process.cwd(), '.mcp-indexer.json'));
  const homeConfig = loadJsonFile(join(homedir(), '.mcp-indexer.json'));

  const fileConfig = cwdConfig ?? homeConfig;
  if (fileConfig) {
    Object.assign(config, fileConfig);
    if (fileConfig.embeddings && typeof fileConfig.embeddings === 'object') {
      Object.assign(config.embeddings, fileConfig.embeddings);
    }
    if (fileConfig.watcher && typeof fileConfig.watcher === 'object') {
      Object.assign(config.watcher, fileConfig.watcher);
    }
    if (fileConfig.dashboard && typeof fileConfig.dashboard === 'object') {
      Object.assign(config.dashboard, fileConfig.dashboard);
    }
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

export interface InitOverrides {
  description?: string;
  provider?: string;
  model?: string;
  embeddingsEnabled?: boolean;
}

export function getDefaultConfigTemplate(overrides: InitOverrides = {}): string {
  return JSON.stringify(
    {
      ...(overrides.description ? { description: overrides.description } : {}),
      provider: overrides.provider ?? 'zai',
      model: overrides.model ?? 'glm-5.1',
      concurrency: 5,
      maxFileSize: 200,
      ignorePatterns: ['*.test.*', '*.spec.*'],
      embeddings: {
        enabled: overrides.embeddingsEnabled ?? false,
        workerUrl: '',
        workerToken: '',
        model: '@cf/baai/bge-m3',
        dimensions: 1024,
      },
      watcher: {
        enabled: false,
        debounce: 2000,
        autoIndex: true,
      },
      webhooks: [],
      costTracking: true,
      dashboard: {
        port: 3333,
        host: '0.0.0.0',
      },
    },
    null,
    2
  );
}
