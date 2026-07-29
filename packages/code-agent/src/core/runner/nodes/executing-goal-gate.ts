/**
 * Compatibility surface for the former runtime-owned goal lifecycle gate.
 *
 * Goals are durable state and telemetry, not execution authority. Tool calls
 * and clean finishes must therefore never be refused because a goal is
 * missing, belongs to an earlier objective, remains in progress, or has weak
 * verification evidence. The goal tool handlers still own schema,
 * transition, attribution, and persistence integrity.
 */
import type { RunContext } from '../machine/types.js';

export type GoalLifecyclePhase = 'missing' | 'in_progress' | 'unavailable';

export type GoalLifecycleFinishDecision =
  | {
      kind: 'nudge';
      phase: GoalLifecyclePhase;
      text: string;
    }
  | {
      kind: 'violation';
      phase: GoalLifecyclePhase;
      message: string;
    };

export interface GoalLifecycleGateOptions {
  maxNudgesPerPhase?: number;
  /** Exact post-filter tool surface offered to the model on this turn. */
  effectiveToolNames?: ReadonlySet<string>;
}

/**
 * Goal state cannot authorize unrelated capabilities. Kept as a no-op so
 * direct and nested dispatch paths retain one stable callback contract.
 */
export function goalLifecycleRefusalBeforeTool(
  _ctx: RunContext,
  _toolName: string,
  _toolInput: unknown,
  _options: Pick<GoalLifecycleGateOptions, 'effectiveToolNames'> = {},
): string | null {
  return null;
}

/**
 * A text response is allowed to finish regardless of goal state. Incomplete
 * or absent goals remain observable session state; they are not run failures.
 */
export function evaluateGoalLifecycleAtFinish(
  _ctx: RunContext,
  _options: GoalLifecycleGateOptions = {},
): GoalLifecycleFinishDecision | null {
  return null;
}
