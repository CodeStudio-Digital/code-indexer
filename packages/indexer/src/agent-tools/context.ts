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
import { createMcpSemanticMutationSink } from './semantic-mutation-sink.js';
import {
  UNAVAILABLE_SEMANTIC_SEARCH_CLIENT,
  type McpSemanticSearchClient,
} from './semantic-client.js';

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
  /** Semantic reads are delegated to the semantic owner (the host process). */
  semanticSearchClient: McpSemanticSearchClient;
  /** In-process lexical fallback used when the semantic owner is unavailable. */
  hybridSearch: HybridSearch;
}

/** The host's edges: the semantic owner client and the namespace wake. Without
 * a client every semantic read falls back to FTS; without a wake the durable
 * mutation job waits for the next owner wake. */
export interface IndexToolContextOverrides {
  semanticSearchClient?: McpSemanticSearchClient;
  mutationSinkWake?: (namespace: string) => void | Promise<void>;
}

/** Services the index tools need, built over the caller's database handle. */
export function createIndexToolContext(
  config: IndexerConfig,
  db: CodeIndexDB,
  overrides: IndexToolContextOverrides = {},
): IndexToolContext {
  const semanticStore = new SemanticStore(db.raw());
  // The index tools never load an embedding model or open a vector database.
  // Semantic reads go to the owner through the host's client; this tiny
  // HybridSearch instance exists only for the always-available FTS fallback
  // when there is no owner to ask.
  const searchTelemetry = new FileSemanticSearchTelemetryStore((projectId) => {
    const project = db.getProject(projectId);
    return project && !project.is_synthetic ? project.root_path : null;
  });
  const hybridSearch = new HybridSearch(
    db, null, new NullEmbeddingService(), null, null, null, null, null, null, searchTelemetry,
  );
  const semanticMutationSink = createMcpSemanticMutationSink(semanticStore, { wake: overrides.mutationSinkWake });

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
    modelDiscovery: new ModelDiscovery(db, async (request, signal) =>
      (await overrides.semanticSearchClient?.searchCatalog?.(request, signal))?.value ?? null),
    semanticSearchClient: overrides.semanticSearchClient ?? UNAVAILABLE_SEMANTIC_SEARCH_CLIENT,
    hybridSearch,
  };
}
