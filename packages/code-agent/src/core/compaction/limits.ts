import { getEffectiveContextWindow } from '@mcp/code-agent/providers/capabilities.js';

/** chars-per-token heuristic, matching token-budget.ts. */
const CHARS_PER_TOKEN = 4;

// Reasoning (mirrors Claude Code's autoCompact constants):
//   AUTOCOMPACT_BUFFER_TOKENS — reserve 13K (default 50K) tokens of headroom
//     below the effective window before triggering compaction. The model needs
//     room to run at least one more tool-emitting turn while summarising.
//   PROTECT_TOKEN_RATIO — keep ~55% of effective window as verbatim tail.
// Both are env-overridable for field tuning without a release.
/** @deprecated Fixed buffer goes negative on short windows — use
 *  `autocompactBufferTokens(effective)`; kept for the legacy char path. */
export const AUTOCOMPACT_BUFFER_TOKENS = 20_000;
export const PROTECT_TOKEN_RATIO = 0.55;

/**
 * Ratio of the effective window at which compaction fires — the single knob
 * that drives the post-turn size gate (`shouldCompact90`), the body-after-
 * prefix gate (ratio − 0.05) and the token-budget backstop below.
 *
 * History: 0.90 → 0.75 → 0.70 (Frente B / Fix B — session-887 coherence
 * degradation) → back to 0.90 by operator decision: the early trigger wasted
 * ~30% of the window, and continuity across summaries is now carried by the
 * durable session-state / project-memory injection instead of a longer tail.
 * Fixed product value; no env var overrides it.
 */
export const DEFAULT_COMPACT_TRIGGER_RATIO = 0.90;

/** The fixed trigger ratio — the single knob of every compaction gate. */
export function resolveTriggerRatio(): number {
  return DEFAULT_COMPACT_TRIGGER_RATIO;
}

/**
 * Headroom (tokens) reserved below the effective window before the
 * token-budget backstop fires. Proportional to the configured trigger ratio
 * so the backstop lands AT the ratio — never before the primary gate — and
 * capped at 50K for huge windows. The previous fixed 50K went NEGATIVE on a
 * 32k window (trigger=1 → compaction attempted every turn until the no-op
 * breaker silenced it). No env var overrides it.
 */
export function autocompactBufferTokens(effective: number): number {
  const slack = Math.floor(effective * (1 - resolveTriggerRatio()));
  return Math.min(AUTOCOMPACT_BUFFER_TOKENS, Math.max(1_000, slack));
}

// Phase D multidimensional triggers — see CompactionTriggerInputs.
export const COMPACT_CUMULATIVE_RATIO = 10;
export const COMPACT_POLLING_TRIGGER_RATIO = 0.5;
export const COMPACT_STUCK_TURN_CAP = 8;

/**
 * Pure inputs for the trigger decision. Pass `null` for branches that don't
 * apply (e.g., `snapshotTotal: null` when on the legacy char path).
 */
export interface CompactionTriggerInputs {
  /** Token-mode primary path (null when legacy / no model). */
  snapshotTotal: number | null;
  trigger: number | null;
  effective: number | null;
  /** Legacy char-mode fallback. */
  charTotal: number;
  charMinimum: number;
  legacyTriggerTokens: number | null;
  lastKnownInputTokens: number | null;
  /** Phase D inputs. */
  cumulativeInputTokens: number;
  pollingLoopDetected: boolean;
  consecutiveNoTextTurns: number;
  /** Tunables (callable passes these so tests can override). */
  cumulativeRatio: number;
  pollingTriggerRatio: number;
  stuckTurnCap: number;
}

export interface CompactionTriggerDecision {
  shouldCompact: boolean;
  reason:
    | 'token-budget'
    | 'char-budget'
    | 'cumulative'
    | 'polling-loop'
    | 'stuck-progress'
    | 'none';
  detail: string;
}

/**
 * Multidimensional compaction trigger. Pure function — deterministic given
 * the same inputs, no side effects.
 *
 * Evaluation order (first matching branch wins):
 *   1. polling-aware (lowest threshold — fires earliest in loops)
 *   2. stuck-progress (independent of token count — catches no-reasoning)
 *   3. cumulative (independent of per-turn — catches steady burn)
 *   4. primary token-budget (existing behaviour)
 *   5. legacy char-budget (existing fallback)
 */
export function computeCompactionTrigger(inp: CompactionTriggerInputs): CompactionTriggerDecision {
  const refTrigger =
    inp.trigger != null
      ? inp.trigger
      : inp.legacyTriggerTokens != null
        ? inp.legacyTriggerTokens
        : Math.floor(inp.charMinimum / CHARS_PER_TOKEN);
  const refEffective =
    inp.effective != null
      ? inp.effective
      : refTrigger > 0 ? refTrigger + AUTOCOMPACT_BUFFER_TOKENS : null;

  // 1. polling-aware
  if (inp.pollingLoopDetected && inp.snapshotTotal != null && refTrigger > 0) {
    const loweredTrigger = Math.floor(refTrigger * inp.pollingTriggerRatio);
    if (inp.snapshotTotal >= loweredTrigger) {
      return {
        shouldCompact: true,
        reason: 'polling-loop',
        detail: `polling loop detected; tokens=${inp.snapshotTotal} ≥ ${loweredTrigger} (lowered from ${refTrigger} via ratio ${inp.pollingTriggerRatio})`,
      };
    }
  }

  // 2. stuck-progress
  if (inp.stuckTurnCap > 0 && inp.consecutiveNoTextTurns >= inp.stuckTurnCap) {
    return {
      shouldCompact: true,
      reason: 'stuck-progress',
      detail: `${inp.consecutiveNoTextTurns} consecutive turns with zero assistant text (cap ${inp.stuckTurnCap})`,
    };
  }

  // 3. cumulative
  if (inp.cumulativeRatio > 0 && refEffective != null && refEffective > 0) {
    const cumulativeThreshold = refEffective * inp.cumulativeRatio;
    if (inp.cumulativeInputTokens >= cumulativeThreshold) {
      return {
        shouldCompact: true,
        reason: 'cumulative',
        detail: `cumulative input tokens ${inp.cumulativeInputTokens} ≥ ${cumulativeThreshold} (${inp.cumulativeRatio}× effective window ${refEffective})`,
      };
    }
  }

  // 4. primary token-budget
  if (inp.snapshotTotal != null && inp.trigger != null) {
    if (inp.snapshotTotal >= inp.trigger) {
      return {
        shouldCompact: true,
        reason: 'token-budget',
        detail: `tokens=${inp.snapshotTotal} ≥ trigger ${inp.trigger}`,
      };
    }
  }

  // 5. legacy char-budget
  if (inp.snapshotTotal == null) {
    const fired =
      inp.legacyTriggerTokens != null && inp.lastKnownInputTokens != null
        ? inp.lastKnownInputTokens >= inp.legacyTriggerTokens
        : inp.charTotal > inp.charMinimum;
    if (fired) {
      return {
        shouldCompact: true,
        reason: 'char-budget',
        detail: inp.lastKnownInputTokens != null
          ? `legacy tokens=${inp.lastKnownInputTokens} ≥ ${inp.legacyTriggerTokens}`
          : `legacy chars=${inp.charTotal} > minimum ${inp.charMinimum}`,
      };
    }
  }

  return { shouldCompact: false, reason: 'none', detail: '' };
}

export interface TokenLimits {
  effective: number;
  trigger: number;
  protect: number;
  rawWindow: number;
  isFallback: boolean;
}

/**
 * Token-based compaction limits derived from the effective window.
 *   effective = window − min(max_output, 20K)
 *   trigger   = effective − autocompactBufferTokens(effective)
 *               (≈ resolveTriggerRatio()×effective; 50K-capped on huge windows)
 *   protect   = floor(effective * PROTECT_TOKEN_RATIO)
 */
export function deriveTokenLimits(model: string, contextWindow?: number | null): TokenLimits {
  const resolved = getEffectiveContextWindow(model);
  const eff = contextWindow != null && Number.isFinite(contextWindow) && contextWindow > 0
    ? {
        ...resolved,
        window: Math.floor(contextWindow),
        effective: Math.max(1, Math.floor(contextWindow) - resolved.reservedOutput),
        isFallback: false,
      }
    : resolved;
  return {
    effective: eff.effective,
    trigger: Math.max(1, eff.effective - autocompactBufferTokens(eff.effective)),
    protect: Math.max(1, Math.floor(eff.effective * PROTECT_TOKEN_RATIO)),
    rawWindow: eff.window,
    isFallback: eff.isFallback,
  };
}
