import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { backfillSnapshotEmbeddings } from '@mcp/services/services/snapshot-backfill.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorItemState, VectorStore } from '@mcp/store/vectors.js';
import type { VectorMatch, VectorRecord } from '@mcp/shared/types.js';

class FakeEmbedding implements EmbeddingService {
  calls = 0;
  failNext = false;
  beforeEmbed: (() => void) | null = null;
  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    this.beforeEmbed?.();
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
  private readonly items = new Map<string, VectorItemState>();
  async upsert(records: VectorRecord[]): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('vector store offline');
    }
    this.upserts.push(...records);
    for (const record of records) {
      const itemKey = `${record.metadata.type}:${record.metadata.ref_id}`;
      const chunkIndex = Number(record.metadata.chunk_index ?? 0);
      this.items.set(`${itemKey}\0${chunkIndex}`, {
        itemKey,
        sourceHash: record.metadata.embedding_hash ?? record.id,
        vectorId: record.id,
        chunkIndex,
        status: 'indexed',
        attempts: 1,
        error: null,
      });
    }
    return records.length;
  }
  async search(): Promise<VectorMatch[]> {
    return [];
  }
  async deleteByIds(ids: string[]): Promise<number> {
    const remove = new Set(ids);
    for (const [key, item] of this.items) if (item.vectorId && remove.has(item.vectorId)) this.items.delete(key);
    return ids.length;
  }
  async listItems(_namespace: string, itemKeys?: string[]): Promise<VectorItemState[]> {
    const keys = itemKeys ? new Set(itemKeys) : null;
    return [...this.items.values()].filter((item) => !keys || keys.has(item.itemKey));
  }
  async deleteByItemKeys(itemKeys: string[]): Promise<number> {
    const keys = new Set(itemKeys);
    let deleted = 0;
    for (const [identity, item] of this.items) {
      if (!keys.has(item.itemKey)) continue;
      this.items.delete(identity);
      deleted++;
    }
    return deleted;
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

  it('persists snapshot and records vector ids/hashes in semantic_items', async () => {
    const { snap, embedError } = await svc.create(projectId, {
      title: 'Use ES modules',
      category: 'decision',
      content: 'Project standardised on ESM.',
    });
    expect(embedError).toBeUndefined();
    expect(vectors.upserts.length).toBe(1);
    expect(vectors.upserts[0].metadata?.type).toBe('snapshot');
    expect(vectors.upserts[0].metadata?.ref_id).toBe(String(snap.id));

    expect(db.getSnapshotById(snap.id)!.embedding_hash).toBeNull();
    const items = await vectors.listItems(`snapshot:p${projectId}`, [`snapshot:${snap.id}`]);
    expect(items.some((item) => item.vectorId === vectors.upserts[0].id && item.sourceHash)).toBe(true);
  });

  it('persists the semantic mutation before starting asynchronous embedding', async () => {
    const noteMutation = vi.fn();
    const guarded = new SnapshotService(db, embedding, vectors, { noteMutation });
    embedding.beforeEmbed = () => {
      expect(noteMutation).toHaveBeenCalledWith({
        namespace: `snapshot:p${projectId}`,
        itemKeys: ['*'],
        operation: 'upsert',
      });
    };

    const { snap } = await guarded.create(projectId, {
      title: 'Durable fence', category: 'decision', content: 'Delta precedes embedding.',
    });

    expect(noteMutation).toHaveBeenCalledTimes(1);
    guarded.delete(snap.id);
    expect(noteMutation).toHaveBeenLastCalledWith({
      namespace: `snapshot:p${projectId}`,
      itemKeys: [`snapshot:${snap.id}`],
      operation: 'delete',
    });
  });

  it('opens the durable snapshot fence before SQLite and settles after commit', async () => {
    const order: string[] = [];
    const beginMutation = vi.fn(() => {
      expect(db.countSnapshots(projectId)).toBe(0);
      order.push('fence:start');
      return { jobId: 41, token: 'snapshot-41', namespace: `snapshot:p${projectId}` };
    });
    const settleMutation = vi.fn(() => {
      expect(db.countSnapshots(projectId)).toBe(1);
      order.push('fence:settle');
    });
    const guarded = new SnapshotService(db, null, null, {
      noteMutation: vi.fn(),
      beginMutation,
      settleMutation,
    });

    const { snap } = await guarded.create(projectId, {
      title: 'Cross process', category: 'decision', content: 'Fence first.',
    });

    expect(snap.id).toBeGreaterThan(0);
    expect(order).toEqual(['fence:start', 'fence:settle']);
    expect(beginMutation).toHaveBeenCalledWith({
      namespace: `snapshot:p${projectId}`,
      itemKeys: ['*'],
      operation: 'upsert',
    });
  });

  it('chunks a long snapshot into multiple vectors sharing one ref_id', async () => {
    const longContent = 'lorem ipsum dolor sit amet '.repeat(400); // ~10.8k chars
    const { snap, embedError } = await svc.create(projectId, {
      title: 'Long note',
      category: 'note',
      content: longContent,
    });
    expect(embedError).toBeUndefined();
    // Multiple overlapping windows → multiple vectors.
    expect(vectors.upserts.length).toBeGreaterThan(1);
    // Every chunk belongs to the same snapshot and carries a chunk_index.
    const refIds = new Set(vectors.upserts.map((r) => r.metadata?.ref_id));
    expect(refIds).toEqual(new Set([String(snap.id)]));
    const indices = vectors.upserts.map((r) => r.metadata?.chunk_index).sort();
    expect(indices[0]).toBe('0');
    // All chunk ids are registered in the semantic ledger for cleanup.
    const registered = await vectors.listItems(`snapshot:p${projectId}`, [`snapshot:${snap.id}`]);
    expect(registered.length).toBe(vectors.upserts.length);
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
    expect((await vectors.listItems(`snapshot:p${projectId}`, [`snapshot:${r1.snap.id}`])).length).toBe(1);
    expect((await vectors.listItems(`snapshot:p${projectId}`, [`snapshot:${r2.snap.id}`])).length).toBe(1);
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
