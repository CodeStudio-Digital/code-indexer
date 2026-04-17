/**
 * SSE heartbeat helper — prevents proxies (nginx, Cloudflare, ELB) from
 * dropping idle connections after ~30–60s of silence.
 *
 * Emits `event: ping` at a fixed interval. The client's
 * ReconnectingSSEClient silently discards ping events.
 *
 * Usage:
 *   const stopHeartbeat = attachHeartbeat(stream);
 *   try { await waitEnded(bus); } finally { stopHeartbeat(); ... }
 */

interface SSEStream {
  writeSSE(message: { event?: string; data: string; id?: string }): Promise<unknown>;
}

export const DEFAULT_HEARTBEAT_MS = 20_000;

export function attachHeartbeat(stream: SSEStream, intervalMs: number = DEFAULT_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    // Fire-and-forget — if the client disconnected, the parent stream
    // close logic will handle cleanup.
    void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {
      /* client gone; ignore */
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
