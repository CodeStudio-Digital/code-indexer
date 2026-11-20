/**
 * Dominance guard — the long-horizon backstop the per-turn doom-loop and the
 * per-call dedup can't see: ONE tool eating a long window of turns with ZERO
 * assistant text between them. Catches the "silently grinding read_file /
 * mcp__grep_code for 50+ turns, no progress narration" pattern (the 200–700-
 * turn runaways in telemetry) even when other tools intersperse enough to keep
 * the doom-loop fuzzy window from closing.
 *
 * Window + ratio come from fixed product constants (8 turns, 0.75). The
 * zero-text condition is deliberate: when the
 * agent narrates a turn it's reasoning, not stuck, so we stay quiet — keeps the
 * false-positive rate near zero.
 *
 * Pure + deterministic. The runner owns the env-tunables and passes them in so
 * the same window/ratio drive both the check and the dashboard banner.
 */

/** One recorded tool-turn: the representative tool + whether it carried text. */
export interface DominanceTurn {
  name: string;
  hadText: boolean;
}

export interface DominanceState {
  /** Rolling window of the last N tool-turns. */
  window: DominanceTurn[];
}

export function createDominanceState(): DominanceState {
  return { window: [] };
}

export type DominanceVerdict =
  | { fired: false }
  | { fired: true; toolName: string; count: number; window: number; ratio: number };

export interface CheckDominanceArgs {
  /**
   * This turn's representative tool name (the runner passes the first
   * non-repeatable tool). Empty string records a blank slot that can't
   * dominate — e.g. an all-polling turn.
   */
  toolName: string;
  /** True when the assistant emitted any non-empty text alongside the tools. */
  hadText: boolean;
  state: DominanceState;
  /** Window size in turns (product default 8). */
  window: number;
  /** Dominance fraction in (0,1] (product default 0.75). */
  ratio: number;
}

/**
 * Push this turn into the rolling window and report whether a single tool now
 * dominates it with zero assistant text. Fires only on a FULL window so a
 * short burst of one tool (legitimate focused work) is never flagged.
 */
export function checkDominance(args: CheckDominanceArgs): DominanceVerdict {
  args.state.window.push({ name: args.toolName, hadText: args.hadText });
  if (args.state.window.length > args.window) args.state.window.shift();

  // Need a full window before judging — focused bursts are fine.
  if (args.state.window.length < args.window) return { fired: false };

  // Any narration in the window → the agent is reasoning, not grinding.
  if (args.state.window.some((t) => t.hadText)) return { fired: false };

  // Tally non-blank tool names and find the most frequent.
  const counts = new Map<string, number>();
  for (const t of args.state.window) {
    if (!t.name) continue;
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  let topName = '';
  let topCount = 0;
  for (const [name, c] of counts) {
    if (c > topCount) {
      topName = name;
      topCount = c;
    }
  }

  const need = Math.ceil(args.ratio * args.window);
  if (topName && topCount >= need) {
    return { fired: true, toolName: topName, count: topCount, window: args.window, ratio: args.ratio };
  }
  return { fired: false };
}

/** Clear the rolling window. Called after the guard fires (mirrors doom-loop). */
export function resetDominanceState(state: DominanceState): void {
  state.window.length = 0;
}
