import type { TokenSnapshot } from '@mcp/code-agent/core/token-accounting.js';
import { getEffectiveContextWindow } from '@mcp/code-agent/providers/capabilities.js';

/**
 * Below this char total, auto-compaction is a no-op. Default 60k — fallback
 * for models without a known context_window. Use `deriveCompactionLimits()`
 * to get model-aware thresholds when context_window is available.
 *
 * @deprecated Char-based thresholds are retained only for the legacy code
 * path (CODER_NEW_COMPACTION=0). New path uses token-based limits derived
 * from the model's effective context window. Will be removed.
 */
export const PRUNE_MINIMUM = Number(process.env.CODER_PRUNE_MINIMUM ?? 60_000);

/**
 * How many chars of the most-recent history are guaranteed to survive
 * compaction verbatim when using the fixed fallback.
 *
 * @deprecated See `PRUNE_MINIMUM`.
 */
export const PRUNE_PROTECT = Number(process.env.CODER_PRUNE_PROTECT ?? 80_000);

/** Fraction of context window (in chars) at which compaction triggers. */
const TRIGGER_RATIO = 0.90;
/** Fraction of context window (in chars) kept verbatim after compaction. */
const PROTECT_RATIO = 0.55;
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
export const AUTOCOMPACT_BUFFER_TOKENS = Number(process.env.CODER_AUTOCOMPACT_BUFFER ?? 50_000);
export const PROTECT_TOKEN_RATIO = Number(process.env.CODER_PROTECT_RATIO ?? 0.55);

/**
 * Ratio of the effective window at which compaction fires — the single knob
 * that drives the post-turn size gate (`shouldCompact90`), the body-after-
 * prefix gate (ratio − 0.05) and the token-budget backstop below.
 *
 * History: 0.90 → 0.75 → 0.70 (Frente B / Fix B — session-887 coherence
 * degradation) → back to 0.90 by operator decision: the early trigger wasted
 * ~30% of the window, and continuity across summaries is now carried by the
 * durable session-state / project-memory injection instead of a longer tail.
 * Reversible at runtime via `CODER_COMPACT_TRIGGER_RATIO`.
 */
export const DEFAULT_COMPACT_TRIGGER_RATIO = 0.90;

/** Env-resolved trigger ratio, clamped so a typo can't disable compaction. */
export function resolveTriggerRatio(): number {
  const raw = process.env.CODER_COMPACT_TRIGGER_RATIO;
  if (!raw) return DEFAULT_COMPACT_TRIGGER_RATIO;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_COMPACT_TRIGGER_RATIO;
  return Math.min(0.95, Math.max(0.5, n));
}

/**
 * Headroom (tokens) reserved below the effective window before the
 * token-budget backstop fires. Proportional to the configured trigger ratio
 * so the backstop lands AT the ratio — never before the primary gate — and
 * capped at 50K for huge windows. The previous fixed 50K went NEGATIVE on a
 * 32k window (trigger=1 → compaction attempted every turn until the no-op
 * breaker silenced it). `CODER_AUTOCOMPACT_BUFFER` still wins when set.
 */
export function autocompactBufferTokens(effective: number): number {
  const env = process.env.CODER_AUTOCOMPACT_BUFFER;
  if (env != null && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const slack = Math.floor(effective * (1 - resolveTriggerRatio()));
  return Math.min(50_000, Math.max(1_000, slack));
}

// Phase D multidimensional triggers — see CompactionTriggerInputs.
export const COMPACT_CUMULATIVE_RATIO = Number(process.env.CODER_COMPACT_CUMULATIVE_RATIO ?? 10);
export const COMPACT_POLLING_TRIGGER_RATIO = Number(process.env.CODER_COMPACT_POLLING_TRIGGER_RATIO ?? 0.5);
export const COMPACT_STUCK_TURN_CAP = Number(process.env.CODER_COMPACT_STUCK_TURN_CAP ?? 8);

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

/** Feature flag — set to 0 to fall back to the legacy char-based path. */
export function isNewCompactionEnabled(): boolean {
  return process.env.CODER_NEW_COMPACTION !== '0';
}

export interface CompactionLimits {
  minimum: number;
  protect: number;
  triggerTokens: number | null;
  protectTokens: number | null;
}

/**
 * Derive context-aware compaction limits from the model's known context window.
 * When `contextWindowTokens` is null/undefined, falls back to env defaults so
 * behaviour is unchanged for models without registered capacity.
 *
 * Prefer `deriveTokenLimits(model)` (which incorporates output reservation)
 * when the model id is available.
 */
export function deriveCompactionLimits(contextWindowTokens: number | null | undefined): CompactionLimits {
  if (!contextWindowTokens) {
    return { minimum: PRUNE_MINIMUM, protect: PRUNE_PROTECT, triggerTokens: null, protectTokens: null };
  }
  const contextChars = contextWindowTokens * CHARS_PER_TOKEN;
  return {
    minimum: Math.floor(contextChars * TRIGGER_RATIO),
    protect: Math.floor(contextChars * PROTECT_RATIO),
    triggerTokens: Math.floor(contextWindowTokens * TRIGGER_RATIO),
    protectTokens: Math.floor(contextWindowTokens * PROTECT_TOKEN_RATIO),
  };
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

/** Should we compact? `total` is the snapshot total (confirmed + estimate). */
export function shouldCompact(snapshot: TokenSnapshot, model: string, contextWindow?: number | null): boolean {
  const limits = deriveTokenLimits(model, contextWindow);
  return snapshot.total >= limits.trigger;
}
