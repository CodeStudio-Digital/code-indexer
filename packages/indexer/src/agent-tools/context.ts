import type { CodeIndexDB } from '@mcp/store/db.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { HybridSearch } from '../search/hybrid.js';
import { FileSemanticSearchTelemetryStore } from '../search/search-telemetry.js';
import { ModelDiscovery } from '../indexer/providers/model-discovery.js';
import { NullEmbeddingService } from '../search/embeddings.js';
import { createMcpSemanticMutationSink } from './loopback/server-control.js';
import {
  createMcpSemanticSearchClient,
  type McpSemanticSearchClient,
} from './loopback/semantic-search-client.js';

export interface IndexToolContext {
  /** Per-request cancellation; never store a request signal on the shared context. */
  signal?: AbortSignal;
  db: CodeIndexDB;
  semanticStore: SemanticStore;
  costTracker: CostTracker;
  snapshotService: SnapshotService;
  /** Dedicated Agent Memory (migration 181) — backs the bridged save_memory/search_memory. */
  agentMemoryService: AgentMemoryService;
  modelDiscovery: ModelDiscovery;
  /** Semantic reads are delegated to the localhost server/worker owner. */
  semanticSearchClient: McpSemanticSearchClient;
  /** In-process lexical fallback used when the localhost owner is unavailable. */
  hybridSearch: HybridSearch;
}

/** Services the index tools need, built over the caller's database handle. */
export function createIndexToolContext(config: IndexerConfig, db: CodeIndexDB): IndexToolContext {
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
    modelDiscovery: new ModelDiscovery(db),
    semanticSearchClient: createMcpSemanticSearchClient(config),
    hybridSearch,
  };
}
