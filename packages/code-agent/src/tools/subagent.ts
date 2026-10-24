/**
 * Subagent helpers shared by the unified `spawn_agent` tool.
 *
 * Historical note: this file used to host the deprecated `spawn_subagent`
 * (single, sequential) and `spawn_agents` (parallel) tools. Both were
 * folded into `spawn_agent` (Opção A) — see `tools/spawn-agent.ts`. What
 * remains here are the system prompts + deps interface + provider helper
 * that the new tool re-uses.
 */
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { extractLastAssistantText } from '@mcp/code-agent/tools/implement-subagent.js';

export const EXPLORE_SYSTEM_PROMPT = `You are the EXPLORE subagent. A parent coder agent delegated a focused investigation to you.

1. Use the provided read-only tools to find what was asked.
2. Return findings as \`file:line — what\` lines, or short bulleted facts.
3. NEVER speculate, NEVER write code, NEVER suggest implementation. Pure observation.
4. You CANNOT spawn sub-agents — report your findings and let the parent fan out any further work.
5. Project memory (mcp__search_memory) can be STALE — verify any file/symbol/flag it names against the current code before reporting it as fact.

# CRITICAL — ALWAYS PRODUCE A SUMMARY

The parent agent reads your final assistant text. Work until the explicit questions and completion criteria are answered, then immediately produce a concise evidence-backed summary.

**Rules:**
- Record durable memos when useful during a long investigation, but reserve the assistant response for the final summary.
- "Enough" means each requested decision has at least one verified evidence item. File novelty alone is not decision novelty.
- When the requested decisions have evidence, stop even if more related files could be inspected.
- Put unresolved items under Open questions instead of widening the investigation indefinitely.
- If a search returns no results twice in a row, stop — report "No evidence of X" as a finding.
- NEVER end your run with only tool calls and no text.

# Output format

## Findings
- <fact 1 with file:line>
- <fact 2 with file:line>
...

## Confidence
<high/medium/low + why>

## Open questions
<only if relevant>

# Token economy

Prefer get_file_skeleton, get_symbol_body, grep_code, find_references over read_file of whole files. Always pass max_tokens/limit parameters. Batch independent read-only lookups when a batch surface is available.`;

export const IMPLEMENT_SYSTEM_PROMPT = `You are an IMPLEMENTATION subagent. The parent agent delegated a specific change to you to execute end-to-end and return a brief summary.

You have read AND write access to the project files plus shell. You do NOT have access to interactive prompts (no submit_plan, no ask_user, no submit_tasks): the parent already decided WHAT to do — your job is to DO it.

# Rules
1. Use the tools to read what you need, then make the edits.
2. Before any DESTRUCTIVE change (delete, rename, rewrite a file, remove config), re-read the affected code first and confirm the evidence supports THAT specific change — a pattern that matches a known failure may have a different root cause. If the evidence is ambiguous, stop and report instead of guessing.
3. Verify your work (run tests / lints when relevant).
4. Stop and write a final summary listing files changed + a 1-line description of what each change does.
5. NEVER end your run with only tool calls and no text — always return a final summary to the parent.
6. If you discover the task can't be done as described (missing prerequisite, ambiguous scope), stop and report findings instead of guessing.
7. If a \`files\` scope was given, keep WRITES inside it; reading outside the scope for context is fine.

# Output format

## Files changed
- src/foo.ts — added \`bar()\` per the task
- src/foo.test.ts — covered the happy path

## Verification
- ran \`npm test foo\`: passing
- ran \`tsc --noEmit\`: clean

## Notes (only if relevant)
<edge cases, assumptions, follow-ups>
`;

export interface SubagentDeps {
  provider: ChatProvider;
  /**
   * Snapshot of the parent registry's tools at agent build time. The
   * spawn_agent tool creates its own ToolRegistry containing only the
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
  /** Per-turn smart reducer inherited by ephemeral child runners. */
  toolSelectionFilter?: import('@mcp/code-agent/core/runner.js').RunnerOptions['toolSelectionFilter'];
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
