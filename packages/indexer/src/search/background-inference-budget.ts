import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';

/** Query work bypasses this budget. Background work always retains some
 * progress and never interrupts a native batch or loses its durable cursor. */
export function backgroundInferenceDutyCycle(cpuFraction: number, loopUtilization: number): number {
  return cpuFraction >= 0.75 || loopUtilization >= 0.8 ? 0.1 : 0.5;
}

/** Sample on demand between batches; no idle polling and no model loading. */
export class BackgroundInferenceBudget {
  private cpu = process.cpuUsage();
  private loop = performance.eventLoopUtilization();
  private sampledAt = performance.now();
  private duty = 0.5;

  current(): number {
    const now = performance.now();
    const elapsed = now - this.sampledAt;
    if (elapsed < 500) return this.duty;
    const cpu = process.cpuUsage();
    const loop = performance.eventLoopUtilization();
    const loopDelta = performance.eventLoopUtilization(loop, this.loop);
    const cpuFraction = (cpu.user + cpu.system - this.cpu.user - this.cpu.system)
      / (elapsed * 1_000 * availableParallelism());
    this.duty = backgroundInferenceDutyCycle(cpuFraction, loopDelta.utilization);
    this.cpu = cpu;
    this.loop = loop;
    this.sampledAt = now;
    return this.duty;
  }
}
