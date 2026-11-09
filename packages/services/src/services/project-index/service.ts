import { drainDirtyQueue } from './service-drain.js';


import { isUnityProjectRoot } from '@mcp/shared/utils/project-ignore.js';

import { type ActiveIndexRun, type DirtyEvent, type ProjectIndexSettings, type ProjectIndexStatus, type StructuralProgressFrame } from './types.js';
import { isStructurallyReady, waitForStructuralReadiness, type StructuralReadinessResult } from './structural-readiness.js';
import { type EnsureFreshReason, type SemanticCatchupHooks, PROGRESS_MIN_INTERVAL_MS, LARGE_PROJECT_FILE_COUNT, envDelay, yieldToEventLoop, msg } from './service-support.js';
import { ProjectIndexWatchers } from './service-watchers.js';
export type { EnsureFreshReason, SemanticCatchupHooks } from './service-support.js';

/** Coordinates structural indexing and semantic catch-up for active projects. */
export class ProjectIndexService extends ProjectIndexWatchers {
  private readonly structuralRuns = new Map<number, Promise<StructuralReadinessResult>>();

  /** Explicit repair waits for its own pass, not a previously usable baseline.
   * Cancellation/timeout stops this caller's wait and any queued request; an
   * already running shared index publication is allowed to finish atomically. */
  reconcileStructural(projectId: number, timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void): Promise<StructuralReadinessResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: StructuralReadinessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const current = (status: StructuralReadinessResult['status']): StructuralReadinessResult => ({
        status, phase: this.getStatus(projectId).phase,
      });
      const onAbort = () => finish(current('aborted'));
      const timer = setTimeout(() => finish(current('timeout')), Math.max(1, timeoutMs));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      void (async () => {
        // A pass already scanning may have visited the changed file before
        // this request. Wait for it, then request a new repair pass.
        while (!settled && this.structuralRuns.has(projectId)) {
          await this.structuralRuns.get(projectId);
        }
        if (settled) return;
        if (this.disposed) { finish(current('disabled')); return; }
        this.startStructuralRun(projectId, this.settings(), true, 'manual', () => {
          if (settled) return false;
          beforeStart?.();
          return true;
        });
        let result: StructuralReadinessResult = current('disabled');
        // A branch/workspace event can supersede the pass. Follow its queued
        // replacement through the watcher barrier instead of acknowledging it.
        while (!settled && this.structuralRuns.has(projectId)) {
          result = await this.structuralRuns.get(projectId)!;
        }
        finish(result);
      })().catch((error) => finish({ ...current('error'), error: msg(error) }));
    });
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
    this.fallbackMtimes.delete(projectId);
    this.fallbackReconcileAt.delete(projectId);
    if (this.semanticLifecycleActive.delete(projectId)) this.notifyProjectInactive(projectId);
    const timer = this.pendingActivation.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.pendingActivation.delete(projectId);
      this.status.setScheduledRun(projectId, undefined);
    }
    // A branch event may have suspended the watcher counting on the deferred
    // run just cancelled above; without a reconcile to resume in, end the
    // suppression here so a kept-alive watcher (other subscribers) stays live.
    this.resumeWatcherEvents(projectId);
    this.scheduleFileWatcherStop(projectId);
    return true;
  }

  /** Fire-and-forget "project became active". Cheap and re-entrant. */
  ensureFresh(projectId: number, reason: EnsureFreshReason): void {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.autoIndex && reason !== 'manual') return;

    if (reason === 'branch' || reason === 'workspace') {
      if (this.running.has(projectId)) {
        if (this.runReason.get(projectId) !== reason) {
          this.queuedReconcile.set(projectId, reason);
          // The queued follow-up reconcile supersedes the checkout burst —
          // suppress now so the running pass's barrier flush doesn't drain the
          // burst file-by-file first.
          this.suppressBulkBurst(projectId);
        }
        // Same-reason: the running bulk pass already owns suppression; its
        // barrier/resume flushes keep later deltas correct — discarding here
        // could drop events for files its scan already passed.
        return;
      }
      this.suppressBulkBurst(projectId);
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

    // Expose synthetic-global work immediately so the non-blocking status
    // indicator reflects the scheduled pass before the session starts.
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
  protected startStructuralRun(
    projectId: number,
    s: ProjectIndexSettings,
    manual: boolean,
    reason: EnsureFreshReason = manual ? 'manual' : 'open',
    beforeStart?: () => boolean | void,
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
    // Bulk-op suppression (IntelliJ BatchFileChangeListener): a branch/workspace
    // reconcile supersedes the checkout's per-file burst. Re-asserted here
    // (idempotent) because the queued-restart path enters directly, without
    // passing through ensureFresh. The matching resume lives in the finally.
    if (reason === 'branch' || reason === 'workspace') this.suppressBulkBurst(projectId);
    this.ensureGitMetaWatching(projectId);
    this.ensureFileWatching(projectId, 0, true);
    let reconciled = false;
    let run: Promise<StructuralReadinessResult>;
    run = this.mutex
      .withLock(projectId, async () => {
        await this.waitForFileWatcherReady(projectId);
        // Semantic jobs can own this mutex too. Recheck the requesting owner
        // after every queue/barrier, immediately before the worker starts.
        if (beforeStart?.() === false) return;
        const completed = await this.runStructural(projectId, s, manual);
        if (!completed) return;
        // Give watcher callbacks queued in the same event-loop turn a chance
        // to enter their debounce buffer, then flush it at the scan barrier.
        await yieldToEventLoop();
        await this.flushWatcherEvents(projectId);
        if (this.queuedReconcile.has(projectId)) return;
        await this.drainDirtyLocked(projectId);
        this.status.refreshFromDb(projectId);
        reconciled = true;
        if ((this.activations.get(projectId)?.size ?? 0) > 0) this.notifyProjectReady(projectId);
        void this.semanticCatchup?.ensureProject(projectId).catch((error) =>
          console.warn(`[project-index] semantic project catch-up paused for ${projectId}: ${msg(error)}`));
      })
      .catch((err) => this.status.setPhase(projectId, 'error', msg(err)))
      .then((): StructuralReadinessResult => {
        const status = this.getStatus(projectId);
        return {
          status: reconciled ? 'ready' : status.phase === 'too_large' ? 'too_large' : 'error',
          phase: status.phase,
          ...(!reconciled ? { error: status.error ?? 'Structural reconciliation did not settle.' } : {}),
        };
      })
      .finally(() => {
        if (this.structuralRuns.get(projectId) === run) this.structuralRuns.delete(projectId);
        this.fallbackReconcileAt.set(projectId, Date.now());
        this.running.delete(projectId);
        this.runReason.delete(projectId);
        if (reconciled) this.reconciledLifecycle.add(projectId);
        this.lastProgressAt.delete(projectId);
        const queuedReason = this.queuedReconcile.get(projectId);
        this.queuedReconcile.delete(projectId);
        if (queuedReason && !this.disposed) {
          // Keep suppression armed across the hand-off — the queued bulk run
          // re-asserts it and its own finally performs the resume.
          this.startStructuralRun(projectId, this.settings(), false, queuedReason);
        } else {
          // No-op unless this run suspended (resume checks membership). Events
          // buffered after the scan barrier flush out here and drain normally.
          this.resumeWatcherEvents(projectId);
          this.scheduleDrain(projectId);
          if (!this.shouldKeepWatcher(projectId)) this.scheduleFileWatcherStop(projectId);
        }
      });
    this.structuralRuns.set(projectId, run);
  }

  /** Known changes (Monaco save/rename/delete, scaffold) — index-form rel paths. */
  markDirty(projectId: number, events: DirtyEvent[]): void {
    if (this.disposed || events.length === 0) return;
    this.dirty.add(projectId, events);
    this.drainFailures.delete(projectId);
    this.semanticCatchup?.noteDelta(projectId, events);
    this.status.setDirtyPending(projectId, this.dirty.size(projectId));
    // Every indexable change is also a UI-visible change — markDirty is the
    // single funnel (watcher + Monaco fast-path + scaffold), so publishing
    // here gives the live tree near-zero latency on editor saves.
    this.publishFsEvents(projectId, events.map((e) => ({ ...e, isDir: false })));
    this.scheduleDrain(projectId);
  }

  getStatus(projectId: number): ProjectIndexStatus {
    return {
      ...this.status.get(projectId),
      dirtyPending: this.dirty.size(projectId),
      watcherActive: this.watcher.isWatching(projectId) && !this.watcher.isSkipped?.(projectId),
      watcherMode: this.watcher.isSkipped?.(projectId) ? 'polling'
        : this.watcher.isWatching(projectId) ? 'live' : 'off',
    };
  }

  subscribe(projectId: number, fn: (s: ProjectIndexStatus) => void): () => void {
    return this.status.subscribe(projectId, () => fn(this.getStatus(projectId)));
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

  /**
   * Give a user-triggered filesystem mutation priority over background
   * structural scanning/writes. Nested/concurrent operations share one lease;
   * the indexer resumes only after the final lease settles.
   */
  async withInteractiveFilesystemPriority<T>(
    projectId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const depth = this.interactivePriorityDepth.get(projectId) ?? 0;
    this.interactivePriorityDepth.set(projectId, depth + 1);
    if (depth === 0) this.setInteractivePriority(projectId, true);
    try {
      return await fn();
    } finally {
      const remaining = (this.interactivePriorityDepth.get(projectId) ?? 1) - 1;
      if (remaining > 0) {
        this.interactivePriorityDepth.set(projectId, remaining);
      } else {
        this.interactivePriorityDepth.delete(projectId);
        this.setInteractivePriority(projectId, false);
      }
    }
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

  // ─── Internals ────────────────────────────────────────────────────

  protected async runStructural(projectId: number, s: ProjectIndexSettings, manual = false): Promise<boolean> {
    const beforeScan = this.dirty.takeBatch(projectId, Number.MAX_SAFE_INTEGER);
    this.status.setPhase(projectId, 'scanning');
    const result = await this.executor.runStructuralIndex(projectId, {
      maxFiles: s.maxFiles,
      allowEmptyWipe: manual,
      forceReparse: manual,
      onProgress: (p) => this.publishStructuralProgress(projectId, p),
      onChanges: async (events, previousItemKeys) => {
        // A cold scan also owns durable deltas: watcher history may not include
        // files that predate startup. Failed publication must leave them replayable.
        const pending = this.dirty.takeBatch(projectId, Number.MAX_SAFE_INTEGER);
        const pendingPaths = new Set(pending.entries.map(entry => entry.path));
        const discovered = events.filter(event => !pendingPaths.has(event.path));
        this.dirty.add(projectId, discovered);
        const discoveredPaths = new Set(discovered.map(event => event.path));
        beforeScan.entries.push(...this.dirty.takeBatch(projectId, Number.MAX_SAFE_INTEGER).entries
          .filter(entry => discoveredPaths.has(entry.path)));
        // Only scan-owned versions may be acknowledged. Watcher events arriving
        // during the scan remain pending, even when their path occurs in events.
        await this.semanticCatchup?.noteDelta(projectId, events, previousItemKeys);
      },
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
    if (result.aborted || result.errorCount > 0) {
      this.status.setPhase(projectId, 'error', 'Structural publication did not complete; the previous index and pending deltas were preserved.');
      return false;
    }
    this.dirty.ack(projectId, beforeScan);
    return true;
  }

  protected setInteractivePriority(projectId: number, busy: boolean): void {
    try {
      this.executor.setInteractivePriority?.(projectId, busy);
    } catch (error) {
      // Priority is a performance contract, never a correctness gate for Git.
      console.warn(
        `[project-index] failed to ${busy ? 'pause' : 'resume'} background indexing for project ${projectId}: ${msg(error)}`,
      );
    }
  }

  protected publishStructuralProgress(projectId: number, p: StructuralProgressFrame): void {
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

  protected async drainDirtyLocked(projectId: number): Promise<void> {
    await drainDirtyQueue(projectId, this.dirty, () => this.executor, this.status, (events, previousItemKeys) => {
      this.semanticCatchup?.noteDelta(projectId, events, previousItemKeys);
    });
  }

  protected notifyProjectReady(projectId: number): void {
    if (!this.semanticCatchup?.projectReady || this.semanticLifecycleActive.has(projectId)) return;
    this.semanticLifecycleActive.add(projectId);
    void Promise.resolve(this.semanticCatchup.projectReady(projectId)).catch((error) => {
      this.semanticLifecycleActive.delete(projectId);
      console.warn(`[project-index] semantic lifecycle activation failed for ${projectId}: ${msg(error)}`);
    });
  }

  protected notifyProjectInactive(projectId: number): void {
    void Promise.resolve(this.semanticCatchup?.projectInactive?.(projectId)).catch((error) =>
      console.warn(`[project-index] semantic lifecycle deactivation failed for ${projectId}: ${msg(error)}`));
  }

  protected scheduleDrain(projectId: number): void {
    if (this.disposed || this.running.has(projectId) || this.draining.has(projectId) || this.drainRetries.has(projectId)
      || (this.drainFailures.get(projectId) ?? 0) >= 5 || this.dirty.size(projectId) === 0) return;
    this.draining.add(projectId);
    void this.mutex
      .withLock(projectId, async () => {
        if (this.disposed || this.running.has(projectId)) return;
        await this.drainDirtyLocked(projectId);
        this.drainFailures.delete(projectId);
        this.status.refreshFromDb(projectId);
        void this.semanticCatchup?.ensureProject(projectId).catch((error) =>
          console.warn(`[project-index] semantic watcher catch-up paused for ${projectId}: ${msg(error)}`));
      })
      .catch((err) => {
        const failures = (this.drainFailures.get(projectId) ?? 0) + 1;
        this.drainFailures.set(projectId, failures);
        this.status.setPhase(projectId, 'error', `${msg(err)}; ${this.dirty.size(projectId)} pending`);
        if (!this.disposed && failures < 5) {
          const timer = setTimeout(() => {
            this.drainRetries.delete(projectId);
            this.scheduleDrain(projectId);
          }, Math.min(30_000, 500 * 2 ** (failures - 1)));
          timer.unref?.();
          this.drainRetries.set(projectId, timer);
        }
        console.warn(`[project-index] drain failed for project ${projectId}: ${msg(err)}`);
      })
      .finally(() => {
        this.draining.delete(projectId);
        // Items that arrived between the loop exit and the flag reset.
        if (this.dirty.size(projectId) > 0) this.scheduleDrain(projectId);
      });
  }
}
