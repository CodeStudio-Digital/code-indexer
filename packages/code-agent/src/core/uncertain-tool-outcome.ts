import type { AgentMessage } from './messages.js';
import type { CoderTool, ToolContext } from './tool.js';
import { resolveToolInvocationMetadata } from './policy.js';
import { BUILTIN_CLASSIFICATION } from './tool-classification.js';
import type { ToolPermissionMode } from './permission-gate.js';

/** Inspect typed host evidence, never strings returned by an untrusted tool. */
export function unresolvedToolOutcome(messages: readonly AgentMessage[]): string | undefined {
  return unresolvedToolOutcomes(messages)[0];
}

export function unresolvedToolOutcomes(messages: readonly AgentMessage[]): string[] {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.effect_outcome === 'unknown') pending.add(block.tool_use_id);
    }
  }
  return [...pending];
}

/** Conversation may resume; an uncertain action must never be replayed automatically. */
export function needsOutcomeRecoveryApproval(
  recovery: ToolContext['outcomeRecovery'], tool: CoderTool | undefined, input: unknown,
  mode?: ToolPermissionMode,
): boolean {
  if (!recovery) return false;
  const replay = tool ? recovery.replayToolUseIds?.(tool.name, input).length : 0;
  if (!recovery.toolUseIds.length && !replay) return false;
  if (!tool) return true;
  // The user's unrestricted mode authorizes NEW work. Historical uncertainty
  // is evidence, not a session-wide downgrade of that explicit permission.
  // Only a host-owned signature index can distinguish a new call from replay.
  if (mode === 'unrestricted' && recovery.authoritative && recovery.replayToolUseIds && !replay) return false;
  // A reviewed script must not freely replay its original uncertain batch;
  // its nested children have different invocation signatures.
  if (replay && tool.source === 'native' && tool.name === 'code_exec' && tool.effectBoundary === 'nested') return true;
  // These native controls have no workspace/external effect of their own.
  // code_exec's children still cross the same authority with the same context.
  if (tool.source === 'native' && (
    (tool.name === 'code_exec' && tool.effectBoundary === 'nested')
    || ['find_tools', 'expand_toolset', 'ask_user'].includes(tool.name)
  )) return false;
  const declared = tool.riskOf !== undefined || tool.mutates === false
    || (tool.source === 'native' && BUILTIN_CLASSIFICATION[tool.name]?.mutates === false);
  if (!declared) return true;
  const metadata = resolveToolInvocationMetadata(tool, input);
  return metadata.mutates || metadata.riskLevel !== 'read'
    || metadata.executionClass !== 'read' || tool.effectBoundary !== undefined;
}

export function outcomeRecoveryPrompt(recovery: ToolContext['outcomeRecovery'], mode?: ToolPermissionMode): string {
  if (!recovery?.toolUseIds.length) return recovery?.resolvedToolUseIds?.length
    ? '\n\n<tool-outcome-recovery>\nThe host has recorded a terminal receipt or an explicit user review for earlier uncertain calls. The selected approval mode applies again to new work. Historical unknown result blocks remain an audit record, not an instruction to replay them. A user review does not assert success or absence of effects. Inspect current state and continue the task; do not repeat an old uncertain operation blindly.\n</tool-outcome-recovery>'
    : '';
  return '\n\n<tool-outcome-recovery>\n'
    + `Previous tool calls have an unconfirmed outcome: ${JSON.stringify(recovery.toolUseIds)}.\n`
    + 'Continue this conversation by inspecting existing files, outputs and process status using read tools. Briefly describe the verification when useful; a tool error does not require ending the chat or asking the user to type Continue. '
    + 'Do not replay the uncertain action, assume it failed, or claim it is reconciled. '
    + (mode === 'unrestricted' && recovery.authoritative && recovery.replayToolUseIds
      ? 'The user selected unrestricted mode. Continue new authorized work without asking for permission merely because an older call is uncertain. Exact replay of an unresolved or user-reviewed operation still requires its own decision; database-write rules remain separate. '
      : 'New commands, mutations and other effects require explicit recovery approval for that exact invocation. ')
    + 'The host checks terminal receipts automatically. An explicit review can be recorded separately; do not invent a review or ask the user a duplicate prose permission question. '
    + 'Execute-once approval authorizes the new action only. An explicit user review is recorded separately and never asserts success or termination of the original action. '
    + 'If available evidence cannot establish a safe next step, report precisely what remains unknown.\n'
    + '</tool-outcome-recovery>';
}

export function uncertainToolOutcomeError(toolUseId: string): Error {
  return Object.assign(new Error(`TOOL_OUTCOME_UNKNOWN: ${toolUseId} may have taken effect. Inspect its outcome and follow the selected permission mode for new work. Do not blindly replay the uncertain operation.`), { code: 'TOOL_OUTCOME_UNKNOWN' as const });
}


export function isUncertainToolOutcomeError(error: unknown): error is Error & { code: 'TOOL_OUTCOME_UNKNOWN' } {
  return error instanceof Error && (error as Error & { code?: string }).code === 'TOOL_OUTCOME_UNKNOWN';
}
