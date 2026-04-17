import { CodeIndexDB } from '../../store/db.js';
import { loadConfig, type IndexerConfig } from '../../utils/config.js';
import { ProviderStore } from '../../store/provider-store.js';
import { CostTracker } from '../../core/services/costs.js';
import { SnapshotService } from '../../core/services/snapshots.js';
import { DiffService } from '../../core/services/differ.js';
import { ExportService } from '../../core/services/exporter.js';
import { WebhookDispatcher } from '../../core/services/webhooks.js';
import { HybridSearch } from '../../core/search/hybrid.js';
import { createReranker } from '../../core/search/reranker.js';
import { ModelDiscovery } from '../../core/indexer/providers/model-discovery.js';
import type { EmbeddingService } from '../../core/search/embeddings.js';
import type { VectorStore } from '../../store/vectors.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
} from '../../core/bootstrap/index.js';

export interface ToolContext {
  config: IndexerConfig;
  db: CodeIndexDB;
  providerStore: ProviderStore;
  costTracker: CostTracker;
  snapshotService: SnapshotService;
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
    createSearchBundle(db, providerStore, createReranker());

  return {
    config,
    db,
    providerStore,
    costTracker: new CostTracker(db),
    snapshotService: new SnapshotService(db, embeddingService, searchableVectorStore),
    diffService: new DiffService(db),
    exportService: new ExportService(db),
    webhookDispatcher: new WebhookDispatcher(db),
    modelDiscovery: new ModelDiscovery(db),
    embeddingService,
    vectorStore,
    hybridSearch,
  };
}
