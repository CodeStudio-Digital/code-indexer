/** ID-based routing from semantic namespaces to distributed sqlite-vec files. */
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync, rmSync, statSync } from 'node:fs';
import type { VectorMatch, VectorRecord } from '@mcp/shared/types.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { resolveProjectDbLocation } from './project-db/paths.js';
import { ProjectVectorStorePool } from './project-vector-store-pool.js';
import type { SqliteVecVectorStore } from './sqlite-vec-store.js';
import {
  generationMatchesEmbeddingFingerprint,
  type VectorItemState,
  type VectorSearchOptions,
  type VectorStore,
  type VectorWriteTarget,
} from './vectors.js';
import type {
  EmbeddingTarget,
  SemanticNamespaceGenerationRow,
  SemanticPurpose,
  SemanticStore,
} from './semantic-store.js';

export type LocalSemanticNamespace =
  | `code:p${number}`
  | `snapshot:p${number}`
  | `memory:project:p${number}`
  | `docs:c${number}`
  | 'memory:user';

export interface LocalVectorProject {
  id: number;
  rootPath?: string | null;
  root_path?: string | null;
  dbPath?: string | null;
  db_path?: string | null;
}

export interface LocalVectorRoute {
  namespace: LocalSemanticNamespace;
  purpose: SemanticPurpose;
  scope: 'code' | 'snapshot' | 'project_memory' | 'docs' | 'user_memory';
  projectId: number | null;
  collectionId: number | null;
  generationId: number;
  dbPath: string;
  tableName: string;
}

export interface LocalVectorRouterOptions {
  resolveProject: (projectId: number) => LocalVectorProject | null | undefined;
  semanticStore?: Pick<SemanticStore, 'listNamespaceGenerations'>
    & Partial<Pick<SemanticStore,
      | 'deleteNamespace'
      | 'getGeneration'
      | 'getProfile'
      | 'listItems'
      | 'upsertItem'
      | 'deleteItemsByVectorIds'
      | 'deleteItemsByItemKeys'
      | 'deleteItemsForNamespaceGeneration'
      | 'hasProjectRemovalRequest'
    >>;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  forceProjectFallback?: boolean;
  pool?: ProjectVectorStorePool;
  maxOpen?: number;
  idleTtlMs?: number;
}

export interface LocalVectorNamespaceStatus {
  namespace: string;
  purpose: SemanticPurpose;
  dbPath: string;
  size_bytes: number;
  active: LocalVectorRoute | null;
  building: LocalVectorRoute | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
  updated_at: string | null;
}

export function semanticVectorTableName(purpose: SemanticPurpose, generationId: number): string {
  if (!Number.isSafeInteger(generationId) || generationId < 1) {
    throw new Error(`Invalid semantic generation id: ${generationId}`);
  }
  return `${purpose}_g_${generationId}`;
}

export function globalSemanticVectorPaths(dataDir = mcpDataDir()): {
  dir: string;
  docs: string;
  userMemory: string;
} {
  const dir = join(dataDir, 'semantic');
  return {
    dir,
    docs: join(dir, 'docs-vectors.db'),
    userMemory: join(dir, 'memory-vectors.db'),
  };
}

function parseId(value: string, namespace: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid semantic namespace: ${namespace}`);
  return id;
}

function fileSize(path: string): number {
  try { return existsSync(path) ? statSync(path).size : 0; } catch { return 0; }
}

function physicalDbKey(dbPath: string): string {
  const absolute = resolvePath(dbPath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function canonicalTarget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTarget);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, canonicalTarget(entry)]),
  );
}

export function embeddingTargetsEqual(left: EmbeddingTarget, right: EmbeddingTarget): boolean {
  // SemanticStore hydrates legacy ONNX rows with the managed q8 default. A
  // batch pinned before that hydration may still carry an omitted dtype; both
  // values identify the same immutable space and must compare canonically.
  const withDefaults = (target: EmbeddingTarget): EmbeddingTarget =>
    target.kind === 'onnx' && target.dtype === undefined
      ? { ...target, dtype: 'q8' }
      : target;
  return JSON.stringify(canonicalTarget(withDefaults(left)))
    === JSON.stringify(canonicalTarget(withDefaults(right)));
}

export class SemanticEmbeddingTargetMismatchError extends Error {
  readonly code = 'SEMANTIC_EMBEDDING_TARGET_MISMATCH';

  constructor(namespace: string, generationId: number, detail: string) {
    super(`Refusing semantic upsert for ${namespace} g${generationId}: ${detail}`);
    this.name = 'SemanticEmbeddingTargetMismatchError';
  }
}

export class ProjectSemanticRemovalPendingError extends Error {
  readonly code = 'PROJECT_SEMANTIC_REMOVAL_PENDING';

  constructor(projectId: number) {
    super(`Project ${projectId} semantic removal is pending; vector access is fenced`);
    this.name = 'ProjectSemanticRemovalPendingError';
  }
}

export class LocalVectorRouter {
  readonly pool: ProjectVectorStorePool;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: LocalVectorRouterOptions) {
    this.dataDir = options.dataDir ?? mcpDataDir(options.env);
    this.env = options.env ?? process.env;
    this.pool = options.pool ?? new ProjectVectorStorePool({
      maxOpen: options.maxOpen ?? 8,
      idleTtlMs: options.idleTtlMs ?? 60_000,
    });
  }

  resolve(namespace: string, generationId: number): LocalVectorRoute {
    const table = (purpose: SemanticPurpose): string => semanticVectorTableName(purpose, generationId);
    let match = /^code:p(\d+)$/.exec(namespace);
    if (match) return this.projectRoute(namespace, parseId(match[1], namespace), generationId, 'code', 'code', table('code'));
    match = /^snapshot:p(\d+)$/.exec(namespace);
    if (match) return this.projectRoute(namespace, parseId(match[1], namespace), generationId, 'memory', 'snapshot', table('memory'));
    match = /^memory:project:p(\d+)$/.exec(namespace);
    if (match) return this.projectRoute(namespace, parseId(match[1], namespace), generationId, 'memory', 'project_memory', table('memory'));
    match = /^docs:c(\d+)$/.exec(namespace);
    if (match) {
      const collectionId = parseId(match[1], namespace);
      return {
        namespace: namespace as LocalSemanticNamespace,
        purpose: 'docs', scope: 'docs', projectId: null, collectionId,
        generationId, dbPath: globalSemanticVectorPaths(this.dataDir).docs, tableName: table('docs'),
      };
    }
    if (namespace === 'memory:user') {
      return {
        namespace, purpose: 'memory', scope: 'user_memory', projectId: null, collectionId: null,
        generationId, dbPath: globalSemanticVectorPaths(this.dataDir).userMemory, tableName: table('memory'),
      };
    }
    throw new Error(`Unsupported semantic namespace: ${namespace}`);
  }

  store(namespace: string, generationId: number): SqliteVecVectorStore {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.get(route.dbPath, route.tableName);
  }

  /** Resolve the immutable generation currently serving search traffic. */
  resolveForRead(namespace: string): LocalVectorRoute | null {
    const state = this.namespaceState(namespace);
    if (!state?.active_generation_id) return null;
    const route = this.resolve(namespace, state.active_generation_id);
    return this.projectAccessBlocked(route) ? null : route;
  }

  /** Writes build the replacement generation; without one, update the active generation. */
  resolveForWrite(namespace: string): LocalVectorRoute | null {
    const state = this.namespaceState(namespace);
    const generationId = state?.building_generation_id ?? state?.active_generation_id;
    if (!generationId) return null;
    const route = this.resolve(namespace, generationId);
    return this.projectAccessBlocked(route) ? null : route;
  }

  getNamespaceStatus(namespace: string): LocalVectorNamespaceStatus {
    const state = this.namespaceState(namespace);
    // Generation 1 is used only to parse the namespace and resolve its physical path.
    const base = this.resolve(namespace, state?.active_generation_id ?? state?.building_generation_id ?? 1);
    return {
      namespace,
      purpose: state?.purpose ?? base.purpose,
      dbPath: base.dbPath,
      size_bytes: ['', '-wal', '-shm'].reduce((total, suffix) => total + fileSize(base.dbPath + suffix), 0),
      active: state?.active_generation_id ? this.resolve(namespace, state.active_generation_id) : null,
      building: state?.building_generation_id ? this.resolve(namespace, state.building_generation_id) : null,
      expected_items: state?.expected_items ?? 0,
      indexed_items: state?.indexed_items ?? 0,
      failed_items: state?.failed_items ?? 0,
      delta_items: state?.delta_items ?? 0,
      last_error: state?.last_error ?? null,
      updated_at: state?.updated_at ?? null,
    };
  }

  /** Compatibility facade for existing search/index code that passes namespaces. */
  asVectorStore(): VectorStore { return new LocalSemanticVectorStore(this); }

  upsert(
    namespace: string,
    generationId: number,
    records: VectorRecord[],
    writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.write(route.dbPath, route.tableName, async (store) => {
      this.assertProjectAccessAllowed(route);
      // Re-check only after this physical file's write queue grants the turn.
      // A profile may have changed while an earlier write was in flight.
      if (writeTarget) this.assertPinnedWriteTarget(route, writeTarget);
      else this.assertCurrentWriteTarget(route);
      try {
        const accepted = await store.upsert(records, namespace);
        if (accepted > 0) {
          for (const record of records.slice(0, accepted)) {
            this.options.semanticStore?.upsertItem?.({
              generation_id: generationId,
              namespace,
              item_key: `${record.metadata.type ?? 'vector'}:${record.metadata.ref_id ?? record.metadata.chunk_id ?? record.id}`,
              source_hash: record.metadata.embedding_hash ?? record.id,
              vector_id: record.id,
              chunk_index: Number(record.metadata.chunk_index ?? 0) || 0,
              status: 'indexed',
              attempts: 1,
              error: null,
            });
          }
        }
        return accepted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const record of records) {
          this.options.semanticStore?.upsertItem?.({
            generation_id: generationId,
            namespace,
            item_key: `${record.metadata.type ?? 'vector'}:${record.metadata.ref_id ?? record.metadata.chunk_id ?? record.id}`,
            source_hash: record.metadata.embedding_hash ?? record.id,
            vector_id: null,
            chunk_index: Number(record.metadata.chunk_index ?? 0) || 0,
            status: 'failed',
            attempts: 1,
            error: message,
          });
        }
        throw error;
      }
    });
  }

  /** Last-line defense against vectors produced by a newly-saved profile being
   * written into an older active/building table with the same dimension. The
   * worker owns the real SemanticStore, so production writes always pass here. */
  private assertCurrentWriteTarget(route: LocalVectorRoute): void {
    const semantic = this.options.semanticStore;
    if (!semantic?.getGeneration || !semantic.getProfile) return;
    const generation = semantic.getGeneration(route.generationId);
    if (!generation) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation metadata is missing',
      );
    }
    if (generation.purpose !== route.purpose) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `generation purpose ${generation.purpose} does not match ${route.purpose}`,
      );
    }
    const profile = semantic.getProfile(route.purpose);
    if (!profile) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `semantic profile ${route.purpose} is missing`,
      );
    }
    if (profile.embedding_target.kind === 'disabled') {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `semantic profile ${route.purpose} is disabled`,
      );
    }
    if (!embeddingTargetsEqual(generation.embedding_target, profile.embedding_target)) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation embedding target differs from the current semantic profile',
      );
    }
  }

  private assertPinnedWriteTarget(route: LocalVectorRoute, target: VectorWriteTarget): void {
    if (target.generationId !== route.generationId) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `batch pins generation ${target.generationId}`,
      );
    }
    const semantic = this.options.semanticStore;
    if (!semantic?.getGeneration) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation metadata cannot be validated',
      );
    }
    const generation = semantic.getGeneration(route.generationId);
    if (!generation || generation.purpose !== route.purpose) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation metadata is missing or belongs to another purpose',
      );
    }
    const state = this.namespaceState(route.namespace);
    if (!state || (state.active_generation_id !== route.generationId
      && state.building_generation_id !== route.generationId)) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation is no longer referenced by the namespace',
      );
    }
    if (generation.status === 'failed' || generation.status === 'retired') {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `generation status is ${generation.status}`,
      );
    }
    if (generation.fingerprint !== target.generationFingerprint) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'batch generation fingerprint differs from persisted metadata',
      );
    }
    if (!embeddingTargetsEqual(generation.embedding_target, target.embeddingTarget)) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'batch embedding target differs from persisted generation target',
      );
    }
    if (!generationMatchesEmbeddingFingerprint(
      target.generationFingerprint,
      target.embeddingFingerprint,
    )) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'batch embedding fingerprint does not identify the generation space',
      );
    }
  }

  search(
    namespace: string,
    generationId: number,
    queryVector: number[],
    options: { topK?: number; filter?: Record<string, string> } = {},
  ): Promise<VectorMatch[]> {
    const route = this.resolve(namespace, generationId);
    // A queued CLI removal preserves relational FTS while deliberately making
    // the derivable vector database non-serving. Most importantly this check
    // happens before pool.read(), so a deleted vectors.db cannot be recreated
    // by a late search from another process.
    if (this.projectAccessBlocked(route)) return Promise.resolve([]);
    return this.pool.read(route.dbPath, route.tableName,
      (store) => store.search(queryVector, { ...options, namespace }));
  }

  deleteByIds(
    namespace: string,
    generationId: number,
    ids: string[],
    writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.write(route.dbPath, route.tableName, async (store) => {
      this.assertProjectAccessAllowed(route);
      if (writeTarget) this.assertPinnedWriteTarget(route, writeTarget);
      const deleted = await store.deleteByIds(ids, namespace);
      this.options.semanticStore?.deleteItemsByVectorIds?.(generationId, namespace, ids);
      return deleted;
    });
  }

  listItems(
    namespace: string,
    generationId: number,
    itemKeys?: string[],
    writeTarget?: VectorWriteTarget,
  ): VectorItemState[] {
    if (writeTarget) this.assertPinnedWriteTarget(this.resolve(namespace, generationId), writeTarget);
    const rows = this.options.semanticStore?.listItems?.({
      generation_id: generationId,
      namespace,
      ...(itemKeys ? { item_keys: itemKeys } : {}),
    }) ?? [];
    return rows.map((row) => ({
      itemKey: row.item_key,
      sourceHash: row.source_hash,
      vectorId: row.vector_id,
      chunkIndex: row.chunk_index,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
    }));
  }

  deleteByItemKeys(
    namespace: string,
    generationId: number,
    itemKeys: string[],
  ): Promise<number> {
    if (itemKeys.length === 0) return Promise.resolve(0);
    const uniqueKeys = [...new Set(itemKeys)];
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.write(route.dbPath, route.tableName, async (store) => {
      this.assertProjectAccessAllowed(route);
      const rows = this.options.semanticStore?.listItems?.({
        generation_id: generationId,
        namespace,
        item_keys: uniqueKeys,
      }) ?? [];
      const ids = [...new Set(rows.flatMap((row) => row.vector_id ? [row.vector_id] : []))];
      const deleted = ids.length > 0 ? await store.deleteByIds(ids, namespace) : 0;
      this.options.semanticStore?.deleteItemsByItemKeys?.(generationId, namespace, uniqueKeys);
      return deleted;
    });
  }

  deleteNamespace(namespace: string, generationId: number): Promise<number> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.write(route.dbPath, route.tableName, async (store) => {
      this.assertProjectAccessAllowed(route);
      const deleted = await store.deleteNamespace(namespace);
      this.options.semanticStore?.deleteItemsForNamespaceGeneration?.(generationId, namespace);
      return deleted;
    });
  }

  /**
   * Remove a logical namespace from both the active and in-construction
   * generations, then retire its control-plane state. A generation table is
   * dropped only when no other namespace references it.
   */
  async removeNamespace(namespace: string): Promise<number> {
    const state = this.namespaceState(namespace);
    if (!state) return 0;
    const generationIds = [...new Set([
      state.active_generation_id,
      state.building_generation_id,
    ].filter((id): id is number => id != null))];
    let deleted = 0;
    for (const generationId of generationIds) {
      deleted += await this.deleteNamespace(namespace, generationId);
    }

    const allStates = this.options.semanticStore?.listNamespaceGenerations() ?? [];
    for (const generationId of generationIds) {
      const route = this.resolve(namespace, generationId);
      const referencedElsewhere = allStates.some((row) => {
        if (row.namespace === namespace) return false;
        return [row.active_generation_id, row.building_generation_id]
          .filter((id): id is number => id != null)
          .some((referencedGenerationId) => {
            try {
              const referencedRoute = this.resolve(row.namespace, referencedGenerationId);
              return physicalDbKey(referencedRoute.dbPath) === physicalDbKey(route.dbPath)
                && referencedRoute.tableName === route.tableName;
            } catch {
              // A stale control-plane row that no longer resolves cannot keep
              // an unrelated physical table alive indefinitely.
              return false;
            }
          });
      });
      if (!referencedElsewhere) await this.dropGeneration(namespace, generationId);
    }
    this.options.semanticStore?.deleteNamespace?.(namespace);
    return deleted;
  }

  generationIdsForNamespace(namespace: string): number[] {
    const state = this.namespaceState(namespace);
    return [...new Set([
      state?.active_generation_id,
      state?.building_generation_id,
    ].filter((id): id is number => id != null))];
  }

  dropGeneration(namespace: string, generationId: number): Promise<void> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.write(route.dbPath, route.tableName, (store) => store.dropTable());
  }

  /** Migration 238 leaves old Knowledge tables intentionally unreferenced.
   * The worker-owned pool removes them only through an explicit admin sweep. */
  dropLegacyKnowledgeTables(namespace: string): Promise<number> {
    const route = this.resolve(namespace, 1);
    this.assertProjectAccessAllowed(route);
    return this.pool.dropVirtualTablesWithPrefix(route.dbPath, 'knowledge_g_');
  }

  hasGeneration(namespace: string, generationId: number): Promise<boolean> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.read(route.dbPath, route.tableName, (store) => store.hasTable());
  }

  async compactGenerationDatabase(
    namespace: string,
    generationId: number,
  ): Promise<{ before_bytes: number; after_bytes: number }> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    const size = () => ['', '-wal', '-shm']
      .reduce((total, suffix) => total + fileSize(route.dbPath + suffix), 0);
    const before = size();
    await this.pool.compact(route.dbPath);
    return { before_bytes: before, after_bytes: size() };
  }

  /** Physical proof used by the activation gate. Unlike listItems(), this
   * reads the sqlite-vec table itself and therefore detects ledger/vector
   * divergence after a crash or a partial write. */
  listIds(namespace: string, generationId: number): Promise<string[]> {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.read(route.dbPath, route.tableName, (store) => store.listIds(namespace));
  }

  /** Fan out without ATTACH; at most four DB reads execute concurrently. */
  async searchMany(
    targets: Array<{ namespace: string; generationId: number }>,
    queryVector: number[],
    options: { topK?: number; filter?: Record<string, string>; concurrency?: number } = {},
  ): Promise<VectorMatch[]> {
    const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 4)));
    const results: VectorMatch[][] = new Array(targets.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const index = cursor++;
        const target = targets[index];
        results[index] = await this.search(target.namespace, target.generationId, queryVector, options);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    const merged = results.flat().sort((a, b) => b.score - a.score);
    if (options.topK == null || !Number.isFinite(options.topK)) return merged;
    return merged.slice(0, Math.max(0, Math.floor(options.topK)));
  }

  evictProject(projectId: number): boolean {
    const dbPath = this.projectVectorsPath(projectId);
    return this.pool.evict(dbPath);
  }

  /** Release and remove only this project's derivable vector DB. */
  async removeProject(projectId: number): Promise<void> {
    const dbPath = this.projectVectorsPath(projectId);
    if (!await this.pool.drainAndEvict(dbPath) && this.pool.has(dbPath)) {
      throw new Error(`Cannot remove project ${projectId} vectors while writes are pending`);
    }
    // Close the logical write target before unlinking the file. After the
    // drain resolves this continuation is synchronous, so no worker request
    // can resolve a fresh generation in the gap and recreate vectors.db.
    for (const namespace of [
      `code:p${projectId}`,
      `snapshot:p${projectId}`,
      `memory:project:p${projectId}`,
    ]) {
      this.options.semanticStore?.deleteNamespace?.(namespace);
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }

  close(): void { this.pool.closeAll(); }
  drainAndClose(): Promise<void> { return this.pool.drainAndCloseAll(); }

  private projectRoute(
    namespace: string,
    projectId: number,
    generationId: number,
    purpose: SemanticPurpose,
    scope: LocalVectorRoute['scope'],
    tableName: string,
  ): LocalVectorRoute {
    return {
      namespace: namespace as LocalSemanticNamespace,
      purpose, scope, projectId, collectionId: null, generationId,
      dbPath: this.projectVectorsPath(projectId), tableName,
    };
  }

  private projectVectorsPath(projectId: number): string {
    const project = this.options.resolveProject(projectId);
    if (!project) throw new Error(`Unknown project id: ${projectId}`);
    const persistedDbPath = project.dbPath ?? project.db_path;
    if (persistedDbPath) return join(dirname(persistedDbPath), 'vectors.db');
    const rootPath = project.rootPath ?? project.root_path;
    return resolveProjectDbLocation(projectId, rootPath, {
      env: this.env,
      forceFallback: this.options.forceProjectFallback,
    }).vectorsPath;
  }

  private namespaceState(namespace: string): SemanticNamespaceGenerationRow | null {
    if (!this.options.semanticStore) return null;
    return this.options.semanticStore.listNamespaceGenerations({ namespace })[0] ?? null;
  }

  private projectAccessBlocked(route: LocalVectorRoute): boolean {
    return route.projectId !== null
      && this.options.semanticStore?.hasProjectRemovalRequest?.(route.projectId) === true;
  }

  private assertProjectAccessAllowed(route: LocalVectorRoute): void {
    if (this.projectAccessBlocked(route)) {
      throw new ProjectSemanticRemovalPendingError(route.projectId!);
    }
  }
}

/** VectorStore adapter: reads active, writes/deletes building-or-active. */
export class LocalSemanticVectorStore implements VectorStore {
  constructor(readonly router: LocalVectorRouter) {}

  async upsert(
    records: VectorRecord[],
    namespace?: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    if (!namespace) throw new Error('Semantic vector upsert requires a namespace');
    const route = writeTarget
      ? this.router.resolve(namespace, writeTarget.generationId)
      : this.router.resolveForWrite(namespace);
    if (!route) throw new Error(`No active or building generation for ${namespace}`);
    return this.router.upsert(namespace, route.generationId, records, writeTarget);
  }

  async search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    if (!options?.namespace) return [];
    if (options.generationId != null) {
      return this.router.search(
        options.namespace,
        options.generationId,
        queryVector,
        options,
      );
    }
    const route = this.router.resolveForRead(options.namespace);
    if (!route) return [];
    return this.router.search(options.namespace, route.generationId, queryVector, options);
  }

  async deleteByIds(
    ids: string[],
    namespace?: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    if (!namespace) throw new Error('Semantic vector delete requires a namespace');
    if (writeTarget) {
      return this.router.deleteByIds(namespace, writeTarget.generationId, ids, writeTarget);
    }
    let deleted = 0;
    for (const generationId of this.router.generationIdsForNamespace(namespace)) {
      deleted += await this.router.deleteByIds(namespace, generationId, ids);
    }
    return deleted;
  }

  async listItems(
    namespace: string,
    itemKeys?: string[],
    writeTarget?: VectorWriteTarget,
  ): Promise<VectorItemState[]> {
    const route = writeTarget
      ? this.router.resolve(namespace, writeTarget.generationId)
      : this.router.resolveForWrite(namespace);
    if (!route) return [];
    return this.router.listItems(namespace, route.generationId, itemKeys, writeTarget);
  }

  async deleteByItemKeys(itemKeys: string[], namespace: string): Promise<number> {
    let deleted = 0;
    for (const generationId of this.router.generationIdsForNamespace(namespace)) {
      deleted += await this.router.deleteByItemKeys(namespace, generationId, itemKeys);
    }
    return deleted;
  }

  async deleteNamespace(namespace: string): Promise<number> {
    return this.router.removeNamespace(namespace);
  }

  async isAvailable(): Promise<boolean> { return true; }
}
