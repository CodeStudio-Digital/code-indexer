import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '../../store/db.js';
import type { ContextSnapshot, SnapshotCategory, SnapshotVersion, VectorRecord } from '../../types.js';
import type { EmbeddingService } from '../search/embeddings.js';
import type { VectorStore } from '../../store/vectors.js';

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
function snapshotVecId(snapshotId: number): string {
  return 'sn_' + createHash('md5').update(`snapshot:${snapshotId}`).digest('hex').slice(0, 24);
}

/** Stable hash of the text actually fed to the embedding service. Used to
 *  detect "content unchanged → skip embedding" on update/backfill. */
function embeddingTextHash(snap: Pick<ContextSnapshot, 'title' | 'content'>): string {
  const text = `${snap.title}\n${snap.content}`.slice(0, 2000);
  return createHash('md5').update(text).digest('hex');
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
      const text = `${snap.title}\n${snap.content}`.slice(0, 2000);
      const { vectors } = await this.embeddingService.embed([text]);
      if (vectors.length === 0 || vectors[0].length === 0) {
        return { ok: false, error: 'embedding service returned no vectors' };
      }
      const vectorId = snapshotVecId(snap.id);
      const record: VectorRecord = {
        id: vectorId,
        values: vectors[0],
        metadata: {
          project_name: projectName,
          type: 'snapshot',
          ref_id: String(snap.id),
        },
      };
      await this.vectorStore.upsert([record]);
      this.db.updateSnapshotEmbeddingHash(snap.id, newHash);
      // Idempotent: vector_ids has a UNIQUE on (project_id, vector_id) so
      // re-registering the same id is a no-op via INSERT OR IGNORE-style
      // behaviour. We rely on saveVectorIds being called once per snapshot;
      // for updates the same vectorId is reused and the row already exists.
      const existing = this.db
        .getVectorIdsByProject(snap.project_id)
        .some((r) => r.vector_id === vectorId);
      if (!existing) {
        this.db.saveVectorIds(snap.project_id, [
          { vectorId, type: 'snapshot' },
        ]);
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[snapshot-embed] upsert failed:', msg);
      return { ok: false, error: msg };
    }
  }

  private async removeFromVectorStore(snapshotId: number): Promise<void> {
    if (!this.vectorStore) return;
    try {
      await this.vectorStore.deleteByIds([snapshotVecId(snapshotId)]);
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
