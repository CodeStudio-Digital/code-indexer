/**
 * Typed request/response/event bridge over a `worker_threads.MessagePort`
 * (or any object with the `MessagePort` shape: `on('message', cb)` +
 * `postMessage(data)`). Both sides instantiate one; the main thread
 * uses `request()` to call into the worker, the worker uses `emit()`
 * to push events back.
 *
 * Concurrency model:
 *   - Requests carry a generated correlation id and resolve when the
 *     matching `res` envelope arrives.
 *   - An optional per-request timeout rejects the promise and frees
 *     the pending entry — the orchestrator side may still publish
 *     the response later, but it'll be dropped.
 *   - `dispose()` rejects every in-flight request with `ErrPortClosed`
 *     so callers don't hang when the worker dies.
 *
 * Failure semantics:
 *   - Non-`ok: true` responses become rejected promises with an
 *     `Error` whose `.message` is `error` and `.code` is `code` (when
 *     present). Callers can `if ((e as { code?: string }).code === ...)`.
 *   - Listener exceptions are swallowed so a buggy handler can't kill
 *     the worker. Errors are surfaced via `opts.onListenerError` for
 *     observability.
 */
import type {
  EventEnvelope,
  ProtocolMessage,
  RequestEnvelope,
  ResponseEnvelope,
} from './protocol.js';
import { isEvent, isRequest, isResponse } from './protocol.js';

/**
 * Subset of `worker_threads.MessagePort` we actually use. Decouples
 * the bridge from Node-specific types so unit tests can pass a
 * lightweight stub with no Worker overhead.
 */
export interface MessagePortLike {
  postMessage: (value: unknown) => void;
  on: (event: 'message' | 'messageerror' | 'close', listener: (arg: unknown) => void) => unknown;
  off?: (event: string, listener: (arg: unknown) => void) => unknown;
  close?: () => void;
}

export interface MessageBridgeOpts {
  /** The port to read/write protocol messages on. */
  port: MessagePortLike;
  /** Optional default request timeout in ms. 0/undefined = no timeout. */
  defaultTimeoutMs?: number;
  /** Best-effort listener error sink. */
  onListenerError?: (err: unknown, context: 'request' | 'event') => void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;
type EventListener = (payload: unknown, envelope: EventEnvelope) => void;

export class ErrPortClosed extends Error {
  readonly code = 'port_closed';
  constructor(message = 'MessageBridge port closed') {
    super(message);
    this.name = 'ErrPortClosed';
  }
}

/**
 * Type guard for "the worker port closed under me" errors. Use in catch
 * blocks of any RPC call into a worker — when true, the WorkerHost
 * supervisor may be restarting the worker. For read-only RPCs a caller can
 * choose to retry; for mutating RPCs this means OUTCOME_UNKNOWN because the
 * worker may have applied the effect before its acknowledgement was lost.
 * Mutating callers must fence/evict the stale handle and never replay
 * automatically.
 *
 * Defensive: recognises BOTH `instanceof ErrPortClosed` AND the
 * `code === 'port_closed'` shape so structured-cloned errors crossing
 * a MessageChannel (which lose their prototype) still match.
 */
export function isPortClosedError(err: unknown): boolean {
  if (err instanceof ErrPortClosed) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'port_closed'
  );
}

export class ErrRequestTimeout extends Error {
  readonly code = 'request_timeout';
  constructor(message = 'MessageBridge request timed out') {
    super(message);
    this.name = 'ErrRequestTimeout';
  }
}

/**
 * A mutating RPC has an unknown outcome when its acknowledgement can no
 * longer be correlated, even though the worker may already have applied the
 * effect. This includes a closed port, a request timeout, and an
 * `unserializable_response`. A request timeout removes the pending
 * correlation entry without cancelling the handler, while response
 * serialization happens only after the handler has returned its post-effect
 * value.
 *
 * Callers must fence/evict the stale executor and must not automatically
 * replay the mutation. Read-only RPCs may use narrower retry policies.
 */
export function isMutationOutcomeUnknownError(err: unknown): boolean {
  if (isPortClosedError(err)) return true;
  return (
    typeof err === 'object'
    && err !== null
    && (
      (err as { code?: unknown }).code === 'request_timeout'
      || (err as { code?: unknown }).code === 'unserializable_response'
    )
  );
}

export class MessageBridge {
  private readonly port: MessagePortLike;
  private readonly defaultTimeoutMs: number;
  private readonly onListenerError: (err: unknown, context: 'request' | 'event') => void;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private closed = false;
  private idCounter = 0;
  private outgoingSeq = 0;

  constructor(opts: MessageBridgeOpts) {
    this.port = opts.port;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 0;
    this.onListenerError = opts.onListenerError ?? (() => undefined);
    this.port.on('message', (msg) => this.handleMessage(msg));
    this.port.on('close', () => this.dispose());
  }

  /**
   * Send a `req` and wait for the matching `res`. Rejects on timeout,
   * port close, or any non-`ok` response. Generic types are caller-
   * provided — the bridge doesn't validate the runtime shape.
   */
  request<TValue = unknown, TPayload = unknown>(
    type: string,
    payload: TPayload,
    opts?: { timeoutMs?: number },
  ): Promise<TValue> {
    if (this.closed) {
      return Promise.reject(new ErrPortClosed());
    }
    const id = this.nextId();
    const env: RequestEnvelope<TPayload> = { kind: 'req', id, type, payload };
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<TValue>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: (value) => resolve(value as TValue),
        reject,
        timer: timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new ErrRequestTimeout(`request '${type}' timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null,
      };
      this.pending.set(id, entry);
      try {
        this.port.postMessage(env);
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Register a request handler. Called when a `req` arrives whose
   * `type` matches. The handler's return value (or resolved promise)
   * is sent back as a `res` with `ok: true`; thrown errors become
   * `ok: false` responses with the error string.
   *
   * Replacing an existing handler for the same type is allowed — the
   * latest registration wins. Returns an unsubscribe function.
   */
  handle(type: string, handler: RequestHandler): () => void {
    this.handlers.set(type, handler);
    return () => {
      if (this.handlers.get(type) === handler) {
        this.handlers.delete(type);
      }
    };
  }

  /**
   * Subscribe to events of a given type. Multiple listeners are
   * supported. Listener exceptions are swallowed (see class header).
   */
  on(type: string, listener: EventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(type);
    };
  }

  /** Emit a fire-and-forget event. Carries a monotonic `seq` for replay. */
  emit<TPayload = unknown>(type: string, payload: TPayload): void {
    if (this.closed) return;
    this.outgoingSeq += 1;
    const env: EventEnvelope<TPayload> = {
      kind: 'evt',
      type,
      seq: this.outgoingSeq,
      payload,
    };
    try {
      this.port.postMessage(env);
    } catch (err) {
      // Port likely closed concurrently. Silent — the dispose() path
      // will reject any pending callers; events are best-effort by
      // contract.
      this.onListenerError(err, 'event');
    }
  }

  /**
   * Tear down: reject every pending request, clear handlers + listeners,
   * close the port. Safe to call multiple times. The `close` event from
   * the port (if any) calls this automatically.
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new ErrPortClosed();
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.handlers.clear();
    this.listeners.clear();
    try {
      this.port.close?.();
    } catch { /* best-effort */ }
  }

  private nextId(): string {
    this.idCounter += 1;
    return `${Date.now().toString(36)}-${this.idCounter.toString(36)}`;
  }

  private handleMessage(raw: unknown): void {
    const msg = raw as ProtocolMessage;
    if (isResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // late response — caller already gave up
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.value);
      } else {
        const err = new Error(msg.error) as Error & { code?: string };
        if (msg.code) err.code = msg.code;
        entry.reject(err);
      }
      return;
    }
    if (isRequest(msg)) {
      void this.dispatchRequest(msg);
      return;
    }
    if (isEvent(msg)) {
      this.dispatchEvent(msg);
      return;
    }
  }

  private async dispatchRequest(req: RequestEnvelope): Promise<void> {
    const handler = this.handlers.get(req.type);
    if (!handler) {
      this.respond({
        kind: 'res',
        id: req.id,
        ok: false,
        error: `no handler registered for '${req.type}'`,
        code: 'no_handler',
      });
      return;
    }
    try {
      const value = await handler(req.payload);
      this.respond({ kind: 'res', id: req.id, ok: true, value });
    } catch (err) {
      this.onListenerError(err, 'request');
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      this.respond({
        kind: 'res',
        id: req.id,
        ok: false,
        error: message,
        ...(typeof code === 'string' && code ? { code } : {}),
      });
    }
  }

  private respond(res: ResponseEnvelope): void {
    if (this.closed) return;
    try {
      this.port.postMessage(res);
    } catch (err) {
      this.onListenerError(err, 'request');
      // A successful response whose value can't be structured-cloned (e.g. it
      // carried a function/class instance/Promise) would otherwise leave the
      // caller hanging until its request timeout fires. Fail it fast with a
      // descriptive error on the same id so the caller rejects immediately.
      if (res.kind === 'res' && res.ok) {
        try {
          this.port.postMessage({
            kind: 'res',
            id: res.id,
            ok: false,
            error: `response not serializable: ${err instanceof Error ? err.message : String(err)}`,
            code: 'unserializable_response',
          });
        } catch {
          // Port truly broken — dispose() will reject any pending callers.
        }
      }
    }
  }

  private dispatchEvent(env: EventEnvelope): void {
    const set = this.listeners.get(env.type);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        listener(env.payload, env);
      } catch (err) {
        this.onListenerError(err, 'event');
      }
    }
  }
}
