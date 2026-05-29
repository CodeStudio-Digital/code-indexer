import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ContextSnapshot, SnapshotCategory, SnapshotVersion, VectorRecord } from '@mcp/shared/types.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';

// Long snapshots are split into overlapping windows instead of being
// truncated at 2000 chars, so the whole note stays semantically searchable.
const SNAPSHOT_WINDOW_CHARS = 2000;
const SNAPSHOT_OVERLAP_CHARS = 200;
const MAX_SNAPSHOT_CHUNKS = 6;

export interface SnapshotWithStale extends ContextSnapshot {
  stale?: boolean;
  stale_files?: string[];
}

/** Result envelope for create/update so callers can surface embed failures
 *  and silently-skipped file references without re-querying. */
export interface SnapshotMutationResult {
  snap: ContextSnapshot;
  /** Reason why the vector index did not get updated, if any. The snapshot
   *  itself is always persisted to SQLite — embed failures are recoverable
   *  via backfill. */
  embedError?: string;
  /** Referenced file paths the caller passed but were not yet in the file
   *  index. Empty array means everything was tracked. */
  skippedFiles?: string[];
}

/**
 * Build the stable vector id for a snapshot. Hashing the numeric id keeps the
 * shape consistent with file/symbol vectors (`f_<hash>`, `s_<hash>`) so all
 * vector records share the same id space.
 */
function snapshotVecId(snapshotId: number, chunk = 0): string {
  const seed = chunk === 0 ? `snapshot:${snapshotId}` : `snapshot:${snapshotId}:${chunk}`;
  return 'sn_' + createHash('md5').update(seed).digest('hex').slice(0, 24);
}

/** Stable hash of the FULL text fed to the embedding service. Used to detect
 *  "content unchanged → skip embedding" on update/backfill. Hashes the whole
 *  title+content (no truncation) so edits past the old 2000-char cap also
 *  trigger a re-embed. */
function embeddingTextHash(snap: Pick<ContextSnapshot, 'title' | 'content'>): string {
  return createHash('md5').update(`${snap.title}\n${snap.content}`).digest('hex');
}

export class SnapshotService {
  private projectNameCache = new Map<number, string>();

  constructor(
    private db: CodeIndexDB,
    // Optional — when omitted (CLI commands, tests, exporter) snapshots are
    // only stored in SQLite. The mcp-server and http-api inject both so every
    // create/update/delete also touches the vector store.
    private embeddingService: EmbeddingService | null = null,
    private vectorStore: VectorStore | null = null
  ) {}

  hasEmbeddingBackend(): boolean {
    return this.embeddingService !== null && this.vectorStore !== null;
  }

  private resolveProjectName(projectId: number): string | null {
    if (this.projectNameCache.has(projectId)) return this.projectNameCache.get(projectId)!;
    const project = this.db.getProject(projectId);
    if (!project) return null;
    this.projectNameCache.set(projectId, project.name);
    return project.name;
  }

  /**
   * Embed and upsert a single snapshot, then write the embedding hash and
   * register the vector id. Returns an error string instead of throwing so
   * callers can surface it without losing the SQLite write that already
   * succeeded.
   *
   * Skips when the embedding text hasn't changed since the last successful
   * embed (`embedding_hash` matches). Skips when no embedding backend is
   * configured (CLI/tests).
   */
  async embedAndUpsert(snap: ContextSnapshot): Promise<{ ok: boolean; error?: string; skipped?: 'no-backend' | 'unchanged' }> {
    if (!this.embeddingService || !this.vectorStore) {
      return { ok: true, skipped: 'no-backend' };
    }
    const projectName = this.resolveProjectName(snap.project_id);
    if (!projectName) return { ok: false, error: 'project not found' };

    const newHash = embeddingTextHash(snap);
    if (snap.embedding_hash === newHash) {
      return { ok: true, skipped: 'unchanged' };
    }

    try {
      const windows = slidingWindows(`${snap.title}\n${snap.content}`, {
        windowChars: SNAPSHOT_WINDOW_CHARS,
        overlapChars: SNAPSHOT_OVERLAP_CHARS,
        maxChunks: MAX_SNAPSHOT_CHUNKS,
      });
      // Non-first windows get the title prepended so every vector carries the
      // snapshot's subject as context (chunk 0 already starts with it).
      const chunkTexts = windows.map((w, i) => (i === 0 ? w : `${snap.title}\n${w}`));
      const { vectors } = await this.embeddingService.embed(chunkTexts);
      if (vectors.length === 0 || vectors[0].length === 0) {
        return { ok: false, error: 'embedding service returned no vectors' };
      }
      const records: VectorRecord[] = vectors.map((values, i) => ({
        id: snapshotVecId(snap.id, i),
        values,
        metadata: {
          project_name: projectName,
          type: 'snapshot',
          ref_id: String(snap.id),
          chunk_index: String(i),
        },
      }));
      await this.vectorStore.upsert(records);

      // Drop leftover chunk vectors from a previously-longer version of this
      // snapshot (e.g. it shrank from 5 windows to 2). Best-effort.
      const staleIds: string[] = [];
      for (let i = records.length; i < MAX_SNAPSHOT_CHUNKS; i++) staleIds.push(snapshotVecId(snap.id, i));
      if (staleIds.length > 0) {
        try { await this.vectorStore.deleteByIds(staleIds); } catch { /* best-effort */ }
      }

      this.db.updateSnapshotEmbeddingHash(snap.id, newHash);
      // INSERT OR REPLACE keyed on (project_id, vector_id) — idempotent, so we
      // register every current chunk id unconditionally.
      this.db.saveVectorIds(
        snap.project_id,
        records.map((r) => ({ vectorId: r.id, type: 'snapshot' as const })),
      );
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[snapshot-embed] upsert failed:', msg);
      return { ok: false, error: msg };
    }
  }

  private async removeFromVectorStore(snapshotId: number): Promise<void> {
    if (!this.vectorStore) return;
    // Delete every possible chunk id — deleting absent ids is a no-op, so a
    // fixed [0, MAX) sweep cleans up regardless of how many chunks existed.
    const ids: string[] = [];
    for (let i = 0; i < MAX_SNAPSHOT_CHUNKS; i++) ids.push(snapshotVecId(snapshotId, i));
    try {
      await this.vectorStore.deleteByIds(ids);
    } catch (err) {
      console.error('[snapshot-embed] delete failed:', (err as Error).message);
    }
  }

  /**
   * Create a snapshot. SQLite write is synchronous and always succeeds (or
   * throws — caller's job to handle). Embedding is awaited so failures can
   * be reported, but a failure is non-fatal: the snapshot is persisted and
   * a later backfill can fix the vector index.
   */
  async create(
    projectId: number,
    data: {
      title: string;
      category: SnapshotCategory;
      content: string;
      tags?: string[];
      createdBy?: string;
      referencedFiles?: string[];
    }
  ): Promise<SnapshotMutationResult> {
    const snap = this.db.createSnapshot(projectId, data);
    let skippedFiles: string[] | undefined;
    if (data.referencedFiles && data.referencedFiles.length > 0) {
      const result = this.db.setSnapshotFiles(snap.id, projectId, data.referencedFiles);
      if (result.skipped.length > 0) skippedFiles = result.skipped;
    }
    const embed = await this.embedAndUpsert(snap);
    return {
      snap,
      embedError: embed.ok ? undefined : embed.error,
      skippedFiles,
    };
  }

  async update(
    id: number,
    updates: Partial<Pick<ContextSnapshot, 'title' | 'category' | 'content'>> & {
      tags?: string[];
      referencedFiles?: string[];
      projectId?: number;
      updatedBy?: string;
    }
  ): Promise<SnapshotMutationResult> {
    this.db.updateSnapshot(id, {
      title: updates.title,
      category: updates.category,
      content: updates.content,
      tags: updates.tags,
      updatedBy: updates.updatedBy,
    });
    let skippedFiles: string[] | undefined;
    if (updates.referencedFiles !== undefined) {
      if (updates.projectId === undefined) {
        throw new Error('updateSnapshot: projectId is required when updating referencedFiles');
      }
      const result = this.db.setSnapshotFiles(id, updates.projectId, updates.referencedFiles);
      if (result.skipped.length > 0) skippedFiles = result.skipped;
    }
    const current = this.db.getSnapshotById(id);
    if (!current) throw new Error(`snapshot ${id} not found after update`);

    let embedError: string | undefined;
    // Re-embed only when title/content changed — category/tags don't affect
    // semantic match. updateSnapshot clears embedding_hash for those fields,
    // so the hash-equal short-circuit in embedAndUpsert will fire when only
    // metadata moved.
    if (updates.title !== undefined || updates.content !== undefined) {
      const embed = await this.embedAndUpsert(current);
      if (!embed.ok) embedError = embed.error;
    }
    return { snap: current, embedError, skippedFiles };
  }

  /**
   * Annotate a snapshot with `stale: true` if any referenced file's current
   * hash diverges from the hash at creation time. Snapshots with no
   * referenced files are never marked stale.
   */
  annotateStale(projectId: number, snap: ContextSnapshot): SnapshotWithStale {
    const staleFiles = this.db.getStaleSnapshotFiles(snap.id, projectId);
    if (staleFiles.length === 0) return snap;
    return { ...snap, stale: true, stale_files: staleFiles };
  }

  /** Annotate a list of snapshots with staleness in one pass. */
  annotateStaleMany(projectId: number, snaps: ContextSnapshot[]): SnapshotWithStale[] {
    return snaps.map((s) => this.annotateStale(projectId, s));
  }

  delete(id: number): void {
    this.db.deleteSnapshot(id);
    void this.removeFromVectorStore(id);
  }

  list(projectId: number, category?: SnapshotCategory): ContextSnapshot[] {
    return this.db.listSnapshots(projectId, category);
  }

  search(projectId: number, query: string): ContextSnapshot[] {
    return this.db.searchSnapshots(projectId, query);
  }

  /**
   * Render a list of snapshots grouped by category as Markdown. Used by
   * `get_project_context` (after semantic search has narrowed the set) and
   * by the legacy `getForContext` dump path.
   */
  static renderGrouped(snaps: ContextSnapshot[], heading = '# Project Context'): string {
    if (snaps.length === 0) return '';
    const grouped = new Map<string, ContextSnapshot[]>();
    const categoryOrder: SnapshotCategory[] = ['architecture', 'decision', 'convention', 'pattern', 'todo', 'note'];
    for (const snap of snaps) {
      const list = grouped.get(snap.category) ?? [];
      list.push(snap);
      grouped.set(snap.category, list);
    }
    const sections: string[] = [`${heading}\n`];
    for (const category of categoryOrder) {
      const items = grouped.get(category);
      if (!items || items.length === 0) continue;
      sections.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}s\n`);
      for (const snap of items) {
        sections.push(`### ${snap.title}\n${snap.content}\n`);
      }
    }
    return sections.join('\n');
  }

  getForContext(projectId: number): string {
    const snapshots = this.db.listSnapshots(projectId);
    return SnapshotService.renderGrouped(snapshots);
  }

  getHistory(snapshotId: number): SnapshotVersion[] {
    return this.db.getSnapshotHistory(snapshotId);
  }
}
