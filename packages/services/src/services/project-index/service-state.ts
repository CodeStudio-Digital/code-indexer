import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { CodeIndexDB } from '@mcp/store/db.js';

import { FileWatcherService } from '../watcher.js';
import { GitMetaWatcher, type GitMetaEvent } from '../git-meta-watcher.js';
import { KeyedMutex } from './project-mutex.js';
import { ProjectIndexStatusStore } from './status-store.js';
import { DirtyQueue } from './dirty-queue.js';
import { readProjectIndexSettings, type DirtyEvent, type FsEvent, type ProjectIndexSettings, type StructuralExecutor } from './types.js';

import { type EnsureFreshReason, type SemanticCatchupHooks, envDelay, msg, toRelPath } from './service-support.js';

/** Shared project lifecycle state and bounded fallback polling. */
export abstract class ProjectIndexState {
  protected mutex = new KeyedMutex<number>();
  protected dirty = new DirtyQueue();
  protected status: ProjectIndexStatusStore;
  protected running = new Set<number>();
  protected automaticRuns = new Map<number, AbortController>();
  private projectPolicies = new Map<number, { owner: number; enabled: boolean }>();
  protected runReason = new Map<number, EnsureFreshReason | 'refresh'>();
  protected draining = new Set<number>();
  protected drainFailures = new Map<number, number>();
  protected drainRetries = new Map<number, ReturnType<typeof setTimeout>>();
  /** One stat-first reconciliation per open lifecycle, regardless of turns. */
  protected reconciledLifecycle = new Set<number>();
  /** A branch switch received during a run collapses into one follow-up pass. */
  protected queuedReconcile = new Map<number, 'branch' | 'workspace'>();
  protected lastProgressAt = new Map<number, number>();
  /** Deferred-open timers (MCP_INDEX_OPEN_DELAY_MS) — cancelled when a run starts. */
  protected pendingOpen = new Map<number, ReturnType<typeof setTimeout>>();
  /** View-activation timers are separate so unmount cannot cancel session work. */
  protected pendingActivation = new Map<number, ReturnType<typeof setTimeout>>();
  /** Active ProjectView instances; multiple windows can show one project. */
  protected activations = new Map<number, Set<string>>();
  /** Deferred heavy working-tree watcher start (MCP_WATCH_OPEN_DELAY_MS). */
  protected fileWatchOpenTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Idle stop timers for recursive file watchers after the UI unsubscribes. */
  protected fileWatchIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** MRU-first list of watched projects (LRU eviction beyond the cap). */
  protected watchOrder: number[] = [];
  /** UI fs-events subscribers (live tree / tab reload), per project. */
  protected fsListeners = new Map<number, Set<(events: FsEvent[]) => void>>();
  /** UI git-meta subscribers (branch chip / git window refresh), per project. */
  protected gitMetaListeners = new Map<number, Set<(event: GitMetaEvent) => void>>();
  protected disposed = false;
  protected semanticCatchup: SemanticCatchupHooks | null = null;
  protected semanticLifecycleActive = new Set<number>();
  /** Open-document paths per project (DI from the LSP document store). */
  protected openPathsProvider: ((projectId: number) => string[]) | null = null;
  /** Over-budget freshness fallback: one shared mtime-poll timer. */
  protected fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
  /** projectId → relPath → last observed mtime (fallback poll baseline). */
  protected fallbackMtimes = new Map<number, Map<string, number | null>>();
  protected fallbackReconcileAt = new Map<number, number>();
  protected fallbackPollRunning = false;
  /** Nested foreground filesystem operations per project (Git stage/commit). */
  protected interactivePriorityDepth = new Map<number, number>();

  constructor(
    protected db: CodeIndexDB,
    protected executor: StructuralExecutor,
    protected watcher: FileWatcherService = new FileWatcherService(),
    protected settings: () => ProjectIndexSettings = readProjectIndexSettings,
    protected gitMetaWatcher: GitMetaWatcher = new GitMetaWatcher(),
  ) {
    this.dirty = new DirtyQueue(db.structuralJournal?.());
    this.status = new ProjectIndexStatusStore(db);
    this.startFallbackPoll();
  }

  protected autoEnabled(projectId: number): boolean {
    let policy = this.projectPolicies.get(projectId);
    if (!policy) {
      const row = this.db.getProjectCatalogEntry(projectId);
      const owner = row?.worktree_parent_id ?? projectId;
      const settings = owner === projectId ? row : this.db.getProjectCatalogEntry(owner);
      policy = { owner, enabled: settings?.auto_index_enabled !== 0 };
      this.projectPolicies.set(projectId, policy);
    }
    return policy.enabled;
  }

  protected invalidateAutoSettings(owner: number): Set<number> {
    const projects = new Set([owner]);
    for (const [id, policy] of this.projectPolicies) {
      if (policy.owner === owner) { projects.add(id); this.projectPolicies.delete(id); }
    }
    return projects;
  }

  /** Late-bound upgrade: in-process fallback → indexer worker client. */
  setExecutor(executor: StructuralExecutor): void {
    for (const projectId of this.interactivePriorityDepth.keys()) {
      this.setInteractivePriority(projectId, false);
    }
    this.executor = executor;
    for (const projectId of this.interactivePriorityDepth.keys()) {
      this.setInteractivePriority(projectId, true);
    }
  }

  /**
   * Over-budget freshness fallback (the counterpart of the watch-budget guard):
   * projects over MCP_WATCH_MAX_FILES without a native recursive handle skip chokidar, so
   * external edits to the files the user actually has open would go stale until
   * the next reconcile. With a provider wired (LSP document store), a light
   * mtime poll over those open files feeds markDirty — bounded work (open docs
   * only), regardless of how huge the asset tree is.
   */
  setOpenPathsProvider(fn: ((projectId: number) => string[]) | null): void {
    this.openPathsProvider = fn;
  }

  protected startFallbackPoll(): void {
    if (this.disposed || this.fallbackPollTimer) return;
    const interval = envDelay('MCP_WATCH_FALLBACK_POLL_MS', 3_000);
    if (interval <= 0) return;
    const timer = setInterval(() => {
      void this.pollSkippedProjects().catch((error) =>
        console.warn(`[project-index] fallback freshness check failed: ${msg(error)}`));
    }, interval);
    timer.unref?.();
    this.fallbackPollTimer = timer;
  }

  /** Bounded open-file checks plus periodic worker reconciliation for skipped trees. */
  protected async pollSkippedProjects(): Promise<void> {
    if (this.disposed || this.fallbackPollRunning) return;
    const watcher = this.watcher as FileWatcherService & { isSkipped?: (id: number) => boolean };
    if (!watcher.isSkipped) return;
    this.fallbackPollRunning = true;
    try {
      const settings = this.settings();
      const reconcileMs = Math.max(10_000, envDelay('MCP_WATCH_FALLBACK_RECONCILE_MS', 60_000));
      let scheduledReconcile = false;
      for (const projectId of this.activations.keys()) {
        if (!this.autoEnabled(projectId) || !watcher.isSkipped(projectId)) continue;
        const project = this.db.getProjectCatalogEntry(projectId);
        if (!project?.root_path) continue;
        // Closed files, creations and deletions also need an authoritative scan.
        // One worker pass at a time; yield to foreground operations and lifecycle scans.
        const last = this.fallbackReconcileAt.get(projectId);
        if (last === undefined) this.fallbackReconcileAt.set(projectId, Date.now());
        else if (settings.autoIndex && !scheduledReconcile && this.running.size === 0
          && this.draining.size === 0 && this.interactivePriorityDepth.size === 0
          && !this.pendingOpen.has(projectId) && !this.pendingActivation.has(projectId)
          && Date.now() - last >= reconcileMs) {
          this.fallbackReconcileAt.set(projectId, Date.now());
          this.startStructuralRun(projectId, settings, false, 'poll');
          scheduledReconcile = true;
        }
        let paths: string[];
        try {
          paths = this.openPathsProvider?.(projectId).slice(0, 64) ?? [];
        } catch {
          continue;
        }
        let seen = this.fallbackMtimes.get(projectId);
        if (!seen) {
          seen = new Map();
          this.fallbackMtimes.set(projectId, seen);
        }
        const dirty: DirtyEvent[] = [];
        const currentPaths = new Set(paths.map((raw) => raw.replace(/\\/g, '/')));
        for (const old of seen.keys()) if (!currentPaths.has(old)) seen.delete(old);
        for (const raw of paths) {
          if (this.disposed || !this.activations.has(projectId)) return;
          const rel = raw.replace(/\\/g, '/');
          const abs = join(project.root_path, rel);
          if (!toRelPath(project.root_path, abs)) continue;
          const st = await stat(abs).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
            return undefined; // A transient access failure is not a deletion.
          });
          if (st === undefined) continue;
          const mtime = st?.isFile() ? Math.trunc(st.mtimeMs) : null;
          const prev = seen.get(rel);
          if (prev === undefined) {
            // First sighting = baseline only — the open buffer is current.
            seen.set(rel, mtime);
            continue;
          }
          if (mtime === null && prev !== null) {
            seen.set(rel, null);
            dirty.push({ path: rel, kind: 'delete' });
          } else if (mtime !== prev) {
            seen.set(rel, mtime);
            dirty.push({ path: rel, kind: 'upsert' });
          }
        }
        if (dirty.length > 0) this.markDirty(projectId, dirty);
      }
    } finally { this.fallbackPollRunning = false; }
  }
  protected abstract startStructuralRun(
    projectId: number,
    s: ProjectIndexSettings,
    manual: boolean,
    reason?: EnsureFreshReason,
  ): void;
  protected abstract setInteractivePriority(projectId: number, busy: boolean): void;
  abstract markDirty(projectId: number, events: DirtyEvent[]): void;
}
