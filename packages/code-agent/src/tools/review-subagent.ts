/**
 * review-subagent — Camada 4 of the agent improvement plan.
 *
 * Spawns a read-only subagent on a CLEAN context whose only job is to find
 * bugs, regressions, security issues, and missing tests in a diff. The
 * reviewer NEVER inherits the implementer's trajectory — that is exactly the
 * point: a fresh agent without the implementer's bias is far better at
 * spotting issues — a fresh reviewer on a clean context reportedly catches
 * real bugs the implementer's own pass tends to miss.
 *
 * Cross-family routing: when `subagentTarget` is configured to a different
 * provider family (e.g. implementer=Claude, reviewer=GPT-5/Gemini/DeepSeek),
 * the parent layer creates the second provider before calling here.
 *
 * The reviewer receives ONLY:
 *   - the user's original spec/intent
 *   - the diff (file-by-file)
 *   - the test-run summary (if any)
 *   - a list of constraints the operator wants enforced
 *
 * It returns structured JSON: { findings: [{ severity, file, line, issue, suggested_fix }] }
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { SubagentParent } from '@mcp/code-agent/tools/implement-subagent.js';
import { runSubagent } from '@mcp/code-agent/tools/implement-subagent.js';

/**
 * Read-only allowlist for the reviewer. Strict subset of EXPLORE_ALLOWLIST —
 * the reviewer does not need to spawn nested agents and never writes.
 */
export const REVIEW_ALLOWLIST = new Set<string>([
  // Diff inspection
  'git_diff',
  'git_log',
  'git_status',
  // Read-only nav
  'read_file',
  'list_directory',
  'glob',
  // Symbol-level reads (cheaper than full file reads)
  'mcp__read_file',
  'mcp__get_file_skeleton',
  'mcp__get_symbol_body',
  'mcp__get_symbol_details',
  'mcp__find_references',
  'mcp__grep_code',
  'mcp__get_dependents',
  // LSP for type/usage validation
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_diagnostics',
  'get_diagnostics',
]);

const REVIEW_SYSTEM_PROMPT = `You are a CODE REVIEWER subagent. The orchestrator finished an implementation and is asking you for an independent review BEFORE the change ships.

You have read-only access to the project. You CANNOT see the implementer's conversation, plan, or reasoning — you have ONLY the diff and the test outcome. That is intentional. You bring fresh eyes; do not invent context.

# Your job

Find:
  1. Real bugs in the diff (logic errors, missing null checks, broken edge cases, incorrect signatures, leaked resources, race conditions).
  2. Security issues (injection, missing authz, secrets in logs, unsafe deserialization).
  3. Test gaps (untested branches in modified code, missing regression test for the reported bug).
  4. Regressions (a function the diff renamed/removed but is still called somewhere).

Skip:
  - Style nits (formatting, naming preferences) UNLESS they obscure a real bug.
  - Suggestions for "additional improvements" outside the diff.
  - Praise. Be terse.

# Constraints
- Only review the files in the diff. Do not propose refactors elsewhere.
- If you read a file outside the diff to verify a caller/dependency, OK — but stay focused.
- You CANNOT spawn sub-agents — review the diff yourself.
- Limit yourself to ~15 turns. Quality > exhaustiveness.

# Output format — STRICT
Your LAST assistant message MUST contain a JSON block in this EXACT format:

\`\`\`
<review>{"findings": [
  {"severity": "critical|high|medium|low", "file": "path/to/file.ts", "line": 42, "issue": "<≤200 chars>", "suggested_fix": "<≤200 chars>"}
]}</review>
\`\`\`

If no real issues are found, return \`{"findings": []}\` and nothing else. The orchestrator parses this; missing/malformed blocks are treated as a failed review.`;

export interface ReviewInput {
  /** The user-facing intent / spec the implementer was supposed to satisfy. */
  spec: string;
  /** Combined diff (output of \`git diff <base>...HEAD\`). */
  diff: string;
  /** Optional summary of test run (e.g. "vitest: 24/25 passing — 1 fail in foo.test.ts"). */
  testSummary?: string | null;
  /** Optional list of operator constraints (security, perf, no-deps-added, etc.). */
  constraints?: string[];
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  issue: string;
  suggested_fix?: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  /** Raw text the reviewer returned, for debugging. */
  raw: string;
  /** Whether the JSON block was successfully parsed. */
  parsed: boolean;
  /** Subagent token usage so the parent can attribute cost. */
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function buildInitialUserMessage(input: ReviewInput): string {
  const constraints =
    input.constraints && input.constraints.length > 0
      ? input.constraints.map((c) => `- ${c}`).join('\n')
      : '(none)';
  const tests = input.testSummary ? input.testSummary.trim() : '(no test run reported)';
  // Trim diff to a sane upper bound — even with cache, sending 200K of diff
  // is wasteful for the reviewer and dilutes attention.
  const MAX_DIFF_CHARS = 80_000;
  const diff =
    input.diff.length > MAX_DIFF_CHARS
      ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars — review the most critical files first; \`git_diff\` to fetch more]`
      : input.diff;

  return `# Spec
${input.spec.trim()}

# Constraints
${constraints}

# Test summary
${tests}

# Diff
\`\`\`diff
${diff}
\`\`\`

Review the diff per the rules in your system prompt and emit your final \`<review>\` JSON block.`;
}

function parseReviewBlock(text: string): { findings: ReviewFinding[] } | null {
  // Locate the <review>...</review> block. Tolerant of stray whitespace.
  const m = /<review>([\s\S]*?)<\/review>/i.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)) {
      const findings = ((parsed as { findings: unknown[] }).findings as unknown[])
        .filter((f): f is Record<string, unknown> => f != null && typeof f === 'object')
        .map((f): ReviewFinding => ({
          severity: ((['critical', 'high', 'medium', 'low'] as const).find((s) => s === f.severity) ??
            'medium') as ReviewFinding['severity'],
          file: typeof f.file === 'string' ? f.file : 'unknown',
          line: typeof f.line === 'number' ? f.line : undefined,
          issue: typeof f.issue === 'string' ? f.issue : '(no issue text)',
          suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix : undefined,
        }));
      return { findings };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function runReviewSubagent(parent: SubagentParent, input: ReviewInput): Promise<ReviewResult> {
  const initialMessages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: buildInitialUserMessage(input) }] },
  ];

  // Mirror the prompt to the Input tab of the parent session, same pattern as
  // the implement subagent so review prompts are auditable.
  if (parent.sessionStore && parent.sessionId != null) {
    try {
      parent.sessionStore.recordSessionInput({
        session_id: parent.sessionId,
        kind: 'subagent_prompt',
        source_label: 'subagent:review',
        content: REVIEW_SYSTEM_PROMPT,
        meta: { spec_chars: input.spec.length, diff_chars: input.diff.length },
      });
    } catch {
      /* best-effort */
    }
  }

  const result = await runSubagent(parent, {
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    allowlist: REVIEW_ALLOWLIST,
    initialMessages,
    maxTurns: Number(process.env.CODER_REVIEW_MAX_TURNS ?? 15),
  });

  const parsed = parseReviewBlock(result.finalText);
  return {
    findings: parsed?.findings ?? [],
    raw: result.finalText,
    parsed: parsed != null,
    usage: result.usage,
  };
}
