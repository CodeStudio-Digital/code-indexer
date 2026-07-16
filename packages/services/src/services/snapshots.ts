import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ContextSnapshot, SnapshotCategory, SnapshotScope, SnapshotVersion, VectorRecord } from '@mcp/shared/types.js';
import {
  embedDocumentsForNamespace,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { VectorItemState, VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';
import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';
import { snapshotNamespace } from '@mcp/shared/vector-namespace.js';
import type {
  SemanticMutation,
  SemanticMutationFence,
  SemanticMutationSink,
} from '../semantic-mutation-sink.js';

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
export function snapshotEmbeddingTextHash(
  snap: Pick<ContextSnapshot, 'title' | 'content'>,
  fingerprint: string,
): string {
  return createHash('md5').update(`${fingerprint}\n${snap.title}\n${snap.content}`).digest('hex');
}

export function snapshotEmbeddingTexts(
  snap: Pick<ContextSnapshot, 'title' | 'content'>,
): string[] {
  const windows = slidingWindows(`${snap.title}\n${snap.content}`, {
    windowChars: SNAPSHOT_WINDOW_CHARS,
    overlapChars: SNAPSHOT_OVERLAP_CHARS,
    maxChunks: MAX_SNAPSHOT_CHUNKS,
  });
  return windows.map((window, index) => index === 0 ? window : `${snap.title}\n${window}`);
}

export class SnapshotService {
  private projectNameCache = new Map<number, string>();

  constructor(
    private db: CodeIndexDB,
    // Optional — when omitted (CLI commands, tests, exporter) snapshots are
    // only stored in SQLite. The mcp-server and http-api inject both so every
    // create/update/delete also touches the vector store.
    private embeddingService: EmbeddingService | null = null,
    private vectorStore: VectorStore | null = null,
    private semanticMutationSink: SemanticMutationSink | null = null,
  ) {}

  /** Run the relational write behind a durable pre-mutation barrier when the
   * host supports fences. Legacy sinks retain their post-commit notification
   * behavior; external CLI/MCP writers never enter SQLite without a fence. */
  private commitRelationalMutation<T>(input: SemanticMutation, mutation: () => T): T {
    const canFence = typeof this.semanticMutationSink?.beginMutation === 'function'
      && typeof this.semanticMutationSink?.settleMutation === 'function';
    let fence: SemanticMutationFence | null = null;
    if (canFence) fence = this.semanticMutationSink!.beginMutation!(input);

    let result!: T;
    try {
      result = mutation();
    } catch (error) {
      if (fence) this.semanticMutationSink!.settleMutation!(fence, error);
      throw error;
    }

    if (fence) this.semanticMutationSink!.settleMutation!(fence);
    else if (!canFence) this.semanticMutationSink?.noteMutation(input);
    return result;
  }

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
   * Embed and upsert a single snapshot. The vector worker records its hash,
   * chunks and vector ids in semantic_items. Returns an error string so
   * callers can surface it without losing the SQLite write that already
   * succeeded.
   *
   * Skips when the semantic item ledger already contains every current chunk.
   * Skips when no embedding backend is
   * configured (CLI/tests).
   */
  async embedAndUpsert(snap: ContextSnapshot): Promise<{ ok: boolean; error?: string; skipped?: 'no-backend' | 'unchanged' }> {
    if (!this.embeddingService || !this.vectorStore) {
      return { ok: true, skipped: 'no-backend' };
    }
    const projectName = this.resolveProjectName(snap.project_id);
    if (!projectName) return { ok: false, error: 'project not found' };

    const initialHash = snapshotEmbeddingTextHash(
      snap,
      this.embeddingService.fingerprint?.() ?? 'embedding:unknown',
    );
    try {
      const chunkTexts = snapshotEmbeddingTexts(snap);
      const namespace = snapshotNamespace(snap.project_id);
      if (await this.isCurrent(namespace, `snapshot:${snap.id}`, initialHash, chunkTexts.length)) {
        return { ok: true, skipped: 'unchanged' };
      }
      const embedded = await embedDocumentsForNamespace(this.embeddingService, namespace, chunkTexts);
      const { vectors, writeTarget } = embedded;
      if (vectors.length === 0 || vectors[0].length === 0) {
        return { ok: false, error: 'embedding service returned no vectors' };
      }
      const newHash = snapshotEmbeddingTextHash(
        snap,
        writeTarget?.embeddingFingerprint
          ?? this.embeddingService.fingerprint?.()
          ?? 'embedding:unknown',
      );
      if (newHash !== initialHash
        && await this.isCurrent(namespace, `snapshot:${snap.id}`, newHash, chunkTexts.length, writeTarget)) {
        return { ok: true, skipped: 'unchanged' };
      }
      const records: VectorRecord[] = vectors.map((values, i) => ({
        id: snapshotVecId(snap.id, i),
        values,
        metadata: {
          project_name: projectName,
          type: 'snapshot',
          ref_id: String(snap.id),
          chunk_index: String(i),
          embedding_hash: newHash,
        },
      }));
      const accepted = await (writeTarget
        ? this.vectorStore.upsert(records, namespace, writeTarget)
        : this.vectorStore.upsert(records, namespace));
      if (accepted !== records.length) {
        throw new Error(`vector store accepted ${accepted}/${records.length} snapshot record(s)`);
      }

      // Drop leftover chunks from a previously-longer snapshot. A failed
      // cleanup keeps the mutation pending; otherwise coverage could activate
      // a generation that still contains stale text.
      const itemKey = `snapshot:${snap.id}`;
      const ledgerRows = await (writeTarget
        ? this.vectorStore.listItems?.(namespace, [itemKey], writeTarget)
        : this.vectorStore.listItems?.(namespace, [itemKey])) ?? [];
      const staleIds = ledgerRows.flatMap((row) =>
        row.vectorId && (row.sourceHash !== newHash || row.chunkIndex >= records.length)
          ? [row.vectorId]
          : []);
      if (staleIds.length > 0) {
        if (writeTarget) await this.vectorStore.deleteByIds(staleIds, namespace, writeTarget);
        else await this.vectorStore.deleteByIds(staleIds, namespace);
      }

      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[snapshot-embed] upsert failed:', msg);
      return { ok: false, error: msg };
    }
  }

  /** Persistent semantic backfill. Model fingerprints participate in the
   * hash, so profile changes naturally rebuild every project snapshot. */
  async backfillEmbeddings(
    projectId?: number,
    limit = 10_000,
  ): Promise<{ embedded: number; failed: number; skipped: number; total: number }> {
    const rows = this.db.listSnapshotsForSemanticIndex(projectId).slice(0, limit);
    let embedded = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      const result = await this.embedAndUpsert(row);
      if (result.ok && !result.skipped) embedded++;
      else if (result.ok) skipped++;
      else if (!result.ok) failed++;
    }
    return { embedded, failed, skipped, total: rows.length };
  }

  private async removeFromVectorStore(snapshotId: number, projectId: number): Promise<void> {
    if (!this.vectorStore) return;
    try {
      const namespace = snapshotNamespace(projectId);
      if (this.vectorStore.deleteByItemKeys) {
        await this.vectorStore.deleteByItemKeys([`snapshot:${snapshotId}`], namespace);
      } else {
        const ids: string[] = [];
        for (let i = 0; i < MAX_SNAPSHOT_CHUNKS; i++) ids.push(snapshotVecId(snapshotId, i));
        await this.vectorStore.deleteByIds(ids, namespace);
      }
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
      /** Memory provenance (manual|agent|session|compaction|index). */
      source?: string;
      /** 0..1 salience. */
      importance?: number;
      /** Memory scope (migration 145). Defaults to 'project' (or 'user' for
       *  user/feedback categories). */
      scope?: SnapshotScope;
    }
  ): Promise<SnapshotMutationResult> {
    let skippedFiles: string[] | undefined;
    const snap = this.commitRelationalMutation({
      namespace: snapshotNamespace(projectId),
      // The row id does not exist until INSERT returns. A wildcard is the
      // only honest pre-write watermark and is reconciled idempotently.
      itemKeys: ['*'],
      operation: 'upsert',
    }, () => {
      const created = this.db.createSnapshot(projectId, data);
      if (data.referencedFiles && data.referencedFiles.length > 0) {
        const result = this.db.setSnapshotFiles(created.id, projectId, data.referencedFiles);
        if (result.skipped.length > 0) skippedFiles = result.skipped;
      }
      return created;
    });
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
      /** 0..1 retrieval salience — the Memory tab "pin" boost. */
      importance?: number;
    }
  ): Promise<SnapshotMutationResult> {
    let skippedFiles: string[] | undefined;
    // Re-embed only when title/content changed — category/tags don't affect
    // semantic match, and semantic_items already holds the current text hash.
    const semanticChange = updates.title !== undefined || updates.content !== undefined;
    const before = semanticChange ? this.db.getSnapshotById(id) : null;
    const write = (): ContextSnapshot => {
      this.db.updateSnapshot(id, {
        title: updates.title,
        category: updates.category,
        content: updates.content,
        tags: updates.tags,
        updatedBy: updates.updatedBy,
        importance: updates.importance,
      });
      if (updates.referencedFiles !== undefined) {
        if (updates.projectId === undefined) {
          throw new Error('updateSnapshot: projectId is required when updating referencedFiles');
        }
        const result = this.db.setSnapshotFiles(id, updates.projectId, updates.referencedFiles);
        if (result.skipped.length > 0) skippedFiles = result.skipped;
      }
      const current = this.db.getSnapshotById(id);
      if (!current) throw new Error(`snapshot ${id} not found after update`);
      return current;
    };
    const current = semanticChange && before
      ? this.commitRelationalMutation({
          namespace: snapshotNamespace(before.project_id),
          itemKeys: [`snapshot:${id}`],
          operation: 'upsert',
        }, write)
      : write();

    let embedError: string | undefined;
    if (semanticChange) {
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
    const snap = this.db.getSnapshotById(id);
    if (snap) {
      this.commitRelationalMutation({
        namespace: snapshotNamespace(snap.project_id),
        itemKeys: [`snapshot:${id}`],
        operation: 'delete',
      }, () => this.db.deleteSnapshot(id));
      void this.removeFromVectorStore(id, snap.project_id);
    } else {
      this.db.deleteSnapshot(id);
    }
  }

  /**
   * Reversible soft-delete used by the memory consolidator. Archives the row
   * (excluded from every agent-facing read path) and drops its vectors so an
   * archived memory can never surface — even before the SQL filter applies.
   * Best-effort on the vector side; the row's `archived_at IS NULL` filter is
   * the hard guarantee.
   */
  async archive(id: number, reason: string): Promise<void> {
    const snap = this.db.getSnapshotById(id);
    if (snap) {
      this.commitRelationalMutation({
        namespace: snapshotNamespace(snap.project_id),
        itemKeys: [`snapshot:${id}`],
        operation: 'delete',
      }, () => this.db.archiveSnapshot(id, reason));
      await this.removeFromVectorStore(id, snap.project_id);
    } else {
      this.db.archiveSnapshot(id, reason);
    }
  }

  /** Restore an archived snapshot. The DB layer NULLs the embedding hash so
   *  the backfill re-embeds it on the next sweep. */
  unarchive(id: number): void {
    const snap = this.db.getSnapshotById(id);
    if (snap) {
      this.commitRelationalMutation({
        namespace: snapshotNamespace(snap.project_id),
        itemKeys: [`snapshot:${id}`],
        operation: 'upsert',
      }, () => this.db.unarchiveSnapshot(id));
    } else {
      this.db.unarchiveSnapshot(id);
    }
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
