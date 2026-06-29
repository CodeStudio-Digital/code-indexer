import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type {
  AgentMemoryRow,
  AgentMemoryScope,
  AgentMemoryType,
  VectorRecord,
} from '@mcp/shared/types.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';

/**
 * Agent Memory service — embed-on-write + hybrid (FTS + vector RRF) search over
 * the dedicated `agent_memory` table, SEPARATE from snapshots.
 *
 * Deliberately NOT built on SnapshotService / HybridSearch (those are coupled
 * to the snapshots/code/docs flows). This is a small adapter that reuses the
 * SAME proven patterns: sliding-window chunking, central vectors filtered by
 * metadata, reciprocal-rank fusion, and an FTS-only fallback when no embedding
 * backend is configured.
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
function embeddingTextHash(
  row: Pick<AgentMemoryRow, 'name' | 'description' | 'content'>,
  fingerprint: string,
): string {
  return createHash('md5')
    .update(`${fingerprint}\n${row.name}\n${row.description}\n${row.content}`)
    .digest('hex');
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
  ) {}

  hasEmbeddingBackend(): boolean {
    return this.embeddingService !== null && this.vectorStore !== null;
  }

  private fingerprint(): string {
    return this.embeddingService?.fingerprint?.() ?? 'no-embed';
  }

  private resolveProjectName(projectId: number): string {
    if (projectId === 0) return '__user__';
    if (this.projectNameCache.has(projectId)) return this.projectNameCache.get(projectId)!;
    const project = this.db.getProject(projectId);
    const name = project?.name ?? `project:${projectId}`;
    this.projectNameCache.set(projectId, name);
    return name;
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
    const fingerprint = this.fingerprint();
    const newHash = embeddingTextHash(row, fingerprint);
    if (row.embedding_hash === newHash) return { ok: true, skipped: 'unchanged' };

    try {
      const projectName = this.resolveProjectName(row.project_id);
      const windows = slidingWindows(`${row.name}\n${row.description}\n${row.content}`, {
        windowChars: MEMORY_WINDOW_CHARS,
        overlapChars: MEMORY_OVERLAP_CHARS,
        maxChunks: MAX_MEMORY_CHUNKS,
      });
      const chunkTexts = windows.map((w, i) => (i === 0 ? w : `${row.name}\n${w}`));
      const { vectors } = await this.embeddingService.embed(chunkTexts);
      if (vectors.length === 0 || vectors[0].length === 0) {
        return { ok: false, error: 'embedding service returned no vectors' };
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
        },
      }));
      await this.vectorStore.upsert(records);

      // Drop leftover chunk vectors from a previously-longer version.
      const staleIds: string[] = [];
      for (let i = records.length; i < MAX_MEMORY_CHUNKS; i++) staleIds.push(memoryVecId(row.id, i));
      if (staleIds.length > 0) {
        try { await this.vectorStore.deleteByIds(staleIds); } catch { /* best-effort */ }
      }

      this.db.updateAgentMemoryEmbedding(row.id, newHash, records[0].id);
      this.db.saveVectorIds(
        row.project_id,
        records.map((r) => ({ vectorId: r.id, type: 'agent_memory' as const })),
      );
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[agent-memory-embed] upsert failed:', msg);
      return { ok: false, error: msg };
    }
  }

  /** Remove a memory's chunk vectors (archive / forget / supersede). */
  async removeVectors(memoryId: number, projectId: number): Promise<void> {
    const ids: string[] = [];
    for (let i = 0; i < MAX_MEMORY_CHUNKS; i++) ids.push(memoryVecId(memoryId, i));
    if (this.vectorStore) {
      try { await this.vectorStore.deleteByIds(ids); } catch (err) {
        console.error('[agent-memory-embed] delete failed:', (err as Error).message);
      }
    }
    try { this.db.deleteVectorIdRows(projectId, ids); } catch { /* best-effort */ }
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
    if (this.embeddingService && this.vectorStore) {
      try {
        const { vector } = await this.embeddingService.embedQuery(q);
        if (vector.length > 0) {
          const projectName = this.resolveProjectName(scope === 'user' ? 0 : projectId);
          const matches = await this.vectorStore.search(vector, {
            topK: limit * 4,
            filter: { type: 'agent_memory', project_name: projectName, scope },
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

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({ ...e.row, score: e.score }));
  }

  /** Backfill: embed every memory missing a vector (one pass, best-effort). */
  async backfillEmbeddings(projectId?: number, limit = 200): Promise<{ embedded: number; failed: number }> {
    if (!this.hasEmbeddingBackend()) return { embedded: 0, failed: 0 };
    const rows = this.db.listAgentMemoryMissingEmbedding(projectId).slice(0, limit);
    let embedded = 0;
    let failed = 0;
    for (const row of rows) {
      const res = await this.embedAndUpsert(row);
      if (res.ok && !res.skipped) embedded++;
      else if (!res.ok) failed++;
    }
    return { embedded, failed };
  }
}
