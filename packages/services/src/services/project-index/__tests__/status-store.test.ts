/**
 * Bug A (Single Source of Truth) — the in-memory status store holds the live
 * pass (`activeRun`) so a renderer that navigates away and back re-hydrates it.
 * The invariants that make that safe:
 *   - a working-phase `setPhase` PRESERVES activeRun (the original bug zeroed
 *     `progress` on every setPhase, wiping the bar mid-run);
 *   - a resting/terminal `setPhase`, `clearActiveRun`, and `refreshFromDb`
 *     all clear it (the run is over);
 *   - the deprecated `progress` alias stays in sync for the StatusBar chip.
 * Fake DB only — no better-sqlite3, runs regardless of native ABI state.
 */
import { describe, it, expect } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { ProjectIndexStatusStore } from '../status-store.js';

function fakeDb(): CodeIndexDB {
  return {
    getProjectCatalogEntry: () => ({
      id: 1, root_path: 'D:/fake', file_count: 3, symbol_count: 7,
      structural_indexed_at: '2026-06-17T00:00:00Z', last_indexed: null,
    }),
    countSemanticStale: () => 0,
  } as unknown as CodeIndexDB;
}

describe('ProjectIndexStatusStore — activeRun SoT', () => {
  it('setActiveRun publishes activeRun, the progress alias, and a working phase', () => {
    const store = new ProjectIndexStatusStore(fakeDb());
    store.setActiveRun(1, { kind: 'structural', current: 4, total: 10 });
    const s = store.get(1);
    expect(s.activeRun).toMatchObject({ kind: 'structural', current: 4, total: 10 });
    expect(s.activeRun?.startedAt).toBeTypeOf('number');
    expect(s.progress).toEqual({ current: 4, total: 10 }); // chip alias in sync
    expect(s.phase).toBe('structural_indexing');
  });

  it('a working-phase setPhase preserves the live pass; a resting one clears it', () => {
    const store = new ProjectIndexStatusStore(fakeDb());
    store.setActiveRun(1, { kind: 'semantic', current: 2, total: 8 });
    store.setPhase(1, 'semantic_indexing'); // still working → keep
    expect(store.get(1).activeRun).toBeTruthy();
    store.setPhase(1, 'semantic_ready'); // settled → clear
    expect(store.get(1).activeRun).toBeUndefined();
    expect(store.get(1).progress).toBeUndefined();
  });

  it('preserves startedAt across frames of the same kind', () => {
    const store = new ProjectIndexStatusStore(fakeDb());
    store.setActiveRun(1, { kind: 'structural', current: 1, total: 10 });
    const started = store.get(1).activeRun?.startedAt;
    store.setActiveRun(1, { kind: 'structural', current: 2, total: 10 });
    expect(store.get(1).activeRun?.startedAt).toBe(started);
  });

  it('clearActiveRun and refreshFromDb both drop the live pass', () => {
    const store = new ProjectIndexStatusStore(fakeDb());
    store.setActiveRun(1, { kind: 'structural', current: 5, total: 10 });
    store.clearActiveRun(1);
    expect(store.get(1).activeRun).toBeUndefined();
    expect(store.get(1).progress).toBeUndefined();

    store.setActiveRun(1, { kind: 'structural', current: 5, total: 10 });
    store.refreshFromDb(1); // settle from DB → structural_ready, no live pass
    expect(store.get(1).activeRun).toBeUndefined();
    expect(store.get(1).phase).toBe('structural_ready');
  });
});
