import { isAbsolute, relative } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { FileWatcherService, type WatcherFileEvent } from '../watcher.js';
import { GitMetaWatcher, type GitMetaEvent } from '../git-meta-watcher.js';
import { KeyedMutex } from './project-mutex.js';
import { ProjectIndexStatusStore } from './status-store.js';
import { DirtyQueue } from './dirty-queue.js';
import {
  readProjectIndexSettings,
  type ActiveIndexRun,
  type DirtyEvent,
  type FsEvent,
  type ProjectIndexSettings,
  type ProjectIndexStatus,
  type StructuralExecutor,
} from './types.js';

export type EnsureFreshReason = 'open' | 'scaffold' | 'session' | 'manual' | 'branch';

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
  /** Deferred-open timers (MCP_INDEX_OPEN_DELAY_MS) — cancelled when a run starts. */
  private pendingOpen = new Map<number, ReturnType<typeof setTimeout>>();
  /** MRU-first list of watched projects (LRU eviction beyond the cap). */
  private watchOrder: number[] = [];
  /** UI fs-events subscribers (live tree / tab reload), per project. */
  private fsListeners = new Map<number, Set<(events: FsEvent[]) => void>>();
  /** Git-metadata watcher (HEAD/refs) — sees branch switches the file watcher can't. */
  private gitMetaWatcher = new GitMetaWatcher();
  /** UI git-meta subscribers (branch chip / git window refresh), per project. */
  private gitMetaListeners = new Map<number, Set<(event: GitMetaEvent) => void>>();
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
    // 'branch' bypasses the cooldown like 'manual' (a fresh checkout must
    // re-index now), but stays gated by autoIndex above.
    if (reason !== 'manual' && reason !== 'branch' && Date.now() - last < ENSURE_COOLDOWN_MS && this.watcher.isWatching(projectId)) {
      return; // fresh enough — the watcher is keeping it current
    }
    this.lastEnsureAt.set(projectId, Date.now());
    // Watch BEFORE the run: changes landing mid-delay/mid-run buffer in the
    // dirty queue and drain right after — closes the scan/charge race.
    // ensureWatching self-gates (file watcher → autoWatch, git-meta → autoWatch||autoIndex).
    this.ensureWatching(projectId);

    const manual = reason === 'manual';
    const delay = manual ? 0 : s.openDelayMs;
    if (delay <= 0) {
      this.startStructuralRun(projectId, s, manual);
      return;
    }
    if (this.pendingOpen.has(projectId)) return; // already scheduled
    // Defer the CPU-bound run so the renderer paints the project screen
    // before the indexer worker pins a core. A manual trigger during the
    // window preempts — startStructuralRun cancels this timer.
    const t = setTimeout(() => {
      this.pendingOpen.delete(projectId);
      this.startStructuralRun(projectId, s, false);
    }, delay);
    t.unref?.();
    this.pendingOpen.set(projectId, t);
  }

  /** Kick the locked structural run + drain. Cancels any deferred-open timer. */
  private startStructuralRun(projectId: number, s: ProjectIndexSettings, manual: boolean): void {
    const pending = this.pendingOpen.get(projectId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOpen.delete(projectId);
    }
    if (this.disposed || this.running.has(projectId)) return;
    this.running.add(projectId);
    void this.mutex
      .withLock(projectId, () => this.runStructural(projectId, s, manual))
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

  /** Live git-metadata events for the UI (branch chip, git window). Subscribing arms the watcher. */
  subscribeGitMeta(projectId: number, fn: (event: GitMetaEvent) => void): () => void {
    let set = this.gitMetaListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.gitMetaListeners.set(projectId, set);
    }
    set.add(fn);
    this.ensureWatching(projectId);
    // Seed this subscriber with the current branch (changed:[]) so the UI can
    // distinguish a genuine switch (→ toast) from its first frame (→ just sync).
    const project = this.db.getProject(projectId);
    if (project?.root_path) {
      const seed = this.gitMetaWatcher.readCurrent(project.root_path);
      if (seed) { try { fn(seed); } catch { /* ignore */ } }
    }
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.gitMetaListeners.delete(projectId);
    };
  }

  private publishGitMeta(projectId: number, event: GitMetaEvent): void {
    const set = this.gitMetaListeners.get(projectId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch { /* UI listeners never break the watcher */ }
    }
  }

  /** Branch switch (HEAD changed) → explicit re-index; any git-dir change → UI refresh. */
  private onGitMetaChange(projectId: number, event: GitMetaEvent): void {
    this.publishGitMeta(projectId, event);
    // HEAD change ⇒ branch switch ⇒ explicit structural pass. If a run is already
    // in flight ensureFresh drops this (no queue) — acceptable: the checkout's
    // working-tree deltas still flow through the file watcher → markDirty → drain,
    // so symbols/FTS catch up incrementally even when the structural pass is skipped.
    if (event.changed.includes('head')) this.ensureFresh(projectId, 'branch');
  }

  ensureWatching(projectId: number): void {
    if (this.disposed) return;
    const s = this.settings();
    // The heavy working-tree watcher follows autoWatch. The git-meta (.git/HEAD)
    // watcher is cheap and powers branch monitoring + re-index, so it follows
    // autoIndex too — otherwise turning off the file watcher would silently kill
    // branch detection even with auto-indexing on.
    const wantFiles = s.autoWatch;
    const wantGitMeta = s.autoWatch || s.autoIndex;
    if (!wantFiles && !wantGitMeta) return;
    this.watchOrder = [projectId, ...this.watchOrder.filter((id) => id !== projectId)];
    if ((wantFiles && !this.watcher.isWatching(projectId)) || (wantGitMeta && !this.gitMetaWatcher.isWatching(projectId))) {
      const project = this.db.getProject(projectId);
      if (!project?.root_path) return;
      const root = project.root_path;
      if (wantFiles && !this.watcher.isWatching(projectId)) {
        this.watcher.startWatching(
          projectId,
          { rootPath: root, debounce: s.watchDebounceMs },
          { onFileChanged: (events) => this.onWatcherEvents(projectId, root, events) },
        );
        this.status.setWatcher(projectId, true);
      }
      // Sibling watcher for the git-identity signal (.git/HEAD + refs) the
      // working-tree watcher ignores. No-op when the project isn't a repo.
      if (wantGitMeta && !this.gitMetaWatcher.isWatching(projectId)) {
        this.gitMetaWatcher.startWatching(projectId, root, {
          onChange: (event) => this.onGitMetaChange(projectId, event),
        });
      }
    }
    while (this.watchOrder.length > s.maxWatchedProjects) {
      void this.stopWatching(this.watchOrder[this.watchOrder.length - 1]);
    }
  }

  async stopWatching(projectId: number): Promise<void> {
    this.watchOrder = this.watchOrder.filter((id) => id !== projectId);
    await this.watcher.stopWatching(projectId);
    await this.gitMetaWatcher.stopWatching(projectId);
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

  /**
   * Publish a live pass to the status store. The manual index/embeddings stream
   * handlers call this on each progress frame so the run shows up in the
   * main-process SoT — and therefore survives a renderer navigation (the
   * manual run no longer lives only in React state tied to the SSE fetch).
   */
  setActiveRun(projectId: number, run: Omit<ActiveIndexRun, 'startedAt'> & { startedAt?: number }): void {
    this.status.setActiveRun(projectId, run);
  }

  /** Settle status from the DB (clears the live pass) once a run ends. */
  refreshStatus(projectId: number): void {
    this.status.refreshFromDb(projectId);
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
    for (const t of this.pendingOpen.values()) clearTimeout(t);
    this.pendingOpen.clear();
    await this.watcher.stopAll();
    await this.gitMetaWatcher.stopAll();
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
