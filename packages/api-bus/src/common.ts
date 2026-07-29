/**
 * Shared types for the api-bus RPC contract.
 *
 * The contract is transport-agnostic: the same handler signatures are
 * mounted on Hono routes (HTTP/SSE for browser dev + diagnostics) and on
 * Electron `ipcMain.handle` + `MessageChannel` (in-process, zero overhead).
 *
 * `AsyncStream<T>` is the streaming primitive. Hono adapts it to SSE;
 * Electron adapts it to a `MessagePort` posted to the renderer. Callers
 * consume it as a normal `AsyncIterable<T>` and never see the transport.
 */

/**
 * A pull-based stream of values. Implementations may finish with `return`
 * (clean completion) or throw (error propagates to the consumer).
 *
 * Equivalent to `AsyncIterable<T>` but named to make the streaming intent
 * explicit at every API boundary.
 */
export type AsyncStream<T> = AsyncIterable<T>;

/**
 * Per-request context injected by the transport layer.
 *
 * - `user`: present when the caller is authenticated. The Electron IPC
 *   bridge extracts user identity from the cached JWT; Hono extracts it
 *   from the `Authorization` header via `userAuthMiddleware`.
 * - `requestId`: stable id for log correlation across the handler and any
 *   nested calls (worker pool dispatches, provider calls, etc.).
 */
export interface ApiContext {
  user?: AuthenticatedUser;
  requestId: string;
  /**
   * Abort signal tied to the request lifecycle. For HTTP this fires when
   * the client disconnects; for IPC it fires when the renderer cancels
   * the call or the window closes.
   */
  signal: AbortSignal;
  /**
   * Request provenance — which surface (Electron / HTTP / CLI / internal)
   * issued the call, plus optional client identity. Populated by each
   * transport adapter; used for log correlation, telemetry, and compliance.
   * Mirrors Codex's `clientInfo` on the app-server initialize.
   */
  clientInfo?: ClientInfo;
  /** Optional filesystem-session attribution for pipeline telemetry. */
  telemetryScope?: {
    sessionId?: string;
    companySessionId?: string;
  };
}

/** Request-source provenance attached to every {@link ApiContext}. */
export interface ClientInfo {
  /** Which surface issued the request. */
  sourceType: 'electron' | 'http' | 'cli' | 'internal';
  /** Optional client name/version (e.g. the HTTP User-Agent). */
  userAgent?: string;
  /** Optional origin (HTTP `Origin` header, or an IPC channel label). */
  origin?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  tier: 'free' | 'pro';
}

/**
 * Structured error thrown by handlers. The transport layer translates
 * `status` to the appropriate HTTP code or IPC error payload.
 *
 * Conventional status codes:
 *  - 400 invalid input
 *  - 401 not authenticated (`auth_required`)
 *  - 402 tier insufficient (`pro_required`, `quota_exceeded`)
 *  - 403 forbidden
 *  - 404 not found
 *  - 409 conflict
 *  - 500 internal
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, status: number, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Pagination envelope used by list endpoints that need it.
 * Cursor-based; `nextCursor: null` means end of stream.
 */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
