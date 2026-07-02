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
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { extractLastAssistantText } from '@mcp/code-agent/tools/implement-subagent.js';

export const EXPLORE_SYSTEM_PROMPT = `You are the EXPLORE subagent. A parent coder agent delegated a focused investigation to you.

1. Use the provided read-only tools to find what was asked.
2. Return findings as \`file:line — what\` lines, or short bulleted facts.
3. NEVER speculate, NEVER write code, NEVER suggest implementation. Pure observation.
4. You CANNOT spawn sub-agents — report your findings and let the parent fan out any further work.
5. Project memory (mcp__search_memory) can be STALE — verify any file/symbol/flag it names against the current code before reporting it as fact.

# CRITICAL — ALWAYS PRODUCE A SUMMARY

The parent agent ONLY reads your final assistant text. If you hit max_turns without a text summary, your entire investigation is WASTED — the parent gets "(no summary produced)" and all your tool calls were for nothing.

**Rules:**
- Every few turns, write a partial text summary of what you found so far. This ensures the parent gets SOMETHING even if you hit max_turns.
- When you have gathered enough info, stop and write your complete final summary.
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

Prefer get_file_skeleton, get_symbol_body, grep_code, find_references over read_file of whole files. Always pass max_tokens/limit parameters.`;

export const IMPLEMENT_SYSTEM_PROMPT = `You are an IMPLEMENTATION subagent. The parent agent delegated a specific change to you to execute end-to-end and return a brief summary.

You have read AND write access to the project files plus shell. You do NOT have access to interactive prompts (no submit_plan, no ask_user, no submit_tasks): the parent already decided WHAT to do — your job is to DO it.

# Rules
1. Use the tools to read what you need, then make the edits.
2. Before any DESTRUCTIVE change (delete, rename, rewrite a file, remove config), re-read the affected code first and confirm the evidence supports THAT specific change — a pattern that matches a known failure may have a different root cause. If the evidence is ambiguous, stop and report instead of guessing.
3. Verify your work (run tests / lints when relevant).
4. Stop and write a final summary listing files changed + a 1-line description of what each change does.
5. NEVER end your run with only tool calls and no text — the parent reads ONLY your final assistant text. If you hit max_turns without a summary, the entire effort is wasted.
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
   * into `coder_session_inputs` on the parent session for the Input tab.
   */
  sessionStore?: SessionStore;
  /**
   * When set, subagents use this provider (possibly from a different
   * provider family) instead of the parent's. Created from admin
   * subagent config.
   */
  subagentProvider?: ChatProvider;
}

export function describeProvider(provider: ChatProvider): { provider: string; model: string; label: string } {
  const providerName = provider.name || 'provider';
  const model = provider.model || 'default';
  return { provider: providerName, model, label: `${providerName}:${model}` };
}

// Re-export so existing imports keep resolving (fallback summary helper
// some scripts may use).
export { extractLastAssistantText };
