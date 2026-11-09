import { CodeIndexDB } from '@mcp/store/db.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { ExportService } from '@mcp/services/services/exporter.js';
import { WebhookDispatcher } from '@mcp/services/services/webhooks.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { FileSemanticSearchTelemetryStore } from '@mcp/indexer/search/search-telemetry.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { createMcpSemanticMutationSink } from './server-control.js';
import {
  createMcpSemanticSearchClient,
  type McpSemanticSearchClient,
} from './semantic-search-client.js';

export interface ToolContext {
  /** Per-request cancellation; never store a request signal on the shared context. */
  signal?: AbortSignal;
  config: IndexerConfig;
  db: CodeIndexDB;
  semanticStore: SemanticStore;
  costTracker: CostTracker;
  snapshotService: SnapshotService;
  /** Dedicated Agent Memory (migration 181) — backs the bridged save_memory/search_memory. */
  agentMemoryService: AgentMemoryService;
  exportService: ExportService;
  webhookDispatcher: WebhookDispatcher;
  modelDiscovery: ModelDiscovery;
  /** Semantic reads are delegated to the localhost server/worker owner. */
  semanticSearchClient: McpSemanticSearchClient;
  /** In-process lexical fallback used when the localhost owner is unavailable. */
  hybridSearch: HybridSearch;
}

export function buildContext(): ToolContext {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);

  const semanticStore = new SemanticStore(db.raw());
  // The MCP process is intentionally incapable of loading an embedding model
  // or opening a vector database. Semantic reads go through localhost RPC;
  // this tiny HybridSearch instance exists only for the always-available FTS
  // fallback when the app/server is stopped.
  const searchTelemetry = new FileSemanticSearchTelemetryStore((projectId) => {
    const project = db.getProject(projectId);
    return project && !project.is_synthetic ? project.root_path : null;
  });
  const hybridSearch = new HybridSearch(
    db, null, new NullEmbeddingService(), null, null, null, null, null, null, searchTelemetry,
  );
  const semanticMutationSink = createMcpSemanticMutationSink(semanticStore);

  return {
    config,
    db,
    semanticStore,
    costTracker: new CostTracker(db),
    snapshotService: new SnapshotService(db, null, null, semanticMutationSink),
    agentMemoryService: new AgentMemoryService(
      db,
      null,
      null,
      null,
      semanticMutationSink,
    ),
    exportService: new ExportService(db),
    webhookDispatcher: new WebhookDispatcher(db),
    modelDiscovery: new ModelDiscovery(db),
    semanticSearchClient: createMcpSemanticSearchClient(config),
    hybridSearch,
  };
}
