import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../store/db.js';
import { SnapshotService } from '../core/services/snapshots.js';
import { backfillSnapshotEmbeddings } from '../core/services/snapshot-backfill.js';
import type { EmbeddingService } from '../core/search/embeddings.js';
import type { VectorStore } from '../store/vectors.js';
import type { VectorMatch, VectorRecord } from '../types.js';

class FakeEmbedding implements EmbeddingService {
  calls = 0;
  failNext = false;
  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('embedding backend down');
    }
    return { vectors: texts.map(() => [0.1, 0.2, 0.3]), tokens: 1 };
  }
  async embedQuery(): Promise<{ vector: number[]; tokens: number }> {
    return { vector: [0.1, 0.2, 0.3], tokens: 1 };
  }
}

class FakeVectorStore implements VectorStore {
  upserts: VectorRecord[] = [];
  failNext = false;
  async upsert(records: VectorRecord[]): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('vector store offline');
    }
    this.upserts.push(...records);
    return records.length;
  }
  async search(): Promise<VectorMatch[]> {
    return [];
  }
  async deleteByIds(ids: string[]): Promise<number> {
    return ids.length;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('Snapshot embedding pipeline', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;
  let embedding: FakeEmbedding;
  let vectors: FakeVectorStore;
  let svc: SnapshotService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-snap-embed-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    const p = db.createProject('p', dir);
    projectId = p.id;
    embedding = new FakeEmbedding();
    vectors = new FakeVectorStore();
    svc = new SnapshotService(db, embedding, vectors);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists snapshot, embeds it, registers vector_id, writes embedding_hash', async () => {
    const { snap, embedError } = await svc.create(projectId, {
      title: 'Use ES modules',
      category: 'decision',
      content: 'Project standardised on ESM.',
    });
    expect(embedError).toBeUndefined();
    expect(vectors.upserts.length).toBe(1);
    expect(vectors.upserts[0].metadata?.type).toBe('snapshot');
    expect(vectors.upserts[0].metadata?.ref_id).toBe(String(snap.id));

    const reread = db.getSnapshotById(snap.id)!;
    expect(reread.embedding_hash).not.toBeNull();

    const ids = db.getVectorIdsByProject(projectId);
    expect(ids.some((r) => r.type === 'snapshot' && r.vector_id === vectors.upserts[0].id)).toBe(true);
  });

  it('embed failure does not block the SQLite write and surfaces a warning', async () => {
    vectors.failNext = true;
    const { snap, embedError } = await svc.create(projectId, {
      title: 'Caching tier',
      category: 'architecture',
      content: 'Use Redis for L2.',
    });
    expect(embedError).toMatch(/vector store offline/);
    // Snapshot row exists despite the embed failure
    const reread = db.getSnapshotById(snap.id)!;
    expect(reread.title).toBe('Caching tier');
    expect(reread.embedding_hash).toBeNull();
    expect(vectors.upserts.length).toBe(0);
  });

  it('does not re-embed when title and content are unchanged', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'No-op test',
      category: 'note',
      content: 'Same content twice.',
    });
    expect(embedding.calls).toBe(1);

    // Second update changes only the category — embed must not fire again
    await svc.update(snap.id, { category: 'decision' });
    expect(embedding.calls).toBe(1);

    // Updating content invalidates the hash → re-embed once
    await svc.update(snap.id, { content: 'Different content', projectId });
    expect(embedding.calls).toBe(2);
  });

  it('backfill embeds snapshots created without a backend', async () => {
    const sansBackend = new SnapshotService(db);
    const r1 = await sansBackend.create(projectId, {
      title: 'Snap A',
      category: 'note',
      content: 'A',
    });
    const r2 = await sansBackend.create(projectId, {
      title: 'Snap B',
      category: 'note',
      content: 'B',
    });
    expect(db.getSnapshotById(r1.snap.id)!.embedding_hash).toBeNull();
    expect(db.getSnapshotById(r2.snap.id)!.embedding_hash).toBeNull();

    const result = await backfillSnapshotEmbeddings(db, svc, projectId);
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(db.getSnapshotById(r1.snap.id)!.embedding_hash).not.toBeNull();
    expect(db.getSnapshotById(r2.snap.id)!.embedding_hash).not.toBeNull();
  });

  it('backfill is idempotent — second pass skips already-embedded rows', async () => {
    await svc.create(projectId, { title: 'X', category: 'note', content: 'x' });
    expect(embedding.calls).toBe(1);
    const result = await backfillSnapshotEmbeddings(db, svc, projectId);
    expect(result.embedded).toBe(0); // nothing pending
    expect(embedding.calls).toBe(1);
  });

  it('updateSnapshot writes an audit row with the supplied updatedBy', async () => {
    const { snap } = await svc.create(projectId, {
      title: 'Original',
      category: 'note',
      content: 'v1',
      createdBy: 'alice',
    });
    await svc.update(snap.id, { content: 'v2', updatedBy: 'bob', projectId });
    const history = svc.getHistory(snap.id);
    expect(history.length).toBe(1);
    // The version row records who made the edit, not the original creator.
    expect(history[0].updated_by).toBe('bob');
  });
});
