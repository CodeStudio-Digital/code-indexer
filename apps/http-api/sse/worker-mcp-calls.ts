import type { MessageBridge } from '@mcp/orchestrator-host';
import { err, unknownToolOutcome } from "@mcp/agent-runtime-host/tool-result.js";
import type { McpExternalPool } from './McpExternalPool.js';

interface WorkerMcpCallRequest {
  callId?: string; serverId: string; toolName: string; args: Record<string, unknown>;
  catalogueRevision?: string; runId?: number; authority?: unknown;
}

/** Cancellation belongs to this worker's bridge, never to the shared server.
 * A cancellation ACK does not establish whether a remote mutation occurred. */
export function registerWorkerMcpCalls(bridge: MessageBridge, getPool: () => McpExternalPool | null,
  authorize?: (request: WorkerMcpCallRequest) => (() => void) | Promise<() => void>): () => void {
  const active = new Map<string, AbortController>();
  const envelope = (result: ReturnType<typeof err>) => ({ ok: !result.isError, text: result.content, result });
  const offCall = bridge.handle('mcpExt.callTool', async (payload) => {
    const p = payload as WorkerMcpCallRequest;
    const pool = getPool();
    if (!pool) return envelope(err('External MCP pool not configured in this http-api process.'));
    if (p.callId === undefined && !authorize) return pool.callTool(p.serverId, p.toolName, p.args); // older standalone caller
    if (typeof p.callId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(p.callId) || active.has(p.callId) || active.size >= 32) {
      return envelope(err('Invalid or saturated external MCP call request.'));
    }
    const controller = new AbortController();
    active.set(p.callId, controller);
    const timer = setTimeout(() => controller.abort(new Error('External MCP deadline elapsed')), 10 * 60_000);
    timer.unref();
    try {
      let assertDispatch: (() => void) | undefined;
      try { assertDispatch = await authorize?.(p); controller.signal.throwIfAborted(); assertDispatch?.(); }
      catch { return envelope(err('External MCP request belongs to an inactive or cancelled worker run.')); }
      return await pool.callTool(p.serverId, p.toolName, p.args, controller.signal, p.catalogueRevision, assertDispatch);
    } catch (error) {
      return envelope(unknownToolOutcome('External MCP dispatch failed: ' + String(error) + '. Reconcile before retrying.'));
    } finally {
      clearTimeout(timer);
      active.delete(p.callId);
    }
  });
  const offCancel = bridge.handle('mcpExt.cancelTool', (payload) => {
    const { callId } = payload as { callId: string };
    active.get(callId)?.abort(new Error('External MCP caller cancelled'));
    return { acknowledged: true };
  });
  return () => {
    offCall(); offCancel();
    for (const controller of active.values()) controller.abort(new Error('External MCP worker bridge closed'));
  };
}
