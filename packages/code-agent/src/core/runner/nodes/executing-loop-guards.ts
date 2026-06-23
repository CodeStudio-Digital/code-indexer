/**
 * Per-turn loop backstops evaluated by the Executing node AFTER dispatch:
 *
 *   - doom-loop  — the same tool-call signature recurs across turns (strict
 *     full-sig / fuzzy name-only). Catches rotating-args and once-per-turn
 *     repeats that the per-call tuple-hash / dup-call guards can't see.
 *   - dominance  — one tool eats a long window of turns with ZERO assistant
 *     text. Catches the silent-grind runaway (the 200–700-turn sessions in
 *     telemetry) when other tools intersperse enough to keep doom-loop quiet.
 *
 * Both windows are fed every tool-turn. The node acts on the returned verdict
 * only when the per-call guards (tuple-hash / failure-streak) didn't already
 * flag a loop — they're more specific, so they win.
 *
 * Polling / `repeatable` tools (wait_for_*, list_*, *_status, or a CoderTool
 * flagged `repeatable`) are filtered out first: a string of identical polls is
 * the legitimate workflow, not a loop (mirrors the dup-call / failure-streak
 * exemptions), so a master polling `list_subordinates` is never derailed.
 */
import { checkDoomLoop, resetDoomLoopState, type DoomLoopState } from '../guards/doom-loop.js';
import { checkDominance, resetDominanceState, type DominanceState } from '../guards/dominance.js';
import {
  REPEATABLE_NAME_PATTERN,
  doomLoopThreshold,
  DOOM_LOOP_FUZZY_THRESHOLD,
  FUZZY_LOOP_TOOLS,
  dominanceWindow,
  dominanceRatio,
} from '../constants.js';

export interface PerTurnLoopVerdict {
  /** Guard kind for the `ToolLoopDetected` BehaviorEvent. */
  guard: 'doom-loop' | 'dominance';
  /** Finer kind for the dashboard `tool_loop_intervention` banner. */
  interventionKind: 'doom-loop-strict' | 'doom-loop-fuzzy' | 'dominance';
  toolName: string;
  count: number;
  threshold: number;
  window: number;
  snapshot: {
    strict: string[];
    fuzzy: string[];
    dominance: Array<{ name: string; hadText: boolean }>;
  };
  reason: string;
}

export interface PerTurnLoopArgs {
  toolUses: ReadonlyArray<{ name: string; input: Record<string, unknown> }>;
  /** True when the assistant emitted any non-empty text this turn. */
  hadText: boolean;
  /** Names of tools flagged `repeatable` in the registry (polling primitives). */
  repeatableNames: ReadonlySet<string>;
  doom: DoomLoopState;
  dominance: DominanceState;
}

/**
 * Feed this turn into both rolling windows and return the first guard that
 * fired (doom-loop has priority), or null. Both checks run every turn so each
 * window stays honest; on a fire BOTH windows reset so the next accumulation
 * starts clean (no Executing↔Planning oscillation, still re-fires if the model
 * keeps looping). Honors `CODER_DOOM_LOOP=0` / `CODER_DOMINANCE=0`.
 */
export function evaluatePerTurnLoops(args: PerTurnLoopArgs): PerTurnLoopVerdict | null {
  const blocks = args.toolUses.filter(
    (t) => !REPEATABLE_NAME_PATTERN.test(t.name) && !args.repeatableNames.has(t.name),
  );

  let verdict: Omit<PerTurnLoopVerdict, 'snapshot'> | null = null;

  // ── Doom-loop (per-turn signature repeat) ──
  if (process.env.CODER_DOOM_LOOP !== '0') {
    // The window must HOLD at least `threshold` signatures or the guard can
    // never fire — a silent footgun when env cranks the thresholds above the
    // default 10-entry window. Size it to the larger configured threshold so a
    // misconfigured cap degrades to "fires late", not "never fires".
    const maxWindow = Math.max(10, doomLoopThreshold(), DOOM_LOOP_FUZZY_THRESHOLD);
    // Fuzzy (name-only) only watches state-churn tools; reads/edits/search/exec
    // are exempt so legitimate high-frequency work isn't flagged. Strict (below,
    // inside checkDoomLoop) stays on for ALL tools — it's precise (identical args).
    const d = checkDoomLoop({
      blocks,
      state: args.doom,
      maxWindow,
      fuzzyEligible: (name) => FUZZY_LOOP_TOOLS.has(name),
    });
    if (d.fired) {
      verdict = {
        guard: 'doom-loop',
        interventionKind: d.guard,
        toolName: blocks.map((b) => b.name).join(','),
        count: d.count,
        threshold: d.threshold,
        window: maxWindow,
        reason:
          `Same tool signature repeated ${d.count}× across turns (${d.guard}) ` +
          `— forcing a planning turn to break the loop.`,
      };
    }
  }

  // ── Dominance (long-horizon single-tool grind, zero text) ──
  // Accumulate every turn even when doom already fired so the window stays
  // honest; only ACT when doom didn't fire (doom is the more immediate signal).
  if (process.env.CODER_DOMINANCE !== '0') {
    const window = dominanceWindow();
    const ratio = dominanceRatio();
    const dom = checkDominance({
      toolName: blocks[0]?.name ?? '',
      hadText: args.hadText,
      state: args.dominance,
      window,
      ratio,
    });
    if (!verdict && dom.fired) {
      verdict = {
        guard: 'dominance',
        interventionKind: 'dominance',
        toolName: dom.toolName,
        count: dom.count,
        threshold: Math.ceil(ratio * window),
        window,
        reason:
          `Tool '${dom.toolName}' dominated ${dom.count}/${window} turns with ` +
          `zero assistant text — forcing a planning turn to break the grind.`,
      };
    }
  }

  if (!verdict) return null;

  // Snapshot AFTER both checks have pushed this turn (so the dashboard sees the
  // windows that triggered), THEN reset both.
  const full: PerTurnLoopVerdict = {
    ...verdict,
    snapshot: {
      strict: args.doom.strict.slice(),
      fuzzy: args.doom.fuzzy.slice(),
      dominance: args.dominance.window.slice(),
    },
  };
  resetDoomLoopState(args.doom);
  resetDominanceState(args.dominance);
  return full;
}
