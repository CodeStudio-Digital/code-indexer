import { LocalVectorRouteResolver } from './local-vector-route-resolver.js';
import { semanticVectorTableName, globalSemanticVectorPaths, fileSize, physicalDbKey, embeddingTargetsEqual, SemanticEmbeddingTargetMismatchError, ProjectSemanticRemovalPendingError } from './local-vector-values.js';
export { semanticVectorTableName, globalSemanticVectorPaths, embeddingTargetsEqual, SemanticEmbeddingTargetMismatchError, ProjectSemanticRemovalPendingError } from './local-vector-values.js';
import type { LocalSemanticNamespace, LocalVectorRoute, LocalVectorRouterOptions, LocalVectorNamespaceStatus } from './local-vector-router-types.js';
export type { LocalSemanticNamespace, LocalVectorProject, LocalVectorRoute, LocalVectorRouterOptions, LocalVectorNamespaceStatus } from './local-vector-router-types.js';
/** ID-based routing from semantic namespaces to distributed sqlite-vec files. */

import { rmSync } from 'node:fs';
import type { VectorMatch, VectorRecord } from '@mcp/shared/types.js';

import type { SqliteVecVectorStore } from './sqlite-vec-store.js';
import { type VectorItemState, type VectorSearchOptions, type VectorStore, type VectorWriteTarget } from './vectors.js';

export class LocalVectorRouter extends LocalVectorRouteResolver {

  store(namespace: string, generationId: number): SqliteVecVectorStore {
    const route = this.resolve(namespace, generationId);
    this.assertProjectAccessAllowed(route);
    return this.pool.get(route.dbPath, route.tableName);
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
