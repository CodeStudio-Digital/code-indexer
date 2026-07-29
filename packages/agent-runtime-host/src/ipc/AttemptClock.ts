import { OutboundFrameError } from './OutboundFrameError.js';

const MAX_INT64 = (1n << 63n) - 1n;
const NANOS_PER_MILLISECOND = 1_000_000n;

export interface AuthorityClock {
  now(): bigint;
}

class MonotonicUnixClock implements AuthorityClock {
  readonly #anchorUnixMs;
  readonly #anchorMonotonicNs;
  #lastUnixMs;

  constructor(
    wallNow: () => number,
    private readonly monotonicNow: () => bigint,
  ) {
    const wall = wallNow();
    if (!Number.isSafeInteger(wall) || wall <= 0) {
      throw invalidClock();
    }
    this.#anchorUnixMs = BigInt(wall);
    this.#lastUnixMs = this.#anchorUnixMs;
    this.#anchorMonotonicNs = monotonicNow();
  }

  now(): bigint {
    const elapsed = this.monotonicNow() - this.#anchorMonotonicNs;
    if (elapsed < 0n) throw invalidClock();
    const candidate = this.#anchorUnixMs + elapsed / NANOS_PER_MILLISECOND;
    if (candidate <= 0n || candidate > MAX_INT64) throw invalidClock();
    if (candidate > this.#lastUnixMs) this.#lastUnixMs = candidate;
    return this.#lastUnixMs;
  }
}

class ManualAuthorityClock implements AuthorityClock {
  constructor(private readonly source: () => bigint) {}
  now(): bigint {
    const value = this.source();
    if (value <= 0n || value > MAX_INT64) throw invalidClock();
    return value;
  }
}

export function createAuthorityClock(): AuthorityClock {
  return new MonotonicUnixClock(
    Date.now,
    process.hrtime.bigint,
  );
}

/** Internal test seam; this module is not a package export. */
export function createAuthorityClockForTesting(
  source: () => bigint,
): AuthorityClock {
  return new ManualAuthorityClock(source);
}

/** Internal test seam for wall-clock regression and monotonic-anchor tests. */
export function createAnchoredClockForTesting(
  wallNow: () => number,
  monotonicNow: () => bigint,
): AuthorityClock {
  return new MonotonicUnixClock(wallNow, monotonicNow);
}

function invalidClock(): OutboundFrameError {
  return new OutboundFrameError(
    'invalid_clock',
    'authority clock must produce a positive monotonic int64',
  );
}
