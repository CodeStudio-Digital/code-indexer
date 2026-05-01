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
import { CompanySandboxStore } from '../../../store/company-sandbox-store.js';
import { CompanySandboxServicesStore } from '../../../store/company-sandbox-services-store.js';
import { CompanySessionEnvStore } from '../../../store/company-session-env-store.js';
import { CompanySessionDatabaseStore } from '../../../store/company-session-database-store.js';
import { CompanyLocalProjectStore } from '../../../store/company-local-project-store.js';
import { SkillStore } from '../../../store/skill-store.js';
import { QaTestRunStore } from '../../../core/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '../../../core/qa/store/qa-test-result-store.js';
import { ChromeServiceStore } from '../../../store/chrome-service-store.js';
import { DesignSystemStore } from '../../../store/design-system-store.js';
import { VerdaccioStore } from '../../../store/verdaccio-store.js';
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
  /**
   * Skills registry (builtin + user + imported). Shared across the boot
   * seeder (`ensureBuiltinSkills`) and the admin/coder routes that
   * currently instantiate ad-hoc per request — sharing the same DB
   * handle avoids SQLite WAL contention on heavy boots.
   */
  skillStore: SkillStore;
}

export interface QaDeps {
  /**
   * Per-run QA test rows. Read by the TestsTab routes (history, detail);
   * written by the test-event endpoint that the Playwright reporter posts to.
   */
  qaTestRunStore: QaTestRunStore;
  /**
   * Per-test outcome rows streamed in by the Playwright reporter.
   * Cascade-deletes with the parent run (FK in migration 043).
   */
  qaTestResultStore: QaTestResultStore;
}

export interface ChromeServiceDeps {
  /**
   * Singleton-row config for the SHARED Playwright/Chromium container
   * (admin-managed). The runtime `ChromeService` class operates on
   * this store; the admin routes read it directly.
   */
  chromeServiceStore: ChromeServiceStore;
}

export interface DesignSystemDeps {
  /**
   * CRUD store for Design System Creator sessions, versions and
   * components (migration 048). Read by the design-system routes and
   * by the DS tools registered on subordinate runners.
   */
  designSystemStore: DesignSystemStore;
  /**
   * Singleton config for the embedded Verdaccio registry (migration 049).
   * The runtime `VerdaccioService` operates on this store.
   */
  verdaccioStore: VerdaccioStore;
}

export interface CompanyDeps {
  companyStore: CompanyStore;
  /**
   * Persisted per-session sandbox state. Enables the SandboxManager to
   * survive API restarts by reconciling its in-memory map with rows in
   * `company_sandboxes` instead of relying solely on podman labels.
   */
  companySandboxStore: CompanySandboxStore;
  /**
   * Per-service sandbox rows for the multi-microservice model
   * (migration 035). The `SandboxManager.provisionAdditionalService`
   * path reads/writes here; the single-primary-container path keeps
   * using `companySandboxStore`.
   */
  companySandboxServicesStore: CompanySandboxServicesStore;
  /** Shared env vars per session; injected into every container + written as /app/.env. */
  companySessionEnvStore: CompanySessionEnvStore;
  /**
   * Typed databases registered per session (Databases tab). Stores metadata
   * only — actual connection strings live in `companySessionEnvStore` so
   * container injection works without code changes.
   */
  companySessionDatabaseStore: CompanySessionDatabaseStore;
  /**
   * Local (host-process) project registry — separate from sandbox tables
   * because host processes have a different lifecycle (no container id,
   * no image, no limits) and the sandbox CHECK constraints forbid a
   * 'local-process' runtime. See migration 042.
   */
  companyLocalProjectStore: CompanyLocalProjectStore;
}

export type ServerDeps = CoreDeps
  & ProviderDeps
  & SearchDeps
  & CostingDeps
  & ProjectServiceDeps
  & CoderDeps
  & CompanyDeps
  & QaDeps
  & ChromeServiceDeps
  & DesignSystemDeps;

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
  // Share the same underlying better-sqlite3 handle that CodeIndexDB
  // opened — re-opening the file would create lock contention.
  const companySandboxStore = new CompanySandboxStore(db.raw());
  const companySandboxServicesStore = new CompanySandboxServicesStore(db.raw());
  const companySessionEnvStore = new CompanySessionEnvStore(db.raw());
  const companySessionDatabaseStore = new CompanySessionDatabaseStore(db.raw());
  const companyLocalProjectStore = new CompanyLocalProjectStore(db.raw());
  const skillStore = new SkillStore(db.raw());
  const qaTestRunStore = new QaTestRunStore(db.raw());
  const qaTestResultStore = new QaTestResultStore(db.raw());
  const chromeServiceStore = new ChromeServiceStore(db.raw());
  const designSystemStore = new DesignSystemStore(db.raw());
  const verdaccioStore = new VerdaccioStore(db.raw());

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
    companySandboxStore,
    companySandboxServicesStore,
    companySessionEnvStore,
    companySessionDatabaseStore,
    companyLocalProjectStore,
    skillStore,
    qaTestRunStore,
    qaTestResultStore,
    chromeServiceStore,
    designSystemStore,
    verdaccioStore,
    embeddingKind,
    vectorStoreKind,
    mcpBearerResolver: null,
  };
}
