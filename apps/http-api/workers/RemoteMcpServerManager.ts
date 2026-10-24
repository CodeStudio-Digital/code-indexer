/**
 * RemoteMcpServerManager — worker-side proxy for `McpExternalPool`.
 *
 * Implements the narrow `IMcpServerManager` contract that `runCoder()`
 * depends on, but instead of opening real MCP transports it routes
 * every operation through the bridge RPC channel to the main process.
 *
 * Why this exists:
 *   - Worker_threads in Node don't share heap, so a singleton pool
 *     in the main process can't be referenced directly from the
 *     coder-worker.ts module — it has to talk over the MessageBridge.
 *   - The pool lives for the whole http-api process; this proxy is
 *     instantiated once per worker run and is essentially free
 *     (no I/O at construction).
 *   - Tool handlers built here close over the bridge so `callTool`
 *     forwards args + serverId + toolName to the pool, awaits the
 *     response, and returns the same `ToolResult` shape the in-process
 *     `McpServerManager` would have.
 *
 * Caveats:
 *   - `connectAll()` becomes a no-op for connection plumbing, but it
 *     IS the point where we fetch the snapshot so `listAllTools()`
 *     has data to return. We call snapshot eagerly in connectAll so
 *     runCoder's existing `if (extTools.length > 0)` gate keeps
 *     working without changing the sequence.
 *   - `closeAll()` is also a no-op — the pool owns connection
 *     lifecycle. A worker dying mid-run won't close anything, which
 *     is exactly what we want.
 *
 * Bridge RPC contract (matched by the handlers in `CoderWorkerPool.ts`):
 *
 *   request 'mcpExt.snapshot' → McpExternalSnapshot
 *   request 'mcpExt.callTool' { serverId, toolName, args }
 *           → { ok: boolean, text: string }
 */
import type { MessageBridge } from '@mcp/orchestrator-host';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err, unknownToolOutcome } from "@mcp/agent-runtime-host/tool-result.js";
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { IMcpServerManager } from '@mcp/code-agent/tools/mcp-server-manager-interface.js';
import type { McpExternalSnapshot } from '../sse/McpExternalPool.js';
import { requestMcpCall } from './mcp-call-request.js';

/**
 * Catalogue requests have a 60s ceiling. Tool calls carry independent
 * cancellation and unknown-outcome semantics after dispatch.
 */
const RPC_TIMEOUT_MS = 60_000;

export class RemoteMcpServerManager implements IMcpServerManager {
  private snapshot: McpExternalSnapshot | null = null;

  constructor(private readonly bridge: MessageBridge, private readonly runId?: number) {}

  /**
   * runCoder calls this with the list of enabled servers. We don't
   * need the configs (the pool already has them), but the timing is
   * the right moment to fetch the snapshot. Subsequent `listAllTools`
   * calls within the same `runCoder()` reuse this cached snapshot —
   * matches what the in-process manager does.
   */
  async connectAll(_configs: McpServerConfig[]): Promise<void> {
    await this.fetchSnapshot();
  }

  /**
   * A session can outlive the pool snapshot it received at run startup. Ask
   * the main process for a reconciled snapshot again so a broker that came up
   * later becomes visible without recreating the session.
   */
  async refreshAll(_configs: McpServerConfig[]): Promise<void> {
    await this.fetchSnapshot();
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      this.snapshot = await this.bridge.request<McpExternalSnapshot>(
        'mcpExt.snapshot',
        {},
        { timeoutMs: RPC_TIMEOUT_MS },
      );
    } catch (e) {
      // Don't bring the run down if the snapshot fails — drop into
      // "no external tools" mode so the agent can still answer with
      // built-ins.
      console.warn(
        `[mcp-ext-proxy] snapshot RPC failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.snapshot = null;
    }
  }

  async listAllTools(): Promise<{ tools: CoderTool[]; tierMap: Map<string, ToolTier> }> {
    if (!this.snapshot) return { tools: [], tierMap: new Map() };

    const tools: CoderTool[] = this.snapshot.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as CoderTool['parameters'],
      source: 'mcp_external',
      ...(t.transport && t.catalogueRevision ? { externalMcpTransport: { serverId: t.serverId,
        toolName: t.toolName, transport: t.transport, catalogueRevision: t.catalogueRevision,
        processTreeContained: t.processTreeContained === true } } : {}),
      effectBoundary: 'external_mcp',
      capabilityProvenance: { kind: 'mcp_external', providerId: 'mcp-external', serverId: t.serverId,
        provenanceRef: `mcp-server:${t.serverId}${t.catalogueRevision ? `:${t.catalogueRevision}` : ''}` },
      mutates: true,
      parallelSafe: false,
      riskLevel: 'write',
      repeatPolicy: t.repeatable ? 'pollable' : 'stable',
      handler: this.createHandler(t.serverId, t.toolName, t.name, t.catalogueRevision),
      repeatable: t.repeatable,
    }));

    const tierMap = new Map<string, ToolTier>(
      this.snapshot.tierMap as Array<[string, ToolTier]>,
    );

    return { tools, tierMap };
  }

  getCustomTierSummary(): Map<string, { displayName: string; toolCount: number }> {
    if (!this.snapshot) return new Map();
    return new Map(this.snapshot.customTierSummary);
  }

  async closeAll(): Promise<void> {
    // No-op: the pool owns connection lifecycle. Dropping the
    // snapshot reference here would just force the next worker
    // to re-fetch it, which is wasteful.
  }

  get connectedCount(): number {
    return this.snapshot?.connectedCount ?? 0;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Build the handler that the runner ultimately invokes when the
   * model calls `ext_<server>__<tool>`. Sends the args over the
   * bridge; the pool's `callTool` runs the live transport call with
   * its pre-dispatch reconnect machinery and returns the full result plus the
   * `{ ok, text }` shape we'd produce in-process.
   */
  private createHandler(
    serverId: string,
    toolName: string,
    prefixedName: string,
    catalogueRevision?: string,
  ): CoderTool['handler'] {
    return async (args, ctx): Promise<ToolResult> => {
      if (ctx.signal?.aborted) return err('External MCP call cancelled before dispatch.');
      if (ctx.mutationFence?.mode === 'enforce' && !ctx.externalMcpAuthority) {
        return err('External MCP has no product authority for an enforced invocation.');
      }
      try { ctx.mutationFence?.assertMutation({ kind: 'external_mcp', operation: 'tools/call', resource: prefixedName }); }
      catch { return err('External MCP authority expired before worker dispatch.'); }
      const authority = ctx.externalMcpAuthority ? { payload: ctx.externalMcpAuthority.payload,
        binding: ctx.mutationFence?.resourceBinding, toolUseId: ctx.currentToolUseId } : undefined;
      const unknown = (result: ToolResult) => { if (result.effectOutcome === 'unknown') ctx.externalMcpAuthority?.outcomeUnknown(); return result; };
      try {
        const r = await requestMcpCall(this.bridge, { serverId, toolName, args, catalogueRevision, runId: this.runId, authority }, ctx.signal);
        if (!r) return unknown(unknownToolOutcome(`Empty response from pool for ${prefixedName}; reconcile before retrying.`));
        if (r.result) return unknown(r.result);
        return r.ok ? ok(r.text) : err(r.text);
      } catch (e) {
        ctx.externalMcpAuthority?.outcomeUnknown();
        return unknownToolOutcome(
          `External MCP RPC failed for ${prefixedName}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    };
  }
}
