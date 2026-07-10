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

/**
 * Review target — mirrors Codex's `review_request.rs` (UncommittedChanges /
 * BaseBranch / Commit). Changes only the framing paragraph so the reviewer
 * calibrates scope; the output contract is identical across targets.
 */
export type ReviewTarget = 'uncommitted' | 'base' | 'commit';

function targetFraming(target: ReviewTarget): string {
  switch (target) {
    case 'base':
      return 'You are reviewing the FULL diff of this branch against its base (merge-base) — the whole feature, not a single edit. Weigh cross-file coherence and whether the feature is complete and consistent, alongside line-level bugs.';
    case 'commit':
      return "You are reviewing a SINGLE COMMIT. Judge the change against the commit's stated intent: flag anything the message implies but the diff omits, and anything the diff does beyond what the message claims.";
    case 'uncommitted':
    default:
      return 'You are reviewing UNCOMMITTED working-tree changes (not yet committed). Focus on whether this change is correct and safe to commit as-is.';
  }
}

/**
 * Build the reviewer system prompt for a given target. Kept a function (not a
 * const) so the target-specific framing can be spliced in; the job/constraints/
 * output-format sections are shared.
 */
export function reviewSystemPrompt(target: ReviewTarget = 'uncommitted'): string {
  return `You are a CODE REVIEWER subagent. The orchestrator finished an implementation and is asking you for an independent review BEFORE the change ships.

You have read-only access to the project. You CANNOT see the implementer's conversation, plan, or reasoning — you have ONLY the diff and the test outcome. That is intentional. You bring fresh eyes; do not invent context.

${targetFraming(target)}

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
  {"severity": "critical|high|medium|low", "code_location": {"file": "path/to/file.ts", "line_range": {"start": 42, "end": 48}}, "issue": "<≤200 chars>", "suggested_fix": "<≤200 chars>"}
]}</review>
\`\`\`

Use project-root-relative paths. For a single-line finding set \`start\` == \`end\`. If no real issues are found, return \`{"findings": []}\` and nothing else. The orchestrator parses this; missing/malformed blocks are treated as a failed review.`;
}

export interface ReviewInput {
  /** The user-facing intent / spec the implementer was supposed to satisfy. */
  spec: string;
  /** Combined diff (output of \`git diff <base>...HEAD\`). */
  diff: string;
  /** Optional summary of test run (e.g. "vitest: 24/25 passing — 1 fail in foo.test.ts"). */
  testSummary?: string | null;
  /** Optional list of operator constraints (security, perf, no-deps-added, etc.). */
  constraints?: string[];
  /** What the diff represents — calibrates the reviewer's framing. Default 'uncommitted'. */
  target?: ReviewTarget;
}

/** Structured code location (Codex parity): file + line range. */
export interface CodeLocation {
  file: string;
  line_range?: { start: number; end: number };
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Retained for existing consumers; mirrors code_location.file. */
  file: string;
  /** Retained for existing consumers; mirrors code_location.line_range.start. */
  line?: number;
  issue: string;
  suggested_fix?: string;
  /** Structured location (start/end line). Always populated when a file is known. */
  code_location?: CodeLocation;
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

/**
 * Extract a code location from a raw finding, accepting the new structured
 * `code_location` object OR the legacy flat `file`/`line` fields. Always yields
 * a populated `{ file, line?, code_location }` triple so both old consumers
 * (file/line) and new ones (code_location) work.
 */
function extractLocation(f: Record<string, unknown>): { file: string; line?: number; code_location?: CodeLocation } {
  const cl = f.code_location;
  if (cl && typeof cl === 'object') {
    const clo = cl as Record<string, unknown>;
    const file = typeof clo.file === 'string' ? clo.file : 'unknown';
    // Accept nested {line_range:{start,end}} or flat {start_line,end_line}.
    const lr = clo.line_range && typeof clo.line_range === 'object' ? (clo.line_range as Record<string, unknown>) : null;
    const start = typeof lr?.start === 'number' ? lr.start
      : typeof clo.start_line === 'number' ? clo.start_line : undefined;
    const end = typeof lr?.end === 'number' ? lr.end
      : typeof clo.end_line === 'number' ? clo.end_line : start;
    const code_location: CodeLocation = { file };
    if (start != null) code_location.line_range = { start, end: end ?? start };
    return { file, line: start, code_location };
  }
  // Legacy flat shape.
  const file = typeof f.file === 'string' ? f.file : 'unknown';
  const line = typeof f.line === 'number' ? f.line : undefined;
  const code_location: CodeLocation = { file };
  if (line != null) code_location.line_range = { start: line, end: line };
  return { file, line, code_location };
}

/** Exported for tests. Parses the reviewer's `<review>` JSON block. */
export function parseReviewBlock(text: string): { findings: ReviewFinding[] } | null {
  // Locate the <review>...</review> block. Tolerant of stray whitespace.
  const m = /<review>([\s\S]*?)<\/review>/i.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)) {
      const findings = ((parsed as { findings: unknown[] }).findings as unknown[])
        .filter((f): f is Record<string, unknown> => f != null && typeof f === 'object')
        .map((f): ReviewFinding => {
          const loc = extractLocation(f);
          return {
            severity: ((['critical', 'high', 'medium', 'low'] as const).find((s) => s === f.severity) ??
              'medium') as ReviewFinding['severity'],
            file: loc.file,
            line: loc.line,
            issue: typeof f.issue === 'string' ? f.issue : '(no issue text)',
            suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix : undefined,
            code_location: loc.code_location,
          };
        });
      return { findings };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function runReviewSubagent(parent: SubagentParent, input: ReviewInput): Promise<ReviewResult> {
  const systemPrompt = reviewSystemPrompt(input.target ?? 'uncommitted');
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
        content: systemPrompt,
        meta: { spec_chars: input.spec.length, diff_chars: input.diff.length, target: input.target ?? 'uncommitted' },
      });
    } catch {
      /* best-effort */
    }
  }

  const result = await runSubagent(parent, {
    profile: 'review',
    systemPrompt,
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
