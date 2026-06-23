/**
 * Cross-cutting ports — the seams that keep domain/application layers
 * runtime-agnostic (Node vitest ↔ workerd). Infrastructure adapters implement
 * these; use-cases depend ONLY on these interfaces. The dependency rule points
 * inward: nothing here imports `@cloudflare/*` or `node:*`.
 */

/** Wall-clock time. Test double = a controllable fake clock. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** ISO-8601 string (matches D1 `datetime('now')`-style storage). */
  isoNow(): string;
}

/** Opaque identifier + slug generation (uuid v4 / url-safe nanoid). */
export interface IdGen {
  uuid(): string;
  /** URL-safe slug of `size` chars — share links, opaque tokens. */
  slug(size?: number): string;
}

/** Structured, PII-safe logging (no raw emails/IPs/secrets in `fields`). */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** One statement for a batch (parameterized — never string-interpolated). */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/**
 * DbExecutor — the single persistence seam. Hides D1 vs better-sqlite3 so the
 * SAME repository code runs on D1 (prod) and on an in-memory better-sqlite3
 * (fast unit tests, no workerd). Parameterized statements ONLY, mirroring
 * `worker-market/src/catalog.ts` (`.prepare(sql).bind(params).all<T>()`).
 *
 * Async by contract because D1 is async; the better-sqlite3 adapter wraps its
 * sync calls in resolved promises so the port stays uniform.
 */
export interface DbExecutor {
  /** First matching row, or null. */
  first<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** All matching rows. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Execute a write; returns the number of rows affected. */
  run(sql: string, params?: readonly unknown[]): Promise<{ rowsAffected: number }>;
  /** Atomic batch (D1 `.batch()` / sqlite transaction). All-or-nothing. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

/** Random bytes (CSPRNG) — WebCrypto in prod, node:crypto in tests. */
export interface RandomSource {
  /** `n` cryptographically-secure random bytes. */
  bytes(n: number): Uint8Array;
}

/**
 * RateLimiter — a fixed-window counter keyed by an arbitrary string. Prod adapter
 * is a Durable Object (strongly consistent, serialized per key); tests use an
 * in-memory fake. `consume` counts ONE hit and reports whether it stayed within
 * `limit` for the current `windowMs`.
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}
export interface RateLimitDecision {
  allowed: boolean;
  /** ms until the window resets (only meaningful when `allowed` is false). */
  retryAfterMs: number;
}
