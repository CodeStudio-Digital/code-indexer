import { CodeIndexDB } from '@mcp/store/db.js';
import { registerShutdownTask } from './shutdown-tasks.js';
import { getMemoryLedger } from './perf/memory-ledger.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { ProjectIndexService, createInProcessStructuralExecutor } from '@mcp/services/services/project-index/index.js';
import { getLspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import { MemoryRetriever } from '@mcp/services/memory/retriever.js';
import { createRunEndMemory, type RunEndMemory } from '@mcp/services/memory/run-end.js';
import { MemoryExtractor } from '@mcp/services/memory/extractor.js';
import { DiffService } from '@mcp/services/services/differ.js';
import { ExportService } from '@mcp/services/services/exporter.js';
import { WebhookDispatcher } from '@mcp/services/services/webhooks.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { SessionStore } from '@mcp/code-agent/index.js';
import { setInvestigationEmbedder } from '@mcp/code-agent/tools/investigation-embedder.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';
import { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { CompanySessionDatabaseStore } from '@mcp/store/company-session-database-store.js';
import { CompanyLocalProjectStore } from '@mcp/store/company-local-project-store.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { QaTestRunStore } from '@mcp/services/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '@mcp/services/qa/store/qa-test-result-store.js';
import { ChromeServiceStore } from '@mcp/store/chrome-service-store.js';
import { DesignSystemStore } from '@mcp/store/design-system-store.js';
import { ApiClientStore } from '@mcp/store/api-client-store.js';
import { VerdaccioStore } from '@mcp/store/verdaccio-store.js';
import { PipelineTelemetryStore } from '@mcp/store/pipeline-telemetry-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PipelineProviderResolver, generalDefaultAsFallback } from '@mcp/services/pipelines/index.js';
import { TaskPreflightService } from '@mcp/services/services/task-preflight/index.js';
import { getAllKnownToolsMeta } from '@mcp/code-agent/tools/tiers.js';
import {
  buildPreflightToolCatalog,
  buildPreflightSkillCatalog,
} from './preflight-capability-catalog.js';
import { NoopTelemetrySink } from '@mcp/candidate-pipeline/stats.js';
import type { TelemetrySink } from '@mcp/candidate-pipeline/stats.js';
import {
  InMemoryToolEmbeddingStore,
  type EmbeddingFn,
} from '@mcp/code-agent/tool-selection/index.js';
import {
  InMemoryMessageEmbeddingStore,
  createContextRelevancePipeline,
} from '@mcp/code-agent/context-relevance/index.js';
import type {
  ContextRelevanceQuery,
  MessageCandidate,
} from '@mcp/code-agent/context-relevance/index.js';
import type { CandidatePipeline } from '@mcp/candidate-pipeline';
import { SubAgentResultCacheStore } from '@mcp/store/sub-agent-result-cache-store.js';
import { SubAgentResultCache } from '@mcp/services/sub-agent-cache/index.js';
import { DocStore } from '@mcp/store/doc-store.js';
import {
  BrowserBackend,
  CrossEncoderReranker,
  detectBlocked,
  DocHybridSearch,
  DocIngestProgressTracker,
  EscalatingFetcher,
  IndexDocumentationUseCase,
  PlainFetchBackend,
  QueryRewriter,
  Reranker,
  UrlFetcher,
} from '@mcp/services/services/docs/index.js';
import { InMemoryRoleEmbeddingStore } from '@mcp/company/role-pipeline/index.js';
import { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { QualityInterventionStore } from '@mcp/store/quality-intervention-store.js';
import { CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';
import {
  CodeQualityClassifier,
  CompletenessClassifier,
  OffTopicClassifier,
  PolicyClassifier,
  QualityClassifierPipeline,
  ToolMisuseClassifier,
} from '@mcp/services/quality/index.js';
import {
  ShadowTrafficRunner,
  FeedbackCollector,
  ToolSelectionOutcomeMatcher,
  RolePipelineOutcomeMatcher,
  KanbanPriorityOutcomeMatcher,
} from '@mcp/services/shadow-traffic/index.js';
import {
  buildToolSelectionShadowVariants,
  DEFAULT_TOOL_SELECTION_VARIANTS,
  applyToolSelectionThin,
  type ThinTool,
} from '@mcp/code-agent/tool-selection/index.js';
import type {
  ToolSelectionQuery,
} from '@mcp/code-agent/tool-selection/index.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { LshIndexStore } from '@mcp/store/lsh-index-store.js';
import { LSHIndex } from '@mcp/indexer/search/lsh-index.js';
import {
  NullLshIndexingSink,
  RealLshIndexingSink,
  type LshIndexingSink,
} from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import {
  createAndSeedProviderStore,
  createSearchBundle,
  deriveKindLabel,
} from '@mcp/indexer/bootstrap/index.js';
import { createReranker } from '@mcp/indexer/search/reranker.js';
import { createEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import { setGlobalRecentFilesTouchSink } from '@mcp/code-agent/tools/global-recent-files.js';
import { setBuilderCheckpointDeps } from '../sse/builder-checkpoint.js';
import { createEmbeddingExecutor } from '../sse/EmbeddingsWorkerClient.js';
import { resolve as pathResolveNode, sep as pathSep } from 'node:path';
import type { ChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import { invokePluginTool, type PluginToolInvokeFn } from '../sse/PluginHostSingleton.js';

/**
 * Late-bound ChromeService reference shared with the doc indexer's
 * `BrowserBackend`. Populated by `server.ts` after the ChromeService
 * singleton is constructed. Null = browser escalation unavailable; the
 * EscalatingFetcher silently degrades to plain results.
 */
let chromeServiceForDocs: ChromeService | null = null;
export function setChromeServiceForDocs(svc: ChromeService | null): void {
  chromeServiceForDocs = svc;
}

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
  /**
   * Electron-only: returns `app.getAppMetrics()` — the full process tree
   * (GPU, renderer, utility) with working-set + CPU. Injected by the
   * Electron main process AFTER `createApp()` (http-api can't import
   * `electron`); undefined on web deploys, where the perf monitor shows
   * only the main process + worker threads. Read lazily per sampler tick
   * by `server/perf/perf-sampler.ts`, so the late assignment is safe.
   */
  processMetricsProvider?: () => import('./perf/perf-sampler.js').ProcessMetricLike[];
}

export interface ProviderDeps {
  providerStore: ProviderStore;
  modelDiscovery: ModelDiscovery;
}

export interface SearchDeps {
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  hybridSearch: HybridSearch;
  /** Mem C — project-memory retrieval over snapshots (relevance × importance). */
  memoryRetriever: MemoryRetriever;
  /** Mem C write-back — end-of-run durable-memory distillation (facts + gotchas). */
  runEndMemory: RunEndMemory;
  /** Direct agent ports: save_note scope 'project' (dedup'd write) + recall_memory
   *  (full-content semantic fetch). Mirrors `RunCoderOptions.projectMemory`. */
  projectMemory: {
    save(
      projectId: number,
      projectName: string,
      entry: { title: string; content: string; category: string },
    ): Promise<{ created: number; merged: number; skipped: number } | null>;
    recall(
      projectId: number,
      projectName: string,
      query: string,
      limit?: number,
    ): Promise<Array<{
      id: string; title: string; content: string;
      category?: string; source?: string; importance?: number; staleNote?: string;
    }>>;
  };
  /**
   * I2 — process-wide hot cache of recently-touched files. Always
   * constructed (so tools can `touch()` regardless of feature flag), but
   * `HybridSearch` only consults it when `MCP_PIPELINES_RECENT_FILES_SOURCE=1`.
   * Tools wiring the touch() calls live elsewhere; this exposure makes
   * the source reachable for them.
   */
  recentFilesSource: RecentFilesSource;
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
  /**
   * IntelliJ-style structural auto-index: "project opened" → idempotent
   * tree-sitter+FTS run ($0, no provider) + real-time watcher. Boots with
   * the in-process executor; `server.ts`/`electron/main.ts` upgrade it to
   * the dedicated indexer worker via `setExecutor` (late-bound — same
   * pattern as the coder worker doc deps).
   */
  projectIndexService: ProjectIndexService;
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

export interface ApiClientDeps {
  /**
   * CRUD store for the in-app Postman tables (migration 147): collections,
   * environments, requests (verification folded in) and regression-run
   * history. Read by the api-client routes and re-wired into the coder/company
   * workers (module globals don't cross worker_threads) for the `api_*` tools.
   */
  apiClientStore: ApiClientStore;
}

export interface PipelineDeps {
  /**
   * Per-stage telemetry rows emitted by the candidate-pipeline framework
   * (migration 080). Buffered in-memory and flushed in batches — the table
   * is append-only and indexed by (pipeline_name, stage, created_at).
   */
  pipelineTelemetryStore: PipelineTelemetryStore;
  /**
   * Admin-managed provider+model bindings per pipeline+role (migration 080).
   * The resolver consults this with a session→template→global hierarchy.
   */
  pipelineBindingsStore: PipelineProviderBindingsStore;
  /**
   * Resolves which provider/model/config a given pipeline should use for a
   * given role, given the current session+template context. Every pipeline
   * stage that calls an LLM goes through this resolver — never instantiates
   * a provider client directly.
   */
  pipelineProviderResolver: PipelineProviderResolver;
  /**
   * Task preflight — first-prompt analysis (binding `code-agent/preflight`).
   * Fail-open: unconfigured/timeout/error → the session starts as before.
   */
  taskPreflight: TaskPreflightService;
  /**
   * SQLite-backed telemetry sink. Pass to any `new CandidatePipeline({ telemetry })`
   * to get automatic per-stage rows in `pipeline_telemetry`.
   */
  pipelineTelemetrySink: TelemetrySink;
  /**
   * Shared cache of tool-description embeddings used by the
   * ToolSelectionPipeline. Tools change rarely so this stays small.
   */
  toolEmbeddingStore: InMemoryToolEmbeddingStore;
  /**
   * Adapter that exposes the indexer's EmbeddingService as the simple
   * `EmbeddingFn` interface the candidate-pipeline framework expects.
   * Returns a Float32Array of the embedding for a single text input.
   */
  toolSelectionEmbed: EmbeddingFn;
  /**
   * Per-process store of message embeddings used by the ContextRelevance
   * pipeline. Keyed by message-id; intentionally lives in-memory because
   * messages are session-scoped and lose value the moment the session ends.
   */
  messageEmbeddingStore: InMemoryMessageEmbeddingStore;
  /**
   * Pre-built ContextRelevance pipeline. Installed as the global by the
   * boot path (toggled via `MCP_PIPELINES_CONTEXT_RELEVANCE=1`). The
   * runtime consults it before falling through to deterministic
   * compaction.
   */
  contextRelevancePipeline: CandidatePipeline<ContextRelevanceQuery, MessageCandidate>;
  /**
   * SQLite-backed cache of sub-agent (Explore / Plan / general-purpose)
   * outputs keyed by (prompt_hash, context_digest, agent_type). Lets the
   * runtime skip an expensive sub-agent run when the exact same query has
   * been answered within its TTL window.
   */
  subAgentResultCache: SubAgentResultCache;
  /**
   * Shared embeddings of role descriptions, used by the RolePipeline's
   * two-tower scorer. Roles change with template revisions, so this stays
   * small and lives in-memory.
   */
  roleEmbeddingStore: InMemoryRoleEmbeddingStore;
  /**
   * Persistent store of quality verdicts (`quality_classifications`).
   * Read by the admin UI; written by `QualityClassifierPipeline`.
   */
  qualityClassificationStore: QualityClassificationStore;
  /**
   * Persistent store of quality interventions (`quality_interventions`,
   * migration 090). Inserts on every nudge / planning intervention so the
   * dashboard can answer "did the next turn improve?" without inference.
   */
  qualityInterventionStore: QualityInterventionStore;
  /**
   * Shadow-traffic counterfactual log table. Inserts come from
   * shadow side-effects; outcome backfills come from feedback collectors.
   */
  counterfactualLogStore: CounterfactualLogStore;
  /**
   * Five-classifier pipeline (off-topic / completeness / code / policy /
   * tool-misuse). Runs all in parallel via Promise.allSettled.
   * Provider per classifier is resolved via PipelineProviderResolver, so
   * the admin picks model/provider/temperature without a redeploy.
   */
  qualityClassifierPipeline: QualityClassifierPipeline;
  /**
   * Shadow-traffic runner for the ToolSelectionPipeline. Sample rate is
   * driven by the MCP_SHADOW_TOOL_SELECTION_RATE env var (default 0 = off).
   * When > 0, deterministically samples a fraction of requests and runs
   * configured `k` variants in parallel, logging each variant's selection
   * to `counterfactual_logs`.
   */
  toolSelectionShadowRunner: ShadowTrafficRunner<ToolSelectionQuery>;
  /**
   * Setter for the tool registry used by the shadow runner. The runner
   * integration calls this once during boot; until then shadow variants
   * see an empty registry and emit empty selections (visible in the
   * counterfactual logs so the gap is obvious).
   */
  setToolSelectionRegistry: (fn: () => CoderTool[]) => void;
  /**
   * LSH index for codebase embeddings. Stores 32-bit SimHash signatures +
   * multi-hash buckets per (project, entity_type, entity_id). Indexer
   * integration calls `lshIndex.indexMany(...)` alongside its vector-store
   * upsert; search calls `lshIndex.candidatesFor(...)` to narrow candidates
   * before doing full-precision cosine similarity in the vector store.
   */
  lshIndex: LSHIndex;
  /** Direct store handle for diagnostics + admin maintenance endpoints. */
  lshIndexStore: LshIndexStore;
  /**
   * Sink the IndexAgent calls after vector-store upserts. Null when LSH
   * is disabled (`MCP_LSH_INDEXING != '1'`); real impl pushes signatures
   * + buckets into the LSH store. Default: disabled so existing indexing
   * paths see zero overhead.
   */
  lshIndexingSink: LshIndexingSink;
  /**
   * Counterfactual feedback collector. Calls observe(...) when the
   * runtime sees a real outcome (tool actually called, role spawned,
   * card moved to done) so the shadow analytics get backfilled.
   */
  feedbackCollector: FeedbackCollector;
  /**
   * Pre-bound `RunnerOptions.toolSelectionFilter` factory. Returns a
   * filter function the runner calls per turn, only when
   * `MCP_PIPELINES_TOOL_SELECTION === '1'`. Returns `undefined` when the
   * flag is off — making `opts.toolSelectionFilter` undefined and skipping
   * the hook entirely. Zero runtime overhead when disabled.
   */
  buildToolSelectionFilter: () => undefined | ((
    tools: ThinTool[],
    ctx: { taskText: string; recentToolCalls: ReadonlyArray<{ name: string; timestampMs: number; ok: boolean }> },
  ) => Promise<ThinTool[]>);
  /**
   * Companion to `buildToolSelectionFilter` — the runtime calls this
   * with the recently-invoked tool names so the FeedbackCollector can
   * backfill `true_outcome_json` on shadow rows. Safe to call when the
   * feature is off (no-op).
   */
  observeToolSelectionOutcome: (taskText: string, toolsCalled: ReadonlyArray<string>) => void;
}

export interface DocCorpusDeps {
  /**
   * Persistence layer for the documentation corpus (migration 086).
   * Owns CRUD over `doc_collections`, `doc_sources`, `doc_chunks`, plus
   * the FTS5 search helper consumed by `DocHybridSearch`.
   */
  docStore: DocStore;
  /**
   * Hybrid (FTS5 + vector) retrieval over the doc corpus. Wired into the
   * agent's `rag_search_docs` tool at boot via `setGlobalDocSearch` so
   * any session in the process can search docs without per-runner setup.
   */
  docHybridSearch: DocHybridSearch;
  /**
   * Orchestrates one PDF/URL ingestion at a time. The HTTP routes
   * (`/api/docs/...`) and any background recovery code call into the same
   * instance — concurrency control lives in `doc_sources.status`.
   */
  indexDocsUseCase: IndexDocumentationUseCase;
  /**
   * In-memory cache of the latest progress frame per source. Shared
   * between the writer (use-case onProgress) and the reader
   * (`GET /api/docs/sources/:id/progress`). Lost on process restart —
   * by design (boot recovery already flips in-flight sources to error).
   */
  docProgressTracker: DocIngestProgressTracker;
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

export interface PluginRuntimeDeps {
  /** Invoke an installed plugin's tool from the UI (outside a coder run). */
  invokePluginTool: PluginToolInvokeFn;
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
  & DesignSystemDeps
  & ApiClientDeps
  & PipelineDeps
  & DocCorpusDeps
  & PluginRuntimeDeps;

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

  // Reranker is wired here for parity with mcp-server (apps/mcp-server/context.ts:43)
  // and CLI snapshots (apps/cli/commands/snapshots.ts:67). Without this, the
  // HybridSearch instance served to the Electron renderer via IPC has a
  // NullReranker, which makes mode='hybrid' worse than 'fts' on code queries
  // (measured: hybrid R@5 0.64 vs fts R@5 0.80 in bench/results/search-baseline-2026-05-25).
  // `createReranker()` returns NullReranker when COHERE_API_KEY and
  // MCP_RERANK_WORKER_URL are both unset — zero behavior change in that case.
  //
  // I2 — `RecentFilesSource` is constructed unconditionally but only
  // consulted by HybridSearch when `MCP_PIPELINES_RECENT_FILES_SOURCE=1`
  // is set. The source starts empty; downstream code is expected to call
  // `recentFilesSource.touch(...)` whenever a file is read/edited via
  // the agent (TODO: wire touches from `Read`/`Edit` tool dispatchers in
  // a follow-up PR). Without touches the source stays empty → recent
  // stream contributes 0 results → legacy 2-stream RRF path runs unchanged.
  const recentFilesSource = new RecentFilesSource();
  // I1 — pipeline telemetry store is constructed early so the V2
  // search pipeline (gated by MCP_PIPELINES_INDEXER_SEARCH_V2=1) can
  // emit per-stage rows from inside HybridSearch. The same instance is
  // reused below as the SearchDeps `pipelineTelemetryStore` so the
  // admin panel sees a unified view.
  const pipelineTelemetryStore = new PipelineTelemetryStore(db.raw());
  // Pipeline telemetry is disabled — a no-op sink drops every event so the
  // doc_search rewriter/reranker + quality/search pipelines stop hammering
  // `pipeline_telemetry` (the dashboard tab that read it was removed). The
  // store is kept only so the (now dead) admin routes still typecheck.
  const pipelineTelemetrySink = new NoopTelemetrySink();
  // Single reranker instance shared by code search (HybridSearch) and the doc
  // RAG cross-encoder below — a LocalReranker lazily loads a ~hundreds-of-MB
  // ONNX model, so we must NOT construct it twice.
  const codeReranker = createReranker(providerStore);
  // Embeddings off the main thread: wrap the in-process service in a worker-
  // backed executor when the backend is local ONNX. That inference is CPU-
  // bound and would otherwise freeze the UI while the semantic pass reduces
  // the "stale" count. cloudflare/bedrock stay in-process (async network I/O
  // never blocks the event loop). Kill switch MCP_EMBED_WORKER=0; per-call
  // fallback to in-process on worker errors. Built HERE (not in
  // createSearchBundle) so the SAME wrapped instance reaches every consumer —
  // there's no late-bound setter like the structural executor has.
  const baseEmbedding = createEmbeddingService(providerStore);
  const embedFingerprint = baseEmbedding.fingerprint?.() ?? '';
  const embedLocalCfg = (providerStore.getDefaultEmbedding()?.config ?? {}) as { model?: string; cacheDir?: string };
  const idleEnv = Number(process.env.MCP_EMBED_WORKER_IDLE_MS);
  const embedExec = createEmbeddingExecutor(
    {
      isLocal: embedFingerprint.startsWith('local:'),
      fingerprint: embedFingerprint,
      model: embedLocalCfg.model,
      cacheDir: embedLocalCfg.cacheDir,
      idleTtlMs: Number.isFinite(idleEnv) && idleEnv > 0 ? idleEnv : undefined,
    },
    baseEmbedding,
  );
  const { embeddingService, vectorStore, searchableVectorStore, hybridSearch } =
    createSearchBundle(
      db,
      providerStore,
      codeReranker,
      recentFilesSource,
      pipelineTelemetrySink,
      embedExec.executor,
    );
  // Release the local ONNX sessions (embeddings + reranker) on shutdown —
  // both also self-evict after an idle TTL; this covers the exit path.
  registerShutdownTask('onnx-dispose', async () => {
    await Promise.allSettled([
      embeddingService.dispose?.(),
      (codeReranker as { dispose?: () => Promise<void> }).dispose?.(),
    ]);
  });

  // I2 follow-up wiring — the fs tools (read_file/edit_file/write_file/
  // create_file/multi_edit) call `emitRecentFileTouched({ absolutePath, kind })`
  // after a successful op. We resolve the abs path to (projectId, fileId)
  // by matching the longest project root prefix, then query the files
  // table. Sub-ms; failures are swallowed (touch is best-effort). Without
  // this sink the cache stays empty — even with MCP_PIPELINES_RECENT_FILES_SOURCE=1
  // the source would contribute nothing.
  const findFileStmt = db
    .raw()
    .prepare(`SELECT id FROM files WHERE project_id = ? AND path = ? LIMIT 1`);
  // Builder checkpoints — run-end hook deps (worker pool + in-process
  // stream both notify through the builder-checkpoint module global).
  setBuilderCheckpointDeps({ db });

  setGlobalRecentFilesTouchSink((event) => {
    try {
      const absolutePath = pathResolveNode(event.absolutePath);
      // Match the project whose root_path is the longest prefix of absolutePath.
      // listProjects() is small (typically <20 entries) — O(N) scan is fine.
      const projects = db.listProjects();
      let bestProject: { id: number; root: string } | null = null;
      for (const p of projects) {
        if (!p.root_path) continue;
        const rootResolved = pathResolveNode(p.root_path);
        const rootWithSep = rootResolved.endsWith(pathSep) ? rootResolved : rootResolved + pathSep;
        const isUnder = absolutePath === rootResolved || absolutePath.startsWith(rootWithSep);
        if (!isUnder) continue;
        if (!bestProject || rootResolved.length > bestProject.root.length) {
          bestProject = { id: p.id, root: rootResolved };
        }
      }
      if (!bestProject) return;
      // Project-relative path uses forward slashes in the DB (indexer
      // normalizes them); replicate that here so the WHERE matches.
      const relSep = absolutePath.slice(bestProject.root.length).replace(/^[\\/]+/, '');
      const relForward = relSep.split(pathSep).join('/');
      const row = findFileStmt.get(bestProject.id, relForward) as { id?: number } | undefined;
      if (!row?.id) return; // file not indexed yet — touch() needs a fileId
      recentFilesSource.touch({
        projectId: bestProject.id,
        fileId: row.id,
        filePath: relForward,
        kind: event.kind,
      });
    } catch {
      // Best-effort: a misbehaving touch must never break a tool call.
    }
  });

  const snapshotService = new SnapshotService(db, embeddingService, searchableVectorStore);

  // Structural auto-index (dumb mode). In-process executor by default —
  // the entrypoints upgrade it to the indexer worker_thread right after
  // createApp so the feature never depends on the worker build existing.
  const projectIndexService = new ProjectIndexService(
    db,
    createInProcessStructuralExecutor(db, {
      ignorePatterns: config.ignorePatterns,
      maxFileSizeKB: config.maxFileSize,
      concurrency: config.concurrency,
    }),
  );
  registerShutdownTask('project-index-dispose', () => projectIndexService.dispose());
  // External LSP servers (intelephense/pyright/...) — graceful shutdown +
  // exit + SIGKILL fallback. The manager is lazy (wired on first LSP call);
  // a never-wired manager is just a null here.
  registerShutdownTask('lsp-servers-stop', () => getLspServerManager()?.stopAll() ?? Promise.resolve());
  // Mem C — project-memory retriever over the snapshot store (reuses the
  // admin-configured embedding/vector backend via hybridSearch). Passed into
  // runCoder so the runner proactively injects relevant memory per turn.
  // topK 5 (was the default 3) + diagnostics on the silent-skip paths so an
  // empty injection is explainable from the logs.
  const memoryRetriever = new MemoryRetriever(hybridSearch, db, {
    topK: 5,
    log: (event, data) => console.debug(`[memory] retriever ${event}`, data),
  });
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
  const apiClientStore = new ApiClientStore(db.raw());
  const verdaccioStore = new VerdaccioStore(db.raw());
  // I1 — pipelineTelemetryStore + pipelineTelemetrySink are declared
  // EARLIER (before createSearchBundle) so the V2 search path can emit
  // per-stage telemetry. The references here are the same instances.
  const pipelineBindingsStore = new PipelineProviderBindingsStore(db.raw());
  const pipelineProviderResolver = new PipelineProviderResolver(pipelineBindingsStore, providerStore);
  // Task preflight — analyzes the FIRST prompt of a fresh coder session.
  // Runs zero-config: a `code-agent/preflight` binding wins, else the general
  // default model (getFallbackDefault). The catalog spans native tools +
  // cached external MCP tools + active skills, so the analyzer can pin MCP
  // tools and suggest task-relevant skills. The memory index reads the same
  // store that feeds the runner's MEMORY.md-style block.
  const nativeToolMeta = () =>
    getAllKnownToolsMeta().map((t) => ({ name: t.name, tier: t.tier, description: t.description }));
  const taskPreflight = new TaskPreflightService({
    resolver: pipelineProviderResolver,
    getFallbackDefault: () => generalDefaultAsFallback(providerStore),
    getToolCatalog: () => buildPreflightToolCatalog(config.dbPath, nativeToolMeta()),
    getSkillCatalog: (sessionId, projectId) =>
      buildPreflightSkillCatalog(skillStore, sessionId, projectId),
    getMemoryIndex: (projectId) => {
      try {
        if (!db.getProjectMemoryEnabled(projectId)) return [];
        return db
          .listMemoryIndex(projectId, 20)
          .map((m) => ({ title: m.title, category: m.category, excerpt: m.excerpt }));
      } catch {
        return [];
      }
    },
  });
  // Mem C write-back — distills durable memory (facts + `gotcha` lessons) at
  // run-end. Reuses the snapshot writer + hybrid dedup + the resolver's
  // `memory_extraction` binding; when no binding is set it falls back to the
  // general default AI model (zero-config). Passed into runCoder as `runEndMemory`.
  const runEndMemory = createRunEndMemory({
    writer: snapshotService,
    search: hybridSearch,
    resolver: pipelineProviderResolver,
    getFallbackDefault: () => generalDefaultAsFallback(providerStore),
    // Memory-health diagnostics (migration 136) — every pass lands a row so
    // the project Memory tab can show when/what was learned (or why not).
    distillLog: (projectId, entry) => {
      try { db.insertMemoryDistillLog(projectId, entry); } catch { /* best-effort */ }
    },
  });

  // Direct agent ports for project memory (save_note scope 'project' +
  // recall_memory). The write path reuses the distillers' MemoryExtractor
  // with a LITERAL candidate — same dedup/merge/importance floors, embedding
  // via SnapshotService, zero new dedup code.
  const VALID_MEMORY_CATEGORIES = new Set([
    'architecture', 'decision', 'convention', 'pattern', 'todo', 'note', 'gotcha', 'procedure',
  ]);
  const projectMemory: SearchDeps['projectMemory'] = {
    save: async (projectId, projectName, entry) => {
      const category = VALID_MEMORY_CATEGORIES.has(entry.category) ? entry.category : 'note';
      const candidate = {
        title: entry.title,
        content: entry.content,
        category: category as import('@mcp/shared/types.js').SnapshotCategory,
        importance: 0.6, // per-category floors still apply inside the extractor
      };
      const literal = new MemoryExtractor(
        { distill: async () => [candidate] },
        snapshotService,
        hybridSearch,
      );
      const res = await literal.extractAndPersist(projectId, projectName, 'agent', {});
      try {
        db.insertMemoryDistillLog(projectId, { trigger: 'agent', status: 'ok', ...res });
      } catch { /* diagnostics are best-effort */ }
      return res;
    },
    recall: (projectId, projectName, query, limit) =>
      memoryRetriever.recall(projectId, projectName, query, limit),
  };

  // Tool-selection plumbing. The embed adapter wraps the existing indexer
  // EmbeddingService into a single-text `EmbeddingFn`. ToolEmbeddingStore is
  // shared across all sessions in this process — tools don't vary per
  // session so re-embedding would be wasteful.
  const toolEmbeddingStore = new InMemoryToolEmbeddingStore();
  const toolSelectionEmbed: EmbeddingFn = async (text: string) => {
    const result = await embeddingService.embedQuery(text);
    return Float32Array.from(result.vector);
  };

  // Session Drive — investigation ledger semantic recall. Install the
  // process-global embedder ONCE here (in-process path only; worker threads
  // re-import code-agent fresh and leave it null → keyword recall fallback,
  // same posture as Mem C). Reuses the admin-configured EmbeddingService.
  setInvestigationEmbedder(async (text: string) => {
    try {
      return await toolSelectionEmbed(text);
    } catch {
      return null;
    }
  });

  // Context-relevance shares the same embedding adapter; message vectors
  // live in their own store keyed by message-id. The pipeline reads
  // messages via the `getMessages` closure provided per-request from the
  // runner — here we build it with a placeholder that the runtime
  // overrides at call time via the helper's `messages` argument.
  const messageEmbeddingStore = new InMemoryMessageEmbeddingStore();
  const contextRelevancePipeline = createContextRelevancePipeline({
    getMessages: () => [], // overridden per-request by applyContextCompaction
    embed: toolSelectionEmbed,
    messageEmbeddingStore,
    telemetry: pipelineTelemetrySink,
  });

  // Sub-agent result cache: dedupe repeated Explore/Plan/general-purpose
  // calls within their TTL windows (Explore=30m, Plan=5m, general=15m).
  const subAgentResultCacheStore = new SubAgentResultCacheStore(db.raw());
  const subAgentResultCache = new SubAgentResultCache(subAgentResultCacheStore);

  // Documentação (RAG) — global corpus of external docs (PDF + URL crawl).
  // Reuses the embedding service / vector store that the indexer pipeline
  // already wired; collections are tenant-wide, so no per-project state.
  //
  // Render pipeline: plain fetch first; auto-escalate to headless Chrome
  // (via the existing ChromeService WS endpoint) when bot-detection signals
  // fire. The browser connector is lazy — it only spins up Playwright when
  // a fetch actually trips the detector AND ChromeService is running. With
  // ChromeService off, the connector returns null and the EscalatingFetcher
  // silently keeps the plain result (annotated with `blockedSignals`).
  //
  // `docFetcher` is shared by every ingestion run so the per-host throttle
  // + robots cache + cookie jar are reused across collections. If memory
  // pressure becomes an issue, swap to per-source instances.
  const docStore = new DocStore(db.raw());
  const docFetcher = new UrlFetcher();
  const plainRender = new PlainFetchBackend(docFetcher);
  // Pass the SAME `docFetcher` to the browser backend so a force_browser
  // crawl shares the per-host throttle (penalty, Retry-After, jitter)
  // with the plain path. Without this the browser path would `page.goto`
  // unbounded and trip 429s much faster than the polite plain fetcher.
  const browserRender = new BrowserBackend(async () => {
    // Late-bound: chromeService isn't constructed yet at this point in
    // createDeps (it's owned by server.ts and only assigned after the
    // sandbox manager wires). The closure captures `chromeServiceRef`
    // populated by setChromeServiceForDocs below.
    const svc = chromeServiceForDocs;
    if (!svc) return null;
    return svc.connectBrowser();
  }, docFetcher);
  const docRenderer = new EscalatingFetcher(plainRender, browserRender, detectBlocked);

  // ─── Doc-search enhancements (Phase 10): query rewriter + reranker ──
  // Both share the same PipelineProviderResolver as enrichers/classifiers
  // and are opt-in at call time via `DocSearchInput.enhancements`. Wiring
  // them here so the wrappers exist regardless of env flags — keeps the
  // call site (rag_search_docs adapter in server.ts) simple.
  //
  // - `docQueryRewriter`: produces 2-3 variants merged via RRF. Backed
  //   by sub_agent_result_cache (24h TTL) and pipeline_telemetry.
  // - `docReranker`: re-orders the top-K via LLM scoring. Backed by
  //   doc_rerank_cache (migration 098) and pipeline_telemetry.
  //
  // Both degrade gracefully (no binding configured → no-op) so they are
  // safe to construct unconditionally and pass to DocHybridSearch.
  const docQueryRewriter = new QueryRewriter({
    resolver: pipelineProviderResolver,
    cache: subAgentResultCacheStore,
    // telemetry disabled (pipeline_telemetry tab removed)
  });
  // Reranker selection. A real cross-encoder (local ONNX, Cohere, or the
  // bge-reranker-v2-m3 worker) emits a NATIVE relevance score that's
  // better-calibrated than the LLM-as-judge `Reranker` and feeds
  // DocSearchResult.relevance directly. Since the desktop install now seeds a
  // LOCAL cross-encoder by default (offline, free), prefer it automatically
  // whenever one is configured — no env flag needed.
  //   DOCS_RERANK_CROSS_ENCODER=1 → force the cross-encoder.
  //   DOCS_RERANK_CROSS_ENCODER=0 → force the LLM-as-judge fallback.
  // With no reranker configured (NullReranker), fall back to the LLM judge
  // rather than trusting uncalibrated RRF order.
  const docLlmReranker = new Reranker({
    resolver: pipelineProviderResolver,
    db: db.raw(),
    // telemetry disabled (pipeline_telemetry tab removed)
  });
  // `codeReranker` is the single shared instance created above (before
  // createSearchBundle) — reused here so the ONNX model loads at most once.
  const crossEncoderFlag = process.env.DOCS_RERANK_CROSS_ENCODER;
  const useCrossEncoder =
    crossEncoderFlag === '0'
      ? false
      : crossEncoderFlag === '1' || codeReranker.name !== 'null';
  const docReranker = useCrossEncoder
    ? new CrossEncoderReranker(codeReranker)
    : docLlmReranker;
  const docHybridSearch = new DocHybridSearch(
    docStore,
    embeddingService,
    vectorStore,
    undefined,
    { rewriter: docQueryRewriter, reranker: docReranker },
  );
  // In-memory cache of the latest progress frame per source. Wired so
  // both the use-case (writer) and the HTTP route (reader) share the
  // same instance. Lost on process restart — fine because boot
  // recovery flips any in-flight source to `error` anyway.
  const docProgressTracker = new DocIngestProgressTracker();
  const indexDocsUseCase = new IndexDocumentationUseCase({
    docStore,
    embeddingService,
    vectorStore,
    pipelineProviderResolver,
    renderBackend: docRenderer,
    progressTracker: docProgressTracker,
  });

  // RolePipeline shared embedding store — keyed by (role + skills) so a
  // template revision invalidates entries automatically.
  const roleEmbeddingStore = new InMemoryRoleEmbeddingStore();

  // Quality classifier pipeline — five single-task classifiers running in
  // parallel via Promise.allSettled. Provider per classifier resolves via
  // PipelineProviderResolver (admin-configured).
  const qualityClassificationStore = new QualityClassificationStore(db.raw());
  const qualityInterventionStore = new QualityInterventionStore(db.raw());
  const counterfactualLogStore = new CounterfactualLogStore(db.raw());
  const qualityClassifierPipeline = new QualityClassifierPipeline({
    classifiers: [
      new OffTopicClassifier(pipelineProviderResolver),
      new CompletenessClassifier(pipelineProviderResolver),
      new CodeQualityClassifier(pipelineProviderResolver),
      new PolicyClassifier(pipelineProviderResolver),
      new ToolMisuseClassifier(pipelineProviderResolver),
    ],
    store: qualityClassificationStore,
    telemetry: pipelineTelemetrySink,
  });

  // Shadow-traffic for ToolSelectionPipeline. Sample rate is environment
  // controlled — keep it off by default so test/dev runs don't burn
  // embedding calls. Production opts in by setting the env var.
  //
  // The tool registry is supplied lazily via a mutable ref so the runtime
  // integration can install it once the code-agent runner is wired up.
  // Until then, `getAllToolsRef` returns an empty list and the variants
  // emit empty selections — harmless for shadow but visible in counterfactual
  // logs as a signal that the integration isn't done yet.
  const shadowSampleRate = parseFloat(process.env.MCP_SHADOW_TOOL_SELECTION_RATE ?? '0') || 0;
  let getAllToolsRef: () => CoderTool[] = () => [];
  const toolSelectionShadowVariants = buildToolSelectionShadowVariants({
    getAllTools: () => getAllToolsRef(),
    embed: toolSelectionEmbed,
    toolEmbeddingStore,
    variantKs: DEFAULT_TOOL_SELECTION_VARIANTS,
  });
  const toolSelectionShadowRunner = new ShadowTrafficRunner<ToolSelectionQuery>({
    pipelineName: 'tool_selection',
    variants: toolSelectionShadowVariants,
    store: counterfactualLogStore,
    sampleRate: shadowSampleRate,
    telemetry: pipelineTelemetrySink,
  });
  // Setter the future runtime integration calls once during boot. Until
  // then, shadow runs see an empty tool registry — harmless, visible as
  // empty rows in counterfactual_logs so the gap is obvious.
  const setToolSelectionRegistry = (fn: () => CoderTool[]): void => {
    getAllToolsRef = fn;
  };

  // LSH index for codebase embeddings. Default dim=768 matches bge-base/m3
  // and most OpenAI-compatible embedding endpoints used by the indexer.
  // The exact dim doesn't matter for correctness — `simHashSignature` only
  // dot-products against the configured hyperplanes; vectors shorter than
  // `dim` are zero-padded (the loop caps at `Math.min(embedding.length, plane.length)`).
  const lshIndexStore = new LshIndexStore(db.raw());
  const lshIndex = new LSHIndex({
    dim: parseInt(process.env.MCP_LSH_DIM ?? '768', 10) || 768,
    store: lshIndexStore,
    numHyperplanes: 32,
    numHashes: 4,
    numBuckets: 256,
    seed: 0x1ce1ce1c,
  });
  // LSH indexing sink — disabled by default (no overhead on indexing hot
  // path). Opt in with MCP_LSH_INDEXING=1 to start populating LSH buckets
  // automatically as the indexer commits embeddings.
  const lshIndexingSink: LshIndexingSink = process.env.MCP_LSH_INDEXING === '1'
    ? new RealLshIndexingSink(lshIndex)
    : new NullLshIndexingSink();

  // Counterfactual feedback collector — registers a matcher per known
  // shadow pipeline. Runtime hooks call collector.observe(...) when they
  // see a real outcome (master spawned X, agent called tool Y, …).
  const feedbackCollector = new FeedbackCollector({
    store: counterfactualLogStore,
    matchers: [
      new ToolSelectionOutcomeMatcher(),
      new RolePipelineOutcomeMatcher(),
      new KanbanPriorityOutcomeMatcher(),
    ],
  });

  // Tool-selection runtime filter factory. The runner calls this once
  // when constructing its RunnerOptions; we return either a filter
  // function (env flag on) or undefined (flag off → runner skips the
  // hook entirely).
  //
  // The filter is ALSO the producer side of the shadow-traffic +
  // counterfactual loop: after production selection completes, the same
  // query is handed to `toolSelectionShadowRunner` (deterministic
  // sampling by task hash) which runs the k=8 / k=16 variants off-path
  // and logs predictions. The feedback collector picks up these rows
  // later via `observeToolSelectionOutcome` when the runtime sees what
  // tools were actually called.
  const toolSelectionFilterEnabled = process.env.MCP_PIPELINES_TOOL_SELECTION === '1';

  /**
   * FNV-1a hash of the task text — deterministic shadow-sampling key
   * AND the query_hash linking shadow predictions to later observed
   * outcomes (tools actually called).
   */
  const toolSelectionQueryHash = (taskText: string): string => {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < taskText.length; i++) {
      h ^= taskText.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
  };

  const buildToolSelectionFilter = (): undefined | ((
    tools: ThinTool[],
    ctx: { taskText: string; recentToolCalls: ReadonlyArray<{ name: string; timestampMs: number; ok: boolean }> },
  ) => Promise<ThinTool[]>) => {
    if (!toolSelectionFilterEnabled) return undefined;
    return async (tools, ctx) => {
      const selected = await applyToolSelectionThin({
        allTools: tools,
        taskText: ctx.taskText,
        recentToolCalls: ctx.recentToolCalls,
        embed: toolSelectionEmbed,
        embeddingStore: toolEmbeddingStore,
      });
      // Shadow producer — fires only when MCP_SHADOW_TOOL_SELECTION_RATE > 0
      // and the task hash falls inside the sample. Off-path via setImmediate.
      try {
        const queryHash = toolSelectionQueryHash(ctx.taskText);
        toolSelectionShadowRunner.recordAndShadow(
          {
            queryHash,
            payload: {
              queryId: `tool-selection-${queryHash}`,
              taskText: ctx.taskText,
              recentToolEvents: ctx.recentToolCalls,
              k: 12,
            },
          },
          { toolNames: selected.map((t) => t.name) },
        );
      } catch {
        // Shadow traffic must never affect production.
      }
      return selected;
    };
  };

  /**
   * Outcome observer: the runtime calls this with the task text that
   * triggered the selection and the names of tools the agent actually
   * called afterwards. The feedback collector matches by query_hash
   * and fills `true_outcome_json` on the corresponding shadow rows.
   */
  const observeToolSelectionOutcome = (taskText: string, toolsCalled: ReadonlyArray<string>): void => {
    if (!toolSelectionFilterEnabled || toolsCalled.length === 0) return;
    try {
      feedbackCollector.observe('tool_selection', {
        queryHash: toolSelectionQueryHash(taskText),
        toolsCalled: [...toolsCalled],
      });
    } catch {
      // Best-effort.
    }
  };

  const embeddingKind = deriveKindLabel(embeddingService, 'EmbeddingService');
  const vectorStoreKind = deriveKindLabel(vectorStore, 'VectorStore');

  // ─── Perf-monitor ledger — subsystems self-report occupancy ─────────
  // Pull-based: the sampler calls these closures every tick. Keep them
  // O(1) — counts and flags only, never deep walks.
  {
    const ledger = getMemoryLedger();
    ledger.register('embeddings.tools', () => ({
      count: toolEmbeddingStore.size(),
      detail: 'vetores de descrição de tools (processo inteiro)',
    }));
    ledger.register('embeddings.messages', () => ({
      count: messageEmbeddingStore.size(),
      detail: 'vetores de mensagens (context-relevance)',
    }));
    ledger.register('embeddings.roles', () => ({
      count: roleEmbeddingStore.size(),
      detail: 'vetores de roles (company)',
    }));
    ledger.register('embeddings.localModel', () => {
      const svc = embeddingService as { diagnostics?: () => { model: string; loaded: boolean } };
      const d = svc.diagnostics?.();
      if (!d) return null;
      return {
        count: d.loaded ? 1 : 0,
        detail: `${d.model} — ONNX ${d.loaded ? 'CARREGADO (memória nativa, fora do JS heap)' : 'descarregado'}`,
      };
    });
    ledger.register('search.recentFiles', () => ({
      count: recentFilesSource.size(),
      detail: 'cache de arquivos recentes (Mem A)',
    }));
  }

  return {
    config,
    db,
    providerStore,
    costTracker,
    snapshotService,
    projectIndexService,
    diffService,
    exportService,
    webhookDispatcher,
    modelDiscovery,
    embeddingService,
    vectorStore,
    hybridSearch,
    memoryRetriever,
    runEndMemory,
    projectMemory,
    recentFilesSource,
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
    apiClientStore,
    verdaccioStore,
    pipelineTelemetryStore,
    pipelineBindingsStore,
    pipelineProviderResolver,
    taskPreflight,
    pipelineTelemetrySink,
    toolEmbeddingStore,
    toolSelectionEmbed,
    messageEmbeddingStore,
    contextRelevancePipeline,
    subAgentResultCache,
    roleEmbeddingStore,
    qualityClassificationStore,
    qualityInterventionStore,
    counterfactualLogStore,
    qualityClassifierPipeline,
    toolSelectionShadowRunner,
    setToolSelectionRegistry,
    lshIndex,
    lshIndexStore,
    lshIndexingSink,
    feedbackCollector,
    buildToolSelectionFilter,
    observeToolSelectionOutcome,
    embeddingKind,
    vectorStoreKind,
    docStore,
    docHybridSearch,
    indexDocsUseCase,
    docProgressTracker,
    invokePluginTool,
    mcpBearerResolver: null,
  };
}
