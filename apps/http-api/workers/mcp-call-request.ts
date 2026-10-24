import { randomUUID } from 'node:crypto';
import type { MessageBridge } from '../../../packages/orchestrator-host/src/index.js';
import { err, unknownToolOutcome, type ToolResult } from "@mcp/agent-runtime-host/tool-result.js";

/** Race only the response wait. Remote cancellation never proves non-execution. */
export async function requestMcpCall(bridge: MessageBridge, payload: {
  serverId: string; toolName: string; args: Record<string, unknown>; catalogueRevision?: string; runId?: number; authority?: unknown;
}, signal?: AbortSignal): Promise<{ ok: boolean; text: string; result?: ToolResult }> {
  const envelope = (result: ToolResult) => ({ ok: !result.isError, text: result.content, result });
  if (signal?.aborted) return envelope(err('External MCP call cancelled before dispatch.'));
  const callId = randomUUID();
  const bounded = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]);
  let cancel!: () => void;
  const cancelled = new Promise<ReturnType<typeof envelope>>((resolve) => {
    cancel = () => {
      void bridge.request('mcpExt.cancelTool', { callId }, { timeoutMs: 1_000 }).catch(() => undefined);
      resolve(envelope(unknownToolOutcome('External MCP response wait cancelled after dispatch. Reconcile before retrying.')));
    };
    bounded.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, bridge.request<{
      ok: boolean; text: string; result?: ToolResult;
    }>('mcpExt.callTool', { ...payload, callId }, { timeoutMs: 10 * 60_000 + 1_000 })]);
  } finally {
    bounded.removeEventListener('abort', cancel);
  }
}
