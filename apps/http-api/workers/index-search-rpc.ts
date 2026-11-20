import { randomUUID } from 'node:crypto';
import type { MessageBridge } from '@mcp/orchestrator-host';
import {
  failed,
  parseMemoryResponse,
  parseProjectResponse,
  type McpSemanticSearchClient,
} from '@mcp/indexer/agent-tools/semantic-client.js';

/** The loopback client's deadline and response budget, unchanged. */
const DEADLINE_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Reply = { ok: true; body: unknown } | { ok: false; error: string };

/**
 * One host call bounded by the deadline. A caller abort cancels the host side
 * and rejects (cancellation is not owner unavailability); every other failure
 * answers like an unreachable owner, so tools take the same FTS fallback.
 */
async function call(bridge: MessageBridge, type: string, payload: Record<string, unknown>, callerSignal: AbortSignal | undefined,
  deadlineMs: number): Promise<Reply> {
  callerSignal?.throwIfAborted();
  const requestId = randomUUID();
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void bridge.request('indexSearchCancel', { requestId }, { timeoutMs: 5_000 }).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  stopped.catch(() => undefined);
  try {
    const text = await Promise.race([
      bridge.request(type, { requestId, ...payload }, { timeoutMs: deadlineMs + 1_000 }),
      stopped,
    ]);
    if (typeof text !== 'string') return { ok: false, error: 'semantic server returned a non-JSON response' };
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return { ok: false, error: `semantic server response exceeds ${MAX_RESPONSE_BYTES} bytes` };
    return { ok: true, body: JSON.parse(text) };
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (deadline.aborted) return { ok: false, error: 'Local server request timed out' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The semantic owner client for index tools served inside an agent worker:
 * the host's search functions over MessageBridge instead of loopback HTTP.
 * Session ids travel like the loopback headers; the host validates them.
 */
export function createRpcSemanticSearchClient(
  bridge: MessageBridge,
  /** Tests only: production keeps the loopback client's 20 s deadline. */
  options: { deadlineMs?: number } = {},
): McpSemanticSearchClient {
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  return {
    async searchProject(projectId, query, options = {}) {
      const reply = await call(bridge, 'indexProjectSearch', {
        projectId, query, mode: options.mode, type: options.type, limit: options.limit, consumer: options.consumer ?? 'agent',
        sessionId: options.sessionId, companySessionId: options.companySessionId,
      }, options.signal, deadlineMs);
      if (!reply.ok) return failed(reply.error);
      const value = parseProjectResponse(reply.body);
      return value
        ? { ok: true, value, error: null }
        : failed('semantic server returned an invalid search payload');
    },
    async searchProjectMemory(projectId, query, limit = 5, signal) {
      const reply = await call(bridge, 'indexMemorySearch', { projectId, query, limit }, signal, deadlineMs);
      if (!reply.ok) return failed(reply.error);
      const value = parseMemoryResponse(reply.body);
      return value
        ? { ok: true, value, error: null }
        : failed('semantic server returned an invalid memory payload');
    },
  };
}

/** Durable memory writes wake the host's targeted namespace catch-up; best effort, like the loopback POST. */
export function requestNamespaceReconcile(bridge: MessageBridge, namespace: string): Promise<void> {
  return bridge.request('indexSemanticReconcile', { namespace }, { timeoutMs: 5_000 })
    .then(() => undefined, () => undefined);
}
