import { MemoryMutationCoordinator, type AgentMemoryMutationExecution } from './memory-mutation-coordinator.js';
export type { AgentMemoryMutationExecution } from './memory-mutation-coordinator.js';
import { MAX_MEMORY_CHUNKS, RRF_K, memoryVecId, agentMemoryEmbeddingTextHash, agentMemoryEmbeddingTexts, dedupeAgentMemoryHits } from './agent-memory-ranking.js';
import type { AgentMemoryHit } from './agent-memory-ranking.js';
export type { AgentMemoryHit } from './agent-memory-ranking.js';
export { agentMemoryEmbeddingTextHash, agentMemoryEmbeddingTexts, dedupeAgentMemoryHits } from './agent-memory-ranking.js';

import type { CodeIndexDB } from '@mcp/store/db.js';
import { boundAgentMemoryQuery } from '@mcp/store/db/fts-query.js';
import { abortableRead } from '@mcp/shared/utils/abortable.js';
import type { AgentMemoryRow, AgentMemoryScope, AgentMemoryType, VectorRecord } from '@mcp/shared/types.js';
import { embedDocumentsForNamespace, embedQueryForNamespace, type EmbeddingService, type NamespaceDocumentEmbedding } from '@mcp/indexer/search/embeddings.js';
import type { VectorItemState, VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';
import type { RerankerService } from '@mcp/indexer/search/reranker-types.js';

import { projectMemoryNamespace, userMemoryNamespace } from '@mcp/shared/vector-namespace.js';
import type { SemanticMutation, SemanticMutationSink } from '../semantic-mutation-sink.js';

type MemoryFtsSearch = (
  scope: AgentMemoryScope, projectId: number, query: string, limit: number, signal?: AbortSignal,
) => Promise<AgentMemoryRow[]>;

export class AgentMemoryService {
  private readonly mutations: MemoryMutationCoordinator;
  private projectNameCache = new Map<number, string>();

  constructor(
    private readonly db: CodeIndexDB,
    private readonly embeddingService: EmbeddingService | null = null,
    private readonly vectorStore: VectorStore | null = null,
    private readonly queryEmbeddingService: EmbeddingService | null = embeddingService,
    private readonly semanticMutationSink: SemanticMutationSink | null = null,
    private readonly reranker: RerankerService | null = null,
    mutationExecution: AgentMemoryMutationExecution = {
      execute: <T>(operation: () => T): T => operation(),
    },
    private readonly searchFts?: MemoryFtsSearch,
  ) {
    this.mutations = new MemoryMutationCoordinator(db, semanticMutationSink, mutationExecution);
  }

  private commitRelationalMutation<T>(inputs: readonly SemanticMutation[], mutation: () => T): T {
    return this.mutations.commitRelationalMutation(inputs, mutation);
  }

  runMutationBatch<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutations.runMutationBatch(operation);
  }

  get hasDurableMutationQueue(): boolean {
    return this.mutations.hasDurableMutationQueue;
  }

  runRelationalWrite<T>(operation: () => T): Promise<T> {
    return this.mutations.runRelationalWrite(operation);
  }

  private noteMutation(
    scope: AgentMemoryScope,
    projectId: number,
    itemKeys: readonly string[],
    operation: 'upsert' | 'delete',
  ): void {
    this.semanticMutationSink?.noteMutation({
      namespace: this.namespace(scope, projectId),
      itemKeys,
      operation,
    });
  }

  /** Notify a bulk relational hygiene pass (duplicate consolidation/decay).
   * The coordinator performs a full idempotent reconciliation for the scope. */
  noteScopeMutation(scope: AgentMemoryScope, projectId: number): void {
    this.noteMutation(scope, projectId, ['*'], 'delete');
  }

  /** Execute a bulk relational hygiene pass behind the same pre-write fence
   * used by single-row mutations. The wildcard is intentional: consolidation
   * can archive an arbitrary set chosen inside the SQLite transaction. */
  runScopeMutation<T>(
    scope: AgentMemoryScope,
    projectId: number,
    mutation: () => T,
  ): T {
    const existingKeys = this.db
      .listAgentMemoryForSemanticIndex(scope, projectId)
      .map((row) => `agent_memory:${row.id}`);
    return this.commitRelationalMutation([{
      namespace: this.namespace(scope, projectId),
      // The hygiene source set is known before SQLite changes. The store
      // shrinks this delete fence to rows that actually became archived. Keep
      // an identity watermark too, covering a concurrent cross-process INSERT
      // that becomes visible before the hygiene transaction reads its source.
      itemKeys: [...existingKeys, '*'],
      operation: 'delete',
    }], mutation);
  }

  /**
   * Async main-process variant of runScopeMutation. The complete fence/source
   * transaction is retried as one fail-fast unit, so contention never becomes
   * a synchronous busy wait on Electron's UI thread.
   */
  async runScopeMutationAsync<T>(
    scope: AgentMemoryScope,
    projectId: number,
    mutation: () => T,
  ): Promise<T> {
    return this.runRelationalWrite(() => this.runScopeMutation(scope, projectId, mutation));
  }

  /** Relational create plus a synchronous durable semantic delta. */
  create(data: Parameters<CodeIndexDB['createAgentMemory']>[0]): AgentMemoryRow {
    const scope = data.scope ?? 'project';
    const projectId = scope === 'user' ? 0 : (data.projectId ?? 0);
    return this.commitRelationalMutation([{
      namespace: this.namespace(scope, projectId),
      // INSERT chooses the identity; the pre-write barrier must cover the
      // complete scope until the new id is visible.
      itemKeys: ['*'],
      operation: 'upsert',
    }], () => this.db.createAgentMemory(data));
  }

  /** Logical-immutable replace (archive old + create fresh) with one durable
   * mutation covering both affected item identities. */
  replace(
    oldId: number,
    data: Parameters<CodeIndexDB['replaceAgentMemory']>[1],
  ): AgentMemoryRow {
    const old = this.db.getAgentMemoryById(oldId);
    const targetScope = data.scope ?? 'project';
    const targetProjectId = targetScope === 'user' ? 0 : (data.projectId ?? 0);
    const targetNamespace = this.namespace(targetScope, targetProjectId);
    const inputs: SemanticMutation[] = [{
      namespace: targetNamespace,
      itemKeys: ['*'],
      operation: 'upsert',
    }];
    if (old) {
      const oldNamespace = this.namespace(old.scope, old.project_id);
      inputs.unshift({
        namespace: oldNamespace,
        itemKeys: [`agent_memory:${old.id}`],
        operation: 'delete',
      });
    }
    return this.commitRelationalMutation(
      inputs,
      () => this.db.replaceAgentMemory(oldId, data),
    );
  }

  /** Archive a live memory and synchronously make its vector deletion durable. */
  archive(id: number, reason = 'forgotten'): AgentMemoryRow | null {
    const row = this.db.getAgentMemoryById(id);
    if (!row || row.archived_at) return row ?? null;
    this.commitRelationalMutation([{
      namespace: this.namespace(row.scope, row.project_id),
      itemKeys: [`agent_memory:${row.id}`],
      operation: 'delete',
    }], () => this.db.archiveAgentMemory(id, reason));
    return row;
  }

  /** Restore an archived row and synchronously queue its semantic catch-up. */
  restore(id: number): AgentMemoryRow | null {
    const before = this.db.getAgentMemoryById(id);
    if (!before) return null;
    const restored = this.commitRelationalMutation([{
      namespace: this.namespace(before.scope, before.project_id),
      itemKeys: [`agent_memory:${before.id}`],
      operation: 'upsert',
    }], () => this.db.restoreAgentMemory(id));
    if (!restored) return null;
    const row = this.db.getAgentMemoryById(id) ?? before;
    return row;
  }

  hasEmbeddingBackend(): boolean {
    return this.embeddingService !== null && this.vectorStore !== null;
  }

  private fingerprint(): string {
    return this.embeddingService?.fingerprint?.() ?? 'no-embed';
  }

  private namespace(scope: AgentMemoryScope, projectId: number): string {
    return scope === 'user' ? userMemoryNamespace() : projectMemoryNamespace(projectId);
  }

  private resolveProjectName(projectId: number): string {
    if (projectId === 0) return '__user__';
    if (this.projectNameCache.has(projectId)) return this.projectNameCache.get(projectId)!;
    const project = this.db.getProject(projectId);
    const name = project?.name ?? `project:${projectId}`;
    this.projectNameCache.set(projectId, name);
    return name;
  }

  private async isCurrent(
    namespace: string,
    itemKey: string,
    hash: string,
    expectedChunks: number,
    writeTarget?: VectorWriteTarget,
  ): Promise<boolean> {
    const rows: VectorItemState[] = await (writeTarget
      ? this.vectorStore?.listItems?.(namespace, [itemKey], writeTarget)
      : this.vectorStore?.listItems?.(namespace, [itemKey])) ?? [];
    if (rows.length !== expectedChunks) return false;
    const chunks = new Set<number>();
    for (const row of rows) {
      if (row.itemKey !== itemKey || row.status !== 'indexed' || !row.vectorId || row.sourceHash !== hash) {
        return false;
      }
      chunks.add(row.chunkIndex);
    }
    return Array.from({ length: expectedChunks }, (_, index) => index).every((index) => chunks.has(index));
  }

  /**
   * Embed a memory row and upsert its chunk vectors. Idempotent: skips when the
   * embedding text (incl. model fingerprint) hasn't changed. Best-effort —
   * returns an outcome instead of throwing so a SQLite write is never lost.
   */
  async embedAndUpsert(
    row: AgentMemoryRow,
    prepared?: NamespaceDocumentEmbedding,
  ): Promise<{ ok: boolean; error?: string; skipped?: 'no-backend' | 'unchanged' }> {
    if (!this.embeddingService || !this.vectorStore) return { ok: true, skipped: 'no-backend' };
    const initialHash = agentMemoryEmbeddingTextHash(row, this.fingerprint());
    try {
      const projectName = this.resolveProjectName(row.project_id);
      const chunkTexts = agentMemoryEmbeddingTexts(row);
      const namespace = this.namespace(row.scope, row.project_id);
      if (await this.isCurrent(namespace, `agent_memory:${row.id}`, initialHash, chunkTexts.length)) {
        return { ok: true, skipped: 'unchanged' };
      }
      const embedded = prepared ?? await embedDocumentsForNamespace(this.embeddingService, namespace, chunkTexts);
      const { vectors, writeTarget } = embedded;
      if (vectors.length !== chunkTexts.length || vectors.some(vector => !vector.length || vector.some(value => !Number.isFinite(value)))) {
        return { ok: false, error: 'embedding service returned no vectors' };
      }
      const newHash = agentMemoryEmbeddingTextHash(
        row,
        writeTarget?.embeddingFingerprint ?? this.fingerprint(),
      );
      if (newHash !== initialHash
        && await this.isCurrent(namespace, `agent_memory:${row.id}`, newHash, chunkTexts.length, writeTarget)) {
        return { ok: true, skipped: 'unchanged' };
      }
      const records: VectorRecord[] = vectors.map((values, i) => ({
        id: memoryVecId(row.id, i),
        values,
        metadata: {
          project_name: projectName,
          type: 'agent_memory',
          ref_id: String(row.id),
          scope: row.scope,
          chunk_index: String(i),
          embedding_hash: newHash,
        },
      }));
      const accepted = await (writeTarget
        ? this.vectorStore.upsert(records, namespace, writeTarget)
        : this.vectorStore.upsert(records, namespace));
      if (accepted !== records.length) {
        throw new Error(`vector store accepted ${accepted}/${records.length} memory record(s)`);
      }

      // Drop leftover chunks from a previously-longer memory. Failure keeps
      // the item pending so generation coverage cannot bless stale text.
      const itemKey = `agent_memory:${row.id}`;
      const ledgerRows = await (writeTarget
        ? this.vectorStore.listItems?.(namespace, [itemKey], writeTarget)
        : this.vectorStore.listItems?.(namespace, [itemKey])) ?? [];
      const staleIds = ledgerRows.flatMap((item) =>
        item.vectorId && (item.sourceHash !== newHash || item.chunkIndex >= records.length)
          ? [item.vectorId]
          : []);
      if (staleIds.length > 0) {
        if (writeTarget) await this.vectorStore.deleteByIds(staleIds, namespace, writeTarget);
        else await this.vectorStore.deleteByIds(staleIds, namespace);
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[agent-memory-embed] upsert failed:', msg);
      return { ok: false, error: msg };
    }
  }

  /** Remove a memory's chunk vectors (archive / forget / supersede). */
  async removeVectors(memoryId: number, projectId: number): Promise<void> {
    if (this.vectorStore) {
      const row = this.db.getAgentMemoryById(memoryId);
      const namespace = this.namespace(row?.scope ?? (projectId === 0 ? 'user' : 'project'), projectId);
      try {
        if (this.vectorStore.deleteByItemKeys) {
          await this.vectorStore.deleteByItemKeys([`agent_memory:${memoryId}`], namespace);
        } else {
          const ids: string[] = [];
          for (let i = 0; i < MAX_MEMORY_CHUNKS; i++) ids.push(memoryVecId(memoryId, i));
          await this.vectorStore.deleteByIds(ids, namespace);
        }
      } catch (err) {
        console.error('[agent-memory-embed] delete failed:', (err as Error).message);
      }
    }
  }

  /**
   * Hybrid search within one scope/project. FTS first (always), vector side when
   * an embedding backend is configured, merged with reciprocal-rank fusion. The
   * FTS-only branch is the graceful fallback for no-embed installs.
   */
  async search(
    scope: AgentMemoryScope,
    projectId: number,
    query: string,
    limit: number,
    type?: AgentMemoryType,
    signal?: AbortSignal,
    options: { deduplicate?: boolean; rerank?: boolean } = {},
  ): Promise<AgentMemoryHit[]> {
    signal?.throwIfAborted();
    const q = boundAgentMemoryQuery(query);
    if (!q) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Memory search limit must be 1..128');
    const ftsLimit = Math.max(limit * 3, 15);
    let ftsRows: AgentMemoryRow[] = [];
    try {
      ftsRows = this.searchFts
        ? await this.searchFts(scope, projectId, q, ftsLimit, signal)
        : this.db.searchAgentMemoryFts(scope, projectId, q, ftsLimit);
    } catch (error) {
      signal?.throwIfAborted();
      console.warn('[agent-memory-search] FTS unavailable:', error instanceof Error ? error.message : String(error));
    }
    signal?.throwIfAborted();
    const ftsFiltered = type ? ftsRows.filter((r) => r.type === type) : ftsRows;

    let vectorRows: AgentMemoryRow[] = [];
    if (this.queryEmbeddingService && this.vectorStore) {
      try {
        const namespace = this.namespace(scope, projectId);
        const { vector, generationId } = await abortableRead(() =>
          embedQueryForNamespace(this.queryEmbeddingService!, namespace, q, signal ? { signal } : undefined), signal);
        if (vector.length > 0) {
          const matches = await abortableRead(() => this.vectorStore!.search(vector, {
            topK: limit * 4,
            filter: { type: 'agent_memory', scope },
            namespace,
            generationId,
          }), signal);
          signal?.throwIfAborted();
          // Collect the distinct ref_ids IN MATCH ORDER first, then hydrate them
          // in one batch. The old shape ran one synchronous point query per
          // match — up to 60 per turn (retrieve) and 144 per recall_memory —
          // each blocking the Electron main thread, which shares this handle.
          const seen = new Set<number>();
          const refIds: number[] = [];
          for (const m of matches.slice(0, limit * 4)) {
            const rawId = String(m.metadata.ref_id ?? ''), refId = Number(rawId);
            if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(refId) || seen.has(refId)) continue;
            seen.add(refId);
            refIds.push(refId);
          }
          // The batch returns rows in database order; rank is what feeds the RRF
          // score below, so match order must be re-imposed explicitly here.
          const byId = new Map(this.db.getAgentMemoriesByIds(refIds).map((row) => [row.id, row]));
          for (const refId of refIds) {
            const row = byId.get(refId);
            if (
              row &&
              row.scope === scope &&
              row.project_id === (scope === 'user' ? 0 : projectId) &&
              !row.archived_at &&
              (!type || row.type === type)
            ) {
              vectorRows.push(row);
            }
          }
        }
      } catch (err) {
        signal?.throwIfAborted();
        console.error('[agent-memory-search] vector side failed:', (err as Error).message);
      }
    }

    // RRF merge — rank is position within each list.
    const scoreMap = new Map<number, { row: AgentMemoryRow; score: number }>();
    for (let rank = 0; rank < ftsFiltered.length; rank++) {
      const r = ftsFiltered[rank]!;
      scoreMap.set(r.id, { row: r, score: 1 / (RRF_K + rank + 1) });
    }
    for (let rank = 0; rank < vectorRows.length; rank++) {
      const r = vectorRows[rank]!;
      const existing = scoreMap.get(r.id);
      const delta = 1 / (RRF_K + rank + 1);
      if (existing) existing.score += delta;
      else scoreMap.set(r.id, { row: r, score: delta });
    }

    const ranked = vectorRows.length === 0 ? ftsFiltered.map(row => ({ ...row, score: 0 }))
      : Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .map(({ row, score }) => ({ ...row, score }));
    const fused = options.deduplicate === false ? ranked : dedupeAgentMemoryHits(ranked);
    if (options.rerank !== false && this.reranker && this.reranker.name !== 'null' && fused.length > 0) {
      const depth = Math.min(
        fused.length,
        this.reranker.candidatePoolSize?.(limit) ?? Math.max(limit * 2, 20),
      );
      const candidates = fused.slice(0, depth);
      try {
        const reranked = await abortableRead(() => this.reranker!.rerank(
          q,
          candidates.map((row) => ({
            id: String(row.id),
            text: `${row.name}\n${row.description}\n${row.content}`,
            originalScore: row.score,
          })),
          Math.min(limit, candidates.length),
          signal ? { signal } : undefined,
        ), signal);
        signal?.throwIfAborted();
        const byId = new Map(candidates.map((entry) => [String(entry.id), entry]));
        const seen = new Set<string>();
        if (reranked.length !== Math.min(limit, candidates.length) || reranked.some((row) => {
          if (!byId.has(row.id) || seen.has(row.id) || !Number.isFinite(row.score)) return true;
          seen.add(row.id);
          return false;
        })) throw new Error(`${this.reranker.name} returned an incomplete memory result set`);
        return reranked
          .map((result) => ({ ...byId.get(result.id)!, score: result.score }))
          .sort((a, b) => b.score - a.score);
      } catch (err) {
        signal?.throwIfAborted();
        console.warn(`[agent-memory-search] ${this.reranker.name} rerank unavailable; preserving RRF order: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    }

    return fused.slice(0, limit);
  }

  /** Backfill: embed every memory missing a vector (one pass, best-effort). */
  async backfillEmbeddings(
    projectId?: number,
    limit = 200,
    scope?: 'project' | 'user',
  ): Promise<{ embedded: number; failed: number; skipped: number; total: number; error?: string }> {
    if (!this.hasEmbeddingBackend()) return { embedded: 0, failed: 0, skipped: 0, total: 0 };
    const rows = (() => {
      if (scope === 'user') {
        return this.db.listAgentMemoryForSemanticIndex('user', 0).slice(0, limit);
      }
      if (projectId !== undefined) {
        return [
          ...this.db.listAgentMemoryForSemanticIndex('project', projectId),
          ...this.db.listAgentMemoryForSemanticIndex('local', projectId),
        ].slice(0, limit);
      }
      return [
        ...this.db.listAgentMemoryForSemanticIndex('user', 0),
        ...this.db.listProjects().flatMap((project) => [
          ...this.db.listAgentMemoryForSemanticIndex('project', project.id),
          ...this.db.listAgentMemoryForSemanticIndex('local', project.id),
        ]),
      ].slice(0, limit);
    })();
    let embedded = 0;
    let failed = 0;
    let skipped = 0;
    let error: string | undefined;
    let batch: Array<{ row: AgentMemoryRow; texts: string[] }> = [];
    let namespace = '';
    let chunks = 0;
    const flush = async (): Promise<boolean> => {
      if (!batch.length) return true;
      try {
        // One request serves many memories. The immutable namespace/generation
        // pin is carried into every write, so vectors never cross vector spaces.
        const prepared = await embedDocumentsForNamespace(this.embeddingService!, namespace, batch.flatMap(item => item.texts));
        if (prepared.vectors.length !== chunks) throw new Error('Embedding API returned incomplete memory batch');
        let offset = 0;
        for (const item of batch) {
          const res = await this.embedAndUpsert(item.row, { ...prepared, vectors: prepared.vectors.slice(offset, offset + item.texts.length) });
          offset += item.texts.length;
          if (res.ok && !res.skipped) embedded++;
          else if (res.ok) skipped++;
          else { failed++; error ??= res.error; }
        }
      } catch (cause) {
        failed += batch.length;
        error ??= cause instanceof Error ? cause.message : String(cause);
      }
      batch = []; chunks = 0;
      return !error;
    };
    for (const row of rows) {
      const texts = agentMemoryEmbeddingTexts(row);
      const nextNamespace = this.namespace(row.scope, row.project_id);
      if (await this.isCurrent(nextNamespace, `agent_memory:${row.id}`,
        agentMemoryEmbeddingTextHash(row, this.fingerprint()), texts.length)) { skipped++; continue; }
      if (batch.length && (nextNamespace !== namespace || chunks + texts.length > 32)) {
        if (!await flush()) break;
      }
      namespace = nextNamespace; batch.push({ row, texts }); chunks += texts.length;
    }
    if (!error) await flush();
    return { embedded, failed, skipped, total: rows.length, ...(error ? { error } : {}) };
  }
}
