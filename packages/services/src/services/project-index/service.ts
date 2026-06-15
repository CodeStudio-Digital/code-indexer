import { isAbsolute, relative } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { FileWatcherService, type WatcherFileEvent } from '../watcher.js';
import { KeyedMutex } from './project-mutex.js';
import { ProjectIndexStatusStore } from './status-store.js';
import { DirtyQueue } from './dirty-queue.js';
import {
  readProjectIndexSettings,
  type DirtyEvent,
  type FsEvent,
  type ProjectIndexSettings,
  type ProjectIndexStatus,
  type StructuralExecutor,
} from './types.js';

export type EnsureFreshReason = 'open' | 'scaffold' | 'session' | 'manual';

const ENSURE_COOLDOWN_MS = 30_000;
const DRAIN_BATCH = 200;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Chokidar absolute path → index-form relative path; null when outside the root (or cross-drive). */
function toRelPath(root: string, absPath: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/**
 * IntelliJ-style auto indexing: "project opened" triggers an idempotent
 * structural run; a chokidar watcher + dirty queue keep symbols/FTS fresh in
 * real time; everything per-project serializes on one mutex (structural run ×
 * incremental drain × manual full index). `ensureFresh` is the hot-path entry
 * (fired from GET /projects/:id) — memory-only checks, never awaits.
 */
export class ProjectIndexService {
  private mutex = new KeyedMutex<number>();
  private dirty = new DirtyQueue();
  private status: ProjectIndexStatusStore;
  private running = new Set<number>();
  private draining = new Set<number>();
  private lastEnsureAt = new Map<number, number>();
  /** MRU-first list of watched projects (LRU eviction beyond the cap). */
  private watchOrder: number[] = [];
  /** UI fs-events subscribers (live tree / tab reload), per project. */
  private fsListeners = new Map<number, Set<(events: FsEvent[]) => void>>();
  private disposed = false;

  constructor(
    private db: CodeIndexDB,
    private executor: StructuralExecutor,
    private watcher: FileWatcherService = new FileWatcherService(),
    private settings: () => ProjectIndexSettings = readProjectIndexSettings,
  ) {
    this.status = new ProjectIndexStatusStore(db);
  }

  /** Late-bound upgrade: in-process fallback → indexer worker client. */
  setExecutor(executor: StructuralExecutor): void {
    this.executor = executor;
  }

  /** Fire-and-forget "project became active". Cheap and re-entrant. */
  ensureFresh(projectId: number, reason: EnsureFreshReason): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoIndex && reason !== 'manual') return;
    if (this.running.has(projectId)) return;
    const last = this.lastEnsureAt.get(projectId) ?? 0;
    if (reason !== 'manual' && Date.now() - last < ENSURE_COOLDOWN_MS && this.watcher.isWatching(projectId)) {
      return; // fresh enough — the watcher is keeping it current
    }
    this.lastEnsureAt.set(projectId, Date.now());
    // Watch BEFORE the run: changes landing mid-run buffer in the dirty
    // queue and drain right after — closes the scan/charge race.
    if (s.autoWatch) this.ensureWatching(projectId);
    this.running.add(projectId);
    void this.mutex
      .withLock(projectId, () => this.runStructural(projectId, s, reason === 'manual'))
      .catch((err) => this.status.setPhase(projectId, 'error', msg(err)))
      .finally(() => {
        this.running.delete(projectId);
        this.scheduleDrain(projectId);
      });
  }

  /** Known changes (Monaco save/rename/delete, scaffold) — index-form rel paths. */
  markDirty(projectId: number, events: DirtyEvent[]): void {
    if (this.disposed || events.length === 0) return;
    this.dirty.add(projectId, events);
    this.status.setDirtyPending(projectId, this.dirty.size(projectId));
    // Every indexable change is also a UI-visible change — markDirty is the
    // single funnel (watcher + Monaco fast-path + scaffold), so publishing
    // here gives the live tree near-zero latency on editor saves.
    this.publishFsEvents(projectId, events.map((e) => ({ ...e, isDir: false })));
    this.scheduleDrain(projectId);
  }

  /** Live filesystem events for the UI. Subscribing arms the watcher. */
  subscribeFsEvents(projectId: number, fn: (events: FsEvent[]) => void): () => void {
    let set = this.fsListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.fsListeners.set(projectId, set);
    }
    set.add(fn);
    this.ensureWatching(projectId);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.fsListeners.delete(projectId);
    };
  }

  /** Manual publication for mutations the watcher can't see fast (mkdir). */
  publishFsEvents(projectId: number, events: FsEvent[]): void {
    if (events.length === 0) return;
    const set = this.fsListeners.get(projectId);
    if (!set) return;
    for (const fn of set) {
      try { fn(events); } catch { /* UI listeners never break indexing */ }
    }
  }

  ensureWatching(projectId: number): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoWatch) return;
    this.watchOrder = [projectId, ...this.watchOrder.filter((id) => id !== projectId)];
    if (!this.watcher.isWatching(projectId)) {
      const project = this.db.getProject(projectId);
      if (!project?.root_path) return;
      const root = project.root_path;
      this.watcher.startWatching(
        projectId,
        { rootPath: root, debounce: s.watchDebounceMs },
        { onFileChanged: (events) => this.onWatcherEvents(projectId, root, events) },
      );
      this.status.setWatcher(projectId, true);
    }
    while (this.watchOrder.length > s.maxWatchedProjects) {
      void this.stopWatching(this.watchOrder[this.watchOrder.length - 1]);
    }
  }

  async stopWatching(projectId: number): Promise<void> {
    this.watchOrder = this.watchOrder.filter((id) => id !== projectId);
    await this.watcher.stopWatching(projectId);
    this.status.setWatcher(projectId, false);
  }

  getStatus(projectId: number): ProjectIndexStatus {
    return {
      ...this.status.get(projectId),
      dirtyPending: this.dirty.size(projectId),
      watcherActive: this.watcher.isWatching(projectId),
    };
  }

  subscribe(projectId: number, fn: (s: ProjectIndexStatus) => void): () => void {
    return this.status.subscribe(projectId, fn);
  }

  /** Serialize arbitrary work (e.g. the manual FULL index) against this project. */
  withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(projectId, fn);
  }

  /** Full-index wrapper: lock + semantic_indexing phase + DB-derived settle. */
  withSemanticRun<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(projectId, async () => {
      this.status.setPhase(projectId, 'semantic_indexing');
      try {
        return await fn();
      } finally {
        this.status.refreshFromDb(projectId);
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.watcher.stopAll();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async runStructural(projectId: number, s: ProjectIndexSettings, manual = false): Promise<void> {
    this.status.setPhase(projectId, 'scanning');
    const result = await this.executor.runStructuralIndex(projectId, {
      maxFiles: s.maxFiles,
      allowEmptyWipe: manual,
      onProgress: (p) => this.status.setProgress(projectId, p.current, p.total),
    });
    if (result.aborted === 'too_large') {
      this.status.setPhase(projectId, 'too_large');
      return;
    }
    if (result.aborted === 'empty_scan') {
      this.status.setPhase(
        projectId,
        'error',
        'scan found 0 files — check the project root path and .gitignore/.mcpindexignore; a manual reindex overrides',
      );
      return;
    }
    this.status.refreshFromDb(projectId);
  }

  private onWatcherEvents(projectId: number, rootPath: string, events: WatcherFileEvent[]): void {
    const dirty: DirtyEvent[] = [];
    const dirEvents: FsEvent[] = [];
    for (const e of events) {
      const rel = toRelPath(rootPath, e.path);
      if (!rel) continue;
      if (e.isDir) dirEvents.push({ path: rel, kind: e.kind, isDir: true });
      else dirty.push({ path: rel, kind: e.kind });
    }
    // Dirs go straight to the UI stream (the indexer ignores them);
    // files flow through markDirty, which publishes + drains.
    this.publishFsEvents(projectId, dirEvents);
    this.markDirty(projectId, dirty);
  }

  private scheduleDrain(projectId: number): void {
    if (this.disposed || this.draining.has(projectId) || this.dirty.size(projectId) === 0) return;
    this.draining.add(projectId);
    void this.mutex
      .withLock(projectId, async () => {
        while (this.dirty.size(projectId) > 0) {
          const batch = this.dirty.takeBatch(projectId, DRAIN_BATCH);
          if (batch.total === 0) break;
          if (batch.deletes.length > 0) await this.executor.removeFiles(projectId, batch.deletes);
          if (batch.upserts.length > 0) await this.executor.indexFiles(projectId, batch.upserts);
          this.status.setDirtyPending(projectId, this.dirty.size(projectId));
        }
        this.status.refreshFromDb(projectId);
      })
      .catch((err) => console.warn(`[project-index] drain failed for project ${projectId}: ${msg(err)}`))
      .finally(() => {
        this.draining.delete(projectId);
        // Items that arrived between the loop exit and the flag reset.
        if (this.dirty.size(projectId) > 0) this.scheduleDrain(projectId);
      });
  }
}
