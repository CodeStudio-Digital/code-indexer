import { CodeIndexDB } from '@mcp/store/db.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { DiffService } from '@mcp/services/services/differ.js';
import { ExportService } from '@mcp/services/services/exporter.js';
import { WebhookDispatcher } from '@mcp/services/services/webhooks.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { createReranker } from '@mcp/indexer/search/reranker.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
} from '@mcp/indexer/bootstrap/index.js';

export interface ToolContext {
  config: IndexerConfig;
  db: CodeIndexDB;
  providerStore: ProviderStore;
  costTracker: CostTracker;
  snapshotService: SnapshotService;
  /** Dedicated Agent Memory (migration 181) — backs the bridged save_memory/search_memory. */
  agentMemoryService: AgentMemoryService;
  diffService: DiffService;
  exportService: ExportService;
  webhookDispatcher: WebhookDispatcher;
  modelDiscovery: ModelDiscovery;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  hybridSearch: HybridSearch;
}

export function buildContext(): ToolContext {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);

  // ProviderStore is the source of truth for embedding + vector-store backends.
  // seedFromEnvIfEmpty() migrates legacy .env vars on first run.
  const providerStore = createAndSeedProviderStore(config.dbPath);

  const { embeddingService, vectorStore, searchableVectorStore, hybridSearch } =
    createSearchBundle(db, providerStore, createReranker(providerStore));

  return {
    config,
    db,
    providerStore,
    costTracker: new CostTracker(db),
    snapshotService: new SnapshotService(db, embeddingService, searchableVectorStore),
    agentMemoryService: new AgentMemoryService(db, embeddingService, searchableVectorStore),
    diffService: new DiffService(db),
    exportService: new ExportService(db),
    webhookDispatcher: new WebhookDispatcher(db),
    modelDiscovery: new ModelDiscovery(db),
    embeddingService,
    vectorStore,
    hybridSearch,
  };
}
