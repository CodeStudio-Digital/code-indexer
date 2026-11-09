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
 * the reviewer does not need to spawn nested agents and never writes. Shared
 * by other read-only subagents (micro-agent-profiles), so it must stay execution-free; the probe-capable
 * variant below is used ONLY by runReviewSubagent.
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
 * Reviewer allowlist + probe execution (PoC-or-Demote, Onda 3): the reviewer
 * must PROVE high/critical findings by running a probe (tsc / focused test /
 * small repro) via one-shot `run_command` — never persistent shells. The
 * per-call permission gate still applies to every invocation. Only
 * runReviewSubagent uses this set.
 */
export const REVIEW_PROBE_ALLOWLIST = new Set<string>([...REVIEW_ALLOWLIST, 'run_command']);

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

# Mandatory checklist (do these BEFORE concluding — pull-based review)
1. For EVERY exported symbol whose signature/contract changed, run \`mcp__find_references\` and verify each caller still type-checks against the new signature. A caller the diff forgot is a finding.
2. For every file with logic changes, run \`lsp_diagnostics\` (or \`get_diagnostics\`) on it.
3. Read the enclosing function/class of each logic hunk (\`mcp__get_symbol_body\`), not just the hunk lines.

# Evidence — PoC or demote
A finding is a FACT, not an opinion. For severity \`high\` or \`critical\` you MUST attach
\`evidence\`: probes you actually EXECUTED that demonstrate the problem — a failing
\`run_command\` (tsc / focused test / small repro), or an \`lsp_diagnostics\` error on the
exact line. Rules:
- A probe must be able to FAIL: pair it with a control (the same probe against a case
  that should pass) so a broken probe cannot fake a CONFIRMED.
- No side effects: never run migrations, seeds, installs, or servers as probes.
- High/critical findings WITHOUT executed evidence will be demoted to medium by the
  orchestrator — attach the probe or lower the severity yourself.
- Set \`verdict\`: "CONFIRMED" when your evidence demonstrates the issue; "PLAUSIBLE"
  when you could not build a probe (say why in the issue text).

# Constraints
- Only review the files in the diff. Do not propose refactors elsewhere.
- If you read a file outside the diff to verify a caller/dependency, OK — but stay focused.
- You CANNOT spawn sub-agents — review the diff yourself.
- Limit yourself to ~15 turns. Quality > exhaustiveness.

# Output format — STRICT
Your LAST assistant message MUST contain a JSON block in this EXACT format:

\`\`\`
<review>{"findings": [
  {"severity": "critical|high|medium|low", "verdict": "CONFIRMED|PLAUSIBLE", "code_location": {"file": "path/to/file.ts", "line_range": {"start": 42, "end": 48}}, "issue": "<≤200 chars>", "suggested_fix": "<≤200 chars>", "evidence": [{"cmd": "<probe you ran>", "output_excerpt": "<≤200 chars>", "exit": 1}]}
]}</review>
\`\`\`

Use project-root-relative paths. For a single-line finding set \`start\` == \`end\`. \`evidence\` may be \`[]\` for medium/low. If no real issues are found, return \`{"findings": []}\` and nothing else. The orchestrator parses this; missing/malformed blocks are treated as a failed review.`;
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

/** One executed probe backing a finding (PoC-or-Demote). */
export interface ProbeEvidence {
  cmd: string;
  output_excerpt?: string;
  exit?: number;
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
  /** Executed probes demonstrating the issue. Required for high/critical —
   *  the orchestrator demotes evidence-less ones (enforceEvidenceGate). */
  evidence?: ProbeEvidence[];
  /** CONFIRMED = evidence demonstrates it; PLAUSIBLE = unproven claim. */
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
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

/** Above this size the prompt goes PULL-BASED: a per-file summary instead of
 *  inline diff text — the reviewer interrogates via git_diff/read_file/LSP.
 *  Attention on a summary + targeted pulls beats attention diluted over 80K
 *  of unified diff. */
const PULL_BASED_THRESHOLD_CHARS = 8_000;

/** Per-file added/removed summary parsed from unified-diff text. */
export function summarizeDiffText(diff: string): string {
  const files = new Map<string, { added: number; removed: number }>();
  let current: { added: number; removed: number } | null = null;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(?:.+?) b\/(.+)$/.exec(line) ?? /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      current = files.get(header[1]) ?? { added: 0, removed: 0 };
      files.set(header[1], current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  if (files.size === 0) return '(could not summarize — run `git_diff` to see the change)';
  return [...files.entries()]
    .map(([path, c]) => `- ${path} (+${c.added}/-${c.removed})`)
    .join('\n');
}

function buildInitialUserMessage(input: ReviewInput): string {
  const constraints =
    input.constraints && input.constraints.length > 0
      ? input.constraints.map((c) => `- ${c}`).join('\n')
      : '(none)';
  const tests = input.testSummary ? input.testSummary.trim() : '(no test run reported)';

  // Pull-based review for anything non-trivial: the prompt carries only the
  // per-file summary; the reviewer pulls hunks/symbols/callers itself.
  if (input.diff.length > PULL_BASED_THRESHOLD_CHARS) {
    return `# Spec
${input.spec.trim()}

# Constraints
${constraints}

# Test summary
${tests}

# Changed files (summary — the diff text is NOT inlined on purpose)
${summarizeDiffText(input.diff)}

Interrogate the change yourself: \`git_diff\` for the hunks of each file (most
suspicious first), \`mcp__get_symbol_body\` for the enclosing functions,
\`mcp__find_references\` for every changed signature (mandatory checklist),
\`run_command\` for probes. Then emit your final \`<review>\` JSON block.`;
  }

  return `# Spec
${input.spec.trim()}

# Constraints
${constraints}

# Test summary
${tests}

# Diff
\`\`\`diff
${input.diff}
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
          const evidence = Array.isArray(f.evidence)
            ? (f.evidence as unknown[])
                .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
                .filter((e) => typeof e.cmd === 'string' && e.cmd.trim() !== '')
                .map((e) => ({
                  cmd: String(e.cmd).slice(0, 300),
                  output_excerpt:
                    typeof e.output_excerpt === 'string' ? e.output_excerpt.slice(0, 400) : undefined,
                  exit: typeof e.exit === 'number' ? e.exit : undefined,
                }))
            : undefined;
          return {
            severity: ((['critical', 'high', 'medium', 'low'] as const).find((s) => s === f.severity) ??
              'medium') as ReviewFinding['severity'],
            file: loc.file,
            line: loc.line,
            issue: typeof f.issue === 'string' ? f.issue : '(no issue text)',
            suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix : undefined,
            code_location: loc.code_location,
            evidence: evidence && evidence.length > 0 ? evidence : undefined,
            verdict: f.verdict === 'CONFIRMED' || f.verdict === 'PLAUSIBLE' ? f.verdict : undefined,
          };
        });
      return { findings };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * PoC-or-Demote enforcement (deterministic, exported for tests): a high or
 * critical finding without executed evidence is a CLAIM, not a fact — demote
 * it to medium/PLAUSIBLE and say so in the issue text. Findings WITH evidence
 * default to CONFIRMED. Nothing is ever silently dropped: a wrong demotion
 * costs one severity level, a hallucinated "critical" costs the user's trust.
 */
export function enforceEvidenceGate(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.map((f) => {
    const hasEvidence = (f.evidence?.length ?? 0) > 0;
    if (!hasEvidence && (f.severity === 'critical' || f.severity === 'high')) {
      return {
        ...f,
        severity: 'medium' as const,
        verdict: 'PLAUSIBLE' as const,
        issue: `[demoted from ${f.severity}: no executed evidence] ${f.issue}`,
      };
    }
    return { ...f, verdict: f.verdict ?? (hasEvidence ? 'CONFIRMED' : 'PLAUSIBLE') };
  });
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
      await parent.sessionStore.recordSessionInput({
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
    allowlist: REVIEW_PROBE_ALLOWLIST,
    initialMessages,
    maxTurns: 0,
  });

  const parsed = result.reason === 'completed' ? parseReviewBlock(result.finalText) : null;
  return {
    findings: enforceEvidenceGate(parsed?.findings ?? []),
    raw: result.finalText,
    parsed: parsed != null,
    usage: result.usage,
  };
}
