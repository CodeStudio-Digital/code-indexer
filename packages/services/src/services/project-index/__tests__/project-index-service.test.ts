/**
 * Pure-logic tests for the structural auto-index orchestration — fake
 * executor + fake DB, no better-sqlite3, no chokidar watchers started
 * (autoWatch off), so this suite runs regardless of native ABI state.
 */
import { describe, it, expect } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { KeyedMutex } from '../project-mutex.js';
import { DirtyQueue } from '../dirty-queue.js';
import { ProjectIndexService } from '../service.js';
import type { ProjectIndexSettings, StructuralExecutor, StructuralProgressFrame } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeDb(project: { structural_indexed_at: string | null; last_indexed: string | null }): CodeIndexDB {
  return {
    getProject: () => ({
      id: 1, root_path: 'D:/fake', file_count: 2, symbol_count: 5,
      structural_indexed_at: project.structural_indexed_at,
      last_indexed: project.last_indexed,
    }),
    countSemanticStale: () => 1,
  } as unknown as CodeIndexDB;
}

const SETTINGS: ProjectIndexSettings = {
  autoIndex: true, autoWatch: false, maxFiles: 20000,
  maxWatchedProjects: 3, watchDebounceMs: 50, watchOpenDelayMs: 0, watchIdleMs: 0, openDelayMs: 0,
};

class FakeExecutor implements StructuralExecutor {
  runs = 0;
  indexCalls: string[][] = [];
  removeCalls: string[][] = [];
  delayMs = 0;
  abortTooLarge = false;
  abortEmptyScan = false;
  lastRunOpts: { maxFiles?: number; allowEmptyWipe?: boolean } | null = null;
  onRun?: () => void;
  /** Frames emitted via onProgress during the run (scan/index liveness). */
  progressFrames: StructuralProgressFrame[] = [];
  async runStructuralIndex(
    _projectId: number,
    opts: { maxFiles?: number; allowEmptyWipe?: boolean; onProgress?: (p: StructuralProgressFrame) => void },
  ) {
    this.runs++;
    this.lastRunOpts = opts;
    if (this.delayMs) await sleep(this.delayMs);
    this.onRun?.();
    for (const f of this.progressFrames) opts.onProgress?.(f);
    if (this.abortTooLarge) {
      return { totalFiles: 99999, indexed: 0, removed: 0, skipped: 0, errorCount: 0, durationMs: 1, aborted: 'too_large' as const };
    }
    if (this.abortEmptyScan) {
      return { totalFiles: 0, indexed: 0, removed: 0, skipped: 0, errorCount: 0, durationMs: 1, aborted: 'empty_scan' as const };
    }
    return { totalFiles: 2, indexed: 2, removed: 0, skipped: 0, errorCount: 0, durationMs: 1 };
  }
  async indexFiles(_projectId: number, relPaths: string[]) {
    this.indexCalls.push([...relPaths]);
    if (this.delayMs) await sleep(this.delayMs);
    return { indexed: relPaths.length, skippedUnchanged: 0, skippedIgnored: 0, removed: 0, errors: 0 };
  }
  async removeFiles(_projectId: number, relPaths: string[]) {
    this.removeCalls.push([...relPaths]);
    return { removed: relPaths.length };
  }
}

class FakeFileWatcher {
  started: number[] = [];
  stopped: number[] = [];
  active = new Set<number>();
  events = new Map<number, { onFileChanged: (events: Array<{ path: string; kind: 'upsert' | 'delete'; isDir?: boolean }>) => void | Promise<void> }>();

  startWatching(
    projectId: number,
    _options: object,
    events: { onFileChanged: (events: Array<{ path: string; kind: 'upsert' | 'delete'; isDir?: boolean }>) => void | Promise<void> },
  ): void {
    this.started.push(projectId);
    this.active.add(projectId);
    this.events.set(projectId, events);
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

  readCurrent() {
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
    expect(q.size(1)).toBe(0);
  });
});

describe('ProjectIndexService', () => {
  function makeService(executor: FakeExecutor, db = fakeDb({ structural_indexed_at: null, last_indexed: null })) {
    return new ProjectIndexService(db, executor, undefined, () => SETTINGS);
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
        getProject: () => ({
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

  it('markDirty drains deletes then upserts, serialized with the run', async () => {
    const exec = new FakeExecutor();
    exec.delayMs = 30;
    const svc = makeService(exec);
    svc.ensureFresh(1, 'open');                       // takes the lock first
    svc.markDirty(1, [
      { path: 'src/x.ts', kind: 'upsert' },
      { path: 'src/y.ts', kind: 'delete' },
    ]);
    expect(svc.getStatus(1).dirtyPending).toBe(2);    // buffered during the run
    await sleep(150);
    expect(exec.removeCalls).toEqual([['src/y.ts']]);
    expect(exec.indexCalls).toEqual([['src/x.ts']]);
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
