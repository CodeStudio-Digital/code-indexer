import type { AuthorityClock } from './AttemptClock.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647n;
const MAX_INT64 = (1n << 63n) - 1n;

export class AttemptDeadlineGuard {
  #timer?: NodeJS.Timeout;
  #target?: bigint;
  #closed = false;

  constructor(
    private readonly clock: AuthorityClock,
    private readonly hardDeadlineAtUnixMs: bigint,
    private readonly maximumPendingMs: number,
    private readonly expire: (cause: unknown) => void,
  ) {}

  start(): void {
    this.#arm(this.hardDeadlineAtUnixMs);
  }

  armPending(frameDeadlineAtUnixMs: bigint | undefined, waitsForCapability = false): void {
    const now = this.clock.now();
    const pendingWindow = BigInt(this.maximumPendingMs);
    const pendingDeadline = now > MAX_INT64 - pendingWindow
      ? MAX_INT64
      : now + pendingWindow;
    // An authenticated capability may run longer than the frame I/O timeout.
    // Its declared envelope and attempt authority still impose absolute bounds.
    let target = !waitsForCapability && pendingDeadline < this.hardDeadlineAtUnixMs
      ? pendingDeadline
      : this.hardDeadlineAtUnixMs;
    if (
      frameDeadlineAtUnixMs !== undefined
      && frameDeadlineAtUnixMs < target
    ) target = frameDeadlineAtUnixMs;
    this.#arm(target, now);
  }

  clearPending(): void {
    this.#arm(this.hardDeadlineAtUnixMs);
  }

  tick(): void {
    if (this.#closed || this.#target === undefined) return;
    this.#arm(this.#target);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#target = undefined;
  }

  #arm(target: bigint, sampledNow?: bigint): void {
    if (this.#closed) {
      throw new AttemptFrameReceiverError(
        'receiver_poisoned',
        'attempt deadline guard is closed',
      );
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#target = target;
    const now = sampledNow ?? this.clock.now();
    if (now >= target) {
      this.#closed = true;
      this.#target = undefined;
      this.expire(deadlineExpired(target, now));
      throw deadlineExpired(target, now);
    }
    const remaining = target - now;
    const delay = Number(
      remaining < MAX_TIMER_DELAY_MS ? remaining : MAX_TIMER_DELAY_MS,
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.tick();
      } catch {
        // Expiry already poisoned the owner; timer callbacks have no observer.
      }
    }, Math.max(delay, 1));
    this.#timer.unref();
  }
}

function deadlineExpired(
  target: bigint,
  observedAt: bigint,
): AttemptFrameReceiverError {
  return new AttemptFrameReceiverError(
    'deadline_expired',
    `attempt deadline ${target} expired at ${observedAt}`,
  );
}
