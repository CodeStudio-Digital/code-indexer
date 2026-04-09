import { CodeIndexDB } from '../../store/db.js';
import { loadConfig, type IndexerConfig } from '../../utils/config.js';
import { ProviderStore } from '../../store/provider-store.js';
import { CostTracker } from '../../core/services/costs.js';
import { SnapshotService } from '../../core/services/snapshots.js';
import { DiffService } from '../../core/services/differ.js';
import { ExportService } from '../../core/services/exporter.js';
import { WebhookDispatcher } from '../../core/services/webhooks.js';
import { HybridSearch } from '../../core/search/hybrid.js';
import { HyDEService } from '../../core/search/hyde.js';
import { ModelDiscovery } from '../../core/indexer/providers/model-discovery.js';
import {
  createEmbeddingService,
  type EmbeddingService,
} from '../../core/search/embeddings.js';
import { createVectorStore, NullVectorStore, type VectorStore } from '../../store/vectors.js';

export interface ToolContext {
  config: IndexerConfig;
  db: CodeIndexDB;
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
  // seedFromEnvIfEmpty() migrates legacy .env vars on first run so existing
  // users don't lose their Cloudflare config.
  const providerStore = new ProviderStore(config.dbPath);
  providerStore.seedFromEnvIfEmpty();

  const envFallback =
    config.embeddings.enabled && config.embeddings.workerUrl
      ? { workerUrl: config.embeddings.workerUrl, workerToken: config.embeddings.workerToken }
      : undefined;

  const embeddingService = createEmbeddingService(providerStore, envFallback);
  const vectorStore = createVectorStore(providerStore, envFallback);

  // HybridSearch accepts any VectorStore (including NullVectorStore, which
  // cleanly degrades to FTS-only). Kept as non-null for simpler call sites.
  const searchableVectorStore = vectorStore instanceof NullVectorStore ? null : vectorStore;

  // HyDE is lazy — the service reads the provider row on first call, so we
  // wire it in unconditionally. The HybridSearch only invokes it when the
  // caller asks for `hyde: true` via get_context_for.
  const hydeService = new HyDEService(providerStore);

  return {
    config,
    db,
    costTracker: new CostTracker(db),
    snapshotService: new SnapshotService(db, embeddingService, searchableVectorStore),
    diffService: new DiffService(db),
    exportService: new ExportService(db),
    webhookDispatcher: new WebhookDispatcher(db),
    modelDiscovery: new ModelDiscovery(db),
    embeddingService,
    vectorStore,
    hybridSearch: new HybridSearch(db, searchableVectorStore, embeddingService, hydeService),
  };
}
