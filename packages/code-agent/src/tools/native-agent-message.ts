import { ok, type ToolContext, type ToolResult } from '../core/tool.js';
import type { AgentTreeMessageKind } from '../ports/agent-tree-port.js';

/** Native messaging never falls through to Company or a legacy runner. */
export async function nativeAgentMessage(ctx: ToolContext, kind: AgentTreeMessageKind, to: unknown, message: unknown): Promise<ToolResult> {
  const port = ctx.ports?.agentTree;
  if (ctx.runtimeGeneration !== 'rust_v1' || !port?.message || port.ownerAgentRunId !== ctx.controlPlaneParentAgentRunId) {
    throw new Error('Native messaging requires the admitted tree owner');
  }
  if (typeof to !== 'string' || !to.trim() || typeof message !== 'string' || !message.trim()
    || Buffer.byteLength(message) > 4096 || !ctx.currentToolUseId) throw new Error('Native message requires a bounded body, target and invocation identity');
  const receipt = await port.message({ to: to.trim(), message: message.trim(), kind,
    invocationId: ctx.currentToolUseId, signal: ctx.signal });
  return { ...ok(`Agent ${receipt.target}: ${receipt.status}; message ${receipt.id}.`
    + (receipt.interrupted ? ' Pending question interrupted; no permission was granted.' : ' Delivery is applied at the next provider boundary.')
    + (receipt.jobId ? ` Collect with collect_agents({job_id:"${receipt.jobId}"}).` : '')),
    structuredData: { kind: 'native_agent_message', ...receipt } };
}
