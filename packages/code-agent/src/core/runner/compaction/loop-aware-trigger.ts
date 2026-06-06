/**
 * Loop-aware compaction trigger (Fix B2).
 *
 * Adapts the multidimensional `computeCompactionTrigger` (in
 * `core/compaction/limits.ts`) — fully built + unit-tested but never wired
 * into the BT runner — to the Executing node's per-turn signals. It adds
 * BEHAVIORAL compaction branches on top of the prefix-aware ratio gates:
 *   - `stuck-progress` — N turns in a row with zero assistant text,
 *   - `cumulative`     — steady burn (Σ input ≥ ratio × effective window),
 *   - `polling-loop`   — lowers the threshold when a loop is flagged.
 *
 * Two things this fixes for session 887 (gpt-5.5 / 272k, 18M input tokens,
 * `compaction_triggered=0` on all 149 turns):
 *   1. it works from the tokenizer ESTIMATE when the provider omits `usage`
 *      (the ChatGPT backend), so the caller can compact without a provider
 *      token count;
 *   2. it catches loops/burn the per-turn ratio gate alone never reached.
 *
 * The primary SIZE gate stays `shouldCompact90` / `shouldCompactBodyAfterPrefix`
 * (tighter ratio than this module's token-budget branch) — the caller ORs all
 * three. Pure + deterministic; reuses the tested trigger verbatim.
 */
import {
  computeCompactionTrigger,
  deriveTokenLimits,
  COMPACT_CUMULATIVE_RATIO,
  COMPACT_POLLING_TRIGGER_RATIO,
  COMPACT_STUCK_TURN_CAP,
  type CompactionTriggerDecision,
} from '@mcp/code-agent/core/compaction/limits.js';
import { computeProtectTokens } from './threshold.js';

export interface LoopAwareCompactionInputs {
  /** Model id — resolves the effective window + trigger via `deriveTokenLimits`. */
  model: string;
  /** Best-effort current prompt size: real `usage.input_tokens` ?? tokenizer estimate. */
  snapshotTotal: number;
  /** Input tokens accrued SINCE the last compaction (caller subtracts its checkpoint). */
  cumulativeInputTokens: number;
  /** Turns in a row with zero assistant text — drives `stuck-progress`. */
  consecutiveNoTextTurns: number;
  /**
   * Optional loop flag → lowers the trigger (`polling-loop`). Defaults false:
   * in the BT, per-call/per-turn loop guards already route to Planning BEFORE
   * the compaction decision, so a loop rarely reaches here.
   */
  pollingLoopDetected?: boolean;
}

/** Behavioral reasons that are pointless when there's nothing above the protected tail. */
const BEHAVIORAL: ReadonlySet<CompactionTriggerDecision['reason']> = new Set([
  'stuck-progress',
  'cumulative',
  'polling-loop',
]);

export function evaluateLoopAwareCompaction(
  inp: LoopAwareCompactionInputs,
): CompactionTriggerDecision {
  const limits = deriveTokenLimits(inp.model);
  const decision = computeCompactionTrigger({
    snapshotTotal: inp.snapshotTotal,
    trigger: limits.trigger,
    effective: limits.effective,
    // Char path is dead here — `snapshotTotal` is always non-null so the
    // char-budget branch (guarded by `snapshotTotal == null`) never runs.
    charTotal: 0,
    charMinimum: 0,
    legacyTriggerTokens: null,
    lastKnownInputTokens: null,
    cumulativeInputTokens: inp.cumulativeInputTokens,
    pollingLoopDetected: inp.pollingLoopDetected ?? false,
    consecutiveNoTextTurns: inp.consecutiveNoTextTurns,
    cumulativeRatio: COMPACT_CUMULATIVE_RATIO,
    pollingTriggerRatio: COMPACT_POLLING_TRIGGER_RATIO,
    stuckTurnCap: COMPACT_STUCK_TURN_CAP,
  });

  // A behavioral trigger on a SMALL history would route to Compacting only to
  // find nothing above the protected tail to summarize (a wasted LLM pass).
  // Suppress it below the protect budget; the size gates still cover real bloat.
  if (decision.shouldCompact && BEHAVIORAL.has(decision.reason)) {
    const protectTokens = computeProtectTokens({ model: inp.model });
    if (inp.snapshotTotal <= protectTokens) {
      return {
        shouldCompact: false,
        reason: 'none',
        detail: `${decision.reason} suppressed: ${inp.snapshotTotal} ≤ protect ${protectTokens}`,
      };
    }
  }
  return decision;
}
