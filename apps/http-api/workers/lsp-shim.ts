import { randomUUID } from 'node:crypto';
import { setGlobalAgentLspBackend, type AgentLspLocation } from '../../../packages/code-agent/src/lsp/agent-lsp-backend.js';

interface BridgeLike {
  request(name: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** Cancellation is scoped to this bridge/read id. Never stop a shared server
 * or hide transport failure as a successful empty symbol lookup. */
export function installWorkerLspShim(bridge: BridgeLike): void {
  const call = async (op: 'definition' | 'references' | 'hover', input: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    const readId = randomUUID();
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => { cancellation ??= bridge.request('lspReadCancel', { readId }, { timeoutMs: 1_000 }).catch(() => undefined); };
    bounded.addEventListener('abort', cancel, { once: true });
    try {
      const value = await bridge.request('lspRequest', { op, ...(input as object), readId }, { timeoutMs: 31_000 });
      bounded.throwIfAborted(); return value;
    } finally {
      bounded.removeEventListener('abort', cancel);
      if (bounded.aborted) { cancel(); await cancellation; }
    }
  };
  setGlobalAgentLspBackend({
    definition: (input, signal) => call('definition', input, signal) as Promise<AgentLspLocation[] | null>,
    references: (input, signal) => call('references', input, signal) as Promise<AgentLspLocation[] | null>,
    hover: async (input, signal) => {
      const value = await call('hover', input, signal) as { contents?: string } | null;
      return value?.contents ? { contents: value.contents } : null;
    },
  });
}
