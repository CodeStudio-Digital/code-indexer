/**
 * Per-turn loop backstops evaluated by the Executing node AFTER dispatch:
 *
 *   - dominance  — one tool eats a long window of turns with ZERO assistant
 *     text. Catches the silent-grind runaway (the 200–700-turn sessions in
 *     telemetry) when other tools intersperse enough to keep doom-loop quiet.
 *
 * Both windows are fed every tool-turn. The node acts on the returned verdict
 * only when the per-call guards (tuple-hash / failure-streak) didn't already
 * flag a loop — they're more specific, so they win.
 *
 * Pollable tools resolved from ToolMetadata are filtered out first: a string
 * of identical polls can be the legitimate workflow, so result-aware
 * polling-stuck owns them. Volatile calls remain under these backstops.
 */
import { checkDominance, resetDominanceState, type DominanceState } from '../guards/dominance.js';
import { resolveToolInvocationMetadata } from '../../tool-classification.js';
import type { CoderTool } from '../../tool.js';
import { dominanceWindow, dominanceRatio } from '../constants.js';

export interface PerTurnLoopVerdict {
  /** Guard kind for the `ToolLoopDetected` BehaviorEvent. */
  guard: 'dominance';
  /** Finer kind for the dashboard `tool_loop_intervention` banner. */
  interventionKind: 'dominance';
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
  /** This call resolves to repeatPolicy=pollable (per invocation, see invocationIsPollable). */
  isRepeatable: (toolUse: { name: string; input: Record<string, unknown> }) => boolean;
  dominance: DominanceState;
}

/**
 * Feed this turn into both rolling windows and return the first guard that
 * fired, or null. The product guard is always enabled and uses one fixed,
 * telemetry-proven posture.
 */
/** Per-invocation pollable check: an empty write_stdin is a poll, a write is not. */
export function invocationIsPollable(
  registry: { get(name: string): CoderTool | undefined | null },
  toolUse: { name: string; input: unknown },
): boolean {
  const tool = registry.get(toolUse.name);
  return !!tool && resolveToolInvocationMetadata(tool, toolUse.input).repeatPolicy === 'pollable';
}

export function evaluatePerTurnLoops(args: PerTurnLoopArgs): PerTurnLoopVerdict | null {
  const blocks = args.toolUses.filter(
    (t) => !args.isRepeatable(t),
  );

  const window = dominanceWindow();
  const ratio = dominanceRatio();
  const dom = checkDominance({
    toolName: blocks[0]?.name ?? '',
    hadText: args.hadText,
    state: args.dominance,
    window,
    ratio,
  });
  if (!dom.fired) return null;

  // Snapshot AFTER both checks have pushed this turn (so the dashboard sees the
  // windows that triggered), THEN reset both.
  const full: PerTurnLoopVerdict = {
    guard: 'dominance',
    interventionKind: 'dominance',
    toolName: dom.toolName,
    count: dom.count,
    threshold: Math.ceil(ratio * window),
    window,
    reason:
      `Tool '${dom.toolName}' dominated ${dom.count}/${window} turns with ` +
      `zero assistant text; recorded for diagnostics.`,
    snapshot: {
      strict: [],
      fuzzy: [],
      dominance: args.dominance.window.slice(),
    },
  };
  resetDominanceState(args.dominance);
  return full;
}
