/**
 * ReconnectingSSEClient — resilient SSE consumer.
 *
 * Single implementation used by every dashboard hook that reads an SSE
 * stream (coder, company). Handles:
 *   - Parsing via SSEFramer (DRY)
 *   - Last-Event-ID tracking (callers provide a getter so they can persist
 *     the last seen seq across reconnects)
 *   - Automatic reconnect with pluggable backoff when the stream drops
 *     before a terminal event
 *   - Heartbeat events (`event: ping`) are surfaced as transport liveness,
 *     never mixed into the semantic event stream
 *   - AbortSignal support for clean cancellation
 *
 * Completes successfully when the stream emits an event deemed terminal
 * by the caller (default: `event === 'done'`), or when the signal aborts.
 * Throws only for non-recoverable errors after backoff is exhausted.
 */

import { parseSSEChunk, type SSEEvent, type SSEFrameErrorHandler } from './SSEFramer.js';
import { ExponentialBackoff, sleep, type BackoffStrategy } from './BackoffStrategy.js';

/**
 * Lifecycle phase of the SSE client. The UI uses this to distinguish
 * a healthy live stream from a freshly-opened replay (where we sent
 * Last-Event-ID and the server is catching us up) and from a broken
 * disconnect that's about to backoff-retry.
 *
 * Transitions:
 *   - `connecting` on every `connectOnce()` start (no Last-Event-ID OR initial open)
 *   - `replaying` when Last-Event-ID is being sent (reconnect with state)
 *   - `live` after the first event arrives over the open stream
 *   - `disconnected` when the connection breaks mid-stream (before the next retry)
 */
export type SSEConnectionPhase = 'connecting' | 'replaying' | 'live' | 'disconnected';
export const LAST_EVENT_BUS_ID_HEADER = 'X-MCP-Bus-ID';

export interface ReconnectingSSEOpts {
  /** Target URL for the request. */
  url: string;
  /** HTTP method. POST uses `body`. */
  method: 'GET' | 'POST';
  /** JSON body for POST. Ignored for GET. */
  body?: unknown;
  /** Called for every non-ping, non-empty event. Synchronous. */
  onEvent: (ev: SSEEvent) => void;
  /**
   * Called when a transport heartbeat is received. The numeric argument is
   * the local receipt time; heartbeat frames never flow through `onEvent`.
   * Exceptions are swallowed so diagnostics/UI cannot break the stream.
   */
  onHeartbeat?: (receivedAt: number) => void;
  /** Invoked before each reconnect attempt (attempt >= 1). */
  onReconnect?: (attempt: number) => void | Promise<void>;
  /**
   * Fired on every phase transition. Use to drive a "Reconnecting…
   * replaying events" UI strip. Calls are best-effort — exceptions
   * inside the handler are swallowed so they don't break the stream.
   */
  onPhase?: (phase: SSEConnectionPhase) => void;
  /** Returns the latest seen event id for Last-Event-ID on reconnect. */
  getLastEventId?: () => number;
  /** Returns the bus instance that allocated the latest event id. */
  getLastEventBusId?: () => string | null | undefined;
  /** AbortSignal for cancellation. */
  signal: AbortSignal;
  /** Reconnect a silent transport (including missing pings), not a slow agent. */
  idleTimeoutMs?: number;
  /** Backoff for reconnect attempts. Defaults to exponential 1s..16s, 5 tries. */
  backoff?: BackoffStrategy;
  /**
   * A connection that stays open for this long replenishes the retry budget
   * even when its events have no numeric ids. Defaults to 30 seconds.
   */
  reconnectBudgetResetMs?: number;
  /** Predicate marking a terminal event. Default: `event === 'done'`. */
  isTerminal?: (ev: SSEEvent) => boolean;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /**
   * Called when the framer drops a malformed event block. Defaults to a
   * console.warn diagnostic — corrupt frames used to vanish silently.
   */
  onParseError?: SSEFrameErrorHandler;
}

const defaultIsTerminal = (ev: SSEEvent) => ev.event === 'done';

const defaultParseErrorDiagnostic: SSEFrameErrorHandler = (err) => {
  console.warn('[sse] dropping malformed event block', err.raw);
};

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export class ReconnectingSSEClient {
  private readonly opts: ReconnectingSSEOpts;
  private readonly backoff: BackoffStrategy;
  private readonly isTerminal: (ev: SSEEvent) => boolean;
  private readonly parseErrorHandler: SSEFrameErrorHandler;
  private readonly reconnectBudgetResetMs: number;
  private terminalSeen = false;
  private highestEventIdSeen = Number.NEGATIVE_INFINITY;
  private highestEventIdBusId: string | null = null;
  private connectionMadeProgress = false;
  private connectionOpenedAt = 0;

  constructor(opts: ReconnectingSSEOpts) {
    this.opts = opts;
    this.backoff = opts.backoff ?? new ExponentialBackoff();
    this.isTerminal = opts.isTerminal ?? defaultIsTerminal;
    this.parseErrorHandler = opts.onParseError ?? defaultParseErrorDiagnostic;
    this.reconnectBudgetResetMs = opts.reconnectBudgetResetMs ?? 30_000;
  }

  /**
   * Runs the client. Resolves when terminal event received or signal aborted.
   * Rejects only when reconnect budget is exhausted without success.
   */
  async run(): Promise<void> {
    let attempt = 0;
    while (!this.opts.signal.aborted && !this.terminalSeen) {
      this.connectionMadeProgress = false;
      this.connectionOpenedAt = 0;
      try {
        if (attempt > 0) {
          await this.opts.onReconnect?.(attempt);
        }
        await this.connectOnce();
        // A transport EOF is not an application-level outcome. Proxies and
        // half-open sockets can close cleanly while the run is still active;
        // only an explicit done/error contract may complete the client.
        if (!this.terminalSeen) throw new SSEStreamEndedWithoutTerminalError();
        return;
      } catch (err) {
        if (this.opts.signal.aborted) return;
        if (this.terminalSeen) return;
        if (isAbortError(err)) return;
        if ((err as { nonRetryable?: boolean }).nonRetryable) throw err;

        // Retry budgets describe consecutive failures without progress, not
        // the entire lifetime of a long-running stream. A strictly newer
        // event id is real replay/live progress. For id-less feeds, a stable
        // open interval is sufficient. Replayed duplicate ids do NOT reset
        // the budget, preventing an endless EOF/replay loop.
        if (
          this.connectionMadeProgress
          || (
            this.connectionOpenedAt > 0
            && Date.now() - this.connectionOpenedAt >= this.reconnectBudgetResetMs
          )
        ) {
          attempt = 0;
        }

        // Phase: connection broke mid-stream. The next iteration of the
        // loop will re-emit `connecting`/`replaying` once the backoff
        // has elapsed.
        this.emitPhase('disconnected');

        const budgetDelay = this.backoff.nextDelay(attempt);
        if (budgetDelay === null) throw err;
        const serverDelay = (err as { retryAfterMs?: unknown }).retryAfterMs;
        const delay = typeof serverDelay === 'number' && serverDelay >= 0
          ? serverDelay
          : budgetDelay;
        try {
          await sleep(delay, this.opts.signal);
        } catch {
          return; // aborted during backoff
        }
        attempt++;
      }
    }
  }

  private emitPhase(phase: SSEConnectionPhase): void {
    if (!this.opts.onPhase) return;
    try {
      this.opts.onPhase(phase);
    } catch {
      /* best-effort */
    }
  }

  private emitHeartbeat(receivedAt: number): void {
    if (!this.opts.onHeartbeat) return;
    try {
      this.opts.onHeartbeat(receivedAt);
    } catch {
      /* best-effort */
    }
  }

  private async connectOnce(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(this.opts.headers ?? {}),
    };
    if (this.opts.method === 'POST') headers['Content-Type'] = 'application/json';
    const lastId = this.opts.getLastEventId?.();
    const requestedBusId = normalizedBusId(this.opts.getLastEventBusId?.());
    if (typeof lastId === 'number' && lastId >= 0) {
      headers['Last-Event-ID'] = String(lastId);
      if (requestedBusId) headers[LAST_EVENT_BUS_ID_HEADER] = requestedBusId;
    }
    if (requestedBusId && this.highestEventIdBusId !== requestedBusId) {
      this.highestEventIdBusId = requestedBusId;
      this.highestEventIdSeen = Number.NEGATIVE_INFINITY;
    }

    // Emit `replaying` when we're asking the server to catch us up;
    // otherwise this is a cold connect.
    this.emitPhase(typeof lastId === 'number' && lastId >= 0 ? 'replaying' : 'connecting');

    const connection = new AbortController();
    // A custom Electron stream may not settle read()/cancel() after abort.
    // Race the reader explicitly and never await transport disposal.
    const interrupt = (error: Error) => connection.abort(error);
    const onAbort = () => interrupt(new DOMException('Aborted', 'AbortError'));
    this.opts.signal.addEventListener('abort', onAbort, { once: true });
    if (this.opts.signal.aborted) onAbort();
    let lastBytesAt = Date.now();
    let receivedBytes = false;
    const idleMs = this.opts.idleTimeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const checkIdle = () => {
      const remaining = idleMs! - (Date.now() - lastBytesAt);
      if (remaining > 0) idleTimer = setTimeout(checkIdle, remaining);
      else interrupt(new Error('SSE transport heartbeat timed out; reconnecting'));
    };
    if (idleMs && idleMs > 0) idleTimer = setTimeout(checkIdle, idleMs);
    try {
      const res = await withConnectionAbort(fetch(this.opts.url, {
        method: this.opts.method,
        headers,
        body: this.opts.method === 'POST' ? JSON.stringify(this.opts.body ?? {}) : undefined,
        signal: connection.signal,
      }), connection.signal);
      if (!res.ok || !res.body) {
        // Surface the parsed JSON body alongside the status so callers can
        // route specific 4xx flavours (e.g., 409 INTERACTION_PENDING) into
        // their own UI state instead of a generic "error" toast.
        let httpBody: unknown = null;
        try {
          httpBody = await withConnectionAbort(res.json(), connection.signal);
        } catch {
          /* response body wasn't JSON */
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          nonRetryable: res.status >= 400 && res.status < 500,
          status: res.status,
          httpBody,
          retryAfterMs: retryAfterMs(res),
        });
      }
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstEventSeen = false;

      while (true) {
        const { value, done } = await withConnectionAbort(reader.read(), connection.signal);
        if (done) break;
        lastBytesAt = Date.now();
        if (!receivedBytes) { receivedBytes = true; this.connectionOpenedAt = lastBytesAt; }
        buffer += decoder.decode(value, { stream: true });

        const { events, rest } = parseSSEChunk(buffer, this.parseErrorHandler);
        buffer = rest;

        for (const ev of events) {
          if (ev.event === 'ping') {
            // A heartbeat proves the fetch/reader path is live even when the
            // agent has no semantic output (long thinking/tool wait). Keep it
            // out of onEvent so it cannot enter transcripts or advance cursors.
            if (!firstEventSeen) {
              this.emitPhase('live');
              firstEventSeen = true;
            }
            this.emitHeartbeat(Date.now());
            continue;
          }
          if (!firstEventSeen) {
            // First real event over this connection — we're live now,
            // any replay buffer has started flowing.
            this.emitPhase('live');
            firstEventSeen = true;
          }
          this.opts.onEvent(ev);
          const currentBusId = normalizedBusId(this.opts.getLastEventBusId?.());
          if (currentBusId && this.highestEventIdBusId !== currentBusId) {
            this.highestEventIdBusId = currentBusId;
            this.highestEventIdSeen = Number.NEGATIVE_INFINITY;
          }
          if (typeof ev.id === 'number' && ev.id > this.highestEventIdSeen) {
            this.highestEventIdSeen = ev.id;
            this.connectionMadeProgress = true;
          }
          if (this.isTerminal(ev)) {
            this.terminalSeen = true;
            return;
          }
        }
      }
    } finally {
      clearTimeout(idleTimer);
      this.opts.signal.removeEventListener('abort', onAbort);
      if (reader) {
        void reader.cancel().catch(() => undefined);
        try { reader.releaseLock(); } catch { /* already released */ }
      }
      connection.abort();
    }
  }
}

/** Remove the abort listener after every read; a long stream must not retain
 * one Promise.race reaction per chunk on a never-settled shared promise. */
function withConnectionAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class SSEStreamEndedWithoutTerminalError extends Error {
  readonly code = 'SSE_STREAM_ENDED_WITHOUT_TERMINAL';

  constructor() {
    super('SSE stream ended without a terminal event');
    this.name = 'SSEStreamEndedWithoutTerminalError';
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function normalizedBusId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : null;
}
