/**
 * Worker-side agent-LSP shim — forwards lsp_definition/references/hover on
 * non-TS files to the main process (where the LSP router + external servers
 * live) via MessageBridge RPC. Mirror of memory-shims.ts.
 */
// IMPORTANT: workers import via relative paths only — Node's loader resolves
// these before tsx/tsconfig `paths`, so `@mcp/*` aliases fail inside workers.
import {
  setGlobalAgentLspBackend,
  type AgentLspLocation,
} from '../../../packages/code-agent/src/lsp/agent-lsp-backend.js';

interface BridgeLike {
  request(name: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

const RPC_TIMEOUT_MS = 30_000;

export function installWorkerLspShim(bridge: BridgeLike): void {
  const call = async (op: 'definition' | 'references' | 'hover', input: unknown): Promise<unknown> => {
    try {
      return await bridge.request('lspRequest', { op, ...(input as object) }, { timeoutMs: RPC_TIMEOUT_MS });
    } catch {
      return null; // language nav must never break a run
    }
  };
  setGlobalAgentLspBackend({
    definition: (input) => call('definition', input) as Promise<AgentLspLocation[] | null>,
    references: (input) => call('references', input) as Promise<AgentLspLocation[] | null>,
    hover: async (input) => {
      const r = (await call('hover', input)) as { contents?: string } | null;
      return r?.contents ? { contents: r.contents } : null;
    },
  });
}
