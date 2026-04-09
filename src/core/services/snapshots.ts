import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '../../store/db.js';
import type { ContextSnapshot, SnapshotCategory, SnapshotVersion, VectorRecord } from '../../types.js';
import type { EmbeddingService } from '../search/embeddings.js';
import type { VectorStore } from '../../store/vectors.js';

export interface SnapshotWithStale extends ContextSnapshot {
  stale?: boolean;
  stale_files?: string[];
}

/**
 * Build the stable vector id for a snapshot. Hashing the numeric id keeps the
 * shape consistent with file/symbol vectors (`f_<hash>`, `s_<hash>`) so all
 * vector records share the same id space.
 */
function snapshotVecId(snapshotId: number): string {
  return 'sn_' + createHash('md5').update(`snapshot:${snapshotId}`).digest('hex').slice(0, 24);
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

  private resolveProjectName(projectId: number): string | null {
    if (this.projectNameCache.has(projectId)) return this.projectNameCache.get(projectId)!;
    const project = this.db.getProject(projectId);
    if (!project) return null;
    this.projectNameCache.set(projectId, project.name);
    return project.name;
  }

  /**
   * Fire-and-forget embed + upsert. Errors are logged but never thrown —
   * snapshots must remain usable even when the vector backend is down.
   * Returning the promise lets tests `await` it when needed.
   */
  private async embedAndUpsert(snap: ContextSnapshot): Promise<void> {
    if (!this.embeddingService || !this.vectorStore) return;
    const projectName = this.resolveProjectName(snap.project_id);
    if (!projectName) return;
    try {
      const text = `${snap.title}\n${snap.content}`.slice(0, 2000);
      const { vectors } = await this.embeddingService.embed([text]);
      if (vectors.length === 0 || vectors[0].length === 0) return;
      const record: VectorRecord = {
        id: snapshotVecId(snap.id),
        values: vectors[0],
        metadata: {
          project_name: projectName,
          type: 'snapshot',
          ref_id: String(snap.id),
        },
      };
      await this.vectorStore.upsert([record]);
    } catch (err) {
      console.error('[snapshot-embed] upsert failed:', (err as Error).message);
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

  create(
    projectId: number,
    data: {
      title: string;
      category: SnapshotCategory;
      content: string;
      tags?: string[];
      createdBy?: string;
      referencedFiles?: string[];
    }
  ): ContextSnapshot {
    const snap = this.db.createSnapshot(projectId, data);
    if (data.referencedFiles && data.referencedFiles.length > 0) {
      this.db.setSnapshotFiles(snap.id, projectId, data.referencedFiles);
    }
    // Fire and forget — the vector side shouldn't block snapshot creation.
    void this.embedAndUpsert(snap);
    return snap;
  }

  update(
    id: number,
    updates: Partial<Pick<ContextSnapshot, 'title' | 'category' | 'content'>> & {
      tags?: string[];
      referencedFiles?: string[];
      projectId?: number;
    }
  ): void {
    this.db.updateSnapshot(id, updates);
    if (updates.referencedFiles !== undefined) {
      if (updates.projectId === undefined) {
        throw new Error('updateSnapshot: projectId is required when updating referencedFiles');
      }
      this.db.setSnapshotFiles(id, updates.projectId, updates.referencedFiles);
    }
    // Re-embed only when title/content changed — category/tags don't affect
    // semantic match.
    if (updates.title !== undefined || updates.content !== undefined) {
      const current = this.db.getSnapshotById(id);
      if (current) void this.embedAndUpsert(current);
    }
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

  getForContext(projectId: number): string {
    const snapshots = this.db.listSnapshots(projectId);
    if (snapshots.length === 0) return '';

    const grouped = new Map<string, ContextSnapshot[]>();
    const categoryOrder: SnapshotCategory[] = ['architecture', 'decision', 'convention', 'pattern', 'todo', 'note'];

    for (const snap of snapshots) {
      const list = grouped.get(snap.category) ?? [];
      list.push(snap);
      grouped.set(snap.category, list);
    }

    const sections: string[] = ['# Project Context\n'];

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

  getHistory(snapshotId: number): SnapshotVersion[] {
    return this.db.getSnapshotHistory(snapshotId);
  }
}
