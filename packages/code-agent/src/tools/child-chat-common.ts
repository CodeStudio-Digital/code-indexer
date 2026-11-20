/**
 * Shared by the child-chat tools: the port and the caller; the caller's
 * delegation posture (read-only, or planning before the plan is approved);
 * the wait budget, clamped to the call's own deadline so a wait inside
 * code_exec returns a timeout before the script's limit instead of being cut
 * off by it; and what a tool returns for results it received: each long
 * answer spilled to the tool output store (as spawn_agent does), and the
 * usage of the runs it received claimed once for this turn (E4b ledger),
 * which also refreshes the files the children changed.
 */
import type { ToolContext, ToolResult } from '../core/tool.js';
import { isReadOnlyAgent } from '../agents/index.js';
import { SUBAGENT_TOOL_RESULT_CAP } from '../core/runner.js';
import type { ChildChatPort } from '../ports/child-chat-port.js';
import { CHILD_AGENT_WAIT_MAX_MS, type ChildAgentWaitItem, type ChildAgentWaitResult } from '../runtime/child-agent-wait.js';
import { formatChildAgentItem, formatChildAgentWait } from '../runtime/child-agent-result.js';

export const CHILD_CHAT_PROFILES = ['explore', 'implement', 'verify', 'review', 'full'] as const;

/** Time a clamped wait leaves before the call's deadline, to answer in time. */
const DEADLINE_MARGIN_MS = 5_000;

export function chatCaller(ctx: ToolContext): { port: ChildChatPort; callerId: string } | null {
  return ctx.childChats && ctx.sessionId && !ctx.companyContext ? { port: ctx.childChats, callerId: String(ctx.sessionId) } : null;
}

export function delegationPosture(ctx: ToolContext): { readOnly: boolean; planning: boolean } {
  return {
    readOnly: ctx.childAgentSelf?.readOnly === true || isReadOnlyAgent(ctx.runner?.agentId),
    planning: ctx.planMode === true && ctx.runner?.isPlanApproved() !== true,
  };
}

/** The longest wait this call can make: the requested one, within the call's deadline. */
export function waitBudgetMs(ctx: ToolContext, requestedMs = CHILD_AGENT_WAIT_MAX_MS): number {
  const wanted = Math.min(Math.max(0, requestedMs), CHILD_AGENT_WAIT_MAX_MS);
  if (ctx.deadlineAtEpochMs === undefined || !Number.isFinite(ctx.deadlineAtEpochMs)) return wanted;
  return Math.max(0, Math.min(wanted, ctx.deadlineAtEpochMs - Date.now() - DEADLINE_MARGIN_MS));
}

function bounded(ctx: ToolContext, item: ChildAgentWaitItem): ChildAgentWaitItem {
  const text = item.finalText;
  if (!text || text.length <= SUBAGENT_TOOL_RESULT_CAP || item.outputId || !ctx.toolOutputStore) return item;
  const outputId = ctx.toolOutputStore.put(text);
  return outputId ? { ...item, finalText: text.slice(0, SUBAGENT_TOOL_RESULT_CAP), outputId } : item;
}

/** The tool result for child results it received, with their usage claimed for this turn. */
export async function receivedResult(ctx: ToolContext, result: ChildAgentWaitResult): Promise<ToolResult> {
  const items = result.items.map((item) => bounded(ctx, item));
  const claim = await ctx.childAgentAccounting?.claim(items.map((item) => item.chatId)) ?? {};
  const content = items.length === 1 && result.outcome === 'ready'
    ? formatChildAgentItem(items[0]!)
    : formatChildAgentWait({ ...result, items });
  return { content, ...claim };
}

export const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
export const chatIdOf = (value: unknown): string => text(value).replace(/^chat:/, '');
