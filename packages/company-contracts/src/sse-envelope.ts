/**
 * Versioned wrapper for every SSE payload emitted by the company-mode
 * backend. Consumers must check `v` before interpreting `data`.
 *
 * `seq` is monotonically increasing per session — clients send it back as
 * `Last-Event-ID` on reconnect so the server can replay missed events.
 *
 * `type` is a string drawn from `CompanyEventType` (see `events.ts`).
 * `data` is the per-event payload (shapes in `events.ts` discriminated union).
 */
export interface SSEEnvelope<TData = unknown> {
  v: 1;
  seq: number;
  type: string;
  data: TData;
}

export const SSE_ENVELOPE_VERSION = 1 as const;

/**
 * Type guard used by clients to defensively skip envelopes from a future
 * server version they don't understand. Avoids mis-decoding when a server
 * rolls forward.
 */
export function isSupportedEnvelope<T>(env: unknown): env is SSEEnvelope<T> {
  return (
    typeof env === 'object' &&
    env !== null &&
    (env as { v?: unknown }).v === SSE_ENVELOPE_VERSION &&
    typeof (env as { seq?: unknown }).seq === 'number' &&
    typeof (env as { type?: unknown }).type === 'string'
  );
}
