import { randomUUID } from 'node:crypto';
import type { MessageBridge } from '@mcp/orchestrator-host';
import { abortableRead } from '@mcp/shared/utils/abortable.js';

/** Read cancellation has no mutation/retry semantics. Its id is scoped to the
 * owning worker bridge and never cancels writes or another worker's query. */
export async function requestMemoryRead<T>(bridge: MessageBridge, type: 'memoryRecall' | 'memoryList' | 'investigationSearch',
  payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const readId = randomUUID();
  const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  const cancel = () => { void bridge.request('memoryReadCancel', { readId }, { timeoutMs: 1_000 }).catch(() => undefined); };
  bounded.addEventListener('abort', cancel, { once: true });
  try {
    return await abortableRead(() => bridge.request<T>(type, { ...payload, readId }, { timeoutMs: 10_500 }), bounded);
  } finally {
    bounded.removeEventListener('abort', cancel);
  }
}
