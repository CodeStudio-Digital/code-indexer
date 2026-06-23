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
import { doomLoopThreshold, DOOM_LOOP_FUZZY_THRESHOLD, doomLoopFuzzyTolerance } from '../constants.js';

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
  /**
   * Optional gate for the FUZZY (name-only) check. The fuzzy guard fires on
   * "same tool name N-of-M turns regardless of args" — a LOOP for session
   * state churn but NORMAL for productive work (reading/editing/searching
   * DIFFERENT files 6× is exploration, not a loop — and gpt-5.5 emits 1 tool/
   * turn, so 6 reads = 6 turns). When provided, only blocks whose name passes
   * contribute to the fuzzy signature; non-eligible tool-turns push a blank
   * (so they advance the window but never match). STRICT (full-args) is
   * unaffected — it's precise and safe for high-frequency tools.
   */
  fuzzyEligible?: (name: string) => boolean;
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
  // Fuzzy only watches eligible tools (default: all). A turn made up purely of
  // non-eligible tools (reads/edits/search) yields an empty fuzzy signature —
  // it advances the window as a blank but can't accumulate a fuzzy match.
  const fuzzyBlocks = args.fuzzyEligible
    ? args.blocks.filter((b) => args.fuzzyEligible!(b.name))
    : args.blocks;
  const fuzzySig = toolNamesSignature(fuzzyBlocks);

  // No tool calls this turn — strict resets (a pure-text turn breaks a
  // strict identical-signature chain), but fuzzy is PRESERVED.
  //
  // PR 5 — write_stdin loop on session 798 had 5-8s of provider-chat
  // (occasionally a no-tool turn) between failures. The legacy reset
  // wiped fuzzy on every such turn, so the 13-failure chain never
  // accumulated 6 consecutive fuzzy hits. Preserving fuzzy across
  // intercalated reasoning turns closes that gap — combined with the
  // tolerance window below, fuzzy now fires on patterns that interleave
  // reasoning between tool retries.
  if (!strictSig && !fuzzySig) {
    args.state.strict.length = 0;
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

  // Fuzzy: tolerance-window count. The old check required ALL last
  // `DOOM_LOOP_FUZZY_THRESHOLD` signatures to equal `fuzzySig`. The
  // new check fires when at least `THRESHOLD - TOLERANCE` of the last
  // `THRESHOLD` signatures match — covering loops with intercalated
  // sigs from short reasoning detours. Tolerance defaults to
  // `floor(THRESHOLD / 3)` (2 for the default threshold of 6); env
  // override `CODER_DOOM_LOOP_FUZZY_TOLERANCE`.
  if (
    DOOM_LOOP_FUZZY_THRESHOLD >= 2 &&
    fuzzySig &&
    args.state.fuzzy.length >= DOOM_LOOP_FUZZY_THRESHOLD
  ) {
    const tolerance = Math.max(0, doomLoopFuzzyTolerance(DOOM_LOOP_FUZZY_THRESHOLD));
    const minMatches = Math.max(2, DOOM_LOOP_FUZZY_THRESHOLD - tolerance);
    const recent = args.state.fuzzy.slice(-DOOM_LOOP_FUZZY_THRESHOLD);
    const matches = recent.reduce((acc, s) => acc + (s === fuzzySig ? 1 : 0), 0);
    if (matches >= minMatches) {
      return {
        fired: true,
        guard: 'doom-loop-fuzzy',
        count: matches,
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
