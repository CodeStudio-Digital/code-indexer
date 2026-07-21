import { isAbsolute, relative } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { isUnityProjectRoot } from '@mcp/shared/utils/project-ignore.js';
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
  type StructuralProgressFrame,
} from './types.js';
import {
  isStructurallyReady,
  waitForStructuralReadiness,
  type StructuralReadinessResult,
} from './structural-readiness.js';

export type EnsureFreshReason = 'open' | 'scaffold' | 'session' | 'manual' | 'branch' | 'workspace';

export interface SemanticCatchupHooks {
  noteDelta(projectId: number, events: readonly DirtyEvent[]): void;
  ensureProject(projectId: number): Promise<void>;
  /** Open-project lifecycle hand-off after an integral structural baseline exists. */
  projectReady?(projectId: number): void | Promise<void>;
  /** Final view/lease release; semantic backfill may pause after its current batch. */
  projectInactive?(projectId: number): void | Promise<void>;
}

const DRAIN_BATCH = 200;
const PROGRESS_MIN_INTERVAL_MS = 150;
const LARGE_PROJECT_FILE_COUNT = 5_000;

function envDelay(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
 * incremental drain × manual full index). Metadata reads are intentionally
 * pure; explicit view activation and session/manual events schedule work.
 * `ensureFresh` stays fire-and-forget and never awaits on its callers.
 */
export class ProjectIndexService {
  private mutex = new KeyedMutex<number>();
  private dirty = new DirtyQueue();
  private status: ProjectIndexStatusStore;
  private running = new Set<number>();
  private runReason = new Map<number, EnsureFreshReason>();
  private draining = new Set<number>();
  /** One stat-first reconciliation per open lifecycle, regardless of turns. */
  private reconciledLifecycle = new Set<number>();
  /** A branch switch received during a run collapses into one follow-up pass. */
  private queuedReconcile = new Map<number, 'branch' | 'workspace'>();
  private lastProgressAt = new Map<number, number>();
  /** Deferred-open timers (MCP_INDEX_OPEN_DELAY_MS) — cancelled when a run starts. */
  private pendingOpen = new Map<number, ReturnType<typeof setTimeout>>();
  /** View-activation timers are separate so unmount cannot cancel session work. */
  private pendingActivation = new Map<number, ReturnType<typeof setTimeout>>();
  /** Active ProjectView instances; multiple windows can show one project. */
  private activations = new Map<number, Set<string>>();
  /** Deferred heavy working-tree watcher start (MCP_WATCH_OPEN_DELAY_MS). */
  private fileWatchOpenTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Idle stop timers for recursive file watchers after the UI unsubscribes. */
  private fileWatchIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** MRU-first list of watched projects (LRU eviction beyond the cap). */
  private watchOrder: number[] = [];
  /** UI fs-events subscribers (live tree / tab reload), per project. */
  private fsListeners = new Map<number, Set<(events: FsEvent[]) => void>>();
  /** UI git-meta subscribers (branch chip / git window refresh), per project. */
  private gitMetaListeners = new Map<number, Set<(event: GitMetaEvent) => void>>();
  private disposed = false;
  private semanticCatchup: SemanticCatchupHooks | null = null;
  private semanticLifecycleActive = new Set<number>();

  constructor(
    private db: CodeIndexDB,
    private executor: StructuralExecutor,
    private watcher: FileWatcherService = new FileWatcherService(),
    private settings: () => ProjectIndexSettings = readProjectIndexSettings,
    private gitMetaWatcher: GitMetaWatcher = new GitMetaWatcher(),
  ) {
    this.status = new ProjectIndexStatusStore(db);
  }

  /** Late-bound upgrade: in-process fallback → indexer worker client. */
  setExecutor(executor: StructuralExecutor): void {
    this.executor = executor;
  }

  setSemanticCatchup(hooks: SemanticCatchupHooks | null): void {
    this.semanticCatchup = hooks;
    if (!hooks) {
      this.semanticLifecycleActive.clear();
      return;
    }
    for (const [projectId, activations] of this.activations) {
      if (activations.size > 0 && this.reconciledLifecycle.has(projectId)) {
        this.notifyProjectReady(projectId);
      }
    }
  }

  /**
   * Mark a project view active. Metadata reads stay pure; only this explicit
   * lifecycle edge may schedule the eventual full reconciliation.
   */
  activate(projectId: number, activationId: string): {
    scheduled: boolean;
    delayMs: number | null;
    largeProject: boolean;
  } {
    const project = this.db.getProject(projectId);
    const largeProject = !!project && (
      (project.file_count ?? 0) >= LARGE_PROJECT_FILE_COUNT
      || isUnityProjectRoot(project.root_path)
    );
    let active = this.activations.get(projectId);
    if (!active) {
      active = new Set();
      this.activations.set(projectId, active);
    }
    if (active.has(activationId)) {
      return {
        scheduled: this.pendingActivation.has(projectId),
        delayMs: null,
        largeProject,
      };
    }

    const firstView = active.size === 0;
    active.add(activationId);
    this.ensureGitMetaWatching(projectId);
    // Arm the recursive watcher at the lifecycle edge, before any full scan.
    // The editor/LSP remain independent; runStructural waits for chokidar's
    // ready barrier in the background and drains events before publishing the
    // structural baseline.
    this.ensureFileWatching(projectId, 0, true);
    const s = this.settings();
    if (!firstView || this.disposed || !s.autoIndex || this.running.has(projectId)
      || this.pendingOpen.has(projectId) || this.pendingActivation.has(projectId)
      || this.reconciledLifecycle.has(projectId)) {
      return { scheduled: this.pendingActivation.has(projectId), delayMs: null, largeProject };
    }

    const delayMs = largeProject
      ? envDelay('MCP_INDEX_LARGE_OPEN_DELAY_MS', 30_000)
      : s.openDelayMs;
    if (delayMs <= 0) {
      this.startStructuralRun(projectId, s, false, 'open');
      return { scheduled: false, delayMs: 0, largeProject };
    }

    const dueAt = Date.now() + delayMs;
    const timer = setTimeout(() => {
      this.pendingActivation.delete(projectId);
      if (this.disposed || !this.activations.get(projectId)?.size) {
        this.status.setScheduledRun(projectId, undefined);
        return;
      }
      this.startStructuralRun(projectId, this.settings(), false, 'open');
    }, delayMs);
    timer.unref?.();
    this.pendingActivation.set(projectId, timer);
    this.status.setScheduledRun(projectId, { reason: 'activation', dueAt });
    return { scheduled: true, delayMs, largeProject };
  }

  /** Last project view left: cancel deferred work and report final ownership release. */
  deactivate(projectId: number, activationId: string): boolean {
    const active = this.activations.get(projectId);
    if (!active) return true;
    active.delete(activationId);
    if (active.size > 0) return false;
    this.activations.delete(projectId);
    this.reconciledLifecycle.delete(projectId);
    this.queuedReconcile.delete(projectId);
    if (this.semanticLifecycleActive.delete(projectId)) this.notifyProjectInactive(projectId);
    const timer = this.pendingActivation.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.pendingActivation.delete(projectId);
      this.status.setScheduledRun(projectId, undefined);
    }
    this.scheduleFileWatcherStop(projectId);
    return true;
  }

  /** Fire-and-forget "project became active". Cheap and re-entrant. */
  ensureFresh(projectId: number, reason: EnsureFreshReason): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoIndex && reason !== 'manual') return;

    if ((reason === 'branch' || reason === 'workspace') && this.running.has(projectId)) {
      if (this.runReason.get(projectId) !== reason) this.queuedReconcile.set(projectId, reason);
      return;
    }
    if (reason !== 'manual' && (
      this.running.has(projectId)
      || this.pendingOpen.has(projectId)
      || this.pendingActivation.has(projectId)
    )) {
      return;
    }
    // Session messages and scaffold notifications no longer trigger periodic
    // full scans. The first lifecycle request still establishes/validates the
    // baseline; subsequent turns are served by watcher/Monaco deltas.
    if (reason !== 'manual' && reason !== 'branch' && reason !== 'workspace'
      && this.reconciledLifecycle.has(projectId)) return;

    // Expose global busy state before create-session lets the composer send.
    if (this.db.getProject(projectId)?.is_synthetic) {
      this.status.setPhase(projectId, 'scanning');
    }
    // Both watchers are armed before the pass. The recursive watcher barrier
    // prevents the scan→watch gap that could otherwise lose a save.
    this.ensureGitMetaWatching(projectId);
    this.ensureFileWatching(projectId, 0, true);

    const manual = reason === 'manual';
    const delay = manual ? 0 : s.openDelayMs;
    if (delay <= 0) {
      this.startStructuralRun(projectId, s, manual, reason);
      return;
    }
    if (this.pendingOpen.has(projectId)) return; // already scheduled
    // Defer the CPU-bound run so the renderer paints the project screen
    // before the indexer worker pins a core. A manual trigger during the
    // window preempts — startStructuralRun cancels this timer.
    const t = setTimeout(() => {
      this.pendingOpen.delete(projectId);
      this.startStructuralRun(projectId, s, false, reason);
    }, delay);
    t.unref?.();
    this.pendingOpen.set(projectId, t);
    this.status.setScheduledRun(projectId, { reason, dueAt: Date.now() + delay });
  }

  /** Force a pending structural pass now and wait for a searchable index. */
  ensureStructuralReady(projectId: number, timeoutMs: number, signal?: AbortSignal): Promise<StructuralReadinessResult> {
    const current = this.getStatus(projectId);
    if (signal?.aborted) {
      return Promise.resolve({ status: 'aborted', phase: current.phase });
    }
    // A prior integral baseline is immediately usable while the stat-first
    // reopen reconciliation runs in the background. Only a missing baseline
    // gates the first agent turn.
    if (isStructurallyReady(current)) {
      return Promise.resolve({ status: 'ready', phase: current.phase });
    }
    const settings = this.settings();
    return waitForStructuralReadiness({
      getStatus: () => this.getStatus(projectId),
      subscribe: (fn) => this.subscribe(projectId, fn),
      timeoutMs,
      signal,
      start: () => {
        if (this.running.has(projectId)) return true;
        if (this.disposed || !settings.autoIndex) return false;
        this.startStructuralRun(projectId, settings, false, 'session');
        return this.running.has(projectId);
      },
    });
  }

  /** Kick the locked structural run + drain. Cancels any deferred-open timer. */
  private startStructuralRun(
    projectId: number,
    s: ProjectIndexSettings,
    manual: boolean,
    reason: EnsureFreshReason = manual ? 'manual' : 'open',
  ): void {
    const pending = this.pendingOpen.get(projectId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOpen.delete(projectId);
    }
    const activation = this.pendingActivation.get(projectId);
    if (activation) {
      clearTimeout(activation);
      this.pendingActivation.delete(projectId);
    }
    this.status.setScheduledRun(projectId, undefined);
    if (this.disposed || this.running.has(projectId)) return;
    this.running.add(projectId);
    this.runReason.set(projectId, reason);
    this.ensureGitMetaWatching(projectId);
    this.ensureFileWatching(projectId, 0, true);
    let reconciled = false;
    void this.mutex
      .withLock(projectId, async () => {
        await this.waitForFileWatcherReady(projectId);
        const completed = await this.runStructural(projectId, s, manual);
        if (!completed) return;
        // Give watcher callbacks queued in the same event-loop turn a chance
        // to enter their debounce buffer, then flush it at the scan barrier.
        await yieldToEventLoop();
        await this.flushWatcherEvents(projectId);
        await this.drainDirtyLocked(projectId);
        this.status.refreshFromDb(projectId);
        reconciled = true;
        if ((this.activations.get(projectId)?.size ?? 0) > 0) this.notifyProjectReady(projectId);
        void this.semanticCatchup?.ensureProject(projectId).catch((error) =>
          console.warn(`[project-index] semantic project catch-up paused for ${projectId}: ${msg(error)}`));
      })
      .catch((err) => this.status.setPhase(projectId, 'error', msg(err)))
      .finally(() => {
        this.running.delete(projectId);
        this.runReason.delete(projectId);
        if (reconciled) this.reconciledLifecycle.add(projectId);
        this.lastProgressAt.delete(projectId);
        const queuedReason = this.queuedReconcile.get(projectId);
        this.queuedReconcile.delete(projectId);
        if (queuedReason && !this.disposed) {
          this.startStructuralRun(projectId, this.settings(), false, queuedReason);
        } else {
          this.scheduleDrain(projectId);
          if (!this.shouldKeepWatcher(projectId)) this.scheduleFileWatcherStop(projectId);
        }
      });
  }

  /** Known changes (Monaco save/rename/delete, scaffold) — index-form rel paths. */
  markDirty(projectId: number, events: DirtyEvent[]): void {
    if (this.disposed || events.length === 0) return;
    this.dirty.add(projectId, events);
    this.semanticCatchup?.noteDelta(projectId, events);
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
    const idle = this.fileWatchIdleTimers.get(projectId);
    if (idle) {
      clearTimeout(idle);
      this.fileWatchIdleTimers.delete(projectId);
    }
    this.ensureFileWatching(projectId, this.settings().watchOpenDelayMs);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) {
        this.fsListeners.delete(projectId);
        this.scheduleFileWatcherStop(projectId);
      }
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
    this.ensureGitMetaWatching(projectId);
    // Seed this subscriber with the current branch (changed:[]) so the UI can
    // distinguish a genuine switch (→ toast) from its first frame (→ just sync).
    const project = this.db.getProject(projectId);
    if (project?.root_path) {
      const seed = this.gitMetaWatcher.readCurrent(project.root_path);
      if (seed) { try { fn(seed); } catch { /* ignore */ } }
    }
    return () => {
      set!.delete(fn);
      if (set!.size === 0) {
        this.gitMetaListeners.delete(projectId);
        if (!this.shouldKeepWatcher(projectId)) this.scheduleFileWatcherStop(projectId);
      }
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
    // HEAD change ⇒ one coalesced stat-first reconciliation. If the lifecycle
    // pass is already running, one follow-up is queued; repeated HEAD events
    // during that branch pass are ignored while watcher deltas keep flowing.
    if (event.changed.includes('head')) this.ensureFresh(projectId, 'branch');
  }

  private touchWatchOrder(projectId: number, s: ProjectIndexSettings): void {
    this.watchOrder = [projectId, ...this.watchOrder.filter((id) => id !== projectId)];
    while (this.watchOrder.length > s.maxWatchedProjects) {
      const candidate = [...this.watchOrder]
        .reverse()
        .find((id) => id !== projectId && !this.shouldKeepWatcher(id));
      // The cap is deliberately soft while every watched project is active.
      // Evicting an active project used to delete its activation ownership and
      // cancel its pending baseline; correctness wins over the handle target.
      if (candidate == null) break;
      this.watchOrder = this.watchOrder.filter((id) => id !== candidate);
      void this.stopIdleWatcherHandles(candidate);
    }
  }

  private shouldKeepWatcher(projectId: number): boolean {
    return (this.activations.get(projectId)?.size ?? 0) > 0
      || (this.fsListeners.get(projectId)?.size ?? 0) > 0
      || (this.gitMetaListeners.get(projectId)?.size ?? 0) > 0
      || this.running.has(projectId)
      || this.pendingOpen.has(projectId)
      || this.pendingActivation.has(projectId);
  }

  private ensureGitMetaWatching(projectId: number): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoWatch && !s.autoIndex) return;
    this.touchWatchOrder(projectId, s);
    if (this.gitMetaWatcher.isWatching(projectId)) return;
    const project = this.db.getProject(projectId);
    if (!project?.root_path) return;
    this.gitMetaWatcher.startWatching(projectId, project.root_path, {
      onChange: (event) => this.onGitMetaChange(projectId, event),
    });
  }

  private ensureFileWatching(projectId: number, delayMs: number, lifecycle = false): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoWatch || this.watcher.isWatching(projectId)) return;
    this.touchWatchOrder(projectId, s);
    if (this.fileWatchOpenTimers.has(projectId)) return;
    if (delayMs <= 0) {
      this.startFileWatchingNow(projectId, lifecycle);
      return;
    }
    const timer = setTimeout(() => {
      this.fileWatchOpenTimers.delete(projectId);
      if (this.disposed || !this.shouldKeepWatcher(projectId) || this.watcher.isWatching(projectId)) return;
      this.startFileWatchingNow(projectId, lifecycle);
    }, delayMs);
    timer.unref?.();
    this.fileWatchOpenTimers.set(projectId, timer);
  }

  private startFileWatchingNow(projectId: number, lifecycle = false): void {
    if (this.disposed || this.watcher.isWatching(projectId)) return;
    const s = this.settings();
    if (!s.autoWatch || (!lifecycle && !this.shouldKeepWatcher(projectId))) return;
    this.touchWatchOrder(projectId, s);
    const project = this.db.getProject(projectId);
    if (!project?.root_path) return;
    const root = project.root_path;
    this.watcher.startWatching(
      projectId,
      {
        rootPath: root,
        debounce: s.watchDebounceMs,
        ignorePatterns: projectIndexIgnorePatterns(project),
        maxWatchedFiles: s.watchMaxFiles,
      },
      { onFileChanged: (events) => this.onWatcherEvents(projectId, root, events) },
    );
    this.status.setWatcher(projectId, true);
  }

  private scheduleFileWatcherStop(projectId: number): void {
    const existing = this.fileWatchIdleTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const pendingOpen = this.fileWatchOpenTimers.get(projectId);
    if (pendingOpen) {
      clearTimeout(pendingOpen);
      this.fileWatchOpenTimers.delete(projectId);
    }
    const idleMs = this.settings().watchIdleMs;
    if (idleMs <= 0) {
      if (!this.shouldKeepWatcher(projectId)) void this.stopIdleWatcherHandles(projectId);
      return;
    }
    const timer = setTimeout(() => {
      this.fileWatchIdleTimers.delete(projectId);
      if (!this.shouldKeepWatcher(projectId)) void this.stopIdleWatcherHandles(projectId);
    }, idleMs);
    timer.unref?.();
    this.fileWatchIdleTimers.set(projectId, timer);
  }

  private async stopFileWatching(projectId: number): Promise<void> {
    const openTimer = this.fileWatchOpenTimers.get(projectId);
    if (openTimer) {
      clearTimeout(openTimer);
      this.fileWatchOpenTimers.delete(projectId);
    }
    const idleTimer = this.fileWatchIdleTimers.get(projectId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.fileWatchIdleTimers.delete(projectId);
    }
    await this.watcher.stopWatching(projectId);
    this.status.setWatcher(projectId, false);
  }

  private async stopIdleWatcherHandles(projectId: number): Promise<void> {
    if (this.shouldKeepWatcher(projectId)) return;
    this.watchOrder = this.watchOrder.filter((id) => id !== projectId);
    await this.stopFileWatching(projectId);
    await this.gitMetaWatcher.stopWatching(projectId);
  }

  async stopWatching(projectId: number): Promise<void> {
    const wasSemanticallyActive = this.semanticLifecycleActive.delete(projectId);
    this.activations.delete(projectId);
    this.reconciledLifecycle.delete(projectId);
    this.queuedReconcile.delete(projectId);
    const pending = this.pendingOpen.get(projectId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOpen.delete(projectId);
      this.status.setScheduledRun(projectId, undefined);
    }
    const activation = this.pendingActivation.get(projectId);
    if (activation) {
      clearTimeout(activation);
      this.pendingActivation.delete(projectId);
      this.status.setScheduledRun(projectId, undefined);
    }
    this.watchOrder = this.watchOrder.filter((id) => id !== projectId);
    await this.stopFileWatching(projectId);
    await this.gitMetaWatcher.stopWatching(projectId);
    this.status.setWatcher(projectId, false);
    if (wasSemanticallyActive) this.notifyProjectInactive(projectId);
  }

  restartFileWatching(projectId: number): void {
    if (this.disposed || !this.shouldKeepWatcher(projectId)) return;
    void this.stopFileWatching(projectId)
      .then(() => {
        if (!this.disposed && this.shouldKeepWatcher(projectId)) this.startFileWatchingNow(projectId, true);
      })
      .catch((err) => console.warn(`[project-index] failed to restart watcher for project ${projectId}: ${msg(err)}`));
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
    for (const t of this.pendingActivation.values()) clearTimeout(t);
    for (const t of this.fileWatchOpenTimers.values()) clearTimeout(t);
    for (const t of this.fileWatchIdleTimers.values()) clearTimeout(t);
    this.pendingOpen.clear();
    this.pendingActivation.clear();
    this.activations.clear();
    this.fileWatchOpenTimers.clear();
    this.fileWatchIdleTimers.clear();
    await this.watcher.stopAll();
    await this.gitMetaWatcher.stopAll();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async runStructural(projectId: number, s: ProjectIndexSettings, manual = false): Promise<boolean> {
    this.status.setPhase(projectId, 'scanning');
    const result = await this.executor.runStructuralIndex(projectId, {
      maxFiles: s.maxFiles,
      allowEmptyWipe: manual,
      onProgress: (p) => this.publishStructuralProgress(projectId, p),
    });
    if (result.aborted === 'too_large') {
      this.status.setPhase(projectId, 'too_large');
      return false;
    }
    if (result.aborted === 'empty_scan') {
      this.status.setPhase(
        projectId,
        'error',
        'scan found 0 files — check the project root path and .gitignore/.mcpindexignore; a manual reindex overrides',
      );
      return false;
    }
    if (result.indexed > 0 || result.removed > 0) {
      // The stat-first scanner found changes that happened while the project
      // was closed. It does not expose their individual paths, so one wildcard
      // invalidation asks the semantic coordinator to compare item hashes.
      this.semanticCatchup?.noteDelta(projectId, [{ path: '*', kind: 'upsert' }]);
    }
    return true;
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

  private publishStructuralProgress(projectId: number, p: StructuralProgressFrame): void {
    const now = Date.now();
    const last = this.lastProgressAt.get(projectId) ?? 0;
    // A final frame (current reached a known total) always flushes; otherwise
    // coalesce. Scanning frames carry total 0 until the walk ends, so they ride
    // the time gate. Routing by phase keeps the chip on "Scanning…" with a live
    // count rather than jumping to "Indexing 0/0".
    const done = p.total > 0 && p.current >= p.total;
    if (!done && now - last < PROGRESS_MIN_INTERVAL_MS) return;
    this.lastProgressAt.set(projectId, now);
    if (p.phase === 'scanning') this.status.setScanProgress(projectId, p.current, p.total);
    else this.status.setProgress(projectId, p.current, p.total);
  }

  private async waitForFileWatcherReady(projectId: number): Promise<void> {
    if (!this.settings().autoWatch) return;
    this.startFileWatchingNow(projectId, true);
    const watcher = this.watcher as FileWatcherService & {
      waitUntilReady?: (id: number) => Promise<void>;
    };
    if (!watcher.waitUntilReady) return;
    const timeoutMs = envDelay('MCP_WATCH_READY_TIMEOUT_MS', 30_000);
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      watcher.waitUntilReady(projectId),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (timedOut) {
      console.warn(`[project-index] watcher ready barrier timed out for project ${projectId}; reconciling with watcher gap protection degraded`);
    }
  }

  private async flushWatcherEvents(projectId: number): Promise<void> {
    const watcher = this.watcher as FileWatcherService & {
      flushPending?: (id: number) => Promise<void>;
    };
    await watcher.flushPending?.(projectId);
  }

  private async drainDirtyLocked(projectId: number): Promise<void> {
    while (this.dirty.size(projectId) > 0) {
      const batch = this.dirty.takeBatch(projectId, DRAIN_BATCH);
      if (batch.total === 0) break;
      if (batch.deletes.length > 0) await this.executor.removeFiles(projectId, batch.deletes);
      if (batch.upserts.length > 0) await this.executor.indexFiles(projectId, batch.upserts);
      this.status.setDirtyPending(projectId, this.dirty.size(projectId));
      if (this.dirty.size(projectId) > 0) await yieldToEventLoop();
    }
  }

  private notifyProjectReady(projectId: number): void {
    if (!this.semanticCatchup?.projectReady || this.semanticLifecycleActive.has(projectId)) return;
    this.semanticLifecycleActive.add(projectId);
    void Promise.resolve(this.semanticCatchup.projectReady(projectId)).catch((error) => {
      this.semanticLifecycleActive.delete(projectId);
      console.warn(`[project-index] semantic lifecycle activation failed for ${projectId}: ${msg(error)}`);
    });
  }

  private notifyProjectInactive(projectId: number): void {
    void Promise.resolve(this.semanticCatchup?.projectInactive?.(projectId)).catch((error) =>
      console.warn(`[project-index] semantic lifecycle deactivation failed for ${projectId}: ${msg(error)}`));
  }

  private scheduleDrain(projectId: number): void {
    if (this.disposed || this.running.has(projectId) || this.draining.has(projectId) || this.dirty.size(projectId) === 0) return;
    this.draining.add(projectId);
    void this.mutex
      .withLock(projectId, async () => {
        await this.drainDirtyLocked(projectId);
        this.status.refreshFromDb(projectId);
        void this.semanticCatchup?.ensureProject(projectId).catch((error) =>
          console.warn(`[project-index] semantic watcher catch-up paused for ${projectId}: ${msg(error)}`));
      })
      .catch((err) => console.warn(`[project-index] drain failed for project ${projectId}: ${msg(err)}`))
      .finally(() => {
        this.draining.delete(projectId);
        // Items that arrived between the loop exit and the flag reset.
        if (this.dirty.size(projectId) > 0) this.scheduleDrain(projectId);
      });
  }
}
