/**
 * Periodic CPU/mem sampler for the manager's primary sandboxes. Each
 * tick walks every `ready` non-paused sandbox, asks the driver for a
 * `stats` snapshot, and emits a `stats` event for SSE subscribers.
 *
 * Driver-level failures are swallowed — a hung stats call must not kill
 * the sampler. Sampling is opt-out via `statsIntervalMs <= 0`.
 */
import type { Sandbox, SandboxEvent } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import { IntervalTimer } from '@mcp/services/sandbox/manager/reaper/interval-timer.js';

export interface StatsSamplerDeps {
  getDriver: () => ISandboxDriver | null;
  listSandboxes: () => Iterable<Sandbox>;
  emit: (event: SandboxEvent) => void;
  isShuttingDown: () => boolean;
}

/**
 * Take one stats sample across all ready sandboxes. Exposed separately
 * from `startStatsSampler` so the interval timer can be unit-tested with
 * `vi.useFakeTimers()` and the sample logic with a fake driver alone.
 */
export async function sampleAllSandboxes(deps: StatsSamplerDeps): Promise<void> {
  const driver = deps.getDriver();
  if (!driver) return;
  for (const sb of deps.listSandboxes()) {
    if (sb.status !== 'ready' || sb.runtimePaused) continue;
    try {
      const sample = await driver.stats(sb.containerId);
      if (!sample) continue;
      deps.emit({
        kind: 'stats',
        sandboxId: sb.id,
        cpuPercent: sample.cpuPercent,
        memBytes: sample.memBytes,
        sampledAt: sample.sampledAt,
      });
    } catch {
      /* best-effort — a hung stats call shouldn't kill the sampler */
    }
  }
}

/**
 * Start an `IntervalTimer` that calls `sampleAllSandboxes` every
 * `intervalMs`. Returns the timer so the caller can stop it on shutdown.
 * Returns `null` when sampling is disabled (`intervalMs <= 0`).
 */
export function startStatsSampler(
  intervalMs: number,
  deps: StatsSamplerDeps,
): IntervalTimer | null {
  if (intervalMs <= 0) return null;
  const timer = new IntervalTimer(intervalMs, () => {
    if (deps.isShuttingDown()) return;
    void sampleAllSandboxes(deps);
  });
  timer.start();
  return timer;
}
