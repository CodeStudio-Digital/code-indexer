/**
 * Per-task budget resolution for the `execute_tasks` orchestrator.
 *
 * Today (PR-A) this only resolves per-`kind` defaults and applies the
 * `estimated_complexity` multiplier — fixing Bug C where the field was
 * gravado pelo submit_tasks but read by nobody. PR-E grows this file
 * with a real token/$ tracker + ask_user interactive gate.
 *
 * Defaults are HARD safety-net caps (a runaway investigate once burned 247
 * tool calls / 47 min). Hitting a cap is benign: the run ends as a partial
 * `tool_budget`/`time_budget` result with a salvage summary. Liveness is
 * still enforced separately by stall/provider/loop/cancellation guards.
 *
 * Resolution per axis: admin per-profile override (DB, via `override` param)
 * > env > per-kind default; explicit `0` at any layer = unlimited. Env:
 *
 *   CODER_TASK_<KIND>_MAX_TOOLS / CODER_TASK_<KIND>_TIMEOUT_MS
 *   CODER_TASK_STALL_MS (shared across kinds — single threshold)
 *
 * The complexity multiplier (`small`=0.5x, `medium`=1x, `large`=2x) applies
 * only to positive limits. Zero remains unlimited at every complexity.
 */
import type { CoderTask, TaskKind } from '@mcp/code-agent/sessions/types.js';
import type { TaskLimit } from './task-run-types.js';
import { taskKind } from './task-run-types.js';

// ─── Per-kind defaults ──────────────────────────────────────────

export const DEFAULT_LIMITS: Record<TaskKind, { maxToolCalls: number; timeoutMs: number }> = {
  investigate: { maxToolCalls: 80, timeoutMs: 840_000 },
  implement: { maxToolCalls: 150, timeoutMs: 1_800_000 },
  verify: { maxToolCalls: 80, timeoutMs: 900_000 },
};

// ─── Complexity multipliers (Bug C) ─────────────────────────────

const COMPLEXITY_MULTIPLIER: Record<NonNullable<CoderTask['estimated_complexity']>, number> = {
  small: 0.5,
  medium: 1,
  large: 2,
};

/**
 * Apply the `estimated_complexity` multiplier to a baseline `TaskLimit`.
 *
 * - `small`  → 0.5x positive maxToolCalls + positive timeoutMs (e.g. rename, one-line tweak)
 * - `medium` → 1x (defaults; declared baseline)
 * - `large`  → 2x positive limits (multi-file refactor, end-to-end feature)
 *
 * `stallMs` is NOT scaled — a single stall threshold is correct
 * regardless of total work (a paused subagent is a paused subagent).
 *
 * Missing complexity returns the base unchanged (treated as `medium`).
 */
export function applyComplexityToLimits(
  complexity: CoderTask['estimated_complexity'] | undefined,
  base: TaskLimit,
): TaskLimit {
  if (!complexity) return base;
  const multiplier = COMPLEXITY_MULTIPLIER[complexity];
  if (multiplier === 1 || multiplier == null) return base;
  return {
    ...base,
    ...(base.maxToolCalls != null && base.maxToolCalls > 0
      ? { maxToolCalls: Math.max(1, Math.floor(base.maxToolCalls * multiplier)) }
      : {}),
    ...(base.timeoutMs != null && base.timeoutMs > 0
      ? { timeoutMs: Math.max(1_000, Math.floor(base.timeoutMs * multiplier)) }
      : {}),
  };
}

/**
 * Compose the effective `TaskLimit` for a single task:
 *   1. start from per-kind defaults
 *   2. replace with the admin per-profile override where set (DB; explicit 0
 *      stays unlimited at every complexity)
 *   3. apply complexity multiplier
 *
 * Returned shape is wire-compatible with `SubagentLimits` — passed
 * straight through to `runSubagent` / `runParallelAgents`.
 */
export function resolveTaskLimit(
  task: CoderTask,
  override?: { maxToolCalls: number | null; timeoutMs: number | null },
): TaskLimit {
  const kind = taskKind(task);
  const defaults = DEFAULT_LIMITS[kind];
  const base: TaskLimit = {
    maxToolCalls: override?.maxToolCalls ?? defaults.maxToolCalls,
    timeoutMs: override?.timeoutMs ?? defaults.timeoutMs,
    stallMs: 120_000,
  };
  return applyComplexityToLimits(task.estimated_complexity, base);
}

// ─── Run-level token cap (PR-E) ─────────────────────────────────

/**
 * User choices for the interactive budget gate. Format matches the
 * `options[]` payload sent to the dashboard's `budget_request` event.
 */
export type BudgetDecision = 'continue+50%' | 'stop_after_current' | 'cancel_pending';

/** What the orchestrator does NEXT after the budget gate consults. */
export type BudgetVerdict = 'continue' | 'skip' | 'abort';

export interface BudgetAskCallback {
  (req: {
    spent: number;
    cap: number;
    estimated: number;
    options: ReadonlyArray<BudgetDecision>;
  }): Promise<BudgetDecision>;
}

export interface BudgetTrackerOpts {
  /** Token cap; null means unlimited (the gate becomes a no-op). */
  tokensCap: number | null;
  /** Estimated tokens charged per task BEFORE it runs. Default 5000. */
  estimatePerTask?: number;
  /** Cap-extension multiplier when the user picks 'continue+50%'. */
  continueMultiplier?: number;
}

/**
 * Tracks token spend across an execute_tasks run and gates each task
 * against the configured cap. When over budget, calls the `ask`
 * callback (provided by the orchestrator) and applies the user's
 * decision.
 *
 * State persists across the wave loop — once the user says
 * 'cancel_pending', every subsequent task is aborted without re-asking;
 * 'stop_after_current' skips every task EXCEPT the one currently in
 * flight (handled by the orchestrator's task loop).
 */
export class BudgetTracker {
  private tokensSpent = 0;
  private tokensCap: number | null;
  private readonly estimatePerTask: number;
  private readonly continueMultiplier: number;
  private cancelled = false;
  private stopAfterCurrent = false;

  constructor(opts: BudgetTrackerOpts) {
    this.tokensCap = opts.tokensCap;
    this.estimatePerTask = opts.estimatePerTask ?? 5_000;
    this.continueMultiplier = opts.continueMultiplier ?? 1.5;
  }

  /** Track real spend reported by a finished task. */
  addSpend(inputTokens: number, outputTokens: number): void {
    this.tokensSpent += (inputTokens || 0) + (outputTokens || 0);
  }

  /** Snapshot for tests / dashboards. */
  snapshot(): { spent: number; cap: number | null; cancelled: boolean; stopAfterCurrent: boolean } {
    return {
      spent: this.tokensSpent,
      cap: this.tokensCap,
      cancelled: this.cancelled,
      stopAfterCurrent: this.stopAfterCurrent,
    };
  }

  /**
   * Decide what to do BEFORE dispatching the next task.
   *
   * Returns:
   *   - 'continue' — under cap or user said keep going
   *   - 'skip'     — mark this task skipped + skip_reason='budget_cap'
   *   - 'abort'    — bail out of the entire wave loop
   */
  async checkBeforeTask(args: { ask?: BudgetAskCallback } = {}): Promise<BudgetVerdict> {
    if (this.cancelled) return 'abort';
    if (this.stopAfterCurrent) return 'skip';
    if (this.tokensCap == null) return 'continue';

    const projected = this.tokensSpent + this.estimatePerTask;
    if (projected <= this.tokensCap) return 'continue';

    if (!args.ask) {
      // No interactive ask wired (test mode / headless) — be conservative.
      // The cap is supposed to protect the user; without a way to ask, we
      // refuse to keep burning tokens.
      this.cancelled = true;
      return 'abort';
    }

    const answer = await args.ask({
      spent: this.tokensSpent,
      cap: this.tokensCap,
      estimated: this.estimatePerTask,
      options: ['continue+50%', 'stop_after_current', 'cancel_pending'],
    });

    switch (answer) {
      case 'continue+50%':
        this.tokensCap = Math.floor((this.tokensCap ?? 0) * this.continueMultiplier);
        return 'continue';
      case 'stop_after_current':
        this.stopAfterCurrent = true;
        return 'skip';
      case 'cancel_pending':
        this.cancelled = true;
        return 'abort';
      default:
        // Unknown → conservative skip.
        return 'skip';
    }
  }
}

/** Read the default token cap from env (0 / unset → unlimited). */
export function loadDefaultTokenCap(): number | null {
  return null;
}
