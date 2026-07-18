import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type {
  AgentMemoryRow,
  AgentMemoryScope,
  AgentMemoryType,
  VectorRecord,
} from '@mcp/shared/types.js';
import {
  embedDocumentsForNamespace,
  embedQueryForNamespace,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { VectorItemState, VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';
import type { RerankerService } from '@mcp/indexer/search/reranker-types.js';
import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';
import { projectMemoryNamespace, userMemoryNamespace } from '@mcp/shared/vector-namespace.js';
import type {
  SemanticMutation,
  SemanticMutationFence,
  SemanticMutationSink,
} from '../semantic-mutation-sink.js';

/**
 * Agent Memory service — embed-on-write + hybrid (FTS + vector RRF) search over
 * the dedicated `agent_memory` table, SEPARATE from snapshots.
 *
 * Deliberately NOT built on SnapshotService / HybridSearch (those are coupled
 * to the snapshots/code/docs flows). This is a small adapter that reuses the
 * SAME proven patterns: sliding-window chunking, scope-specific local vector
 * namespaces, reciprocal-rank fusion, and an FTS-only fallback when no
 * embedding backend is configured.
 */

const MEMORY_WINDOW_CHARS = 2000;
const MEMORY_OVERLAP_CHARS = 200;
const MAX_MEMORY_CHUNKS = 4;
const RRF_K = 60;

/** Stable vector id for an agent-memory chunk (shape mirrors `sn_…`). */
function memoryVecId(memoryId: number, chunk = 0): string {
  const seed = chunk === 0 ? `agent_memory:${memoryId}` : `agent_memory:${memoryId}:${chunk}`;
  return 'am_' + createHash('md5').update(seed).digest('hex').slice(0, 24);
}

/**
 * R1 — embedding hash includes the model fingerprint, so switching embedding
 * models invalidates the vector instead of leaving it silently stale.
 */
export function agentMemoryEmbeddingTextHash(
  row: Pick<AgentMemoryRow, 'name' | 'description' | 'content'>,
  fingerprint: string,
): string {
  return createHash('md5')
    .update(`${fingerprint}\n${row.name}\n${row.description}\n${row.content}`)
    .digest('hex');
}

export function agentMemoryEmbeddingTexts(
  row: Pick<AgentMemoryRow, 'name' | 'description' | 'content'>,
): string[] {
  const windows = slidingWindows(`${row.name}\n${row.description}\n${row.content}`, {
    windowChars: MEMORY_WINDOW_CHARS,
    overlapChars: MEMORY_OVERLAP_CHARS,
    maxChunks: MAX_MEMORY_CHUNKS,
  });
  return windows.map((window, index) => index === 0 ? window : `${row.name}\n${window}`);
}

export interface AgentMemoryHit extends AgentMemoryRow {
  /** Blended retrieval score (RRF fusion of FTS + vector ranks). */
  score: number;
}

export class AgentMemoryService {
  private projectNameCache = new Map<number, string>();

  constructor(
    private readonly db: CodeIndexDB,
    private readonly embeddingService: EmbeddingService | null = null,
    private readonly vectorStore: VectorStore | null = null,
    private readonly queryEmbeddingService: EmbeddingService | null = embeddingService,
    private readonly semanticMutationSink: SemanticMutationSink | null = null,
    private readonly reranker: RerankerService | null = null,
  ) {}

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

  private commitRelationalMutation<T>(
    inputs: readonly SemanticMutation[],
    mutation: () => T,
  ): T {
    const canFence = typeof this.semanticMutationSink?.beginMutation === 'function'
      && typeof this.semanticMutationSink?.settleMutation === 'function';
    const fences: SemanticMutationFence[] = [];
    if (canFence) {
      try {
        for (const input of inputs) {
          const fence = this.semanticMutationSink!.beginMutation!(input);
          if (fence) fences.push(fence);
        }
      } catch (error) {
        for (const fence of fences) {
          try { this.semanticMutationSink!.settleMutation!(fence, error); } catch { /* recovery owns it */ }
        }
        throw error;
      }
    }

    let result!: T;
    try {
      result = mutation();
    } catch (error) {
      for (const fence of fences) {
        try { this.semanticMutationSink!.settleMutation!(fence, error); } catch { /* preserve mutation error */ }
      }
      throw error;
    }

    if (canFence) {
      for (const fence of fences) this.semanticMutationSink!.settleMutation!(fence);
    } else {
      for (const input of inputs) this.semanticMutationSink?.noteMutation(input);
    }
    return result;
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
    return this.commitRelationalMutation([{
      namespace: this.namespace(scope, projectId),
      itemKeys: ['*'],
      operation: 'delete',
    }], mutation);
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
      if (oldNamespace !== targetNamespace) {
        inputs.unshift({
          namespace: oldNamespace,
          itemKeys: [`agent_memory:${old.id}`],
          operation: 'delete',
        });
      }
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
      const embedded = await embedDocumentsForNamespace(this.embeddingService, namespace, chunkTexts);
      const { vectors, writeTarget } = embedded;
      if (vectors.length === 0 || vectors[0].length === 0) {
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
  ): Promise<AgentMemoryHit[]> {
    const q = query.trim();
    if (!q) return [];
    const ftsRows = this.db.searchAgentMemoryFts(scope, projectId, q, Math.max(limit * 3, 15));
    const ftsFiltered = type ? ftsRows.filter((r) => r.type === type) : ftsRows;

    let vectorRows: AgentMemoryRow[] = [];
    if (this.queryEmbeddingService && this.vectorStore) {
      try {
        const namespace = this.namespace(scope, projectId);
        const { vector, generationId } = await embedQueryForNamespace(this.queryEmbeddingService, namespace, q);
        if (vector.length > 0) {
          const matches = await this.vectorStore.search(vector, {
            topK: limit * 4,
            filter: { type: 'agent_memory', scope },
            namespace,
            generationId,
          });
          const seen = new Set<number>();
          for (const m of matches) {
            const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
            if (!refId || seen.has(refId)) continue;
            seen.add(refId);
            const row = this.db.getAgentMemoryById(refId);
            if (
              row &&
              row.scope === scope &&
              !row.archived_at &&
              (!type || row.type === type)
            ) {
              vectorRows.push(row);
            }
          }
        }
      } catch (err) {
        console.error('[agent-memory-search] vector side failed:', (err as Error).message);
      }
    }

    if (vectorRows.length === 0) {
      return ftsFiltered.slice(0, limit).map((r) => ({ ...r, score: 0 }));
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

    const fused = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    if (this.reranker && this.reranker.name !== 'null' && fused.length > 0) {
      const depth = Math.min(
        fused.length,
        this.reranker.candidatePoolSize?.(limit) ?? Math.max(limit * 2, 20),
      );
      const candidates = fused.slice(0, depth);
      try {
        const reranked = await this.reranker.rerank(
          q,
          candidates.map(({ row, score }) => ({
            id: String(row.id),
            text: `${row.name}\n${row.description}\n${row.content}`,
            originalScore: score,
          })),
          Math.min(limit, candidates.length),
        );
        const byId = new Map(candidates.map((entry) => [String(entry.row.id), entry]));
        const seen = new Set<string>();
        if (reranked.length !== Math.min(limit, candidates.length) || reranked.some((row) => {
          if (!byId.has(row.id) || seen.has(row.id) || !Number.isFinite(row.score)) return true;
          seen.add(row.id);
          return false;
        })) throw new Error(`${this.reranker.name} returned an incomplete memory result set`);
        return reranked
          .map((result) => ({ ...byId.get(result.id)!.row, score: result.score }))
          .sort((a, b) => b.score - a.score);
      } catch (err) {
        console.warn(`[agent-memory-search] ${this.reranker.name} rerank unavailable; preserving RRF order: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    }

    return fused.slice(0, limit).map((entry) => ({ ...entry.row, score: entry.score }));
  }

  /** Backfill: embed every memory missing a vector (one pass, best-effort). */
  async backfillEmbeddings(
    projectId?: number,
    limit = 200,
    scope?: 'project' | 'user',
  ): Promise<{ embedded: number; failed: number; skipped: number; total: number }> {
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
    for (const row of rows) {
      const res = await this.embedAndUpsert(row);
      if (res.ok && !res.skipped) embedded++;
      else if (res.ok) skipped++;
      else if (!res.ok) failed++;
    }
    return { embedded, failed, skipped, total: rows.length };
  }
}
