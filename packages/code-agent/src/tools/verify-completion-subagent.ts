/**
 * verify-completion-subagent — A1 of the Claude-Code-gap plan.
 *
 * An INDEPENDENT read-only second agent that confirms the ORIGINAL goal was
 * actually met before the run is allowed to finish (or before a company
 * subordinate is finalized). Mirrors `review-subagent`'s clean-context design:
 * the verifier NEVER sees the executor's transcript — only the persisted goal,
 * plan, scoped files, and recorded verification evidence — so it cannot
 * rubber-stamp the executor's own reasoning. This is the "stop-condition
 * verifier" half of Claude Code's two-agent split (verification executor +
 * stop-condition verifier).
 *
 * This is not a consultative classifier: it gates `update_goal(complete)`.
 * It is baseline behavior for top-level runs and can be disabled explicitly
 * with CODER_GOAL_VERIFY=0.
 *
 * Output contract — the verifier's LAST message contains:
 *   <verdict>{"goal_met": bool, "gaps": [{"description": "...", "severity": "high|medium|low"}]}</verdict>
 * A parsed negative verdict blocks completion. A missing/malformed block is
 * inconclusive so the runner's documented verifier-error fail-open contract
 * can distinguish infrastructure failure from an actual unmet goal.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { SubagentParent } from '@mcp/code-agent/tools/implement-subagent.js';
import { runSubagent } from '@mcp/code-agent/tools/implement-subagent.js';
import { REVIEW_ALLOWLIST } from '@mcp/code-agent/tools/review-subagent.js';

const VERIFY_SYSTEM_PROMPT = `You are a COMPLETION VERIFIER subagent. An implementation agent claims a task is DONE. Your job is to independently confirm whether the ORIGINAL goal was actually achieved — BEFORE the work ships.

You have read-only access to the project. You CANNOT see the implementer's conversation or reasoning — only the goal, the plan (if any), the diff, and recorded verification evidence. That is intentional: you bring fresh eyes and must not rubber-stamp their thinking. Read the actual files when you need to confirm a claim; do not trust the diff alone.

# Your job
Decide: was the goal MET end-to-end? "Met" means the behavior the user asked for actually works — not merely that code was added or that it compiles.
- Check every concrete requirement in the goal/plan against the diff and the current code.
- A substantive goal may intentionally have no code diff (for example, analysis or validation). In that case, judge the persisted goal against the available read-only project state and recorded evidence instead of skipping verification.
- A requirement that is only partially done, stubbed, left as a TODO, or untested is NOT met — list it as a gap.
- Treat missing, failed, stale, or ambiguous verification evidence as a gap when executable validation should exist for the changed code. A prose-only change may instead state why no executable oracle applies.
- If a requirement's evidence is ambiguous, read the relevant file to confirm. If it is still unclear whether a MATERIAL requirement is satisfied, treat the goal as NOT met (be conservative).
- Do NOT invent new requirements beyond the goal/plan, and do NOT block on pure style or hypotheticals.

# Output format — STRICT
Your LAST assistant message MUST contain a JSON block in this EXACT format:

\`\`\`
<verdict>{"goal_met": true, "gaps": [
  {"description": "<what is missing or incomplete, ≤200 chars>", "severity": "high|medium|low"}
]}</verdict>
\`\`\`

If the goal is fully met, return \`{"goal_met": true, "gaps": []}\` and nothing else. The orchestrator parses this block; a missing or malformed block is treated as NOT met.`;

export interface VerifyInput {
  /** The original goal / user intent the run was supposed to satisfy. */
  goal: string;
  /** The approved plan, if one was recorded. */
  plan?: string | null;
  /** Combined diff of the pending changes (output of `git diff`). */
  diff: string;
  /** Optional one-line test outcome (e.g. "vitest: 124/124 passing"). */
  testSummary?: string | null;
  /** Files attributed to this session in a shared/dirty worktree. */
  files?: readonly string[] | null;
}

export interface VerifyRunOptions {
  /** Bounded default used when CODER_GOAL_VERIFY_MAX_TURNS is unset. */
  defaultMaxTurns?: number;
}

interface GoalVerificationStateLike {
  goal: { text: string } | null;
  filesChanged: ReadonlyArray<string>;
}

export interface GoalVerificationScope {
  goal: string;
  files: ReadonlyArray<string>;
}

export interface VerifyGap {
  description: string;
  severity: 'high' | 'medium' | 'low';
}

export interface UsableGoalCompletionVerdict {
  goalMet: boolean;
  gaps: ReadonlyArray<VerifyGap>;
}

export interface VerifyResult {
  /** False for an explicit negative verdict or an unparseable result; consult `parsed`. */
  goalMet: boolean;
  gaps: VerifyGap[];
  /** Raw text the verifier returned, for debugging. */
  raw: string;
  /** Whether the `<verdict>` JSON block parsed. */
  parsed: boolean;
  /** Subagent token usage so the parent can attribute cost. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const MAX_DIFF_CHARS = 80_000;
export const DEFAULT_GOAL_VERIFY_MAX_TURNS = 12;
export const GOAL_VERIFY_HARD_MAX_TURNS = 50;

/**
 * Baseline policy for the semantic completion verifier. Merely constructing
 * the callback does not run it: the Executing gate invokes it only for an
 * in-progress goal attempting `update_goal(status=complete)`, so greetings and
 * other trivial text-only turns do not spend a verifier request.
 */
export function shouldEnableGoalCompletionVerifier(
  configured: string | undefined,
  companyContext: boolean,
): boolean {
  return !companyContext && configured?.trim() !== '0';
}

/**
 * Resolve the persisted goal and its optional file scope. An empty file list
 * is valid: analysis, validation, and other substantive goals can complete
 * without producing a diff.
 */
export function resolveGoalVerificationScope(
  state: GoalVerificationStateLike | null | undefined,
  stagedGoal?: { text: string } | null,
): GoalVerificationScope | null {
  const goal = (stagedGoal?.text ?? state?.goal?.text)?.trim();
  if (!goal) return null;
  return { goal, files: state?.filesChanged ?? [] };
}

export function buildVerifyInitialMessage(input: VerifyInput): string {
  const plan = input.plan && input.plan.trim() ? input.plan.trim() : '(no explicit plan was recorded)';
  const tests = input.testSummary && input.testSummary.trim() ? input.testSummary.trim() : '(no test run reported)';
  const diffBlock = input.diff.trim()
    ? `# Diff\n\`\`\`diff\n${
        input.diff.length > MAX_DIFF_CHARS
          ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars — read the files directly to verify the rest]`
          : input.diff
      }\n\`\`\``
    : '# Diff\n(not provided — this may be a no-diff goal. Inspect the recorded evidence and project state directly; run `git_diff` if pending changes are relevant.)';
  const scopedFiles = (input.files ?? []).map((file) => file.trim()).filter(Boolean);
  const scopeBlock = scopedFiles.length > 0
    ? `# Session-owned file scope\n${scopedFiles.map((file) => `- \`${file}\``).join('\n')}\n\n` +
      'This worktree may contain unrelated concurrent changes. Scope `git_diff` and your verdict to these files; inspect another file only when it is a direct dependency needed to verify the goal.'
    : '# Session-owned file scope\n(not recorded — be alert for unrelated changes in a shared worktree.)';

  return `# Goal
${input.goal.trim()}

# Plan
${plan}

# Recorded verification evidence
${tests}

${scopeBlock}

${diffBlock}

Verify whether the goal is met per the rules in your system prompt, reading files as needed, then emit your final \`<verdict>\` JSON block.`;
}

export function resolveVerifyMaxTurns(
  configured: string | undefined,
  defaultMaxTurns = DEFAULT_GOAL_VERIFY_MAX_TURNS,
): number {
  const fallback = Number.isFinite(defaultMaxTurns) && defaultMaxTurns > 0
    ? Math.min(GOAL_VERIFY_HARD_MAX_TURNS, Math.max(1, Math.floor(defaultMaxTurns)))
    : DEFAULT_GOAL_VERIFY_MAX_TURNS;
  if (configured == null || configured.trim() === '') return fallback;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(GOAL_VERIFY_HARD_MAX_TURNS, Math.max(1, Math.floor(parsed)));
}

/**
 * Pure parser for the `<verdict>` block. Exported for unit testing.
 * Returns null when no parseable block is present (caller treats as NOT met).
 */
export function parseVerdictBlock(text: string): { goalMet: boolean; gaps: VerifyGap[] } | null {
  const m = /<verdict>([\s\S]*?)<\/verdict>/i.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim()) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { goal_met?: unknown }).goal_met === 'boolean') {
      const rawGaps = Array.isArray((parsed as { gaps?: unknown }).gaps)
        ? ((parsed as { gaps: unknown[] }).gaps as unknown[])
        : [];
      const gaps = rawGaps
        .filter((g): g is Record<string, unknown> => g != null && typeof g === 'object')
        .map((g): VerifyGap => ({
          description: typeof g.description === 'string' ? g.description : '(no description)',
          severity: ((['high', 'medium', 'low'] as const).find((s) => s === g.severity) ?? 'medium') as VerifyGap['severity'],
        }));
      return { goalMet: (parsed as { goal_met: boolean }).goal_met === true, gaps };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Convert the raw subagent result into an authoritative completion verdict.
 * An aborted/timed-out provider commonly leaves no parseable verdict. That is
 * verifier failure, not evidence that the user's goal is unmet, so callers
 * fail open exactly as they do for a thrown verifier.
 */
export function resolveUsableGoalCompletionVerdict(
  result: Pick<VerifyResult, 'goalMet' | 'gaps' | 'parsed'>,
): UsableGoalCompletionVerdict | null {
  if (!result.parsed) return null;
  return { goalMet: result.goalMet, gaps: result.gaps };
}

export async function runVerifyCompletionSubagent(
  parent: SubagentParent,
  input: VerifyInput,
  options: VerifyRunOptions = {},
): Promise<VerifyResult> {
  const initialMessages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: buildVerifyInitialMessage(input) }] },
  ];

  // Mirror the prompt to the Input tab of the parent session (auditable),
  // same pattern as the review/implement subagents.
  if (parent.sessionStore && parent.sessionId != null) {
    try {
      await parent.sessionStore.recordSessionInput({
        session_id: parent.sessionId,
        kind: 'subagent_prompt',
        source_label: 'subagent:verify-completion',
        content: VERIFY_SYSTEM_PROMPT,
        meta: { goal_chars: input.goal.length, diff_chars: input.diff.length },
      });
    } catch {
      /* best-effort */
    }
  }

  const result = await runSubagent(parent, {
    profile: 'verify',
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    allowlist: REVIEW_ALLOWLIST,
    initialMessages,
    maxTurns: resolveVerifyMaxTurns(
      '12',
      options.defaultMaxTurns,
    ),
  });

  const parsed = parseVerdictBlock(result.finalText);
  return {
    goalMet: parsed?.goalMet ?? false, // fail-closed
    gaps: parsed?.gaps ?? [],
    raw: result.finalText,
    parsed: parsed != null,
    usage: result.usage,
  };
}
