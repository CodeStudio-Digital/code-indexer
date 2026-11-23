/**
 * Pure-logic tests for the structural auto-index orchestration — fake
 * executor + fake DB, no better-sqlite3, no chokidar watchers started
 * (autoWatch off), so this suite runs regardless of native ABI state.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { KeyedMutex } from '../project-mutex.js';
import { DirtyQueue } from '../dirty-queue.js';
import { ProjectIndexService } from '../service.js';
import type {
  DirtyEvent,
  ProjectIndexSettings,
  StructuralExecutor,
  StructuralRunSummary,
  StructuralChangeHandler,
  StructuralProgressFrame,
} from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeDb(
  project: { structural_indexed_at: string | null; last_indexed: string | null },
  synthetic = false,
  fileCount = 2,
): CodeIndexDB {
  const getProject = () => ({
    id: 1, root_path: 'D:/fake', file_count: fileCount, symbol_count: 5,
    is_synthetic: synthetic,
    structural_indexed_at: project.structural_indexed_at,
    last_indexed: project.last_indexed,
  });
  return { getProject, getProjectCatalogEntry: getProject, countSemanticStale: () => 1 } as unknown as CodeIndexDB;
}

const SETTINGS: ProjectIndexSettings = {
  autoIndex: true, autoWatch: false, maxFiles: 20000,
  maxWatchedProjects: 3, watchDebounceMs: 50, watchOpenDelayMs: 0, watchIdleMs: 0,
  watchMaxFiles: 0, openDelayMs: 0,
};

class FakeExecutor implements StructuralExecutor {
  runs = 0;
  runProjectIds: number[] = [];
  indexCalls: string[][] = [];
  removeCalls: string[][] = [];
  delayMs = 0;
  abortTooLarge = false;
  abortEmptyScan = false;
  lastRunOpts: { maxFiles?: number; allowEmptyWipe?: boolean } | null = null;
  onRun?: () => void;
  runChanges: DirtyEvent[] = [
    { path: 'src/changed.ts', kind: 'upsert' },
    { path: 'src/deleted.ts', kind: 'delete' },
  ];
  previousItemKeys: string[] = [];
  /** Frames emitted via onProgress during the run (scan/index liveness). */
  progressFrames: StructuralProgressFrame[] = [];
  priorityEvents: Array<{ projectId: number; busy: boolean }> = [];
  setInteractivePriority(projectId: number, busy: boolean): void {
    this.priorityEvents.push({ projectId, busy });
  }
  async runStructuralIndex(
    projectId: number,
    opts: Parameters<StructuralExecutor['runStructuralIndex']>[1],
  ): Promise<StructuralRunSummary> {
    this.runs++;
    this.runProjectIds.push(projectId);
    this.lastRunOpts = opts;
    if (this.delayMs) await sleep(this.delayMs);
    if (this.abortTooLarge) {
      return { totalFiles: 99999, indexed: 0, removed: 0, skipped: 0, errorCount: 0, durationMs: 1, aborted: 'too_large' as const };
    }
    if (this.abortEmptyScan) {
      return { totalFiles: 0, indexed: 0, removed: 0, skipped: 0, errorCount: 0, durationMs: 1, aborted: 'empty_scan' as const };
    }
    await opts.onChanges?.(this.runChanges, this.previousItemKeys);
    this.onRun?.();
    for (const f of this.progressFrames) opts.onProgress?.(f);
    return { totalFiles: 2, indexed: 2, removed: 0, skipped: 0, errorCount: 0, durationMs: 1 };
  }
  async indexFiles(
    _projectId: number,
    relPaths: string[],
    opts?: { onChanges?: StructuralChangeHandler },
  ) {
    await opts?.onChanges?.(
      relPaths.map((path) => ({ path, kind: 'upsert' as const })),
      this.previousItemKeys,
    );
    this.indexCalls.push([...relPaths]);
    if (this.delayMs) await sleep(this.delayMs);
    return { indexed: relPaths.length, skippedUnchanged: 0, skippedIgnored: 0, removed: 0, errors: 0 };
  }
  async removeFiles(
    _projectId: number,
    relPaths: string[],
    opts?: { onChanges?: StructuralChangeHandler },
  ) {
    await opts?.onChanges?.(
      relPaths.map((path) => ({ path, kind: 'delete' as const })),
      this.previousItemKeys,
    );
    this.removeCalls.push([...relPaths]);
    return { removed: relPaths.length };
  }
}

class FakeFileWatcher {
  started: number[] = [];
  stopped: number[] = [];
  active = new Set<number>();
  events = new Map<number, { onFileChanged: (events: Array<{ path: string; kind: 'upsert' | 'delete'; isDir?: boolean }>) => void | Promise<void> }>();
  waitCalls: number[] = [];
  flushCalls: number[] = [];
  suspendCalls: number[] = [];
  resumeCalls: number[] = [];
  onStart?: (projectId: number) => void;
  onReadyWait?: (projectId: number) => void;

  startWatching(
    projectId: number,
    _options: object,
    events: { onFileChanged: (events: Array<{ path: string; kind: 'upsert' | 'delete'; isDir?: boolean }>) => void | Promise<void> },
  ): void {
    this.started.push(projectId);
    this.onStart?.(projectId);
    this.active.add(projectId);
    this.events.set(projectId, events);
  }

  async waitUntilReady(projectId: number): Promise<void> {
    this.waitCalls.push(projectId);
    this.onReadyWait?.(projectId);
  }

  async flushPending(projectId: number): Promise<void> {
    this.flushCalls.push(projectId);
  }

  suspend(projectId: number): void {
    this.suspendCalls.push(projectId);
  }

  resume(projectId: number): void {
    this.resumeCalls.push(projectId);
  }

  async stopWatching(projectId: number): Promise<void> {
    this.stopped.push(projectId);
    this.active.delete(projectId);
    this.events.delete(projectId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.active).map((id) => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.active.has(projectId);
  }
}

class FakeGitMetaWatcher {
  started: number[] = [];
  stopped: number[] = [];
  active = new Set<number>();

  startWatching(projectId: number): void {
    this.started.push(projectId);
    this.active.add(projectId);
  }

  async stopWatching(projectId: number): Promise<void> {
    this.stopped.push(projectId);
    this.active.delete(projectId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.active).map((id) => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.active.has(projectId);
  }

  async readCurrent() {
    return { branch: 'main', detached: false, changed: [] };
  }
}

describe('KeyedMutex', () => {
  it('serializes per key (FIFO) and isolates keys', async () => {
    const m = new KeyedMutex<number>();
    const order: string[] = [];
    const a1 = m.withLock(1, async () => { await sleep(20); order.push('a1'); });
    const a2 = m.withLock(1, async () => { order.push('a2'); });
    const b1 = m.withLock(2, async () => { order.push('b1'); });
    await Promise.all([a1, a2, b1]);
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1')); // key 2 didn't wait
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2')); // FIFO on key 1
  });

  it('an error does not poison the chain', async () => {
    const m = new KeyedMutex<number>();
    await expect(m.withLock(1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(m.withLock(1, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('DirtyQueue', () => {
  it('dedupes by path; latest kind wins; batch splits and drains', () => {
    const q = new DirtyQueue();
    q.add(1, [{ path: 'a.ts', kind: 'upsert' }, { path: 'b.ts', kind: 'upsert' }]);
    q.add(1, [{ path: 'a.ts', kind: 'delete' }]); // overrides
    expect(q.size(1)).toBe(2);
    const batch = q.takeBatch(1, 10);
    expect(batch.deletes).toEqual(['a.ts']);
    expect(batch.upserts).toEqual(['b.ts']);
    expect(q.size(1)).toBe(2);
    q.ack(1, batch);
    expect(q.size(1)).toBe(0);
  });
  it('retains unacknowledged work and never acknowledges a newer event', () => {
    const q = new DirtyQueue();
    q.add(1, [{ path: 'a.ts', kind: 'upsert' }, { path: 'b.ts', kind: 'delete' }]);
    const batch = q.takeBatch(1, 10);
    expect(q.takeBatch(1, 10)).toEqual(batch);
    q.add(1, [{ path: 'a.ts', kind: 'delete' }]);
    q.ack(1, batch, ['b.ts']);
    expect(q.takeBatch(1, 10).deletes).toEqual(['a.ts', 'b.ts']);
    q.ack(1, q.takeBatch(1, 10));
    expect(q.size(1)).toBe(0);
  });
});

describe('ProjectIndexService', () => {
  it('disables scanning and watching for the owner and its worktree, retaining manual indexing and other projects', async () => {
    const db = fakeDb({ structural_indexed_at: null, last_indexed: null });
    const project = db.getProjectCatalogEntry(1)!;
    let enabled = 0;
    db.getProjectCatalogEntry = id => ({ ...project, id, worktree_parent_id: id === 2 ? 1 : null,
      auto_index_enabled: id === 1 ? enabled : 1 });
    const watch = new FakeFileWatcher(), exec = new FakeExecutor();
    const service = new ProjectIndexService(db, exec, watch as never, () => ({ ...SETTINGS, autoWatch: true }), new FakeGitMetaWatcher() as never);
    try {
      service.activate(1, 'main'); service.activate(2, 'checkout');
      service.ensureFresh(1, 'session'); service.ensureFresh(2, 'branch');
      service.markDirty(1, [{ path: 'edited.ts', kind: 'upsert' }]);
      expect((await service.ensureStructuralReady(1, 1000)).status).toBe('disabled');
      expect((await service.refreshStructural(2, 1000)).status).toBe('disabled');
      expect(exec.runs).toBe(0);
      expect(watch.started).toEqual([]);
      expect((await service.reconcileStructural(1, 1000)).status).toBe('ready');
      expect(watch.started).toEqual([]);
      service.activate(3, 'other');
      await vi.waitFor(() => expect(exec.runProjectIds).toContain(3));
      enabled = 1;
      await service.applyAutoIndexSetting(1);
      await vi.waitFor(() => expect(exec.runProjectIds).toContain(2));
      expect(watch.active).toEqual(new Set([1, 2, 3]));
    } finally { await service.dispose(); }
  });

  it('aborts an active automatic pass and ignores queued and late work after the switch is turned off', async () => {
    const db = fakeDb({ structural_indexed_at: null, last_indexed: null });
    const row = { ...db.getProjectCatalogEntry(1)!, auto_index_enabled: 1 };
    db.getProjectCatalogEntry = () => row;
    const exec = new FakeExecutor();
    let signal: AbortSignal | undefined;
    const start = vi.spyOn(exec, 'runStructuralIndex').mockImplementation(async (_id, opts) => {
      const runSignal = opts.signal;
      if (!runSignal) throw new Error('Automatic indexing must receive an abort signal');
      signal = runSignal;
      await new Promise<void>(resolve => runSignal.addEventListener('abort', () => resolve(), { once: true }));
      return { totalFiles: 0, indexed: 0, removed: 0, skipped: 0, errorCount: 0, durationMs: 1, aborted: 'signal' };
    });
    const svc = new ProjectIndexService(db, exec, undefined, () => SETTINGS);
    try {
      svc.ensureFresh(1, 'session');
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      svc.ensureFresh(1, 'workspace');
      row.auto_index_enabled = 0;
      await svc.applyAutoIndexSetting(1);
      expect(signal?.aborted).toBe(true);
      await vi.waitFor(() => expect(svc.getStatus(1).phase).not.toBe('scanning'));
      expect(svc.getStatus(1)).toMatchObject({ autoIndexEnabled: false, watcherActive: false });
      expect(start).toHaveBeenCalledOnce();
    } finally { await svc.dispose(); }
  });
  function makeService(
    executor: FakeExecutor,
    db = fakeDb({ structural_indexed_at: null, last_indexed: null }),
    settings: ProjectIndexSettings = SETTINGS,
  ) {
    return new ProjectIndexService(db, executor, undefined, () => settings);
  }

  it('ensureFresh runs once; concurrent calls no-op while running', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 30;
    const svc = makeService(exec);
    svc.ensureFresh(1, 'open');
    svc.ensureFresh(1, 'open');
    svc.ensureFresh(1, 'session');
    await sleep(80);
    expect(exec.runs).toBe(1);
    for (let i = 0; i < 100; i++) svc.ensureFresh(1, 'session');
    await sleep(20);
    expect(exec.runs).toBe(1);
    await svc.dispose();
  });

  it('coalesces a burst of global-workspace changes into one follow-up reconciliation', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 25;
    const svc = makeService(exec);

    svc.ensureFresh(1, 'open');
    await sleep(5);
    for (let i = 0; i < 50; i++) svc.ensureFresh(1, 'workspace');
    await sleep(90);

    expect(exec.runs).toBe(2);
    await svc.dispose();
  });

  it('activation is idempotent and deactivation cancels a deferred reconciliation', async () => {
    const exec = new FakeExecutor();
    const svc = makeService(exec, undefined, { ...SETTINGS, openDelayMs: 40 });

    const first = svc.activate(1, 'view-a');
    const duplicate = svc.activate(1, 'view-a');
    expect(first).toMatchObject({ scheduled: true, delayMs: 40, largeProject: false });
    expect(duplicate.scheduled).toBe(true);
    expect(svc.getStatus(1).scheduledRun?.reason).toBe('activation');

    expect(svc.deactivate(1, 'view-a')).toBe(true);
    await sleep(60);
    expect(exec.runs).toBe(0);
    expect(svc.getStatus(1).scheduledRun).toBeUndefined();
    await svc.dispose();
  });

  it('reports final deactivation only after the last project view leaves', async () => {
    const svc = makeService(new FakeExecutor(), undefined, { ...SETTINGS, openDelayMs: 40 });
    svc.activate(1, 'view-a');
    svc.activate(1, 'view-b');

    expect(svc.deactivate(1, 'view-a')).toBe(false);
    expect(svc.deactivate(1, 'view-b')).toBe(true);
    expect(svc.deactivate(1, 'unknown-view')).toBe(true);
    await svc.dispose();
  });

  it('performs one stat-first reconciliation per reopen lifecycle', async () => {
    const projectRow = {
      structural_indexed_at: '2026-07-14T00:00:00Z' as string | null,
      last_indexed: null,
    };
    const exec = new FakeExecutor();
    const svc = makeService(exec, fakeDb(projectRow));

    svc.activate(1, 'view-a');
    await sleep(25);
    for (let i = 0; i < 25; i++) svc.ensureFresh(1, 'session');
    await sleep(10);
    expect(exec.runs).toBe(1);

    expect(svc.deactivate(1, 'view-a')).toBe(true);
    svc.activate(1, 'view-b');
    await sleep(25);
    expect(exec.runs).toBe(2);
    await svc.dispose();
  });

  it('does not activate semantic backfill from a stale reopen baseline before reconcile+drain', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 25;
    const svc = makeService(
      exec,
      fakeDb({ structural_indexed_at: '2026-07-14T00:00:00Z', last_indexed: null }),
    );
    const lifecycle: string[] = [];
    svc.setSemanticCatchup({
      noteDelta: () => undefined,
      ensureProject: async () => undefined,
      projectReady: (projectId) => { lifecycle.push(`ready:${projectId}`); },
    });

    svc.activate(1, 'view-a');
    expect(lifecycle).toEqual([]);
    await sleep(10);
    expect(lifecycle).toEqual([]);
    await sleep(50);
    expect(lifecycle).toEqual(['ready:1']);
    await svc.dispose();
  });

  it.each([false, true])('uses the large-project delay only until a baseline exists (published: %s)', async published => {
    const previous = process.env.MCP_INDEX_LARGE_OPEN_DELAY_MS;
    process.env.MCP_INDEX_LARGE_OPEN_DELAY_MS = '40';
    const exec = new FakeExecutor();
    const db = fakeDb({ structural_indexed_at: published ? '2026-07-14T00:00:00Z' : null, last_indexed: null }, false, 15_000);
    const svc = makeService(exec, db, { ...SETTINGS, openDelayMs: 0 });
    try {
      expect(svc.activate(1, 'view-a')).toMatchObject({ scheduled: !published, delayMs: published ? 0 : 40, largeProject: true });
      expect(svc.activate(1, 'view-b')).toMatchObject({ scheduled: !published, delayMs: null, largeProject: true });
      await sleep(60);
      expect(exec.runs).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.MCP_INDEX_LARGE_OPEN_DELAY_MS;
      else process.env.MCP_INDEX_LARGE_OPEN_DELAY_MS = previous;
      await svc.dispose();
    }
  });

  it('marks a deferred synthetic workspace busy before the composer can send', async () => {
    const exec = new FakeExecutor();
    const db = fakeDb({ structural_indexed_at: null, last_indexed: null }, true);
    const svc = makeService(exec, db, { ...SETTINGS, openDelayMs: 10_000 });

    svc.ensureFresh(1, 'session');

    expect(svc.getStatus(1).phase).toBe('scanning');
    expect(exec.runs).toBe(0);
    await svc.dispose();
  });

  it('phase transitions: none → scanning/indexing → structural_ready', async () => {
    const projectRow = { structural_indexed_at: null as string | null, last_indexed: null };
    const exec = new FakeExecutor();
    exec.onRun = () => { projectRow.structural_indexed_at = '2026-06-12T00:00:00Z'; };
    const svc = makeService(exec, fakeDb(projectRow));
    expect(svc.getStatus(1).phase).toBe('none');
    svc.ensureFresh(1, 'open');
    await sleep(50);
    expect(svc.getStatus(1).phase).toBe('structural_ready');
    expect(svc.getStatus(1).lastStructuralAt).toBeTruthy();
    await svc.dispose();
  });

  it('forces a deferred structural run and waits until the index is ready', async () => {
    const projectRow = { structural_indexed_at: null as string | null, last_indexed: null };
    const exec = new FakeExecutor();
    exec.delayMs = 15;
    exec.onRun = () => { projectRow.structural_indexed_at = '2026-07-10T00:00:00Z'; };
    const svc = makeService(exec, fakeDb(projectRow), { ...SETTINGS, openDelayMs: 10_000 });

    svc.ensureFresh(1, 'session');
    const result = await svc.ensureStructuralReady(1, 500);

    expect(result.status).toBe('ready');
    expect(exec.runs).toBe(1);
    expect(svc.getStatus(1).phase).toBe('structural_ready');
    await svc.dispose();
  });

  it('times out the readiness wait without starting a second run', async () => {
    const projectRow = { structural_indexed_at: null as string | null, last_indexed: null };
    const exec = new FakeExecutor();
    exec.delayMs = 40;
    exec.onRun = () => { projectRow.structural_indexed_at = '2026-07-10T00:00:00Z'; };
    const svc = makeService(exec, fakeDb(projectRow));

    const first = svc.ensureStructuralReady(1, 5);
    const second = svc.ensureStructuralReady(1, 5);
    await expect(first).resolves.toMatchObject({ status: 'timeout' });
    await expect(second).resolves.toMatchObject({ status: 'timeout' });
    expect(exec.runs).toBe(1);
    await sleep(60);
    await svc.dispose();
  });

  it('does not deadlock when automatic indexing is disabled', async () => {
    const exec = new FakeExecutor();
    const svc = makeService(exec, undefined, { ...SETTINGS, autoIndex: false });
    await expect(svc.ensureStructuralReady(1, 50)).resolves.toMatchObject({ status: 'disabled' });
    expect(exec.runs).toBe(0);
    await svc.dispose();
  });

  it('does not start the index or runner gate after the request is cancelled', async () => {
    const exec = new FakeExecutor();
    const svc = makeService(exec);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(svc.ensureStructuralReady(1, 50, ctrl.signal)).resolves.toMatchObject({ status: 'aborted' });
    expect(exec.runs).toBe(0);
    await svc.dispose();
  });

  it('scan-phase progress keeps phase=scanning with a live count; index frames flip to structural_indexing', async () => {
    const exec = new FakeExecutor();
    // First call always clears the 150ms throttle (lastProgressAt unset); the
    // index frame is a "done" frame (current===total) so it flushes too — no
    // sleeps needed to observe both transitions.
    exec.progressFrames = [
      { phase: 'scanning', current: 750, total: 0, currentFile: '' },
      { phase: 'indexing', current: 4, total: 4, currentFile: 'a.ts' },
    ];
    const svc = makeService(exec);
    const frames: Array<{ phase: string; current?: number; total?: number }> = [];
    svc.subscribe(1, (s) => frames.push({ phase: s.phase, current: s.progress?.current, total: s.progress?.total }));
    svc.ensureFresh(1, 'open');
    await sleep(40);

    // Scan frame routed to setScanProgress: phase stays 'scanning', count shown.
    expect(frames.some((f) => f.phase === 'scanning' && f.current === 750)).toBe(true);
    // Index frame routed to setProgress: phase becomes 'structural_indexing' with real total.
    expect(frames.some((f) => f.phase === 'structural_indexing' && f.total === 4)).toBe(true);
    await svc.dispose();
  });

  it('too_large surfaces as a phase', async () => {
    const exec = new FakeExecutor();
    exec.abortTooLarge = true;
    const svc = makeService(exec);
    svc.ensureFresh(1, 'open');
    await sleep(30);
    expect(svc.getStatus(1).phase).toBe('too_large');
    await svc.dispose();
  });

  it('empty_scan surfaces as an actionable error; manual bypasses the guard', async () => {
    const exec = new FakeExecutor();
    exec.abortEmptyScan = true;
    const svc = makeService(exec);
    svc.ensureFresh(1, 'open');
    await sleep(30);
    expect(exec.lastRunOpts?.allowEmptyWipe).toBeFalsy();
    expect(svc.getStatus(1).phase).toBe('error');
    expect(svc.getStatus(1).error).toContain('0 files');

    svc.ensureFresh(1, 'manual');
    await sleep(30);
    expect(exec.lastRunOpts?.allowEmptyWipe).toBe(true);
    await svc.dispose();
  });

  it('a ready stamp over an EMPTY index derives as none, never ready', async () => {
    const exec = new FakeExecutor();
    const svc = new ProjectIndexService(
      // Stamp present but zero rows — the screenshot bug scenario.
      {
        getProjectCatalogEntry: () => ({
          id: 1, root_path: 'D:/fake', file_count: 0, symbol_count: 0,
          structural_indexed_at: '2026-06-12T00:00:00Z', last_indexed: null,
        }),
        countSemanticStale: () => 0,
      } as never,
      exec, undefined, () => SETTINGS,
    );
    expect(svc.getStatus(1).phase).toBe('none');
    await svc.dispose();
  });

  it('markDirty reconciles deletes and upserts against current disk state, serialized with the run', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 30;
    const svc = makeService(exec);
    svc.ensureFresh(1, 'open');                       // takes the lock first
    await sleep(5);                                  // scan is in flight
    svc.markDirty(1, [
      { path: 'src/x.ts', kind: 'upsert' },
      { path: 'src/y.ts', kind: 'delete' },
    ]);
    expect(svc.getStatus(1).dirtyPending).toBe(2);    // buffered during the run
    await sleep(150);
    expect(exec.removeCalls).toEqual([]);
    expect(exec.indexCalls).toEqual([['src/x.ts', 'src/y.ts']]);
    expect(svc.getStatus(1).dirtyPending).toBe(0);
    await svc.dispose();
  });

  it('incremental dirty queue drains in bounded batches', async () => {
    const exec = new FakeExecutor();
    const svc = makeService(exec);
    svc.markDirty(
      1,
      Array.from({ length: 450 }, (_, i) => ({ path: `src/file-${i}.ts`, kind: 'upsert' as const })),
    );
    await sleep(80);
    expect(exec.indexCalls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(svc.getStatus(1).dirtyPending).toBe(0);
    await svc.dispose();
  });

  it('fences semantic activation immediately on dirty input and catches up only after the structural drain', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 25;
    const svc = makeService(exec);
    const events: string[] = [];
    svc.setSemanticCatchup({
      noteDelta: (projectId) => events.push(`delta:${projectId}`),
      ensureProject: async (projectId) => { events.push(`ensure:${projectId}`); },
    });

    svc.markDirty(1, [{ path: 'src/new.ts', kind: 'upsert' }]);
    expect(events).toEqual(['delta:1']);
    await sleep(10);
    expect(events).toEqual(['delta:1']);

    await sleep(50);
    expect(exec.indexCalls).toEqual([['src/new.ts']]);
    expect(events).toEqual(['delta:1', 'ensure:1']);
    await svc.dispose();
  });

  it('merges worker-captured semantic keys before an incremental mutation', async () => {
    const exec = new FakeExecutor();
    exec.previousItemKeys = ['file:7', 'symbol:11'];
    const svc = makeService(exec);
    const fences: Array<{ paths: string[]; keys: readonly string[]; indexed: number }> = [];
    svc.setSemanticCatchup({
      noteDelta: (_projectId, changes, previousKeys = []) => {
        fences.push({
          paths: changes.map((change) => change.path),
          keys: previousKeys,
          indexed: exec.indexCalls.length,
        });
      },
      ensureProject: async () => undefined,
    });

    svc.markDirty(1, [{ path: 'src/existing.ts', kind: 'upsert' }]);
    expect(fences).toEqual([{
      paths: ['src/existing.ts'],
      keys: [],
      indexed: 0,
    }]);
    await sleep(30);

    expect(fences).toEqual([
      { paths: ['src/existing.ts'], keys: [], indexed: 0 },
      { paths: ['src/existing.ts'], keys: ['file:7', 'symbol:11'], indexed: 0 },
    ]);
    expect(exec.indexCalls).toEqual([['src/existing.ts']]);
    await svc.dispose();
  });

  it('fences exact semantic deltas before a changed structural pass mutates rows', async () => {
    const projectRow = { structural_indexed_at: null as string | null, last_indexed: null };
    const exec = new FakeExecutor();
    exec.delayMs = 20;
    exec.onRun = () => {
      events.push('mutate');
      projectRow.structural_indexed_at = '2026-07-15T00:00:00Z';
    };
    const svc = makeService(exec, fakeDb(projectRow));
    const events: string[] = [];
    svc.setSemanticCatchup({
      noteDelta: (projectId, changes) => events.push(`delta:${projectId}:${changes[0]?.path}`),
      ensureProject: async (projectId) => { events.push(`ensure:${projectId}`); },
      projectReady: (projectId) => { events.push(`ready:${projectId}`); },
    });

    svc.activate(1, 'view-a');
    await sleep(5);
    expect(events).toEqual([]);
    await sleep(40);
    expect(events).toEqual(['delta:1:src/changed.ts', 'mutate', 'ready:1', 'ensure:1']);
    await svc.dispose();

    const emptyExec = new FakeExecutor();
    emptyExec.abortEmptyScan = true;
    const emptySvc = makeService(emptyExec);
    const emptyEvents: string[] = [];
    emptySvc.setSemanticCatchup({
      noteDelta: (projectId) => emptyEvents.push(`delta:${projectId}`),
      ensureProject: async (projectId) => { emptyEvents.push(`ensure:${projectId}`); },
      projectReady: (projectId) => { emptyEvents.push(`ready:${projectId}`); },
    });
    emptySvc.ensureFresh(1, 'open');
    await sleep(30);
    expect(emptySvc.getStatus(1).phase).toBe('error');
    expect(emptyEvents).toEqual([]);
    await emptySvc.dispose();
  });

  it('announces semantic lifecycle readiness once and inactivity after the final view leaves', async () => {
    const exec = new FakeExecutor();
    const events: string[] = [];
    const projectRow = { structural_indexed_at: null as string | null, last_indexed: null };
    exec.onRun = () => { projectRow.structural_indexed_at = '2026-07-15T00:00:00Z'; };
    const svc = makeService(exec, fakeDb(projectRow), { ...SETTINGS, openDelayMs: 0 });
    svc.setSemanticCatchup({
      noteDelta: () => undefined,
      ensureProject: async () => undefined,
      projectReady: (projectId) => { events.push(`ready:${projectId}`); },
      projectInactive: (projectId) => { events.push(`inactive:${projectId}`); },
    });

    svc.activate(1, 'view-a');
    svc.activate(1, 'view-b');
    await sleep(30);
    expect(events).toEqual(['ready:1']);
    expect(svc.deactivate(1, 'view-a')).toBe(false);
    expect(events).toEqual(['ready:1']);
    expect(svc.deactivate(1, 'view-b')).toBe(true);
    await sleep(0);
    expect(events).toEqual(['ready:1', 'inactive:1']);
    await svc.dispose();
  });

  it('git-meta subscription does not start the recursive file watcher', async () => {
    const exec = new FakeExecutor();
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true }),
      gitWatcher as never,
    );
    const unsubscribe = svc.subscribeGitMeta(1, () => {});
    expect(gitWatcher.started).toEqual([1]);
    expect(fileWatcher.started).toEqual([]);
    unsubscribe();
    await svc.dispose();
  });

  it('reconciles the interval between a timed-out initial scan and live watcher coverage', async () => {
    const prev = process.env.MCP_WATCH_READY_TIMEOUT_MS;
    process.env.MCP_WATCH_READY_TIMEOUT_MS = '10';
    const exec = new FakeExecutor();
    const row = { structural_indexed_at: null as string | null, last_indexed: null };
    exec.onRun = () => { row.structural_indexed_at = '2026-01-01T00:00:00Z'; };
    const watcher = new FakeFileWatcher();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    watcher.waitUntilReady = () => ready;
    const svc = new ProjectIndexService(fakeDb(row), exec, watcher as never, () => ({ ...SETTINGS, autoWatch: true }), new FakeGitMetaWatcher() as never);
    try {
      svc.activate(1, 'view');
      expect((await svc.ensureStructuralReady(1, 2000)).status).toBe('ready');
      expect(exec.runs).toBe(1);
      release();
      await vi.waitFor(() => expect(exec.runs).toBe(2));
    } finally {
      release();
      if (prev === undefined) delete process.env.MCP_WATCH_READY_TIMEOUT_MS;
      else process.env.MCP_WATCH_READY_TIMEOUT_MS = prev;
      await svc.dispose();
    }
  });

  it('arms and awaits the file watcher before scanning, then drains scan-time changes before ready', async () => {
    const projectRow = { structural_indexed_at: null as string | null, last_indexed: null };
    const exec = new FakeExecutor();
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const order: string[] = [];
    fileWatcher.onStart = () => order.push('watch:start');
    fileWatcher.onReadyWait = () => order.push('watch:ready');
    exec.onRun = () => {
      order.push('scan');
      projectRow.structural_indexed_at = '2026-07-15T00:00:00Z';
      void fileWatcher.events.get(1)?.onFileChanged([
        { path: 'D:/fake/src/during-scan.ts', kind: 'upsert' },
      ]);
    };
    const svc = new ProjectIndexService(
      fakeDb(projectRow),
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true }),
      gitWatcher as never,
    );

    svc.activate(1, 'view-a');
    const readiness = await svc.ensureStructuralReady(1, 500);

    expect(readiness.status).toBe('ready');
    expect(order.slice(0, 3)).toEqual(['watch:start', 'watch:ready', 'scan']);
    expect(exec.indexCalls).toEqual([['src/during-scan.ts']]);
    expect(fileWatcher.flushCalls).toEqual([1]);
    await svc.dispose();
  });

  it('branch reconcile suppresses the checkout burst: dirty cleared, suspend→resume bracket the run', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 20;
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: '2026-07-14T00:00:00Z', last_indexed: null }),
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true }),
      gitWatcher as never,
    );

    // Checkout burst lands in the dirty queue first…
    svc.markDirty(1, Array.from({ length: 5 }, (_, i) => ({ path: `src/burst-${i}.ts`, kind: 'upsert' as const })));
    // …then the HEAD event triggers the branch reconcile (same sync tick, so
    // the drain never gets a chance to parse the burst file-by-file).
    svc.ensureFresh(1, 'branch');
    expect(fileWatcher.suspendCalls).toContain(1);
    expect(svc.getStatus(1).dirtyPending).toBe(5); // retained until reconcile commits
    await sleep(80);
    expect(exec.runs).toBe(1);
    expect(fileWatcher.resumeCalls).toContain(1);
    expect(exec.indexCalls.flat().filter((p) => p.startsWith('src/burst-'))).toEqual([]);
    await svc.dispose();
  });

  it('a branch switch during an open run suppresses immediately and chains one follow-up reconcile', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 30;
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true }),
      gitWatcher as never,
    );

    svc.ensureFresh(1, 'open');
    await sleep(5); // open run in flight
    svc.markDirty(1, [{ path: 'src/burst.ts', kind: 'upsert' }]);
    svc.ensureFresh(1, 'branch');
    expect(fileWatcher.suspendCalls).toContain(1);
    expect(svc.getStatus(1).dirtyPending).toBe(1);
    await sleep(140);
    expect(exec.runs).toBe(2); // open + queued branch follow-up
    expect(fileWatcher.resumeCalls).toContain(1);
    expect(exec.indexCalls.flat()).not.toContain('src/burst.ts');
    await svc.dispose();
  });

  it('deactivate resumes a suspension whose deferred reconcile was cancelled with it', async () => {
    const exec = new FakeExecutor();
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true, openDelayMs: 5_000 }),
      gitWatcher as never,
    );

    svc.activate(1, 'view-a'); // arms the deferred activation run
    svc.ensureFresh(1, 'branch'); // suppresses, then defers to the pending run
    expect(fileWatcher.suspendCalls).toContain(1);
    expect(svc.deactivate(1, 'view-a')).toBe(true); // cancels the deferred run
    expect(fileWatcher.resumeCalls).toContain(1); // suppression must not outlive it
    expect(exec.runs).toBe(0);
    await svc.dispose();
  });

  it('reconciles closed files in skipped projects without an open-document provider', async () => {
    const exec = new FakeExecutor();
    const watcher = new FakeFileWatcher() as FakeFileWatcher & { isSkipped(id: number): boolean };
    watcher.isSkipped = () => true;
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: '2026-07-14T00:00:00Z', last_indexed: null }),
      exec, watcher as never, () => ({ ...SETTINGS, autoWatch: true }), new FakeGitMetaWatcher() as never,
    );
    try {
      svc.activate(1, 'view');
      await vi.waitFor(() => expect(exec.runs).toBe(1));
      await sleep(15);
      expect(svc.getStatus(1)).toMatchObject({ watcherActive: false, watcherMode: 'polling' });
      const poll = () => (svc as unknown as { pollSkippedProjects(): Promise<void> }).pollSkippedProjects();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 61_000);
      await poll();
      await vi.waitFor(() => expect(exec.runs).toBe(2));
      await poll();
      expect(exec.runs).toBe(2); // never enqueue overlapping scans
      svc.deactivate(1, 'view');
      vi.setSystemTime(Date.now() + 61_000);
      await poll();
      expect(exec.runs).toBe(2);
    } finally { vi.useRealTimers(); await svc.dispose(); }
  });

  it('over-budget fallback polls open-file mtimes into markDirty (skipped projects only)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-fallback-'));
    const prevPoll = process.env.MCP_WATCH_FALLBACK_POLL_MS;
    process.env.MCP_WATCH_FALLBACK_POLL_MS = '25';
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
      const exec = new FakeExecutor();
      const fileWatcher = new FakeFileWatcher() as FakeFileWatcher & { isSkipped(id: number): boolean };
      fileWatcher.isSkipped = () => true; // budget guard skipped this project
      const gitWatcher = new FakeGitMetaWatcher();
      const db = {
        getProjectCatalogEntry: () => ({ id: 1, root_path: root, file_count: 50_000 }),
        getProject: () => ({
          id: 1, root_path: root, file_count: 50_000, symbol_count: 0,
          structural_indexed_at: '2026-07-14T00:00:00Z', last_indexed: null,
        }),
        countSemanticStale: () => 0,
      } as unknown as CodeIndexDB;
      const svc = new ProjectIndexService(
        db, exec, fileWatcher as never,
        () => ({ ...SETTINGS, autoWatch: true, openDelayMs: 10_000 }),
        gitWatcher as never,
      );
      svc.activate(1, 'view-a');
      svc.setOpenPathsProvider(() => ['a.ts']);

      await sleep(60); // ≥1 tick — baseline only, nothing dirty
      expect(exec.indexCalls).toEqual([]);

      // External edit: bump mtime well past the baseline.
      const future = (Date.now() + 5_000) / 1000;
      utimesSync(join(root, 'a.ts'), future, future);
      await sleep(90); // next tick sees the change → markDirty → drain
      expect(exec.indexCalls.flat()).toContain('a.ts');
      await svc.dispose();
    } finally {
      if (prevPoll === undefined) delete process.env.MCP_WATCH_FALLBACK_POLL_MS;
      else process.env.MCP_WATCH_FALLBACK_POLL_MS = prevPoll;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the fallback poll ignores projects that are NOT budget-skipped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-fallback-live-'));
    const prevPoll = process.env.MCP_WATCH_FALLBACK_POLL_MS;
    process.env.MCP_WATCH_FALLBACK_POLL_MS = '25';
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
      const exec = new FakeExecutor();
      const fileWatcher = new FakeFileWatcher() as FakeFileWatcher & { isSkipped(id: number): boolean };
      fileWatcher.isSkipped = () => false; // chokidar owns freshness here
      const gitWatcher = new FakeGitMetaWatcher();
      const db = {
        getProjectCatalogEntry: () => ({ id: 1, root_path: root, file_count: 10 }),
        getProject: () => ({
          id: 1, root_path: root, file_count: 10, symbol_count: 0,
          structural_indexed_at: '2026-07-14T00:00:00Z', last_indexed: null,
        }),
        countSemanticStale: () => 0,
      } as unknown as CodeIndexDB;
      const svc = new ProjectIndexService(
        db, exec, fileWatcher as never,
        () => ({ ...SETTINGS, autoWatch: true, openDelayMs: 10_000 }),
        gitWatcher as never,
      );
      svc.activate(1, 'view-a');
      svc.setOpenPathsProvider(() => ['a.ts']);
      await sleep(60);
      const future = (Date.now() + 5_000) / 1000;
      utimesSync(join(root, 'a.ts'), future, future);
      await sleep(90);
      expect(exec.indexCalls).toEqual([]); // fallback never fired
      await svc.dispose();
    } finally {
      if (prevPoll === undefined) delete process.env.MCP_WATCH_FALLBACK_POLL_MS;
      else process.env.MCP_WATCH_FALLBACK_POLL_MS = prevPoll;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps all active project lifecycles when the watcher cap is exceeded', async () => {
    const exec = new FakeExecutor();
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const db = fakeDb({ structural_indexed_at: '2026-07-14T00:00:00Z', last_indexed: null });
    const svc = new ProjectIndexService(
      db,
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true, maxWatchedProjects: 1, openDelayMs: 20 }),
      gitWatcher as never,
    );

    svc.activate(1, 'view-1');
    svc.activate(2, 'view-2');
    svc.activate(3, 'view-3');
    await sleep(60);

    expect(exec.runProjectIds.sort()).toEqual([1, 2, 3]);
    expect(fileWatcher.stopped).toEqual([]);
    expect(gitWatcher.stopped).toEqual([]);
    await svc.dispose();
  });

  it('file watcher starts after subscribe delay and stops after idle cleanup', async () => {
    const exec = new FakeExecutor();
    const fileWatcher = new FakeFileWatcher();
    const gitWatcher = new FakeGitMetaWatcher();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec,
      fileWatcher as never,
      () => ({ ...SETTINGS, autoWatch: true, watchOpenDelayMs: 30, watchIdleMs: 0 }),
      gitWatcher as never,
    );
    const unsubscribe = svc.subscribeFsEvents(1, () => {});
    expect(fileWatcher.started).toEqual([]);
    await sleep(45);
    expect(fileWatcher.started).toEqual([1]);
    unsubscribe();
    await sleep(10);
    expect(fileWatcher.stopped).toContain(1);
    await svc.dispose();
  });

  it('withSemanticRun waits for the structural run (single lock)', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 40;
    const svc = makeService(exec);
    const order: string[] = [];
    svc.ensureFresh(1, 'open');
    exec.onRun = () => order.push('structural');
    await svc.withSemanticRun(1, async () => { order.push('full'); });
    expect(order).toEqual(['structural', 'full']);
    await svc.dispose();
  });

  it('coalesces nested interactive priority leases and always resumes after failure', async () => {
    const exec = new FakeExecutor();
    const svc = makeService(exec);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = svc.withInteractiveFilesystemPriority(1, () =>
      new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const second = svc.withInteractiveFilesystemPriority(1, () =>
      new Promise<void>((resolve) => { releaseSecond = resolve; }));

    expect(exec.priorityEvents).toEqual([{ projectId: 1, busy: true }]);
    releaseFirst();
    await first;
    expect(exec.priorityEvents).toEqual([{ projectId: 1, busy: true }]);
    releaseSecond();
    await second;
    expect(exec.priorityEvents).toEqual([
      { projectId: 1, busy: true },
      { projectId: 1, busy: false },
    ]);

    await expect(svc.withInteractiveFilesystemPriority(1, async () => {
      throw new Error('mutation failed');
    })).rejects.toThrow('mutation failed');
    expect(exec.priorityEvents.slice(-2)).toEqual([
      { projectId: 1, busy: true },
      { projectId: 1, busy: false },
    ]);
    await svc.dispose();
  });

  it('openDelayMs defers a non-manual run; manual preempts and cancels the timer', async () => {
    // Non-manual open is deferred by the delay; manual runs immediately.
    const exec = new FakeExecutor();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec, undefined, () => ({ ...SETTINGS, openDelayMs: 40 }),
    );
    svc.ensureFresh(1, 'open');
    await sleep(15);
    expect(exec.runs).toBe(0);          // still within the delay window
    await sleep(50);
    expect(exec.runs).toBe(1);          // fired after the delay
    await svc.dispose();

    // A manual trigger during the window preempts and cancels the timer:
    // exactly one run total (no redundant deferred run afterwards).
    const exec2 = new FakeExecutor();
    const svc2 = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec2, undefined, () => ({ ...SETTINGS, openDelayMs: 40 }),
    );
    svc2.ensureFresh(1, 'open');        // schedules
    svc2.ensureFresh(1, 'manual');      // preempts → immediate
    await sleep(10);
    expect(exec2.runs).toBe(1);
    await sleep(60);                     // past the original delay
    expect(exec2.runs).toBe(1);          // deferred timer was cancelled
    await svc2.dispose();
  });

  it('autoIndex=false gates non-manual triggers', async () => {
    const exec = new FakeExecutor();
    const svc = new ProjectIndexService(
      fakeDb({ structural_indexed_at: null, last_indexed: null }),
      exec, undefined, () => ({ ...SETTINGS, autoIndex: false }),
    );
    svc.ensureFresh(1, 'open');
    await sleep(20);
    expect(exec.runs).toBe(0);
    svc.ensureFresh(1, 'manual');
    await sleep(20);
    expect(exec.runs).toBe(1);
    await svc.dispose();
  });
});
