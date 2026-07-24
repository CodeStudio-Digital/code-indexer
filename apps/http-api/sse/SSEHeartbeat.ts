/**
 * SSE heartbeat helper — prevents proxies (nginx, Cloudflare, ELB) from
 * dropping idle connections after ~30–60s of silence.
 *
 * Emits `event: ping` at a fixed interval. ReconnectingSSEClient surfaces
 * these frames through its transport-only `onHeartbeat` callback; they never
 * enter the semantic event stream or replay cursor.
 *
 * Usage:
 *   const stopHeartbeat = attachHeartbeat(streamOrSerializedWriter);
 *   try { await waitEnded(bus); } finally { stopHeartbeat(); ... }
 */

interface SSEStream {
  writeSSE(message: { event?: string; data: string; id?: string }): Promise<unknown>;
}

export const DEFAULT_HEARTBEAT_MS = 20_000;

export function attachHeartbeat(stream: SSEStream, intervalMs: number = DEFAULT_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    // The caller may pass the raw transport or its serialized writer. The SSE
    // bus pump passes the latter so ping cannot overtake data/terminal frames.
    void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {
      /* client gone; ignore */
    });
  }, intervalMs);
  const maybeUnref = timer as { unref?: () => void };
  maybeUnref.unref?.();
  return () => clearInterval(timer);
}
