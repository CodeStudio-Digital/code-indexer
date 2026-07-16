/**
 * resume-nudges — the continuation message appended to a resumed subagent's
 * transcript. Tells the child it was interrupted (why), that everything above
 * is its OWN prior work (don't redo), that the workspace may have drifted, and
 * how to finish. The per-reason line steers behavior for the specific failure.
 */
import type { StopReason } from '@mcp/code-agent/core/runner.js';

export interface NudgeContext {
  attempt: number;
  reason: StopReason;
  /** Raw watchdog/error message — disambiguates timeout/stall/quality/crash. */
  failureNote?: string;
  toolCallCount: number;
  maxToolCalls?: number;
  guidance?: string;
  isImplement: boolean;
}

export type ResumeKind = 'tool_budget' | 'turn_budget' | 'timeout' | 'crash' | 'quality' | 'aborted';

/** Classify the failure into the kind that picks the reason-specific line. */
export function classifyResumeKind(reason: StopReason, failureNote?: string): ResumeKind {
  if (reason === 'tool_budget') return 'tool_budget';
  if (reason === 'max_turns') return 'turn_budget';
  if (reason === 'time_budget') return 'timeout';
  if (reason === 'aborted') return 'aborted';
  const note = (failureNote ?? '').toLowerCase();
  if (note.includes('quality')) return 'quality';
  if (note.includes('timeout') || note.includes('timed out') || note.includes('stall')) return 'timeout';
  return 'crash';
}

function reasonLine(kind: ResumeKind, ctx: NudgeContext): string {
  switch (kind) {
    case 'tool_budget':
      return `you used your full tool-call budget (${ctx.toolCallCount} calls)`;
    case 'turn_budget':
      return `you reached the explicit turn ceiling`;
    case 'timeout':
      return `you hit a time/stall watchdog (${ctx.failureNote ?? 'no progress for too long'})`;
    case 'quality':
      return `you produced several consecutive turns without a single tool call`;
    case 'aborted':
      return `the run was aborted externally`;
    case 'crash':
    default:
      return `the run failed: ${ctx.failureNote ?? 'unknown error'}`;
  }
}

function specificLine(kind: ResumeKind, ctx: NudgeContext): string {
  switch (kind) {
    case 'tool_budget':
      return `You have a fresh budget of ${ctx.maxToolCalls ?? 'the profile default'} calls. ` +
        `Be economical: batch edits, avoid redundant reads.`;
    case 'turn_budget':
      return `Continue from the retained progress and avoid repeating completed exploration.`;
    case 'timeout':
      return `Prefer decisive action over broad exploration. If a command hangs, use a faster or narrower alternative.`;
    case 'quality':
      return `HARD RULE for this attempt: your very next message must either call a tool or deliver the final summary. No analysis-only turns.`;
    case 'aborted':
      return `Re-verify the state of anything you were mid-way through before continuing.`;
    case 'crash':
    default:
      return `If the exact same operation fails again, work around it and record the failure in your final summary instead of retrying it more than once.`;
  }
}

export function buildContinuationNudge(ctx: NudgeContext): string {
  const kind = classifyResumeKind(ctx.reason, ctx.failureNote);
  const lines: string[] = [
    `[RESUME — attempt ${ctx.attempt}]`,
    `Your previous run on this task was interrupted: ${reasonLine(kind, ctx)}.`,
    `Everything above this message is YOUR OWN prior work — do NOT redo completed steps and do NOT re-read files whose content is already visible above.`,
    specificLine(kind, ctx),
    `The workspace may have changed while you were stopped (the orchestrator kept working). Before modifying any file, re-check its CURRENT content with a cheap read.`,
  ];
  if (ctx.guidance && ctx.guidance.trim()) {
    lines.push(`Orchestrator guidance: ${ctx.guidance.trim()}`);
  }
  lines.push(
    `Continue from where you stopped and finish the task. End with your final summary` +
    (ctx.isImplement ? ' and your <result> block.' : '.'),
  );
  return lines.join('\n');
}
