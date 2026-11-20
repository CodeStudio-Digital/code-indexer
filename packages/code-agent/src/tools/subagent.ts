/**
 * Subagent helpers shared by workflow and execute_tasks.
 *
 * Historical note: this file used to host the deprecated `spawn_subagent`
 * (single, sequential) and `spawn_agents` (parallel) tools. Both were
 * folded into `spawn_agent` (Opção A), itself retired for child chats. What
 * remains here are the system prompts + deps interface + provider helper.
 */
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { extractLastAssistantText } from '@mcp/code-agent/tools/implement-subagent.js';

export const EXPLORE_SYSTEM_PROMPT = `You are the EXPLORE subagent. Investigate the parent's questions using the available read-only tools.
Prefer focused searches, symbol reads and file ranges. Verify recalled memory against current code. Reuse evidence. Refine an empty search only with a new lead.
Return a concise final summary with Findings (file:line where applicable), Confidence and any Open questions. Bound claims of absence to what you inspected. Stop when the questions are answered or a concrete gap remains. Leave edits and delegation to the parent.`;

export const IMPLEMENT_SYSTEM_PROMPT = `You are an IMPLEMENTATION subagent. Carry out the parent's assigned change using the tools available in this checkout.
If a files scope was supplied, keep writes inside it. Inspect the target and its relevant callers before editing. Confirm the target and impact before a destructive change. Return ambiguous authority or scope to the parent.
Verify the changed behavior with relevant project checks. Report files changed, what you verified, and any pending check or blocker in your final summary. Reuse available evidence and stop when the assigned work is complete.`;

export interface SubagentDeps {
  provider: ChatProvider;
  /**
   * Snapshot of the parent registry's tools at agent build time. The
   * subagent runner builds its own ToolRegistry containing only the
   * allowlisted subset (per-agent type → READ_ONLY / READ_WRITE / FULL).
   */
  parentTools: CoderTool[];
  /**
   * Optional — when present, every sub-agent system prompt is mirrored
   * into the parent bundle's input records for the Input tab.
   */
  sessionStore?: FsSessionStore;
  /**
   * When set, subagents use this provider (possibly from a different
   * provider family) instead of the parent's. Created from admin
   * subagent config. This is the DEFAULT target (single control); per-profile
   * overrides go through `resolveProviderForProfile`.
   */
  subagentProvider?: ChatProvider;
  /**
   * When set, resolves the subagent provider for a specific micro-agent
   * profile (implement vs explore vs …). Returns `undefined` when that
   * profile inherits the parent provider. Built from admin per-profile
   * subagent config — see `subagent-provider.ts`. Prefer the
   * `providerForProfile()` helper over reading this directly.
   */
  resolveProviderForProfile?: (profileId?: string) => Promise<ChatProvider | undefined>;
  /**
   * When set, resolves the reasoning-effort override for a profile. `undefined`
   * means the subagent inherits the parent session's effort. Prefer the
   * `effortForProfile()` helper over reading this directly.
   */
  resolveEffortForProfile?: (profileId?: string) => string | undefined;
  /**
   * When set, resolves the admin per-profile hard-cap override (max tool
   * calls / wall-clock timeout). `undefined` means no override and
   * depth-derived defaults decide. Prefer the `limitsOverrideForProfile()`
   * helper over reading this directly.
   */
  resolveLimitsForProfile?: (
    profileId?: string,
  ) => import('@mcp/code-agent/tools/subagent-provider.js').ProfileLimitOverride | undefined;
  /** Runtime/plugin tier placement inherited by ephemeral child runners. */
  externalToolTiers?: import('@mcp/code-agent/core/runner.js').RunnerOptions['externalToolTiers'];
  /** Host-resolved concurrency ceiling for this attempt. */
  maxParallel?: number;
  /** Explicit execute_tasks run token cap; null/undefined means unlimited. */
  executeTasksTokenCap?: number | null;
  /** Explicit retry policy for execute_tasks; product defaults apply when omitted. */
  executeTasksRetryConfig?: import('@mcp/code-agent/tools/execute-tasks/task-retry.js').TaskRetryConfig;
  /** Explicit UI response timeout for a budget gate. */
  executeTasksBudgetResponseTimeoutMs?: number;
}

export function describeProvider(provider: ChatProvider): { provider: string; model: string; label: string } {
  const providerName = provider.name || 'provider';
  const model = provider.model || 'default';
  return { provider: providerName, model, label: `${providerName}:${model}` };
}

// Re-export so existing imports keep resolving (fallback summary helper
// some scripts may use).
export { extractLastAssistantText };
