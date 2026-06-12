import { describe, it, expect } from 'vitest';
import { MemoryRetriever, type SnapshotSearch, type AccessMarker, type StaleFilesBatch } from '../retriever.js';
import type { ContextSnapshot } from '@mcp/shared/types.js';

function snap(id: number, title: string, content: string, importance = 0.5): ContextSnapshot {
  return {
    id, project_id: 1, title, category: 'note', content, tags: '[]',
    created_at: '', updated_at: '', created_by: 'manual', embedding_hash: null,
    source: 'manual', importance, last_accessed_at: null, access_count: 0,
  };
}

function sqliteTime(offsetMs: number): string {
  // SQLite datetime('now') format: 'YYYY-MM-DD HH:MM:SS' (UTC, no tz suffix).
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

function snapAt(id: number, importance: number, createdAt: string): ContextSnapshot {
  return {
    id, project_id: 1, title: `S${id}`, category: 'note', content: `c${id}`, tags: '[]',
    created_at: createdAt, updated_at: createdAt, created_by: 'manual', embedding_hash: null,
    source: 'session', importance, last_accessed_at: null, access_count: 0,
  };
}

function fakeAccess(): AccessMarker & { ids: number[] } {
  const ids: number[] = [];
  return { ids, markSnapshotAccessed(x) { ids.push(...x); } };
}

describe('MemoryRetriever', () => {
  it('skips retrieval (no search) for a too-short query', async () => {
    let called = false;
    let logged: string | null = null;
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { called = true; return []; } };
    const out = await new MemoryRetriever(search, fakeAccess(), {
      log: (event) => { logged = event; },
    }).retrieve(1, 'p', 'fix'); // 3 chars < default min 4 (lowered from 12)
    expect(out).toEqual([]);
    expect(called).toBe(false);
    expect(logged).toBe('skip_short_query');
  });

  it('retrieves for short-but-real queries that the old 12-char gate dropped', async () => {
    let called = false;
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { called = true; return []; } };
    await new MemoryRetriever(search, fakeAccess()).retrieve(1, 'p', 'fix auth');
    expect(called).toBe(true);
  });

  it('recall returns full content with category/source, honours limit, marks access', async () => {
    const search: SnapshotSearch = {
      async searchSnapshotsHybrid() {
        return [snap(1, 'A', 'full A', 0.9), snap(2, 'B', 'full B', 0.8), snap(3, 'C', 'full C', 0.7)];
      },
    };
    const access = fakeAccess();
    const out = await new MemoryRetriever(search, access).recall(1, 'p', 'gotcha', 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'A', content: 'full A', category: 'note', source: 'manual' });
    expect(access.ids).toEqual([1, 2]);
  });

  it('recall has no min-query gate (explicit call is intent)', async () => {
    let called = false;
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { called = true; return []; } };
    const out = await new MemoryRetriever(search, fakeAccess()).recall(1, 'p', 'ab');
    expect(called).toBe(true);
    expect(out).toEqual([]);
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

  it('down-ranks a stale memory below a fresh one and surfaces a stale note', async () => {
    const stale = snapAt(2, 0.5, sqliteTime(-200 * 86_400_000)); // ~200 days old
    const fresh = snapAt(1, 0.5, sqliteTime(-60_000)); // 1 min ago
    // stale sits at the BETTER hybrid rank (index 0) — staleness + recency must flip it.
    const search: SnapshotSearch = { async searchSnapshotsHybrid() { return [stale, fresh]; } };
    const access: AccessMarker & StaleFilesBatch = {
      markSnapshotAccessed() {},
      getStaleSnapshotFilesBatch() {
        return new Map([[2, { stale: ['src/x.ts'], total: 1 }]]);
      },
    };
    const out = await new MemoryRetriever(search, access).retrieve(1, 'proj', 'how does pricing rounding work here');
    expect(out.map((o) => o.id)).toEqual(['1', '2']); // fresh first despite stale's better rank
    expect(out.find((o) => o.id === '2')!.staleNote).toContain('src/x.ts');
    expect(out.find((o) => o.id === '1')!.staleNote).toBeUndefined();
  });
});
