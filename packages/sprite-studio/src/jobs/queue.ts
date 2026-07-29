/**
 * SpriteJobQueue — per-sprite-project FIFO with a global concurrency cap.
 *
 * Within one sprite project jobs run strictly one at a time in enqueue
 * order; across projects at most `concurrency` (default 2) run at once.
 * Each running job gets its own AbortController: cancel() aborts a running
 * job's signal or silently drops a still-queued one. Pure promise chaining —
 * no timers.
 */

interface PendingJob {
  projectId: string;
  jobId: string;
  run: (signal: AbortSignal) => Promise<void>;
}

export class SpriteJobQueue {
  /** Global FIFO; per-project ordering falls out of scan-from-front + busyProjects. */
  private pending: PendingJob[] = [];
  private runningCtrls = new Map<string, AbortController>();
  private busyProjects = new Set<string>();

  constructor(private readonly concurrency: number = 2) {}

  /**
   * Queue a job. `run` receives the job's abort signal and is expected to
   * handle its own errors (the runner persists failed/cancelled states); the
   * queue only sequences execution.
   */
  enqueue(
    spriteProjectId: string,
    jobId: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.isActive(jobId)) {
      throw new Error(`Sprite job ${jobId} is already queued or running`);
    }
    this.pending.push({ projectId: spriteProjectId, jobId, run });
    this.pump();
  }

  /**
   * Abort a running job (its signal fires) or remove a queued one before it
   * starts. Returns false when the queue doesn't know the job (already
   * finished or never enqueued) — the caller decides how to mark the row.
   */
  cancel(jobId: string): boolean {
    const ctrl = this.runningCtrls.get(jobId);
    if (ctrl) {
      ctrl.abort();
      return true;
    }
    const idx = this.pending.findIndex((p) => p.jobId === jobId);
    if (idx < 0) return false;
    this.pending.splice(idx, 1);
    return true;
  }

  /** True while the job is queued OR running (i.e. cancel() would find it). */
  isActive(jobId: string): boolean {
    return this.runningCtrls.has(jobId) || this.pending.some((p) => p.jobId === jobId);
  }

  /** Currently running job count (observability/tests). */
  get running(): number {
    return this.runningCtrls.size;
  }

  private pump(): void {
    while (this.runningCtrls.size < this.concurrency) {
      // First queued job whose project has nothing running = FIFO per project.
      const idx = this.pending.findIndex((p) => !this.busyProjects.has(p.projectId));
      if (idx < 0) return;
      const [job] = this.pending.splice(idx, 1);
      this.start(job);
    }
  }

  private start(job: PendingJob): void {
    const ctrl = new AbortController();
    this.runningCtrls.set(job.jobId, ctrl);
    this.busyProjects.add(job.projectId);
    void Promise.resolve()
      .then(() => job.run(ctrl.signal))
      .catch(() => {
        /* runner owns error reporting; the queue must never wedge */
      })
      .finally(() => {
        this.runningCtrls.delete(job.jobId);
        this.busyProjects.delete(job.projectId);
        this.pump();
      });
  }
}
