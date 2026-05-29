import { describe, it, expect } from 'vitest';
import { MemoryRetriever, type SnapshotSearch, type AccessMarker } from '../retriever.js';
import type { ContextSnapshot } from '@mcp/shared/types.js';

function snap(id: number, title: string, content: string, importance = 0.5): ContextSnapshot {
  return {
    id, project_id: 1, title, category: 'note', content, tags: '[]',
    created_at: '', updated_at: '', created_by: 'manual', embedding_hash: null,
    source: 'manual', importance, last_accessed_at: null, access_count: 0,
  };
}

function fakeAccess(): AccessMarker & { ids: number[] } {
  const ids: number[] = [];
  return { ids, markSnapshotAccessed(x) { ids.push(...x); } };
}

describe('MemoryRetriever', () => {
  it('skips retrieval (no search) for a too-short query', async () => {
    let called = false;
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { called = true; return []; } };
    const out = await new MemoryRetriever(search, fakeAccess()).retrieve(1, 'p', 'short');
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('returns [] when search yields nothing', async () => {
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { return []; } };
    const out = await new MemoryRetriever(search, fakeAccess()).retrieve(1, 'p', 'a sufficiently long query');
    expect(out).toEqual([]);
  });

  it('returns top-K, passes through fields, and bumps access for returned ids', async () => {
    const hits = [snap(1, 'A', 'aaa', 0.9), snap(2, 'B', 'bbb'), snap(3, 'C', 'ccc'), snap(4, 'D', 'ddd')];
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { return hits; } };
    const access = fakeAccess();
    const out = await new MemoryRetriever(search, access, { topK: 2 }).retrieve(1, 'proj', 'how does the cache work here');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: '1', title: 'A', content: 'aaa', importance: 0.9 });
    expect(access.ids.sort((a, b) => a - b)).toEqual(out.map((o) => Number(o.id)).sort((a, b) => a - b));
  });

  it('does not throw when access marking fails', async () => {
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { return [snap(1, 'A', 'a')]; } };
    const access: AccessMarker = { markSnapshotAccessed() { throw new Error('db down'); } };
    const out = await new MemoryRetriever(search, access, { topK: 1 }).retrieve(1, 'p', 'a long enough query string');
    expect(out).toHaveLength(1);
  });
});
