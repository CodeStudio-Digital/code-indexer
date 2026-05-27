/**
 * Doom-loop backstop. Tuple-hash catches per-call repeats; this guard
 * catches per-TURN repeats — the model emits the same tool-call signature
 * N turns in a row even though no individual call duplicates a prior one
 * (e.g. paginating chunk by chunk without ever reaching the answer).
 *
 * Two variants, both rolling-window:
 *   - strict — full signature (name + sorted args). Threshold = 3 turns.
 *   - fuzzy  — name-only signature. Threshold = 6 turns (higher tolerance
 *              because false-positive risk is larger).
 *
 * Both thresholds come from `runner/constants.ts` and are env-overridable
 * (`CODER_DOOM_LOOP_THRESHOLD`, `CODER_DOOM_LOOP_FUZZY_THRESHOLD`).
 */
import { toolCallsSignature, toolNamesSignature } from '../signatures.js';
import { doomLoopThreshold, DOOM_LOOP_FUZZY_THRESHOLD } from '../constants.js';

export interface DoomLoopState {
  /** Rolling window of recent strict signatures. */
  strict: string[];
  /** Rolling window of recent fuzzy (name-only) signatures. */
  fuzzy: string[];
}

export function createDoomLoopState(): DoomLoopState {
  return { strict: [], fuzzy: [] };
}

export interface CheckDoomLoopArgs {
  /** Latest assistant message's tool_use blocks. Empty array is a no-op. */
  blocks: Array<{ name: string; input: Record<string, unknown> }>;
  state: DoomLoopState;
  /** Max signatures kept in the rolling window (default 10). */
  maxWindow?: number;
}

export type DoomLoopVerdict =
  | { fired: false }
  | {
      fired: true;
      guard: 'doom-loop-strict' | 'doom-loop-fuzzy';
      count: number;
      threshold: number;
      signature: string;
    };

export function checkDoomLoop(args: CheckDoomLoopArgs): DoomLoopVerdict {
  const maxWindow = args.maxWindow ?? 10;
  const strictSig = toolCallsSignature(args.blocks);
  const fuzzySig = toolNamesSignature(args.blocks);

  // No tool calls this turn — clear the window. Pure-text turns are
  // legitimate progress, not loop fodder.
  if (!strictSig && !fuzzySig) {
    args.state.strict.length = 0;
    args.state.fuzzy.length = 0;
    return { fired: false };
  }

  args.state.strict.push(strictSig);
  args.state.fuzzy.push(fuzzySig);
  if (args.state.strict.length > maxWindow) args.state.strict.shift();
  if (args.state.fuzzy.length > maxWindow) args.state.fuzzy.shift();

  const strictThresh = doomLoopThreshold();
  if (
    strictThresh >= 2 &&
    strictSig &&
    args.state.strict.length >= strictThresh
  ) {
    const recent = args.state.strict.slice(-strictThresh);
    if (recent.every((s) => s === strictSig)) {
      return {
        fired: true,
        guard: 'doom-loop-strict',
        count: strictThresh,
        threshold: strictThresh,
        signature: strictSig,
      };
    }
  }

  if (
    DOOM_LOOP_FUZZY_THRESHOLD >= 2 &&
    fuzzySig &&
    args.state.fuzzy.length >= DOOM_LOOP_FUZZY_THRESHOLD
  ) {
    const recent = args.state.fuzzy.slice(-DOOM_LOOP_FUZZY_THRESHOLD);
    if (recent.every((s) => s === fuzzySig)) {
      return {
        fired: true,
        guard: 'doom-loop-fuzzy',
        count: DOOM_LOOP_FUZZY_THRESHOLD,
        threshold: DOOM_LOOP_FUZZY_THRESHOLD,
        signature: fuzzySig,
      };
    }
  }

  return { fired: false };
}

/** Clear the rolling-window state. Called after a Planning turn. */
export function resetDoomLoopState(state: DoomLoopState): void {
  state.strict.length = 0;
  state.fuzzy.length = 0;
}
