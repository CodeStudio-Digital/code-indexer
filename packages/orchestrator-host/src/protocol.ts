/**
 * Typed message protocol between the main thread and an orchestrator
 * worker_thread. Three envelope kinds:
 *
 *   - `req`  — main → worker request expecting a `res`. Correlated by `id`.
 *   - `res`  — worker → main response. Either `ok: true` with `value`, or
 *              `ok: false` with `error` (always a string for safe transit).
 *   - `evt`  — worker → main fire-and-forget event (no correlation).
 *
 * Payloads are POJOs only. Class instances, functions, Buffers larger
 * than necessary, etc. won't survive `structuredClone` — the
 * `MessageBridge` doesn't validate this for you, but downstream
 * orchestrator services SHOULD pass only plain objects across the
 * thread boundary.
 *
 * Type discipline: kept narrow on purpose so the orchestrator's
 * sprawling event surface (kanban_card_created, board_entry, etc.)
 * doesn't leak into shared types. The bridge treats `type` and
 * `payload` opaquely; consumers cast on the receiving end.
 */

export interface RequestEnvelope<TPayload = unknown> {
  kind: 'req';
  /** Correlation id — the worker echoes the same id on `res`. */
  id: string;
  /** Logical request type (e.g. `'spawn_subordinate'`). */
  type: string;
  /** Caller payload. */
  payload: TPayload;
}

export interface OkResponseEnvelope<TValue = unknown> {
  kind: 'res';
  id: string;
  ok: true;
  value: TValue;
}

export interface ErrResponseEnvelope {
  kind: 'res';
  id: string;
  ok: false;
  /** Always a string — non-Error throws are coerced via `String(err)`. */
  error: string;
  /** Optional structured error code for typed branching on the caller. */
  code?: string;
}

export type ResponseEnvelope<TValue = unknown> =
  | OkResponseEnvelope<TValue>
  | ErrResponseEnvelope;

export interface EventEnvelope<TPayload = unknown> {
  kind: 'evt';
  /** Event type (free-form — matches the orchestrator's meta-bus topics). */
  type: string;
  /** Monotonic sequence number per worker run. Useful for replay/Last-Event-ID parity. */
  seq?: number;
  /** Event payload. POJO only — survives `structuredClone`. */
  payload: TPayload;
}

export type ProtocolMessage<TPayload = unknown, TValue = unknown> =
  | RequestEnvelope<TPayload>
  | ResponseEnvelope<TValue>
  | EventEnvelope<TPayload>;

/** Discriminator helper — narrows `unknown` from `MessagePort.onmessage`. */
export function isRequest<T = unknown>(msg: unknown): msg is RequestEnvelope<T> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { kind?: unknown }).kind === 'req' &&
    typeof (msg as { id?: unknown }).id === 'string' &&
    typeof (msg as { type?: unknown }).type === 'string'
  );
}

export function isResponse<T = unknown>(msg: unknown): msg is ResponseEnvelope<T> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { kind?: unknown }).kind === 'res' &&
    typeof (msg as { id?: unknown }).id === 'string' &&
    typeof (msg as { ok?: unknown }).ok === 'boolean'
  );
}

export function isEvent<T = unknown>(msg: unknown): msg is EventEnvelope<T> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { kind?: unknown }).kind === 'evt' &&
    typeof (msg as { type?: unknown }).type === 'string'
  );
}
