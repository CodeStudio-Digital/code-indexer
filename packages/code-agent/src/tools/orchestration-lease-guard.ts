/**
 * Process-local keepalive around a durable session-bundle lease token.
 *
 * The session-bundle checkpoint lease remains the authority. This guard
 * renews while the owning executor is alive and remembers ownership loss
 * permanently so a transient later success cannot resurrect a fenced
 * executor.
 */
export interface OrchestrationLeaseGuard {
  assertOwned(): Promise<void>;
  start(onLost?: (error: Error) => void): () => void;
  stop(): void;
  isLost(): boolean;
  isRunning(): boolean;
}

export interface CreateOrchestrationLeaseGuardInput {
  label: string;
  leaseMs: number;
  renew: () => boolean | Promise<boolean>;
}

function intervalMs(leaseMs: number): number {
  return Math.max(1_000, Math.floor(leaseMs / 3));
}

export function createOrchestrationLeaseGuard(
  input: CreateOrchestrationLeaseGuardInput,
): OrchestrationLeaseGuard {
  let lost: Error | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let onLost: ((error: Error) => void) | undefined;
  let renewing: Promise<void> = Promise.resolve();

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

  const renewOrLose = async (): Promise<void> => {
    if (lost) throw lost;
    try {
      if (!(await input.renew())) throw lose();
    } catch (error) {
      throw lose(error);
    }
  };

  const queueRenewal = (): Promise<void> => {
    renewing = renewing.then(renewOrLose, renewOrLose);
    return renewing;
  };

  return {
    assertOwned(): Promise<void> {
      return queueRenewal();
    },
    start(callback): () => void {
      if (lost) throw lost;
      onLost = callback;
      if (!timer) {
        timer = setInterval(async () => {
          await queueRenewal().catch(() => undefined);
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
