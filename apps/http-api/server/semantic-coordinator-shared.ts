import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
type AgentMemoryService
} from '@mcp/services/memory/agent-memory-service.js';
import {
type InvestigationSemanticIndex
} from '@mcp/services/memory/investigation-semantic-index.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import {
type IndexDocumentationUseCase
} from '@mcp/services/services/docs/index.js';
import type { DirtyEvent } from '@mcp/services/services/project-index/index.js';
import {
type SnapshotService
} from '@mcp/services/services/snapshots.js';
import {
type LocalVectorRouter,
type SemanticJobRow,
type SemanticPurpose,
type SemanticStore
} from '@mcp/store';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import {
type VectorStore
} from '@mcp/store/vectors.js';

export interface CoordinatorDeps {
  db: CodeIndexDB;
  semanticStore: SemanticStore;
  listJobsOffThread?(filter: Parameters<SemanticStore['listJobs']>[0]): Promise<SemanticJobRow[]>;
  router: LocalVectorRouter;
  vectorStore: VectorStore & {
    removeProject?(projectId: number): Promise<void>;
    dropGeneration?(namespace: string, generationId: number): Promise<void>;
    dropLegacyKnowledgeTables?(namespace: string): Promise<number>;
    hasGeneration?(namespace: string, generationId: number): Promise<boolean>;
    compactGenerationDatabase?(
      namespace: string,
      generationId: number,
    ): Promise<{ before_bytes: number; after_bytes: number }>;
    listIds?(namespace: string, generationId: number): Promise<string[]>;
    deleteByIdsForGeneration?(namespace: string, generationId: number, ids: string[]): Promise<number>;
    deleteByItemKeysForGeneration?(
      namespace: string,
      generationId: number,
      itemKeys: string[],
    ): Promise<number>;
  };
  codeEmbedding: EmbeddingService;
  docsEmbedding: EmbeddingService;
  memoryEmbedding: EmbeddingService;
  costTracker: CostTracker;
  lshSink: LshIndexingSink;
  snapshotService: SnapshotService;
  agentMemoryService: AgentMemoryService;
  investigationSemanticIndex: InvestigationSemanticIndex;
  docStore: DocStore;
  docsIndexer: IndexDocumentationUseCase;
  indexProfile?: 'aggressive' | 'balanced' | 'conservative';
  withProjectLock?<T>(projectId: number, operation: () => Promise<T>): Promise<T>;
  /** Owner id used by Snapshot/AgentMemory durable fences in this process. */
  mutationFenceOwner?: string;
  /** Optional worker-owned startup recovery for stale durable fences. */
  recoverMutationFences?(
    prefixes: readonly string[],
    currentOwner: string,
  ): Promise<number | null>;
}

export type ReindexResult = {
  purpose: SemanticPurpose;
  generation_id: number | null;
  completed_namespaces: string[];
  failed_namespaces: Array<{ namespace: string; error: string }>;
  skipped?: 'disabled';
};

export interface SemanticUnusedVectorCleanupResult {
  tables_removed: number;
  items_removed: number;
  databases_compacted: number;
  bytes_reclaimed: number;
  skipped_referenced: number;
  failures: Array<{ namespace: string; generation_id: number; error: string }>;
}

export type ProjectRemovalOptions = {
  /** Runs under both the structural mutex and semantic namespace barriers. */
  finalize?: () => void | Promise<void>;
  /** Clear the durable tombstone after finalize when the project row remains. */
  retainProject?: boolean;
};

export type ProjectRemovalKind = 'cleanup' | 'delete' | 'clear';

export function projectRemovalKind(options: ProjectRemovalOptions): ProjectRemovalKind {
  if (options.retainProject) return 'clear';
  return options.finalize ? 'delete' : 'cleanup';
}

export class DeltaBuildPendingError extends Error {
  constructor(namespace: string) {
    super(`delta queue pending for ${namespace}`);
    this.name = 'DeltaBuildPendingError';
  }
}

export class SemanticVectorWorkerUnavailableError extends Error {
  readonly code = 'SEMANTIC_VECTOR_WORKER_UNAVAILABLE';

  constructor(operation: string) {
    super(`semantic vector worker unavailable: ${operation}; semantic indexing is paused and FTS remains active`);
    this.name = 'SemanticVectorWorkerUnavailableError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const DOCS_BACKFILL_RETRY_MS = 30_000;

export const PROJECT_REMOVAL_RETRY_MS = 30_000;

const CODE_DELTA_PATH_LIMIT = 512;

export const CODE_VERIFY_WAVE_FILES = 25;

export const CODE_DELTA_BUSY_TIMEOUT_MS = 0;

export const CODE_DELTA_RETRY_BASE_MS = 50;

export const CODE_DELTA_RETRY_MAX_MS = 1_000;

export const MUTATION_FENCE_RECOVERY_PREFIXES = [
  'docs:c',
  'snapshot:p',
  'memory:project:p',
  'memory:user',
] as const;

export function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_BUSY_SNAPSHOT'
    || /database is (?:locked|busy)/i.test(errorMessage(error));
}

export type CodeDeltaCursor = {
  events: DirtyEvent[];
  previous_item_keys: string[];
};

export function readCodeDeltaCursor(cursor: Record<string, unknown> | null): CodeDeltaCursor {
  const events = Array.isArray(cursor?.events)
    ? cursor.events.flatMap((value): DirtyEvent[] => {
        if (!value || typeof value !== 'object') return [];
        const row = value as { path?: unknown; kind?: unknown };
        if (typeof row.path !== 'string' || (row.kind !== 'upsert' && row.kind !== 'delete')) return [];
        return [{ path: row.path.replace(/\\/g, '/'), kind: row.kind }];
      })
    : [];
  const previousItemKeys = Array.isArray(cursor?.previous_item_keys)
    ? cursor.previous_item_keys.filter((value): value is string => typeof value === 'string')
    : [];
  return { events, previous_item_keys: previousItemKeys };
}

export function mergeCodeDeltaCursor(
  current: Record<string, unknown> | null,
  events: readonly DirtyEvent[],
  previousItemKeys: readonly string[],
): CodeDeltaCursor {
  const before = readCodeDeltaCursor(current);
  const byPath = new Map<string, DirtyEvent>();
  for (const event of [...before.events, ...events]) {
    const path = event.path.replace(/\\/g, '/');
    byPath.set(path, { path, kind: event.kind });
  }
  const mergedEvents = byPath.size > CODE_DELTA_PATH_LIMIT
    ? [{ path: '*', kind: 'upsert' as const }]
    : [...byPath.values()];
  const mergedKeys = mergedEvents[0]?.path === '*'
    ? []
    : [...new Set([...before.previous_item_keys, ...previousItemKeys])];
  return { events: mergedEvents, previous_item_keys: mergedKeys };
}

export function projectIdFromSemanticNamespace(namespace: string): number | null {
  const match = /^(?:code|snapshot|memory:project):p(\d+)$/.exec(namespace);
  return match ? Number(match[1]) : null;
}
