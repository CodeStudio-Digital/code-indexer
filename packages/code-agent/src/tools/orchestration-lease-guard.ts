/**
 * Process-local keepalive around a durable SQLite lease token.
 *
 * The database CAS remains the authority. This guard only renews while the
 * owning executor is alive and remembers ownership loss permanently so a
 * transient later success can never resurrect a fenced executor.
 */
export interface OrchestrationLeaseGuard {
  assertOwned(): void;
  start(onLost?: (error: Error) => void): () => void;
  stop(): void;
  isLost(): boolean;
  isRunning(): boolean;
}

export interface CreateOrchestrationLeaseGuardInput {
  label: string;
  leaseMs: number;
  renew: () => boolean;
}

function intervalMs(leaseMs: number): number {
  const ceiling = Math.max(1_000, Math.floor(leaseMs / 3));
  const configured = Number(process.env.CODER_ORCHESTRATION_LEASE_HEARTBEAT_MS);
  if (!Number.isFinite(configured) || configured < 1_000) return ceiling;
  return Math.min(ceiling, Math.floor(configured));
}

export function createOrchestrationLeaseGuard(
  input: CreateOrchestrationLeaseGuardInput,
): OrchestrationLeaseGuard {
  let lost: Error | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let onLost: ((error: Error) => void) | undefined;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    onLost = undefined;
  };

  const lose = (cause?: unknown): Error => {
    if (!lost) {
      lost = cause instanceof Error
        ? new Error(`${input.label} executor lease was fenced or expired: ${cause.message}`)
        : new Error(`${input.label} executor lease was fenced or expired`);
      const notify = onLost;
      stop();
      try { notify?.(lost); } catch { /* ownership is already lost */ }
    }
    return lost;
  };

  const renewOrLose = (): void => {
    if (lost) throw lost;
    try {
      if (!input.renew()) throw lose();
    } catch (error) {
      throw lose(error);
    }
  };

  return {
    assertOwned(): void {
      renewOrLose();
    },
    start(callback): () => void {
      if (lost) throw lost;
      onLost = callback;
      if (!timer) {
        timer = setInterval(() => {
          try { renewOrLose(); } catch { /* sticky loss is observed at next boundary */ }
        }, intervalMs(input.leaseMs));
        timer.unref?.();
      }
      return stop;
    },
    stop,
    isLost: () => lost !== null,
    isRunning: () => timer !== null,
  };
}
