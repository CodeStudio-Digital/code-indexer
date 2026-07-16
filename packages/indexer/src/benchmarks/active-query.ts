import { codeNamespace, docNamespace } from '@mcp/shared/vector-namespace.js';
import type { EmbeddingService } from '../search/embeddings.js';
import type { SemanticProfileRuntime } from '../search/semantic-profile-runtime.js';
import type { SemanticStore } from '@mcp/store/semantic-store.js';
import type { VectorStore } from '@mcp/store/vectors.js';

export interface ActiveBenchmarkQueryServices {
  namespace: string;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore | null;
  /** Immutable generation that owns the serving vector space, when present. */
  activeGenerationId: number | null;
  /** Logical indexed-item count recorded by the active generation. */
  indexedItems: number;
}

export type ReadyActiveBenchmarkQueryServices = ActiveBenchmarkQueryServices & {
  vectorStore: VectorStore;
  activeGenerationId: number;
};

export interface ActiveDocsBenchmarkQueryServices {
  embeddingService: EmbeddingService;
  vectorStore: VectorStore | null;
  activeCollectionIds: number[];
  activeCollections: Array<{
    collectionId: number;
    namespace: string;
    generationId: number;
    indexedItems: number;
  }>;
}

export type DocsBenchmarkMode = 'fts' | 'hybrid' | 'rerank';

/** Explicit FTS-only evaluation is valid without semantic storage. Any
 * hybrid/rerank cell, including one selected as a gate, requires it. */
export function docsBenchmarkNeedsSemanticIndex(
  modes: readonly DocsBenchmarkMode[],
): boolean {
  return modes.some((mode) => mode !== 'fts');
}

/**
 * Bind the live benchmark cell to exactly the vector space currently serving
 * the project. The desired profile may already point at the next model while
 * a namespace-by-namespace rollout is still building.
 */
export function resolveActiveBenchmarkQueryServices(
  semanticStore: Pick<SemanticStore, 'getActiveGeneration' | 'listItems'>,
  semanticRuntime: Pick<SemanticProfileRuntime, 'queryEmbedding'>,
  vectorStore: VectorStore,
  projectId: number,
): ActiveBenchmarkQueryServices {
  const namespace = codeNamespace(projectId);
  const activeGeneration = semanticStore.getActiveGeneration(namespace);
  const indexedItems = activeGeneration
    ? semanticStore.listItems({
        generation_id: activeGeneration.id,
        namespace,
        status: 'indexed',
      }).length
    : 0;
  return {
    namespace,
    embeddingService: semanticRuntime.queryEmbedding('code'),
    vectorStore: activeGeneration ? vectorStore : null,
    activeGenerationId: activeGeneration?.id ?? null,
    indexedItems,
  };
}

/**
 * A quality gate must measure semantic retrieval, not a transparent serving
 * fallback. Validate central control-plane state before opening the physical
 * sqlite-vec table.
 */
export function assertActiveBenchmarkGeneration(
  services: ActiveBenchmarkQueryServices,
): asserts services is ReadyActiveBenchmarkQueryServices {
  if (services.activeGenerationId === null || services.vectorStore === null) {
    throw new Error(
      `[bench] invalid semantic index: ${services.namespace} has no active generation`,
    );
  }
  if (!Number.isFinite(services.indexedItems) || services.indexedItems <= 0) {
    throw new Error(
      `[bench] invalid semantic index: active generation ${services.activeGenerationId} `
      + `for ${services.namespace} has zero indexed items`,
    );
  }
}

/** Physical counterpart to assertActiveBenchmarkGeneration. Activation also
 * checks this invariant, but the benchmark re-verifies it so a missing or
 * corrupted project vectors.db cannot produce a false FTS-only pass. */
export function assertPhysicalBenchmarkVectors(
  services: ReadyActiveBenchmarkQueryServices,
  physicalVectorCount: number,
): void {
  if (!Number.isFinite(physicalVectorCount) || physicalVectorCount <= 0) {
    throw new Error(
      `[bench] invalid semantic index: active generation ${services.activeGenerationId} `
      + `for ${services.namespace} has zero physical vectors`,
    );
  }
}

/** Bind documentation evaluation to the immutable generation serving each
 * collection. DocHybridSearch invokes the returned namespace-aware query
 * proxy per collection, so inactive collections contribute FTS only without
 * disabling vector retrieval for active siblings. */
export function resolveActiveDocsBenchmarkQueryServices(
  semanticStore: Pick<SemanticStore, 'getActiveGeneration' | 'listItems'>,
  semanticRuntime: Pick<SemanticProfileRuntime, 'queryEmbedding'>,
  vectorStore: VectorStore,
  collectionIds: readonly number[],
): ActiveDocsBenchmarkQueryServices {
  const activeCollections: ActiveDocsBenchmarkQueryServices['activeCollections'] = [];
  for (const collectionId of collectionIds) {
    const namespace = docNamespace(collectionId);
    const generation = semanticStore.getActiveGeneration(namespace);
    if (!generation) continue;
    activeCollections.push({
      collectionId,
      namespace,
      generationId: generation.id,
      indexedItems: semanticStore.listItems({
        generation_id: generation.id,
        namespace,
        status: 'indexed',
      }).length,
    });
  }
  const activeCollectionIds = activeCollections.map(({ collectionId }) => collectionId);
  return {
    embeddingService: semanticRuntime.queryEmbedding('knowledge'),
    vectorStore: activeCollectionIds.length > 0 ? vectorStore : null,
    activeCollectionIds,
    activeCollections,
  };
}

/** Docs serving may degrade inactive collections to FTS, but a semantic
 * benchmark cannot: every advertised active collection must have both ledger
 * rows and physical sqlite-vec IDs, otherwise hybrid/rerank scores are not a
 * measurement of the requested retrieval path. */
export async function assertDocsSemanticBenchmarkReady(
  services: ActiveDocsBenchmarkQueryServices,
  listPhysicalIds: (namespace: string, generationId: number) => Promise<readonly string[]>,
): Promise<void> {
  if (services.activeCollections.length === 0 || services.vectorStore === null) {
    throw new Error('[docs-eval] invalid semantic index: no active documentation generation');
  }
  const logicallyEmpty = services.activeCollections.filter(({ indexedItems }) =>
    !Number.isFinite(indexedItems) || indexedItems <= 0);
  if (logicallyEmpty.length > 0) {
    throw new Error(
      `[docs-eval] invalid semantic index: zero indexed items for ${
        logicallyEmpty.map(({ namespace }) => namespace).join(', ')
      }`,
    );
  }
  const physical = await Promise.all(services.activeCollections.map(async (collection) => ({
    collection,
    ids: await listPhysicalIds(collection.namespace, collection.generationId),
  })));
  const physicallyEmpty = physical.filter(({ ids }) => new Set(ids).size === 0);
  if (physicallyEmpty.length > 0) {
    throw new Error(
      `[docs-eval] invalid semantic index: zero physical vectors for ${
        physicallyEmpty.map(({ collection }) => collection.namespace).join(', ')
      }`,
    );
  }
}
