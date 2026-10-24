

import { projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';

import { FileWatcherService, type WatcherFileEvent } from '../watcher.js';
import { type GitMetaEvent } from '../git-meta-watcher.js';

import { type DirtyEvent, type FsEvent, type ProjectIndexSettings } from './types.js';

import { type EnsureFreshReason, envDelay, msg, toRelPath } from './service-support.js';
import { ProjectIndexState } from './service-state.js';

/** Working-tree and Git watcher ownership, subscriptions, and shutdown. */
export abstract class ProjectIndexWatchers extends ProjectIndexState {

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

  protected publishGitMeta(projectId: number, event: GitMetaEvent): void {
    const set = this.gitMetaListeners.get(projectId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch { /* UI listeners never break the watcher */ }
    }
  }

  /** Branch switch (HEAD changed) → explicit re-index; any git-dir change → UI refresh. */
  protected onGitMetaChange(projectId: number, event: GitMetaEvent): void {
    this.publishGitMeta(projectId, event);
    // HEAD change ⇒ one coalesced stat-first reconciliation. If the lifecycle
    // pass is already running, one follow-up is queued; repeated HEAD events
    // during that branch pass are ignored while watcher deltas keep flowing.
    if (event.changed.includes('head')) this.ensureFresh(projectId, 'branch');
  }

  protected touchWatchOrder(projectId: number, s: ProjectIndexSettings): void {
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

  protected shouldKeepWatcher(projectId: number): boolean {
    return (this.activations.get(projectId)?.size ?? 0) > 0
      || (this.fsListeners.get(projectId)?.size ?? 0) > 0
      || (this.gitMetaListeners.get(projectId)?.size ?? 0) > 0
      || this.running.has(projectId)
      || this.pendingOpen.has(projectId)
      || this.pendingActivation.has(projectId);
  }

  protected ensureGitMetaWatching(projectId: number): void {
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

  protected ensureFileWatching(projectId: number, delayMs: number, lifecycle = false): void {
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

  protected startFileWatchingNow(projectId: number, lifecycle = false): void {
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

  protected scheduleFileWatcherStop(projectId: number): void {
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

  protected async stopFileWatching(projectId: number): Promise<void> {
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

  protected async stopIdleWatcherHandles(projectId: number): Promise<void> {
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
    this.fallbackMtimes.delete(projectId);
    this.fallbackReconcileAt.delete(projectId);
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

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const projectId of this.interactivePriorityDepth.keys()) {
      this.setInteractivePriority(projectId, false);
    }
    this.interactivePriorityDepth.clear();
    if (this.fallbackPollTimer) {
      clearInterval(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
    this.fallbackMtimes.clear();
    this.fallbackReconcileAt.clear();
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

  protected onWatcherEvents(projectId: number, rootPath: string, events: WatcherFileEvent[]): void {
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

  protected async waitForFileWatcherReady(projectId: number): Promise<void> {
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

  protected async flushWatcherEvents(projectId: number): Promise<void> {
    const watcher = this.watcher as FileWatcherService & {
      flushPending?: (id: number) => Promise<void>;
    };
    await watcher.flushPending?.(projectId);
  }

  /**
   * Bulk-op suppression: discard the watcher's buffered burst AND the queued
   * per-file drain work — both are superseded by the stat-first reconcile that
   * the bulk reason (branch/workspace) is about to run. Clearing the dirty
   * queue also makes an in-flight drain loop exit at its next takeBatch.
   */
  protected suppressBulkBurst(projectId: number): void {
    const watcher = this.watcher as FileWatcherService & { suspend?: (id: number) => void };
    watcher.suspend?.(projectId);
    this.dirty.clear(projectId);
    this.status.setDirtyPending(projectId, 0);
  }

  /** End bulk-op suppression (no-op when not suspended). */
  protected resumeWatcherEvents(projectId: number): void {
    const watcher = this.watcher as FileWatcherService & { resume?: (id: number) => void };
    watcher.resume?.(projectId);
  }
  protected abstract notifyProjectInactive(projectId: number): void;
  abstract ensureFresh(projectId: number, reason: EnsureFreshReason): void;
}
