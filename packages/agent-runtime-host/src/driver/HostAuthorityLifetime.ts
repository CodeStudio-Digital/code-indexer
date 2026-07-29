import type { AuthorityClock } from '../ipc/AttemptClock.js';
import { AttemptDeadlineGuard } from '../ipc/AttemptDeadlineGuard.js';
import type {
  DurableActivationGrant,
  PreparedDurabilityFacts,
  PreparedDurabilityPort,
} from './HostLifecycleTypes.js';

export class HostAuthorityLifetime {
  readonly #controller = new AbortController();
  #guard: AttemptDeadlineGuard;
  #started = false;

  constructor(
    private readonly clock: AuthorityClock,
    private deadline: bigint,
    private readonly expire: (cause: unknown) => void,
  ) {
    this.#guard = this.#newGuard(deadline);
  }

  async commitPrepared(
    port: PreparedDurabilityPort,
    facts: PreparedDurabilityFacts,
  ): Promise<DurableActivationGrant> {
    this.start();
    const signal = this.#controller.signal;
    const operation = Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return port.commitPrepared(
        facts,
        Object.freeze({
          signal,
          deadlineAtUnixMs: this.deadline,
        }),
      );
    });
    if (signal.aborted) throw signal.reason;
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (rejectAbort) {
        signal.removeEventListener('abort', rejectAbort);
      }
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#guard.start();
  }

  narrowDeadline(deadlineAtUnixMs: bigint): void {
    if (deadlineAtUnixMs > this.deadline || deadlineAtUnixMs <= 0n) {
      throw new RangeError('authority deadline may only narrow');
    }
    if (deadlineAtUnixMs === this.deadline) return;
    this.#guard.close();
    this.deadline = deadlineAtUnixMs;
    this.#guard = this.#newGuard(deadlineAtUnixMs);
    this.#guard.start();
  }

  abort(cause: unknown): void {
    this.#controller.abort(cause);
    this.#guard.close();
  }

  tick(): void {
    this.#guard.tick();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get deadlineAtUnixMs(): bigint {
    return this.deadline;
  }

  #newGuard(deadlineAtUnixMs: bigint): AttemptDeadlineGuard {
    return new AttemptDeadlineGuard(
      this.clock,
      deadlineAtUnixMs,
      1,
      (cause) => {
        this.#controller.abort(cause);
        this.expire(cause);
      },
    );
  }
}
