/**
 * Serializable worker <-> host transport for docs_deep_research.
 *
 * AbortSignal is not structured-cloneable in Node worker_threads: it arrives
 * as an empty plain object. Transport cancellation explicitly by request id
 * and create a fresh AbortController in the receiving realm instead.
 */
import { randomUUID } from 'node:crypto';
import type { MessageBridge } from '../../../packages/orchestrator-host/src/index.js';
import type {
  DocsResearchBridge,
  RunResearchInput,
} from '../../../packages/docs-agent/src/bridges/docs-bridge.js';
import type { DocsResearchResult } from '../../../packages/docs-agent/src/types.js';
import { asAbortSignal } from '../../../packages/code-agent/src/core/abort-signal.js';

export const DOCS_RESEARCH_RPC_TIMEOUT_MS = 10 * 60_000;
export const DOCS_RESEARCH_CANCEL_EVENT = 'docsResearch.cancel';

export type SerializableDocsResearchInput = Omit<RunResearchInput, 'signal'>;

export interface DocsResearchRpcPayload {
  requestId: string;
  input: SerializableDocsResearchInput;
}

export interface DocsResearchCancelPayload {
  requestId: string;
}

type Researcher = Pick<DocsResearchBridge, 'runResearch'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripSignal(value: Record<string, unknown>): SerializableDocsResearchInput {
  const { signal: _nonSerializableSignal, ...serializable } = value;
  return serializable as SerializableDocsResearchInput;
}

function decodePayload(payload: unknown): {
  requestId: string | null;
  input: SerializableDocsResearchInput;
} {
  if (!isRecord(payload)) throw new Error('docsResearch RPC payload must be an object');
  if (typeof payload.requestId === 'string' && isRecord(payload.input)) {
    return { requestId: payload.requestId, input: stripSignal(payload.input) };
  }
  // Rolling-restart compatibility: an old warm worker may still send the flat
  // RunResearchInput shape. Drop its cloned `signal` so it cannot crash the
  // new host; cancellation is unavailable only for that legacy request.
  return { requestId: null, input: stripSignal(payload) };
}

/** Worker side: request research without ever posting AbortSignal itself. */
export function requestDocsResearchOverBridge(
  bridge: MessageBridge,
  input: RunResearchInput,
  timeoutMs = DOCS_RESEARCH_RPC_TIMEOUT_MS,
): Promise<DocsResearchResult> {
  const requestId = randomUUID();
  const { signal: rawSignal, ...serializableInput } = input;
  const signal = asAbortSignal(rawSignal);
  const payload: DocsResearchRpcPayload = { requestId, input: serializableInput };
  let cancelSent = false;
  const sendCancel = (): void => {
    if (cancelSent) return;
    cancelSent = true;
    bridge.emit<DocsResearchCancelPayload>(DOCS_RESEARCH_CANCEL_EVENT, { requestId });
  };

  // post the request first; MessagePort preserves message order, so an already
  // aborted signal's cancel event cannot overtake creation of the host job.
  const pending = bridge.request<DocsResearchResult>('docsResearch', payload, { timeoutMs });
  if (signal?.aborted) sendCancel();
  else signal?.addEventListener('abort', sendCancel, { once: true });

  return pending
    .catch((error) => {
      // An IPC timeout/close must not leave the host-side research orphaned.
      sendCancel();
      throw error;
    })
    .finally(() => {
      signal?.removeEventListener('abort', sendCancel);
    });
}

/** Host side: rehydrate cancellation into a realm-local AbortController. */
export function registerDocsResearchRpcHandlers(
  bridge: MessageBridge,
  getResearcher: () => Researcher | null | undefined,
): () => void {
  const active = new Map<string, AbortController>();

  const offRequest = bridge.handle('docsResearch', async (payload) => {
    const researcher = getResearcher();
    if (!researcher) {
      throw new Error(
        'docs_deep_research is not configured: no DocsResearchBridge installed. Use rag_search_docs as a fallback.',
      );
    }
    const decoded = decodePayload(payload);
    const controller = new AbortController();
    if (decoded.requestId) active.set(decoded.requestId, controller);
    try {
      return await researcher.runResearch({ ...decoded.input, signal: controller.signal });
    } finally {
      if (decoded.requestId) active.delete(decoded.requestId);
    }
  });

  const offCancel = bridge.on(DOCS_RESEARCH_CANCEL_EVENT, (payload) => {
    const requestId = isRecord(payload) ? payload.requestId : undefined;
    if (typeof requestId !== 'string') return;
    const controller = active.get(requestId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error('docs research cancelled by parent worker'));
    }
  });

  return () => {
    offRequest();
    offCancel();
    for (const controller of active.values()) {
      if (!controller.signal.aborted) controller.abort(new Error('docs research RPC disposed'));
    }
    active.clear();
  };
}
