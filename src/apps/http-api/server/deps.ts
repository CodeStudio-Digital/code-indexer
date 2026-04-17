import { CodeIndexDB } from '../../../store/db.js';
import { loadConfig, type IndexerConfig } from '../../../utils/config.js';
import { ProviderStore } from '../../../store/provider-store.js';
import { CostTracker } from '../../../core/services/costs.js';
import { SnapshotService } from '../../../core/services/snapshots.js';
import { DiffService } from '../../../core/services/differ.js';
import { ExportService } from '../../../core/services/exporter.js';
import { WebhookDispatcher } from '../../../core/services/webhooks.js';
import { HybridSearch } from '../../../core/search/hybrid.js';
import { ModelDiscovery } from '../../../core/indexer/providers/model-discovery.js';
import type { EmbeddingService } from '../../../core/search/embeddings.js';
import type { VectorStore } from '../../../store/vectors.js';
import { SessionStore } from '../../../core/coder/index.js';
import { CompanyStore } from '../../../store/company-store.js';
import type { ResolveMcpBearer } from '../../../core/mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
  deriveKindLabel,
} from '../../../core/bootstrap/index.js';

/**
 * Segregated dependency blocks. Routes and mount functions should declare
 * only the subsets they destructure — TypeScript will then prevent passing
 * a `ServerDeps` that's missing any required piece, while leaf modules stay
 * honest about what they use (Interface Segregation Principle).
 *
 * The composed `ServerDeps` (below) is still what `createDeps()` returns, so
 * call sites that want everything keep working unchanged.
 */
export interface CoreDeps {
  config: IndexerConfig;
  db: CodeIndexDB;
}

export interface ProviderDeps {
  providerStore: ProviderStore;
  modelDiscovery: ModelDiscovery;
}

export interface SearchDeps {
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  hybridSearch: HybridSearch;
  /** Resolved kind names for diagnostics (avoid importing concrete classes). */
  embeddingKind: string;
  vectorStoreKind: string;
}

export interface CostingDeps {
  costTracker: CostTracker;
}

export interface ProjectServiceDeps {
  snapshotService: SnapshotService;
  diffService: DiffService;
  exportService: ExportService;
  webhookDispatcher: WebhookDispatcher;
}

export interface CoderDeps {
  sessionStore: SessionStore;
  /**
   * Resolver for OAuth bearer tokens of external MCP servers. Set by
   * `server.ts` after composing the MCP client auth bundle; `runCoder`
   * routes forward it into runCoder via `opts.mcpBearerResolver`.
   */
  mcpBearerResolver: ResolveMcpBearer | null;
}

export interface CompanyDeps {
  companyStore: CompanyStore;
}

export type ServerDeps = CoreDeps
  & ProviderDeps
  & SearchDeps
  & CostingDeps
  & ProjectServiceDeps
  & CoderDeps
  & CompanyDeps;

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
  const providerStore = createAndSeedProviderStore(config.dbPath);

  const { embeddingService, vectorStore, searchableVectorStore, hybridSearch } =
    createSearchBundle(db, providerStore);

  const snapshotService = new SnapshotService(db, embeddingService, searchableVectorStore);
  const sessionStore = new SessionStore(config.dbPath);
  const companyStore = new CompanyStore(config.dbPath);

  const embeddingKind = deriveKindLabel(embeddingService, 'EmbeddingService');
  const vectorStoreKind = deriveKindLabel(vectorStore, 'VectorStore');

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
    mcpBearerResolver: null,
  };
}
