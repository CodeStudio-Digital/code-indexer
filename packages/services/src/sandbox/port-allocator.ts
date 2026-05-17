/**
 * In-process host-port allocator for sandbox containers.
 *
 * Picks a free port from a configurable pool. Tracks allocations so
 * concurrent provisions don't collide. Released ports go back in the pool
 * and may be reused after a short cooldown to avoid OS TIME_WAIT hits.
 *
 * The pool is intentionally small (34000–34999 by default) because each
 * active sandbox also consumes other resources (memory, `node_modules`).
 * `MAX_SANDBOXES` in the manager enforces the ceiling separately; this
 * allocator only concerns itself with unique-port-per-sandbox.
 */

import { createServer } from 'node:net';

export interface PortAllocatorOptions {
  /** Inclusive lower bound of the allocation pool. Default 34000. */
  min?: number;
  /** Inclusive upper bound. Default 34999. */
  max?: number;
  /** Milliseconds before a released port may be handed out again. Default 5000. */
  cooldownMs?: number;
}

export class PortAllocator {
  private readonly min: number;
  private readonly max: number;
  private readonly cooldownMs: number;
  private readonly inUse = new Set<number>();
  private readonly releasedAt = new Map<number, number>();

  constructor(options: PortAllocatorOptions = {}) {
    this.min = options.min ?? 34_000;
    this.max = options.max ?? 34_999;
    this.cooldownMs = options.cooldownMs ?? 5_000;
    if (this.min > this.max) {
      throw new Error(`PortAllocator: min (${this.min}) > max (${this.max})`);
    }
  }

  /**
   * Acquire a free port. Scans the pool deterministically from `min` to
   * `max`, skipping in-use and recently-released ports, then verifies
   * the candidate is actually bindable by trying to listen on it briefly.
   *
   * Throws when the pool is exhausted — the caller should surface an
   * actionable "too many concurrent sandboxes" error.
   */
  async acquire(): Promise<number> {
    const now = Date.now();
    for (let port = this.min; port <= this.max; port++) {
      if (this.inUse.has(port)) continue;
      const releasedAt = this.releasedAt.get(port);
      if (releasedAt !== undefined && now - releasedAt < this.cooldownMs) continue;
      if (!(await isBindable(port))) continue;
      this.inUse.add(port);
      this.releasedAt.delete(port);
      return port;
    }
    throw new Error(
      `PortAllocator: no free port in [${this.min}, ${this.max}] (${this.inUse.size} in use)`,
    );
  }

  /** Release a port back to the pool. Idempotent. */
  release(port: number): void {
    if (!this.inUse.has(port)) return;
    this.inUse.delete(port);
    this.releasedAt.set(port, Date.now());
  }

  /** Test-only: snapshot the current in-use set. */
  snapshot(): { inUse: number[]; poolSize: number } {
    return { inUse: [...this.inUse], poolSize: this.max - this.min + 1 };
  }
}

/**
 * Process-wide shared allocator. Both the container `SandboxManager`
 * and the host-side `LocalProcessManager` must acquire from the SAME
 * instance, otherwise they can hand out the same port (container on
 * 34001 mapped via Docker + local process also binding 34001). Lazy to
 * let tests substitute via `setDefaultPortAllocatorForTests()`.
 */
let sharedAllocator: PortAllocator | null = null;

export function defaultPortAllocator(): PortAllocator {
  if (!sharedAllocator) sharedAllocator = new PortAllocator();
  return sharedAllocator;
}

export function setDefaultPortAllocatorForTests(allocator: PortAllocator | null): void {
  sharedAllocator = allocator;
}

/**
 * Try to bind a TCP listener on `port` briefly. Returns true when the OS
 * accepts the bind (port is free), false on EADDRINUSE or any other error.
 * This is a best-effort check — a race is possible between this probe and
 * the actual container start, but the allocator marks the port in-use
 * immediately on success, so concurrent callers inside the same process
 * can't pick the same port.
 */
async function isBindable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    // Bind on loopback only — matches how drivers expose ports (127.0.0.1:port).
    server.listen(port, '127.0.0.1');
  });
}
