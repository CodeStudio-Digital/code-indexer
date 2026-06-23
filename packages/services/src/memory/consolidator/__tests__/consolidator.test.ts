import { describe, it, expect } from 'vitest';
import { createMemoryConsolidator } from '../index.js';
import type { ConsolSnapshot, ConsolidatorStore, ConsolidatorWriter, ConsolidatorEmbedder } from '../types.js';

const NOW = Date.parse('2026-06-13T00:00:00Z');
const OLD = '2026-01-01 00:00:00';

function snap(id: number, over: Partial<ConsolSnapshot> = {}): ConsolSnapshot {
  return {
    id, category: 'decision', title: `t${id}`, content: `c${id}`,
    importance: 0.5, access_count: 0, last_accessed_at: OLD, created_at: OLD, ...over,
  };
}

/** In-memory fake of the consolidator ports. Archive removes from the live set. */
function makeFakes(initial: ConsolSnapshot[], staleData: Map<number, { stale: string[]; total: number }>) {
  const rows = new Map(initial.map((s) => [s.id, { ...s }]));
  const archived = new Set<number>();
  const updates: Array<{ id: number; u: Record<string, unknown> }> = [];
  const archives: Array<{ id: number; reason: string }> = [];
  const logs: Array<{ status: string; merged: number; archived: number }> = [];

  const store: ConsolidatorStore = {
    listLiveSnapshots: () => [...rows.values()].filter((s) => !archived.has(s.id)),
    staleFilesBatch: (ids) => {
      const m = new Map<number, { stale: string[]; total: number }>();
      for (const id of ids) { const e = staleData.get(id); if (e) m.set(id, e); }
      return m;
    },
    unionFiles: () => {},
    setAccessStats: (id, count, last) => {
      const r = rows.get(id); if (r) { r.access_count = count; r.last_accessed_at = last; }
    },
    logDistill: (_pid, e) => logs.push({ status: e.status, merged: e.merged, archived: e.archived }),
  };
  const writer: ConsolidatorWriter = {
    update: async (id, u) => { const r = rows.get(id); if (r) { if (u.content != null) r.content = u.content; if (u.importance != null) r.importance = u.importance; } updates.push({ id, u: u as Record<string, unknown> }); },
    archive: async (id, reason) => { archived.add(id); archives.push({ id, reason }); },
  };
  const embedder: ConsolidatorEmbedder = { hasBackend: () => false, embed: async () => [] };
  return { store, writer, embedder, rows, archived, updates, archives, logs };
}

describe('memory consolidator', () => {
  const dups = [
    snap(1, { title: 'Use JWT for auth', importance: 0.6, content: 'a' }),
    snap(2, { title: 'Use JWT auth', importance: 0.7, content: 'b' }),
    snap(3, { title: 'Use JWT for authentication', importance: 0.5, content: 'c' }),
  ];
  const staleRow = snap(10, { category: 'note', importance: 0.2, last_accessed_at: OLD });
  const staleData = new Map([[10, { stale: ['f'], total: 1 }]]);

  it('merges near-duplicates and GC-archives a stale row in one pass', async () => {
    const f = makeFakes([...dups, staleRow], staleData);
    const consolidator = createMemoryConsolidator({ ...f, now: () => NOW });

    const r = await consolidator.runOnce(1, 'proj');
    expect(r.merged).toBe(1);
    expect(r.archived).toBe(1);
    expect(r.status).toBe('ok');

    // Winner is the highest-importance dup (#2), importance bumped (0.7 + 0.02*2).
    const winnerUpdate = f.updates.find((u) => u.id === 2);
    expect(winnerUpdate?.u.importance).toBeCloseTo(0.74);

    // Losers archived as merge, stale row archived by GC — soft-delete, not delete.
    expect(f.archives.map((a) => a.id).sort((a, b) => a - b)).toEqual([1, 3, 10]);
    expect(f.archives.find((a) => a.id === 1)?.reason).toBe('merged:2');
    expect(f.archives.find((a) => a.id === 10)?.reason).toBe('stale+cold+low-importance');
    expect(f.logs).toEqual([{ status: 'ok', merged: 1, archived: 1 }]);
  });

  it('is idempotent: a second pass over the settled set is a no-op', async () => {
    const f = makeFakes([...dups, staleRow], staleData);
    const consolidator = createMemoryConsolidator({ ...f, now: () => NOW });
    await consolidator.runOnce(1, 'proj');
    const r2 = await consolidator.runOnce(1, 'proj');
    expect(r2.merged).toBe(0);
    expect(r2.archived).toBe(0);
    expect(r2.status).toBe('empty');
  });

  it('reports empty for a project with fewer than two snapshots', async () => {
    const f = makeFakes([snap(1)], new Map());
    const consolidator = createMemoryConsolidator({ ...f, now: () => NOW });
    const r = await consolidator.runOnce(1, 'proj');
    expect(r.status).toBe('empty');
    expect(r.merged).toBe(0);
  });
});
