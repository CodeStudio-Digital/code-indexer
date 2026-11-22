import { abortableRead } from '@mcp/shared/utils/abortable.js';
import { SSETransportError } from '@mcp/shared/sse/ReconnectingSSEClient.js';

export type DetachedSession = 'finished' | 'interrupted' | 'failed' | 'missing';

/** Losing the renderer connection says nothing about the worker. A command
 * retry uses its original client_msg_id to read the authoritative result.
 * An attach has no command receipt, so ask the session owner. */
export function createSessionStreamRecovery(opts: {
  signal: AbortSignal;
  stateUrl?: string;
  onReconnecting: () => void;
  onDetached: (outcome: DetachedSession) => void;
}) {
  let attachRetries = 0;
  return async (error: unknown): Promise<number | 'complete' | undefined> => {
    const http = error as { status?: number; httpBody?: { code?: string } | null };
    const missingBus = !!opts.stateUrl && http.status === 404;
    const unavailableGateway = !http.httpBody && [502, 503, 504].includes(http.status ?? 0);
    const awaitingReceipt = http.status === 503 && http.httpBody?.code === 'IDEMPOTENCY_RETRY_LATER';
    if (!missingBus && !(error instanceof SSETransportError) && !unavailableGateway && !awaitingReceipt) return;
    opts.signal.throwIfAborted();
    opts.onReconnecting();
    if (opts.stateUrl) {
      const outcome = await readDetachedSession(opts.stateUrl, opts.signal);
      opts.signal.throwIfAborted();
      if (outcome) {
        opts.onDetached(outcome);
        return 'complete';
      }
    }
    // A 404 can race bus registration. Longer outages stay rate-limited and
    // cancellable even when the window remains open for hours.
    return missingBus ? Math.min(16_000, 1000 * 2 ** Math.min(attachRetries++, 4)) : 16_000;
  };
}

async function readDetachedSession(url: string, owner: AbortSignal): Promise<DetachedSession | undefined> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8000);
  const signal = AbortSignal.any([owner, timeout.signal]);
  try {
    const response = await abortableRead(() => fetch(url, { signal, cache: 'no-store' }), signal);
    if (response.status === 404) return 'missing';
    if (!response.ok) {
      if (response.status >= 500) return;
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }
    const state = await abortableRead(() => response.json(), signal);
    // Even an ended bus can still replay the tail, including the worker's
    // precise error. Prefer it to a session-level summary while available.
    if (state.alive !== false || state.hasReplay === true) return;
    switch (state.status) {
      case 'idle':
      case 'completed':
        return 'finished';
      case 'error':
        return 'failed';
      case 'running':
      case 'working':
      case 'in_progress':
      case 'interrupted':
        return 'interrupted';
    }
  } catch (err) {
    owner.throwIfAborted();
    if (err && typeof err === 'object' && 'status' in err) throw err;
    // A failed probe cannot confirm a finished run.
  } finally {
    clearTimeout(timer);
  }
}
