/**
 * request_review — explicit invocation of the review subagent (Camada 4).
 *
 * The agent calls this when it believes the work is done and wants a
 * second-opinion review before commit/merge. Internally builds the
 * SubagentParent (parent provider, parent tool snapshot) and delegates to
 * runReviewSubagent. Returns the structured findings as a tool result.
 *
 * The runner can also auto-trigger this near end-of-loop (heuristic in
 * runner.ts), but giving the agent an explicit tool covers the common case
 * of "I think I'm done — please double-check".
 */
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { runReviewSubagent, type ReviewInput, type ReviewFinding } from '@mcp/code-agent/tools/review-subagent.js';
import type { SubagentParent } from '@mcp/code-agent/tools/implement-subagent.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';

export interface RequestReviewDeps {
  provider: ChatProvider;
  /** Snapshot of parent's tool registry. Used as base for the review allowlist. */
  parentTools: import('@mcp/code-agent/core/tool.js').CoderTool[];
  sessionId?: SessionId;
  sessionStore?: FsSessionStore;
  /** Reviewer provider (different family). When unset, falls back to parent's. */
  reviewerProvider?: ChatProvider;
  resolveReviewerProvider?: () => Promise<ChatProvider | undefined>;
}

export function buildRequestReviewTool(deps: RequestReviewDeps): CoderTool {
  return {
    name: 'request_review',
    source: 'native',
    mutates: false,
    parallelSafe: false,
    effectBoundary: 'nested',
    riskLevel: 'read',
    description:
      'Request a second-opinion code review of the current diff (Camada 4). Spawns a fresh, ' +
      'read-only reviewer subagent on a CLEAN context — it cannot see your conversation, only ' +
      'the diff + spec + test outcome you provide. Use BEFORE asking the user to commit/merge ' +
      'a non-trivial change. Returns a JSON list of findings with severity and suggested fixes.\n\n' +
      'WHEN TO USE: after you finish a multi-file edit; after fixing a security-sensitive bug; ' +
      "before suggesting `git_commit` to the user; when the user says \"are you sure?\" and you're " +
      'about to claim yes.\n\n' +
      "DON'T: call on every turn (expensive — spawns a new subagent). Don't call for trivial " +
      "(<10 line) changes or pure read-only investigations.",
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description:
            "Plain-English description of what you were trying to accomplish. The reviewer cannot " +
            'see your prior conversation, so be self-contained — include the user request and any ' +
            'constraints you honored (e.g. "no new dependencies").',
        },
        diff: {
          type: 'string',
          description:
            'The unified diff to review. Typically the output of `git diff <base>...HEAD`. ' +
            'If empty, the reviewer will run `git diff` itself.',
        },
        test_summary: {
          type: 'string',
          description:
            'Optional one-line test outcome (e.g. "vitest: 124/124 passing"). Helps the reviewer ' +
            'focus on logic instead of "did you run the tests".',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of constraints the operator wanted enforced (security review, no new ' +
            'deps, performance-sensitive, etc.).',
        },
        target: {
          type: 'string',
          enum: ['uncommitted', 'base', 'commit'],
          description:
            'What the diff represents, so the reviewer calibrates scope: `uncommitted` (default — ' +
            'working-tree changes), `base` (whole branch vs its merge-base), or `commit` (a single commit).',
        },
      },
      required: ['spec', 'diff'],
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const spec = typeof args.spec === 'string' ? args.spec : '';
      const diff = typeof args.diff === 'string' ? args.diff : '';
      if (!spec.trim()) return err('request_review: `spec` is required.');
      if (!diff.trim()) return err('request_review: `diff` is required (run `git_diff` first if you have none).');

      const constraints = Array.isArray(args.constraints)
        ? (args.constraints as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;
      const testSummary = typeof args.test_summary === 'string' ? args.test_summary : null;
      const target =
        args.target === 'base' || args.target === 'commit' || args.target === 'uncommitted'
          ? args.target
          : undefined;

      const input: ReviewInput = { spec, diff, testSummary, constraints, target };

      try {
        ctx.signal?.throwIfAborted();
        const provider = deps.reviewerProvider ?? await deps.resolveReviewerProvider?.() ?? deps.provider;
        ctx.signal?.throwIfAborted();
        const parent: SubagentParent = {
          provider,
          tools: deps.parentTools,
          ctx,
          sessionId: deps.sessionId ?? ctx.sessionId,
          sessionStore: deps.sessionStore,
          // PR-6 R23: propagate v2 framing to the review subagent.
          agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
        };

        const result = await runReviewSubagent(parent, input);
        ctx.signal?.throwIfAborted();
        if (!result.parsed) return { ...err(formatReviewResult(result.findings, false, result.raw)), subUsage: result.usage,
          structuredData: { kind: 'review_result', status: 'inconclusive', nativeTranscriptRef: result.nativeTranscriptRef } };
        if (deps.sessionStore && deps.sessionId != null) {
          try {
            await deps.sessionStore.markSessionReviewedNow(deps.sessionId);
          } catch {
            /* best-effort */
          }
        }
        return {
          content: formatReviewResult(result.findings, result.parsed, result.raw),
          structuredData: { kind: 'review_result', status: 'completed', findings: result.findings, nativeTranscriptRef: result.nativeTranscriptRef },
          subUsage: {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cache_read_input_tokens: result.usage.cache_read_input_tokens,
            cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          },
        };
      } catch (e) {
        return err(`request_review failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function formatReviewResult(findings: ReviewFinding[], parsed: boolean, raw: string): string {
  if (!parsed) {
    return (
      'Reviewer did not emit a parseable JSON block. Raw output:\n\n' +
      raw
    );
  }
  if (findings.length === 0) {
    return 'Reviewer found no issues. Findings: [].';
  }
  const lines = [`Reviewer returned ${findings.length} finding(s):`];
  for (const f of findings) {
    const range = f.code_location?.line_range;
    const loc = range
      ? range.start === range.end
        ? `${f.file}:${range.start}`
        : `${f.file}:${range.start}-${range.end}`
      : f.line
        ? `${f.file}:${f.line}`
        : f.file;
    const verdict = f.verdict ? ` [${f.verdict}]` : '';
    lines.push(`- [${f.severity}]${verdict} ${loc} — ${f.issue}`);
    if (f.suggested_fix) lines.push(`  fix: ${f.suggested_fix}`);
    for (const e of f.evidence ?? []) {
      const exit = e.exit != null ? ` (exit=${e.exit})` : '';
      lines.push(`  evidence: \`${e.cmd}\`${exit}${e.output_excerpt ? ` → ${e.output_excerpt}` : ''}`);
    }
  }
  return lines.join('\n');
}
