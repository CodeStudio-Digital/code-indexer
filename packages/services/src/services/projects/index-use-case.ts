import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '../costs.js';
import type { WebhookDispatcher } from '../webhooks.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { ProviderName, IndexProgress, IndexResult } from '@mcp/shared/types.js';
import { createProviderAsync } from '../../providers/factory.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import { IndexAgent, type EmbeddingProgress } from '@mcp/indexer/indexer/indexer.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { IndexerFilesUpdatedListener } from '@mcp/indexer/indexer/indexer-events.js';
import { ProjectError } from './errors.js';

export interface IndexProjectInput {
  provider?: string;
  model?: string;
  force?: boolean;
  concurrent?: number;
}

export interface IndexUseCaseDeps {
  db: CodeIndexDB;
  providerStore: ProviderStore;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  costTracker: CostTracker;
  webhookDispatcher: WebhookDispatcher;
  config: IndexerConfig;
  /**
   * Optional LSH indexing sink. When MCP_LSH_INDEXING=1, the host wires
   * `RealLshIndexingSink` so the indexer populates
   * `embedding_simhash_signatures` + `embedding_lsh_buckets` alongside
   * the vector store. Undefined → `NullLshIndexingSink` (no-op).
   */
  lshIndexingSink?: LshIndexingSink;
  /**
   * Optional listener fired after `indexProject()` completes (I3 — Sprint 1).
   * Typically a `makeHybridSearchCacheInvalidator(hybridSearch)` from
   * `@mcp/indexer/search/cache-invalidator.js` so search caches don't
   * serve stale results after a re-index. Undefined → no listener
   * registered → bit-identical to pre-I3.
   */
  filesUpdatedListener?: IndexerFilesUpdatedListener;
}

/** Payload passed to `onStart` before any work begins. Shape kept stable so SSE clients don't regress. */
export interface IndexStartPayload {
  project_id: number;
  project_name: string;
  provider: string;
  /** Undefined when no default model is configured and the caller didn't override it. */
  model: string | undefined;
  force: boolean;
  started_at: string;
  concurrent: number;
}

/** Fully normalized progress frame — snake_case to match the SSE wire format. */
export interface IndexProgressFrame {
  current: number;
  total: number;
  current_file: string;
  elapsed_ms: number;
  cost_usd: number;
  percent: number;
}

export interface EmbeddingProgressFrame {
  current: number;
  total: number;
  percent: number;
}

export interface IndexStreamCallbacks {
  onStart?: (p: IndexStartPayload) => Promise<void> | void;
  onProgress?: (p: IndexProgressFrame) => Promise<void> | void;
  onDone?: (result: IndexResult) => Promise<void> | void;
  onError?: (message: string) => Promise<void> | void;
}

export interface RetryEmbeddingsStreamCallbacks {
  onStart?: (p: { project_id: number; project_name: string; started_at: string }) => Promise<void> | void;
  onProgress?: (p: EmbeddingProgressFrame) => Promise<void> | void;
  onDone?: (result: { embedded: number; skipped: number; tokens: number }) => Promise<void> | void;
  onError?: (message: string) => Promise<void> | void;
}

/**
 * Orchestrates `IndexAgent` runs behind a use-case façade. Routes, CLI, and
 * MCP tools share this path so the provider-resolution, progress-coalescing
 * and error mapping logic lives in exactly one place.
 */
export class IndexProjectUseCase {
  constructor(private readonly deps: IndexUseCaseDeps) {}

  /**
   * Non-streaming run. Throws `ProjectError('not_found', …)` if the project
   * doesn't exist. Any other error propagates unchanged.
   */
  async run(projectId: number, input: IndexProjectInput = {}): Promise<IndexResult> {
    const { db } = this.deps;
    const project = db.getProject(projectId);
    if (!project) throw new ProjectError('not_found', 'Not found');

    const { provider } = await this.resolveProvider(input);
    const agent = this.buildAgent(provider);
    return agent.indexProject(project.root_path, { force: input.force });
  }

  /**
   * Streaming run. All SSE-specific concerns (event naming, timing coalesce)
   * live here; the caller only has to forward callbacks to their transport.
   * Throws `ProjectError('not_found')` before any callback fires.
   */
  async runStream(
    projectId: number,
    input: IndexProjectInput,
    callbacks: IndexStreamCallbacks,
  ): Promise<void> {
    const { db, config } = this.deps;
    const project = db.getProject(projectId);
    if (!project) throw new ProjectError('not_found', 'Not found');

    try {
      const { provider, kind, model } = await this.resolveProvider(input);
      await callbacks.onStart?.({
        project_id: project.id,
        project_name: project.name,
        provider: input.provider ?? kind,
        model: input.model ?? model,
        force: !!input.force,
        started_at: new Date().toISOString(),
        concurrent: input.concurrent ?? 5,
      });

      const agent = this.buildAgent(provider, {
        ...config,
        concurrency: input.concurrent ?? 5,
      });

      // Coalesce progress events to at most one frame per ~120ms so chatty
      // concurrency runs don't flood the channel. Terminal frames are
      // always flushed on done.
      let lastFlushed = 0;
      let latest: IndexProgress | null = null;
      const flush = async () => {
        if (!latest) return;
        const p = latest;
        latest = null;
        await callbacks.onProgress?.({
          current: p.current,
          total: p.total,
          current_file: p.currentFile,
          elapsed_ms: p.elapsedMs,
          cost_usd: p.costUsd,
          percent: p.total > 0 ? Math.round((p.current / p.total) * 100) : 0,
        });
      };

      const result = await agent.indexProject(project.root_path, {
        force: input.force,
        onProgress: (p) => {
          latest = p;
          const now = Date.now();
          if (p.current === p.total || now - lastFlushed > 120) {
            lastFlushed = now;
            void flush();
          }
        },
      });
      await flush();
      await callbacks.onDone?.(result);
    } catch (err) {
      await callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Streaming retry of failed/missing embeddings. Shares the same callback
   * shape as `runStream` but emits `EmbeddingProgressFrame` payloads.
   */
  async retryEmbeddingsStream(
    projectId: number,
    callbacks: RetryEmbeddingsStreamCallbacks,
  ): Promise<void> {
    const { db } = this.deps;
    const project = db.getProject(projectId);
    if (!project) throw new ProjectError('not_found', 'Not found');

    try {
      await callbacks.onStart?.({
        project_id: project.id,
        project_name: project.name,
        started_at: new Date().toISOString(),
      });

      // IndexAgent needs a provider but retryEmbeddings doesn't use it.
      // A dummy provider avoids a real API call at startup.
      const dummyProvider = {
        name: 'none',
        model: 'none',
        analyzeFile: () => { throw new Error('not used'); },
      } as unknown as LLMProvider;
      const agent = this.buildAgent(dummyProvider);

      let lastFlushed = 0;
      let latest: EmbeddingProgress | null = null;
      const flush = async () => {
        if (!latest) return;
        const p = latest;
        latest = null;
        await callbacks.onProgress?.({
          current: p.current,
          total: p.total,
          percent: p.percent,
        });
      };

      const result = await agent.retryEmbeddings(project.root_path, {
        onProgress: (p) => {
          latest = p;
          const now = Date.now();
          if (p.current === p.total || now - lastFlushed > 120) {
            lastFlushed = now;
            void flush();
          }
        },
      });
      await flush();
      await callbacks.onDone?.({
        embedded: result.embedded,
        skipped: result.skipped,
        tokens: result.tokens,
      });
    } catch (err) {
      await callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async resolveProvider(input: IndexProjectInput) {
    const defaults = this.deps.providerStore.getDefaultProviderAndModel();
    const kind = (input.provider ?? defaults.kind) as ProviderName;
    const model = input.model ?? defaults.model;
    // Pass the caller's provider through untouched. When absent, the factory
    // resolves the default ProviderStore row itself — WITH its stored
    // credentials/base_url. Passing `defaults.kind` routed e.g. a zai default
    // (legacy kind='openai') to the bare openai shape, which then demanded
    // OPENAI_API_KEY from the env and broke every app-triggered index run.
    const provider = await createProviderAsync(input.provider as ProviderName | undefined, model);
    return { provider, kind, model };
  }

  private buildAgent(provider: LLMProvider, configOverride?: IndexerConfig): IndexAgent {
    const { db, embeddingService, vectorStore, costTracker, webhookDispatcher, config, lshIndexingSink } = this.deps;
    const agent = new IndexAgent(
      db,
      provider,
      embeddingService,
      vectorStore,
      costTracker,
      webhookDispatcher,
      configOverride ?? config,
      lshIndexingSink,
    );
    // I3 — register the files_updated listener (HybridSearch cache
    // invalidator in production). Skipped when not configured.
    if (this.deps.filesUpdatedListener) {
      agent.onFilesUpdated(this.deps.filesUpdatedListener);
    }
    return agent;
  }
}
