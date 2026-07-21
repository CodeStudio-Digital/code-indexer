import { CodeIndexDB } from '@mcp/store/db.js';
import { registerShutdownTask } from './shutdown-tasks.js';
import {
  canResolveDbMaintenanceWorker,
  startDbMaintenanceWorker,
  stopDbMaintenanceWorker,
} from '../sse/dbMaintenanceSingleton.js';
import { getMemoryLedger } from './perf/memory-ledger.js';
import { createProjectFeatureStoreResolver } from './project-feature-store.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import type { ManagedGitClient } from '@mcp/shared/git/managed-git.js';
import { projectMemoryNamespace } from '@mcp/shared/vector-namespace.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { ProjectIndexService, createInProcessStructuralExecutor } from '@mcp/services/services/project-index/index.js';
import { getLspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { InvestigationSemanticIndex } from '@mcp/services/memory/investigation-semantic-index.js';
import { AgentMemoryRetriever } from '@mcp/services/memory/agent-memory-retriever.js';
import { AgentMemoryWriter, AgentMemoryDedupeSearch } from '@mcp/services/memory/agent-memory-writer.js';
import { LlmRecallFilter } from '@mcp/services/memory/recall-filter.js';
import { LlmMemoryQuerySynthesizer, type ConversationTail } from '@mcp/services/memory/query-synthesizer.js';
import { createRunEndMemory, type RunEndMemory } from '@mcp/services/memory/run-end.js';
import { MemoryExtractor } from '@mcp/services/memory/extractor.js';
import { ExportService } from '@mcp/services/services/exporter.js';
import { WebhookDispatcher } from '@mcp/services/services/webhooks.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import { NullEmbeddingService, type EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullReranker } from '@mcp/indexer/search/reranker.js';
import { NullVectorStore, type VectorStore } from '@mcp/store/vectors.js';
import {
  SemanticStore,
  semanticPurposeForNamespace,
  type EmbeddingTarget,
  type RerankerTarget,
} from '@mcp/store/semantic-store.js';
import { LocalVectorRouter } from '@mcp/store/local-vector-router.js';
import { SessionStore, type RunCoderOptions } from '@mcp/code-agent/index.js';
import {
  setInvestigationSemanticIndex,
  type InvestigationSemanticIndexPort,
} from '@mcp/code-agent/tools/investigation-embedder.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';
import { CompanyServiceTransitionsStore } from '@mcp/store/company-service-transitions-store.js';
import { CompanyServiceLogsStore } from '@mcp/store/company-service-logs-store.js';
import { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { CompanyLocalProjectStore } from '@mcp/store/company-local-project-store.js';
import { FileLocalHistoryStore } from '@mcp/store/file-local-history-store.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { QaTestRunStore } from '@mcp/services/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '@mcp/services/qa/store/qa-test-result-store.js';
import { ChromeServiceStore } from '@mcp/store/chrome-service-store.js';
import { DesignSystemStore } from '@mcp/store/design-system-store.js';
import { AppStudioStore } from '@mcp/store/app-studio-store.js';
import { ApiClientStore } from '@mcp/store/api-client-store.js';
import { SshStore } from '@mcp/store/ssh-store.js';
import { DbClientStore } from '@mcp/store/db-client-store.js';
import { SpriteProjectsStore } from '@mcp/store/sprite-studio/sprite-projects-store.js';
import { SpriteAssetsStore } from '@mcp/store/sprite-studio/sprite-assets-store.js';
import { SpriteAnimationsStore } from '@mcp/store/sprite-studio/sprite-animations-store.js';
import { SpriteJobsStore } from '@mcp/store/sprite-studio/sprite-jobs-store.js';
import { sharedDbConnectionManager } from '@mcp/db-drivers';
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
import { createGitHubAppManagedGitClient } from './github-app-managed-git/client.js';
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
  UrlFetcher,
} from '@mcp/services/services/docs/index.js';
import { InMemoryRoleEmbeddingStore } from '@mcp/company/role-pipeline/index.js';
import { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { QualityInterventionStore } from '@mcp/store/quality-intervention-store.js';
import { CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';
import {
  QualityClassifierPipeline,
  createQualityRuntime,
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
import { decisionTelemetryForTask, toolPolicyForTask } from '@mcp/code-agent/agents/decision-engine.js';
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
import { SemanticProfileRuntime } from '@mcp/indexer/search/semantic-profile-runtime.js';
import { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import { setGlobalRecentFilesTouchSink } from '@mcp/code-agent/tools/global-recent-files.js';
import { setBuilderCheckpointDeps } from '../sse/builder-checkpoint.js';
import { SemanticVectorWorkerClient } from '../sse/SemanticVectorWorkerClient.js';
import { resolve as pathResolveNode, sep as pathSep } from 'node:path';
import type { ChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import { invokePluginTool, type PluginToolInvokeFn } from '../sse/PluginHostSingleton.js';
import { syncPluginProviders } from './plugin-providers.js';
import { SemanticIndexCoordinator } from './semantic-index-coordinator.js';
import {
  createDurableSemanticMutationSink,
  type SemanticMutationSink,
} from '@mcp/services/semantic-mutation-sink.js';
import { randomUUID } from 'node:crypto';

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
  docsEmbeddingService: EmbeddingService;
  memoryEmbeddingService: EmbeddingService;
  vectorStore: VectorStore;
  semanticStore: SemanticStore;
  localVectorRouter: LocalVectorRouter;
  semanticProfileRuntime: SemanticProfileRuntime;
  semanticCoordinator: SemanticIndexCoordinator;
  hybridSearch: HybridSearch;
  /** Mem C — project-memory retrieval over agent_memory (relevance × importance).
   *  Structural port the runner consumes (project scope, no `setRecallFilter`). */
  memoryRetriever: {
    retrieve(
      projectId: number,
      projectName: string,
      taskText: string,
    ): Promise<ReadonlyArray<{ id: string; title: string; content: string; importance?: number; staleNote?: string }>>;
  };
  /** Smart memory-recall query synthesizer — rewrites a meta/continuation
   *  message into a real search query from the conversation tail. Returns null
   *  when the `memory_query` binding is unset (runner uses its heuristic). */
  memoryQuerySynthesizer: (
    tail: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  ) => Promise<string | null>;
  /** Dedicated Agent Memory service + retriever (migration 181) — used for
   *  user-scope recall, embedding backfill and the consolidation sweeper. */
  agentMemoryService: AgentMemoryService;
  agentMemoryRetriever: AgentMemoryRetriever;
  /** Host-owned investigation semantic selector; worker coders reach it by RPC. */
  investigationSemantic: InvestigationSemanticIndexPort;
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
    list(
      projectId: number,
      projectName: string,
      limit?: number,
      type?: string,
    ): Promise<Array<{ name: string; description: string; type: string; importance: number; created_at: string }>>;
    forget(
      projectId: number,
      projectName: string,
      target: string,
    ): Promise<{ archived: number }>;
  };
  /**
   * Process-wide hot cache of recently touched files. Agent read/edit tools
   * feed it and the canonical candidate pipeline always treats it as one
   * bounded RRF source.
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
   * CRUD store for App Studio sessions and recorded features (migration
   * 200). Read by the /api/app-studio routes and by the app_* tools
   * registered on runners of `kind:'app'` workspaces.
   */
  appStudioStore: AppStudioStore;
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
  /**
   * R1 — project-scoped API-client store. Flag-off returns the central
   * `apiClientStore` (byte-identical to today); flag-on returns a store backed
   * by the project's own DB handle, cached per projectId. Routes resolve this
   * per-request from the `:projectId` URL param.
   */
  apiClientFor: (projectId: number) => ApiClientStore;
  /** Embedded SSH client store (saved hosts + identities). Project-scoped like apiClientFor. */
  sshStore: SshStore;
  sshStoreFor: (projectId: number) => SshStore;
  /** Embedded database client store (saved connections + history + saved queries). Project-scoped. */
  dbClientStore: DbClientStore;
  dbClientFor: (projectId: number) => DbClientStore;
}

export interface SpriteStudioDeps {
  /**
   * Sprite Studio (migration 196) — CENTRAL-DB stores on purpose: the job
   * ledger (costs) crosses into admin metering and churn is low. The repo
   * files under `<root>/.sprite-studio/` are the source of truth; these
   * stores hold the queryable operational mirror + the job/cost ledger.
   */
  spriteProjectsStore: SpriteProjectsStore;
  /** Assets, immutable versions and reference images of a sprite project. */
  spriteAssetsStore: SpriteAssetsStore;
  /** Animations + ordered frame pointers into asset versions (F2). */
  spriteAnimationsStore: SpriteAnimationsStore;
  /** Append-only generation-job ledger (status, effective provider/model, cost). */
  spriteJobsStore: SpriteJobsStore;
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
   * Sink semantic embedding calls after vector-store upserts. Null when LSH
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
    ctx: {
      taskText: string;
      recentToolCalls: ReadonlyArray<{ name: string; timestampMs: number; ok: boolean }>;
      protectedToolNames?: ReadonlySet<string>;
    },
  ) => Promise<ThinTool[]>);
  /**
   * Companion to `buildToolSelectionFilter` — the runtime calls this
   * with the recently-invoked tool names so the FeedbackCollector can
   * backfill `true_outcome_json` on shadow rows. Safe to call when the
   * feature is off (no-op).
   */
  observeToolSelectionOutcome: (taskText: string, toolsCalled: ReadonlyArray<string>) => void;
  /** Default-off Agent Decision Engine runtime flags forwarded to runCoder. */
  buildAgentDecisionRuntimeOptions: () => Pick<RunCoderOptions,
    | 'agentDecisionTelemetryEnabled'
    | 'agentDecisionGuidanceEnabled'
    | 'agentDecisionSoftGuardrail'
    | 'agentDecisionSoftGuardrailMinConfidence'
    | 'agentDecisionAskBeforeSwitch'
  >;
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
  /** Append-only audit of service status/health flips (mig 188, company B1). */
  companyServiceTransitionsStore: CompanyServiceTransitionsStore;
  /** Ring-buffered per-service output lines (devserver/container/scaffold, mig 188). */
  companyServiceLogsStore: CompanyServiceLogsStore;
  /** Shared env vars per session; injected into every container + written as /app/.env. */
  companySessionEnvStore: CompanySessionEnvStore;
  /** Local History (JetBrains-style) — versões de arquivos independentes do git (mig 160). */
  fileLocalHistoryStore: FileLocalHistoryStore;
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
  /**
   * Reconcile the provider registry with the currently-enabled declarative
   * provider plugins. Called at boot AND after any install/enable/disable/
   * uninstall so a plugin-contributed provider appears (or disappears) live —
   * no restart, no flags.
   */
  syncPluginProviders: () => void;
}

export interface ManagedGitDeps {
  /** Optional GitHub App identity. Native project Git remains the default path. */
  managedGit: ManagedGitClient;
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
  & SpriteStudioDeps
  & PipelineDeps
  & DocCorpusDeps
  & PluginRuntimeDeps
  & ManagedGitDeps;

export function createDeps(): ServerDeps {
  const config = loadConfig();
  const managedGit = createGitHubAppManagedGitClient();
  // This is the ONE main-process handle: make it the WAL checkpoint owner so the
  // central -wal can't bloat under multi-agent worker write load (see db.ts).
  // Perf W2 — the periodic PASSIVE checkpoint itself moves to the
  // db-maintenance worker (off the main thread; also owns retention).
  // MCP_DB_MAINTENANCE=0 keeps the legacy in-process timer.
  const dbMaintenanceEnabled =
    process.env.MCP_DB_MAINTENANCE !== '0' && canResolveDbMaintenanceWorker();
  const db = new CodeIndexDB(config.dbPath, {
    checkpointOwner: true,
    externalCheckpointer: dbMaintenanceEnabled,
  });
  if (dbMaintenanceEnabled) {
    startDbMaintenanceWorker(config.dbPath, {
      // Restart budget exhausted → never leave the WAL without a checkpointer.
      onPermanentCrash: () => db.enableInternalCheckpointer(),
    });
    registerShutdownTask('db-maintenance-worker', () => stopDbMaintenanceWorker());
  }
  const costTracker = new CostTracker(db);
  const exportService = new ExportService(db);
  const webhookDispatcher = new WebhookDispatcher(db);
  const modelDiscovery = new ModelDiscovery(db);

  // Chat providers remain the inference credential source. Semantic profiles
  // select their embedding/rerank model independently below.
  const providerStore = createAndSeedProviderStore(config.dbPath);
  const semanticStore = new SemanticStore(db.raw());
  const semanticMutationOwner = `http-api:${process.pid}:${randomUUID()}`;
  let semanticCoordinatorForMutations: SemanticIndexCoordinator | null = null;
  const pendingMutationDrains = new Set<string>();
  let mutationDrainScheduled = false;
  const scheduleMutationDrain = (): void => {
    if (mutationDrainScheduled || !semanticCoordinatorForMutations) return;
    mutationDrainScheduled = true;
    const timer = setTimeout(() => {
      mutationDrainScheduled = false;
      const namespaces = [...pendingMutationDrains];
      pendingMutationDrains.clear();
      for (const namespace of namespaces) {
        void semanticCoordinatorForMutations?.catchUpMemoryNamespace(namespace).catch((error) =>
          console.warn(`[semantic] mutation catch-up paused for ${namespace}: ${(error as Error).message}`));
      }
    }, 0);
    (timer as { unref?: () => void }).unref?.();
  };
  const semanticMutationSink: SemanticMutationSink = createDurableSemanticMutationSink(
    semanticStore,
    {
      owner: semanticMutationOwner,
      enabled: (namespace) => {
        try {
          return semanticStore.getProfile(semanticPurposeForNamespace(namespace))?.embedding_target.kind !== 'disabled';
        } catch {
          return false;
        }
      },
      onDurableMutation: (namespace, phase) => {
        // The running fence deliberately blocks activation while its source
        // row is changing. Reconcile only after commit (settled), or for an
        // already-atomic note, to avoid embedding the pre-mutation snapshot.
        if (phase === 'started') return;
        if (semanticCoordinatorForMutations
          && !semanticCoordinatorForMutations.allowsNamespaceMutation(namespace)) return;
        pendingMutationDrains.add(namespace);
        scheduleMutationDrain();
      },
    },
  );
  const localVectorRouter = new LocalVectorRouter({
    resolveProject: (projectId) => db.getProject(projectId),
    semanticStore,
  });
  let semanticVectorWorker: SemanticVectorWorkerClient | null = null;
  try {
    semanticVectorWorker = SemanticVectorWorkerClient.create(config.dbPath);
  } catch (error) {
    console.warn(`[semantic] vector worker unavailable; semantic jobs will pause and search will use FTS: ${(error as Error).message}`);
  }

  // The Code semantic profile resolves the reranker below and ONNX execution
  // is proxied to semantic-vector-worker. HybridSearch owns fail-open to RRF.
  //
  // `RecentFilesSource` is a normal candidate-pipeline source. It starts
  // empty and is fed by successful agent read/edit operations below.
  const recentFilesSource = new RecentFilesSource();
  // The pipeline telemetry store is constructed early so the canonical
  // search pipeline can emit per-stage rows from inside HybridSearch. The same instance is
  // reused below as the SearchDeps `pipelineTelemetryStore` so the
  // admin panel sees a unified view.
  const pipelineTelemetryStore = new PipelineTelemetryStore(db.raw());
  // Provider/model routing for every LLM-backed pipeline, including the
  // optional HyDE query-expansion stage. Construct it before the search
  // bundle so HyDE has the same single source of truth as other pipelines.
  const pipelineBindingsStore = new PipelineProviderBindingsStore(db.raw());
  const pipelineProviderResolver = new PipelineProviderResolver(pipelineBindingsStore, providerStore);
  // Pipeline telemetry is disabled — a no-op sink drops every event so the
  // doc_search rewriter/reranker + quality/search pipelines stop hammering
  // `pipeline_telemetry` (the dashboard tab that read it was removed). The
  // store is kept only so the (now dead) admin routes still typecheck.
  const pipelineTelemetrySink = new NoopTelemetrySink();
  const semanticProfileRuntime = new SemanticProfileRuntime(
    semanticStore,
    providerStore,
    (target: EmbeddingTarget, createFallback) => {
      if (target.kind !== 'onnx') return createFallback();
      return semanticVectorWorker?.embeddingService(target) ?? new NullEmbeddingService();
    },
    (target: RerankerTarget, createFallback) => {
      if (target.kind !== 'onnx') return createFallback();
      return semanticVectorWorker?.rerankerService(target) ?? new NullReranker();
    },
  );
  const codeEmbeddingService = semanticProfileRuntime.embedding('code');
  const docsEmbeddingService = semanticProfileRuntime.embedding('docs');
  const memoryEmbeddingService = semanticProfileRuntime.embedding('memory');
  const codeQueryEmbeddingService = semanticProfileRuntime.queryEmbedding('code');
  const docsQueryEmbeddingService = semanticProfileRuntime.queryEmbedding('docs');
  const memoryQueryEmbeddingService = semanticProfileRuntime.queryEmbedding('memory');
  // HybridSearch owns the fail-open boundary so it can report the concrete
  // fallback reason in per-query diagnostics. A fail-open profile proxy here
  // would hide worker/provider failures and make the UI claim reranking ran.
  const codeReranker = semanticProfileRuntime.reranker('code', { strict: true });
  // Documentation applies calibrated relevance thresholds. Its reranker must
  // surface failures so CrossEncoderReranker can keep the RRF set explicitly
  // uncalibrated; code search remains fail-open inside HybridSearch.
  const docsReranker = semanticProfileRuntime.reranker('docs', { strict: true });
  const memoryReranker = semanticProfileRuntime.reranker('memory', { strict: true });
  // Never open sqlite-vec from Electron's main process. If the dedicated
  // worker entry is unavailable, keep structural/FTS search alive and let
  // semantic jobs pause visibly until the worker can be restored.
  const vectorOverride = semanticVectorWorker ?? new NullVectorStore();
  const { embeddingService, vectorStore, searchableVectorStore, hybridSearch } =
    createSearchBundle(
      db,
      codeReranker,
      recentFilesSource,
      pipelineTelemetrySink,
      codeEmbeddingService,
      vectorOverride,
      codeQueryEmbeddingService,
      memoryQueryEmbeddingService,
      pipelineProviderResolver,
      memoryReranker,
    );
  registerShutdownTask('semantic-runtime-dispose', () => semanticProfileRuntime.dispose());
  registerShutdownTask('semantic-vector-worker', () =>
    semanticVectorWorker ? semanticVectorWorker.dispose() : localVectorRouter.drainAndClose());

  // The fs tools (read_file/edit_file/write_file/
  // create_file/multi_edit) call `emitRecentFileTouched({ absolutePath, kind })`
  // after a successful op. We resolve the abs path to (projectId, fileId)
  // by matching the longest project root prefix, then query the files
  // table. Sub-ms; failures are swallowed (touch is best-effort). Without
  // this sink the source would contribute nothing.
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

  const snapshotService = new SnapshotService(
    db,
    memoryEmbeddingService,
    searchableVectorStore,
    semanticMutationSink,
  );

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
  // Embedded database-client connection pools (shared with the db_* agent
  // tools) — drain open TCP sockets / sqlite handles on quit.
  registerShutdownTask('db-client-pools', () => sharedDbConnectionManager().closeAll());
  // External LSP servers (intelephense/pyright/...) — graceful shutdown +
  // exit + SIGKILL fallback. The manager is lazy (wired on first LSP call);
  // a never-wired manager is just a null here.
  registerShutdownTask('lsp-servers-stop', () => getLspServerManager()?.stopAll() ?? Promise.resolve());
  // Mem C — Agent Memory (migration 181): a dedicated store SEPARATE from
  // snapshots. The service does embed-on-write + hybrid (FTS+vector RRF) search
  // over the admin-configured backend; the retriever blends importance/recency/
  // staleness and applies the conservative selector. `memoryRetriever` below is
  // the project-scope port the runner consumes.
  const agentMemoryService = new AgentMemoryService(
    db,
    memoryEmbeddingService,
    searchableVectorStore,
    memoryQueryEmbeddingService,
    semanticMutationSink,
    memoryReranker,
  );
  const agentMemoryRetriever = new AgentMemoryRetriever(agentMemoryService, db, {
    topK: 5,
    // Relevance floor (CODER_MEMORY_MIN_RELEVANCE, e.g. 0.2): drops tangential
    // hits instead of padding topK; broad `preference` memories must clear a
    // stricter bar. Off by default → no floor.
    ...(process.env.CODER_MEMORY_MIN_RELEVANCE
      ? {
          minRelevance: Number(process.env.CODER_MEMORY_MIN_RELEVANCE),
          conservativeTypes: new Set(['preference']),
        }
      : {}),
    log: (event, data) => console.debug(`[memory] retriever ${event}`, data),
  });
  const memoryRetriever = {
    // projectId 0 = global user memory (scope 'user'); any real id = that
    // project (scope 'project') — the same convention as the write path.
    retrieve: async (projectId: number, _projectName: string, taskText: string) => {
      const scope = projectId === 0 ? 'user' : 'project';
      const rows = await agentMemoryRetriever.retrieve(scope, projectId, taskText);
      // WS10 telemetry — proves proactive recall is firing (and how often it's empty).
      try { db.recordAgentMemoryEvent({ eventType: 'recall', scope, projectId, kept: rows.length }); } catch { /* best-effort */ }
      return rows;
    },
  };
  // Share the same underlying better-sqlite3 handle that CodeIndexDB
  // opened — re-opening the file (the old `new XStore(config.dbPath)`) added
  // extra writers on the central file and serialized every session/company
  // read behind WAL lock contention, blocking the main-thread event loop
  // (and thus IPC for all windows). These two were the last stragglers; the
  // sibling stores below already shared the handle.
  const sessionStore = new SessionStore(db.raw(), semanticMutationSink);
  const investigationSemanticIndex = new InvestigationSemanticIndex(
    { listProject: (projectId) => sessionStore.listInvestigationsForSemanticIndex(projectId) },
    memoryEmbeddingService,
    searchableVectorStore,
    memoryQueryEmbeddingService,
  );
  const companyStore = new CompanyStore(db.raw());
  const companySandboxStore = new CompanySandboxStore(db.raw());
  const companySandboxServicesStore = new CompanySandboxServicesStore(db.raw());
  const companyServiceTransitionsStore = new CompanyServiceTransitionsStore(db.raw());
  const companyServiceLogsStore = new CompanyServiceLogsStore(db.raw());
  const companySessionEnvStore = new CompanySessionEnvStore(db.raw());
  const companyLocalProjectStore = new CompanyLocalProjectStore(db.raw());
  const fileLocalHistoryStore = new FileLocalHistoryStore(db.raw());
  const skillStore = new SkillStore(db.raw());
  const qaTestRunStore = new QaTestRunStore(db.raw());
  const qaTestResultStore = new QaTestResultStore(db.raw());
  const chromeServiceStore = new ChromeServiceStore(db.raw());
  const designSystemStore = new DesignSystemStore(db.raw());
  const appStudioStore = new AppStudioStore(db.raw());
  const apiClientStore = new ApiClientStore(db.raw());
  // R1 — per-project feature stores. The ProjectDbPool caches the live SQLite
  // connection; wrappers must be recreated on access because an idle/LRU
  // eviction closes the raw handle they retain.
  const apiClientFor = createProjectFeatureStoreResolver(
    db,
    apiClientStore,
    (handle) => new ApiClientStore(handle),
  );
  const sshStore = new SshStore(db.raw());
  const sshStoreFor = createProjectFeatureStoreResolver(
    db,
    sshStore,
    (handle) => new SshStore(handle),
  );
  const dbClientStore = new DbClientStore(db.raw());
  const dbClientFor = createProjectFeatureStoreResolver(
    db,
    dbClientStore,
    (handle) => new DbClientStore(handle),
  );
  // Sprite Studio (migration 196) — central DB, same shared handle as the
  // sibling stores above (jobs/costs feed admin metering; churn is low).
  const spriteProjectsStore = new SpriteProjectsStore(db.raw());
  const spriteAssetsStore = new SpriteAssetsStore(db.raw());
  const spriteAnimationsStore = new SpriteAnimationsStore(db.raw());
  const spriteJobsStore = new SpriteJobsStore(db.raw());
  const verdaccioStore = new VerdaccioStore(db.raw());
  // I1 — pipelineTelemetryStore + pipelineTelemetrySink are declared
  // EARLIER (before createSearchBundle) so the V2 search path can emit
  // per-stage telemetry. The references here are the same instances.
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
    getSkillCatalog: (sessionId, projectId, projectRoot) =>
      buildPreflightSkillCatalog(skillStore, sessionId, projectId, projectRoot),
    getMemoryIndex: (projectId) => {
      try {
        if (!db.getProjectMemoryEnabled(projectId)) return [];
        return db
          .listAgentMemoryIndex('project', projectId, 20)
          .map((m) => ({ title: m.description || m.name, category: m.type, excerpt: m.excerpt }));
      } catch {
        return [];
      }
    },
  });
  // D1 (2/2) — selective-recall LLM filter (CODER_MEMORY_LLM_FILTER). Keeps only
  // retrieved memories CLEARLY about the task (CC's aboutness selector). Reuses
  // the `memory_recall` binding; unset binding → fail-open (no filtering). The
  // structural relevance floor (CODER_MEMORY_MIN_RELEVANCE) applies regardless.
  // DEFAULT-ON now (set CODER_MEMORY_LLM_FILTER=0 to disable). Fail-open when no
  // `memory_recall` binding resolves; the retriever only invokes it when there
  // are more candidates than topK (something to actually discriminate).
  if (process.env.CODER_MEMORY_LLM_FILTER !== '0') {
    const recallFilter = new LlmRecallFilter({
      resolver: pipelineProviderResolver,
      getFallbackDefault: () => generalDefaultAsFallback(providerStore),
    });
    agentMemoryRetriever.setRecallFilter((task, items) => recallFilter.filter(task, items));
  }
  // Smart memory-recall query: when the latest user message is a meta /
  // continuation ("continue", "reanalise tudo que fez") the runner asks this to
  // write a real search query from the conversation tail. Optional — an unset
  // `memory_query` binding returns null and the runner falls back to its pure
  // walk-back heuristic (no general-default call on the turn's critical path).
  const memoryQuerySynthesizerImpl = new LlmMemoryQuerySynthesizer({
    resolver: pipelineProviderResolver,
  });
  const memoryQuerySynthesizer = (tail: ConversationTail): Promise<string | null> =>
    memoryQuerySynthesizerImpl.synthesize(tail);
  // Mem C write-back — distills durable memory (facts + `gotcha` lessons) at
  // run-end. Reuses the snapshot writer + hybrid dedup + the resolver's
  // `memory_extraction` binding; when no binding is set it falls back to the
  // general default AI model (zero-config). Passed into runCoder as `runEndMemory`.
  const runEndMemoryRaw = createRunEndMemory({
    writer: new AgentMemoryWriter(db, agentMemoryService),
    search: new AgentMemoryDedupeSearch(agentMemoryService),
    resolver: pipelineProviderResolver,
    getFallbackDefault: () => generalDefaultAsFallback(providerStore),
    // Memory-health diagnostics (migration 136) — every pass lands a row so
    // the project Memory tab can show when/what was learned (or why not).
    distillLog: (projectId, entry) => {
      try { db.insertMemoryDistillLog(projectId, entry); } catch { /* best-effort */ }
    },
    // Style-profile fold (opt-in): the positive distiller maintains ONE
    // "Project style profile" memory per project — same LLM call, replace-
    // not-append merge in the extractor. Off unless the flag is set.
    getStyleProfile: process.env.MCP_MEMORY_STYLE_PROFILE === '1'
      ? (projectId) => {
          try {
            return db.getAgentMemoryByName('project', projectId, 'project-style-profile')?.content ?? null;
          } catch { return null; }
        }
      : undefined,
  });
  // Global-session WRITE redirect: a SYNTHETIC union project (mig 155) has no
  // durable home — its directory is swept when orphaned — so map its id to the
  // PRIMARY real constituent before persisting. This single chokepoint covers
  // every distill moment that flows through the port (compaction harvest,
  // Resumir&limpar, idle sweeper) AND the worker path (the main-side bridge
  // handler calls THIS instance). Inert for ordinary projects (id unchanged).
  const runEndMemory: RunEndMemory = {
    isConfigured: () => runEndMemoryRaw.isConfigured(),
    extractAndPersist: (projectId, projectName, input) => {
      const tgt = db.resolveMemoryWriteProject(projectId);
      return tgt.id === projectId
        ? runEndMemoryRaw.extractAndPersist(projectId, projectName, input)
        : runEndMemoryRaw.extractAndPersist(tgt.id, tgt.name, input);
    },
  };

  // Direct agent ports for project memory (save_note scope 'project' +
  // recall_memory). The write path reuses the distillers' MemoryExtractor
  // with a LITERAL candidate — same dedup/merge/importance floors, embedding
  // via SnapshotService, zero new dedup code.
  const VALID_MEMORY_CATEGORIES = new Set([
    'architecture', 'decision', 'convention', 'pattern', 'todo', 'note', 'gotcha', 'procedure',
    // user/feedback ride the same port (projectId 0) and map to type 'preference'.
    'user', 'feedback',
  ]);
  const projectMemory: SearchDeps['projectMemory'] = {
    save: async (projectId, projectName, entry) => {
      // Same synthetic→primary redirect as runEndMemory: a global session's
      // save_note must persist on a real project, not the throwaway union.
      // Inert for ordinary projects and for user memory (id 0 → id unchanged).
      const tgt = db.resolveMemoryWriteProject(projectId);
      if (tgt.id !== projectId) { projectId = tgt.id; projectName = tgt.name; }
      const category = VALID_MEMORY_CATEGORIES.has(entry.category) ? entry.category : 'note';
      const candidate = {
        title: entry.title,
        content: entry.content,
        category: category as import('@mcp/shared/types.js').SnapshotCategory,
        importance: 0.6, // per-category floors still apply inside the extractor
      };
      const literal = new MemoryExtractor(
        { distill: async () => [candidate] },
        new AgentMemoryWriter(db, agentMemoryService),
        new AgentMemoryDedupeSearch(agentMemoryService),
      );
      const res = await literal.extractAndPersist(projectId, projectName, 'agent', {});
      try {
        db.insertMemoryDistillLog(projectId, { trigger: 'agent', status: 'ok', ...res });
        db.recordAgentMemoryEvent({
          eventType: 'remember',
          scope: projectId === 0 ? 'user' : 'project',
          projectId,
          kept: res.created,
          dropped: res.skipped,
        });
      } catch { /* diagnostics are best-effort */ }
      return res;
    },
    recall: (projectId, _projectName, query, limit) =>
      agentMemoryRetriever.recall(projectId === 0 ? 'user' : 'project', projectId, query, limit ?? 5),
    list: async (projectId, _projectName, limit, type) => {
      const tgt = db.resolveMemoryWriteProject(projectId);
      const scope = tgt.id === 0 ? 'user' : 'project';
      return db
        .listAgentMemoryIndex(scope, tgt.id, limit ?? 12, type as import('@mcp/shared/types.js').AgentMemoryType | undefined)
        .map((m) => ({
          name: m.name,
          description: m.description,
          type: m.type,
          importance: m.importance,
          created_at: m.created_at,
        }));
    },
    forget: async (projectId, _projectName, target) => {
      const tgt = db.resolveMemoryWriteProject(projectId);
      const scope = tgt.id === 0 ? 'user' : 'project';
      const row = db.getAgentMemoryByName(scope, tgt.id, target);
      if (!row) return { archived: 0 };
      agentMemoryService.archive(row.id, 'forgotten:agent');
      await agentMemoryService.removeVectors(row.id, row.project_id).catch(() => undefined);
      try {
        db.recordAgentMemoryEvent({ eventType: 'forget', scope, projectId: tgt.id, memoryId: row.id });
      } catch { /* best-effort */ }
      return { archived: 1 };
    },
  };

  // Tool-selection plumbing. The embed adapter wraps the existing indexer
  // EmbeddingService into a single-text `EmbeddingFn`. ToolEmbeddingStore is
  // shared across all sessions in this process — tools don't vary per
  // session so re-embedding would be wasteful.
  const toolEmbeddingStore = new InMemoryToolEmbeddingStore();
  const toolSelectionEmbed: EmbeddingFn = Object.assign(
    async (text: string) => {
      // Internal selectors belong to the Memory profile. Cache consumers
      // pin the dynamic fingerprint below so a profile edit cannot mix spaces.
      const result = await memoryEmbeddingService.embedQuery(text);
      return Float32Array.from(result.vector);
    },
    {
      fingerprint: (): string =>
        memoryEmbeddingService.fingerprint?.() ?? 'semantic:memory:unfingerprinted',
    },
  );

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
  // - `docReranker`: re-orders candidates via the Docs profile's
  //   cross-encoder before the final top-K is selected.
  //
  // Both degrade gracefully (no binding configured → no-op) so they are
  // safe to construct unconditionally and pass to DocHybridSearch.
  const docQueryRewriter = new QueryRewriter({
    resolver: pipelineProviderResolver,
    cache: subAgentResultCacheStore,
    // telemetry disabled (pipeline_telemetry tab removed)
  });
  // The Docs semantic profile is the sole source of truth. Its strict
  // proxy lets CrossEncoderReranker distinguish inference failures from real
  // calibrated scores; disabled still resolves to NullReranker and preserves
  // the incoming RRF order without falling back to a pipeline LLM.
  const docReranker = new CrossEncoderReranker(docsReranker);
  const docHybridSearch = new DocHybridSearch(
    docStore,
    docsQueryEmbeddingService,
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
    embeddingService: docsEmbeddingService,
    vectorStore,
    pipelineProviderResolver,
    renderBackend: docRenderer,
    progressTracker: docProgressTracker,
  });

  // RolePipeline shared embedding store — keyed by (role + skills) so a
  // template revision invalidates entries automatically.
  const roleEmbeddingStore = new InMemoryRoleEmbeddingStore();

  // One shared hybrid runtime factory is used here and inside worker threads.
  const qualityRuntime = createQualityRuntime(db.raw(), { telemetry: pipelineTelemetrySink });
  const qualityClassificationStore = qualityRuntime.classificationStore;
  const qualityInterventionStore = new QualityInterventionStore(db.raw());
  const counterfactualLogStore = new CounterfactualLogStore(db.raw());
  const qualityClassifierPipeline = qualityRuntime.pipeline;

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
  // automatically as the semantic coordinator commits embeddings.
  const lshIndexingSink: LshIndexingSink = process.env.MCP_LSH_INDEXING === '1'
    ? new RealLshIndexingSink(lshIndex)
    : new NullLshIndexingSink();

  const semanticCoordinator = new SemanticIndexCoordinator({
    db,
    semanticStore,
    router: localVectorRouter,
    vectorStore: vectorOverride,
    codeEmbedding: codeEmbeddingService,
    docsEmbedding: docsEmbeddingService,
    memoryEmbedding: memoryEmbeddingService,
    costTracker,
    lshSink: lshIndexingSink,
    snapshotService,
    agentMemoryService,
    investigationSemanticIndex,
    docStore,
    docsIndexer: indexDocsUseCase,
    indexProfile: config.indexProfile,
    withProjectLock: (projectId, operation) =>
      projectIndexService.withProjectLock(projectId, operation),
    mutationFenceOwner: semanticMutationOwner,
  });
  semanticCoordinatorForMutations = semanticCoordinator;
  // Session Drive keeps only text/metadata in the central ledger. Semantic
  // mutations are durable deltas on the project's shared Memory namespace;
  // search resolves the active generation through the worker-backed index.
  const investigationSemantic: InvestigationSemanticIndexPort = {
    wakeUpsert: (row) => {
      if (row.project_id == null) return;
      // SessionStore already persisted and settled the exact durable fence.
      // This is a targeted latency wake, never a profile-wide rebuild.
      pendingMutationDrains.add(projectMemoryNamespace(row.project_id));
      scheduleMutationDrain();
    },
    search: async ({ sessionId, query, limit }) => {
      const projectId = sessionStore.investigationProjectId(sessionId);
      return projectId == null
        ? []
        : investigationSemanticIndex.search(projectId, query, limit);
    },
  };
  setInvestigationSemanticIndex(investigationSemantic);
  registerShutdownTask('investigation-semantic-index', () => {
    setInvestigationSemanticIndex(null);
  });
  indexDocsUseCase.setSemanticHooks({
    prepareCollection: (collectionId) => semanticCoordinator.prepareDocsCollection(collectionId),
    ensureCollection: (collectionId) => semanticCoordinator.ensureDocsCollection(collectionId),
    beginCollectionMutation: (collectionId, operation) =>
      semanticCoordinator.beginDocsCollectionMutation(collectionId, operation),
    endCollectionMutation: (fence, mutationError) =>
      semanticCoordinator.endDocsCollectionMutation(fence, mutationError),
    runCollectionExclusive: (collectionId, operation) =>
      semanticCoordinator.runDocsCollectionExclusive(collectionId, operation),
  });
  registerShutdownTask('semantic-coordinator', () => semanticCoordinator.dispose());
  projectIndexService.setSemanticCatchup({
    noteDelta: (projectId, events) => semanticCoordinator.noteCodeDelta(projectId, events),
    ensureProject: (projectId) => semanticCoordinator.catchUpCodeProject(projectId),
    projectReady: (projectId) => { semanticCoordinator.activateCodeProject(projectId); },
    projectInactive: (projectId) => { semanticCoordinator.deactivateCodeProject(projectId); },
  });
  semanticCoordinator.recoverInterruptedJobsPassively();

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
  const toolSelectionKRaw = Number.parseInt(process.env.MCP_PIPELINES_TOOL_SELECTION_K ?? '', 10);
  const toolSelectionK = Number.isFinite(toolSelectionKRaw)
    ? Math.min(128, Math.max(8, toolSelectionKRaw))
    : 32;
  // Agent Decision Engine → tool-selection bridge. Default OFF: when enabled,
  // the classified task intent nudges preferred/discouraged tools in the thin
  // selection path. Off (or low classifier confidence) → byte-identical to the
  // pre-bridge behavior, so this is safe to ship dark and enable per-env.
  const agentDecisionToolPolicyEnabled = process.env.MCP_AGENT_DECISION_TOOL_POLICY === '1';
  // Observability-only Agent Decision Engine metadata in tool-selection shadow
  // rows/outcomes. Default OFF and stored inside existing JSON columns (no DB
  // migration). This lets us compare recommendation vs. actual tool use before
  // enforcing routing/guardrails.
  const agentDecisionTelemetryEnabled = process.env.MCP_AGENT_DECISION_TELEMETRY === '1';
  const agentDecisionGuidanceEnabled = process.env.MCP_AGENT_DECISION_GUIDANCE === '1';
  const agentDecisionSoftGuardrailEnabled = process.env.MCP_AGENT_DECISION_SOFT_GUARDRAIL === '1';
  const agentDecisionAskBeforeSwitchEnabled = process.env.MCP_AGENT_DECISION_ASK_BEFORE_SWITCH === '1';
  const guardrailMinConfidenceRaw = Number.parseFloat(process.env.MCP_AGENT_DECISION_GUARDRAIL_MIN_CONFIDENCE ?? '');
  const agentDecisionSoftGuardrailMinConfidence = Number.isFinite(guardrailMinConfidenceRaw)
    ? guardrailMinConfidenceRaw
    : undefined;
  const buildAgentDecisionRuntimeOptions = (): ReturnType<PipelineDeps['buildAgentDecisionRuntimeOptions']> => ({
    agentDecisionTelemetryEnabled,
    agentDecisionGuidanceEnabled,
    agentDecisionSoftGuardrail: agentDecisionSoftGuardrailEnabled,
    agentDecisionSoftGuardrailMinConfidence,
    agentDecisionAskBeforeSwitch: agentDecisionAskBeforeSwitchEnabled,
  });

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
    ctx: {
      taskText: string;
      recentToolCalls: ReadonlyArray<{ name: string; timestampMs: number; ok: boolean }>;
      protectedToolNames?: ReadonlySet<string>;
    },
  ) => Promise<ThinTool[]>) => {
    if (!toolSelectionFilterEnabled) return undefined;
    return async (tools, ctx) => {
      const agentDecision = agentDecisionTelemetryEnabled
        ? decisionTelemetryForTask(ctx.taskText)
        : undefined;
      const selected = await applyToolSelectionThin({
        allTools: tools,
        taskText: ctx.taskText,
        recentToolCalls: ctx.recentToolCalls,
        embed: toolSelectionEmbed,
        embeddingStore: toolEmbeddingStore,
        k: toolSelectionK,
        protectedNames: ctx.protectedToolNames,
        onError: (error) => {
          console.warn(
            `[coder] smart tool-selection failed open: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
        toolPolicy: agentDecisionToolPolicyEnabled
          ? toolPolicyForTask(ctx.taskText)
          : undefined,
        agentDecision,
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
              k: toolSelectionK,
              agentDecision,
            },
          },
          { toolNames: selected.map((t) => t.name), agentDecision },
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
        agentDecision: agentDecisionTelemetryEnabled
          ? decisionTelemetryForTask(taskText)
          : undefined,
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
    exportService,
    webhookDispatcher,
    modelDiscovery,
    embeddingService,
    docsEmbeddingService,
    memoryEmbeddingService,
    vectorStore,
    semanticStore,
    localVectorRouter,
    semanticProfileRuntime,
    semanticCoordinator,
    hybridSearch,
    memoryRetriever,
    memoryQuerySynthesizer,
    agentMemoryService,
    agentMemoryRetriever,
    investigationSemantic,
    runEndMemory,
    projectMemory,
    recentFilesSource,
    sessionStore,
    companyStore,
    companySandboxStore,
    companySandboxServicesStore,
    companyServiceTransitionsStore,
    companyServiceLogsStore,
    companySessionEnvStore,
    companyLocalProjectStore,
    fileLocalHistoryStore,
    skillStore,
    qaTestRunStore,
    qaTestResultStore,
    chromeServiceStore,
    designSystemStore,
    appStudioStore,
    apiClientStore,
    apiClientFor,
    sshStore,
    sshStoreFor,
    dbClientStore,
    dbClientFor,
    spriteProjectsStore,
    spriteAssetsStore,
    spriteAnimationsStore,
    spriteJobsStore,
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
    buildAgentDecisionRuntimeOptions,
    embeddingKind,
    vectorStoreKind,
    docStore,
    docHybridSearch,
    indexDocsUseCase,
    docProgressTracker,
    invokePluginTool,
    syncPluginProviders,
    managedGit,
    mcpBearerResolver: null,
  };
}
