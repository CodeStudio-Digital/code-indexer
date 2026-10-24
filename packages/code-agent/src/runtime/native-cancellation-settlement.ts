import type { ToolContext, ToolResult } from '../core/tool.js';

export function hasOwnedCancellationReceipt(toolName: string, context: ToolContext): boolean {
  const invocationId = context.currentToolUseId;
  if (!invocationId) return false;
  if (toolName === 'docs_deep_research') {
    const port = context.ports?.docsResearch;
    return port?.runtimeGeneration === 'rust_v1' && port.ownerAgentRunId === context.controlPlaneParentAgentRunId
      && port.isReadOnlyInvocation(invocationId);
  }
  if (toolName === 'self_review') {
    const port = context.ports?.sessionReview;
    return port?.runtimeGeneration === 'rust_v1' && port.sessionId === context.sessionId
      && port.agentRunId === context.controlPlaneParentAgentRunId && !context.toolCallLedger?.outcomeUnknownTool
      && port.isCancellationSettled(invocationId);
  }
  return false;
}

/** Cancellation is not a receipt. The real invocation must finish, and its
 * owner must confirm either a sealed read-only tree or committed review state. */
export async function settleOwnedCancellation(toolName: string, context: ToolContext,
  invocation: Promise<ToolResult>): Promise<boolean> {
  if ((toolName !== 'docs_deep_research' || !context.ports?.docsResearch)
    && (toolName !== 'self_review' || !context.ports?.sessionReview)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      invocation.then(result => result.effectOutcome !== 'unknown', () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000); }),
    ]);
    return settled && hasOwnedCancellationReceipt(toolName, context);
  } finally { if (timer) clearTimeout(timer); }
}
