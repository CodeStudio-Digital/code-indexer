/**
 * Cooperative priority gate for user-triggered filesystem work.
 *
 * Structural indexing is background work. When an interactive Git mutation
 * (stage/commit/unstage) starts, the scanner/writer pauses at its next bounded
 * checkpoint so both jobs do not saturate the same working tree and disk.
 *
 * The gate is isolate-local. The main-thread executor toggles it directly;
 * the worker executor mirrors the same state over MessageBridge events.
 */
export class InteractivePriorityGate {
  private busyProjects = new Set<number>();
  private waiters = new Map<number, Set<() => void>>();

  setBusy(projectId: number, busy: boolean): void {
    if (busy) {
      this.busyProjects.add(projectId);
      return;
    }
    if (!this.busyProjects.delete(projectId)) return;
    const waiters = this.waiters.get(projectId);
    this.waiters.delete(projectId);
    for (const resolve of waiters ?? []) resolve();
  }

  isBusy(projectId: number): boolean {
    return this.busyProjects.has(projectId);
  }

  async wait(projectId: number): Promise<void> {
    while (this.busyProjects.has(projectId)) {
      await new Promise<void>((resolve) => {
        let waiters = this.waiters.get(projectId);
        if (!waiters) {
          waiters = new Set();
          this.waiters.set(projectId, waiters);
        }
        waiters.add(resolve);
      });
    }
  }
}
