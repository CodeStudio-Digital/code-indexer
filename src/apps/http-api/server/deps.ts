import { CodeIndexDB } from '../../../store/db.js';
import { loadConfig, type IndexerConfig } from '../../../utils/config.js';
import { ProviderStore } from '../../../store/provider-store.js';
import { CostTracker } from '../../../core/services/costs.js';
import { SnapshotService } from '../../../core/services/snapshots.js';
import { DiffService } from '../../../core/services/differ.js';
import { ExportService } from '../../../core/services/exporter.js';
import { WebhookDispatcher } from '../../../core/services/webhooks.js';
import { HybridSearch } from '../../../core/search/hybrid.js';
import { HyDEService } from '../../../core/search/hyde.js';
import { ModelDiscovery } from '../../../core/indexer/providers/model-discovery.js';
import { createEmbeddingService } from '../../../core/search/embeddings.js';
import type { EmbeddingService } from '../../../core/search/embeddings.js';
import { createVectorStore, NullVectorStore, type VectorStore } from '../../../store/vectors.js';
import { SessionStore } from '../../../core/coder/index.js';
import { CompanyStore } from '../../../store/company-store.js';

export interface ServerDeps {
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
  sessionStore: SessionStore;
  companyStore: CompanyStore;
  /** Resolved kind names for diagnostics (avoid importing concrete classes). */
  embeddingKind: string;
  vectorStoreKind: string;
}

export function createDeps(): ServerDeps {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const costTracker = new CostTracker(db);
  const diffService = new DiffService(db);
  const exportService = new ExportService(db);
  const webhookDispatcher = new WebhookDispatcher(db);
  const modelDiscovery = new ModelDiscovery(db);

  // Instantiated early so createEmbeddingService can query the DB-managed
  // embedding_configs table. The admin UI writes there; legacy .env config
  // is the fallback when no row is marked default.
  const providerStore = new ProviderStore(config.dbPath);
  providerStore.seedFromEnvIfEmpty();

  const envFallback =
    config.embeddings.enabled && config.embeddings.workerUrl
      ? { workerUrl: config.embeddings.workerUrl, workerToken: config.embeddings.workerToken }
      : undefined;

  const embeddingService = createEmbeddingService(providerStore, envFallback);
  const vectorStore = createVectorStore(providerStore, envFallback);
  const searchableVectorStore = vectorStore instanceof NullVectorStore ? null : vectorStore;

  const hydeService = new HyDEService(providerStore);
  const hybridSearch = new HybridSearch(db, searchableVectorStore, embeddingService, hydeService);
  const snapshotService = new SnapshotService(db, embeddingService, searchableVectorStore);
  const sessionStore = new SessionStore(config.dbPath);
  const companyStore = new CompanyStore(config.dbPath);

  // Derive kind labels from class names for diagnostics. Avoids importing
  // every concrete class — constructor.name is sufficient for the debug panel.
  const embeddingKind = embeddingService.constructor.name
    .replace('EmbeddingService', '')
    .replace(/([A-Z])/g, (_, c: string, i: number) => (i ? '-' : '') + c.toLowerCase())
    .replace(/^-/, '') || 'unknown';
  const vectorStoreKind = vectorStore.constructor.name
    .replace('VectorStore', '')
    .replace(/([A-Z])/g, (_, c: string, i: number) => (i ? '-' : '') + c.toLowerCase())
    .replace(/^-/, '') || 'unknown';

  return {
    config,
    db,
    providerStore,
    costTracker,
    snapshotService,
    diffService,
    exportService,
    webhookDispatcher,
    modelDiscovery,
    embeddingService,
    vectorStore,
    hybridSearch,
    sessionStore,
    companyStore,
    embeddingKind,
    vectorStoreKind,
  };
}
