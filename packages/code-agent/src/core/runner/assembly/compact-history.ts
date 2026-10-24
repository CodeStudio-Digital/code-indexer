import type { AgentMessage } from '../../messages.js';
import { envTunables, type CoderTunables } from '../../tunables.js';
import { applyRollingReduction } from '../../compaction.js';
import { repairToolPairing } from '../../transcript-repair.js';
import { approxChars } from '../pure-helpers.js';
/**
 * Per-turn history transformer applied right before the request hits the
 * provider. Two-layer strategy:
 *
 *   1. Push-time truncation (already done at block creation) keeps the
 *      PER-BLOCK size bounded, which is enough for 99% of sessions.
 *
 *   2. Auto-compaction (delegated to core/compaction.ts) kicks in ONLY when
 *      the accumulated total still exceeds PRUNE_MINIMUM, at which point
 *      older tool_result contents get swapped for deterministic markers
 *      until the protected tail fits under PRUNE_PROTECT.
 *
 * The compaction is a pure transformation — the persistent history on disk
 * stays intact — and uses a deterministic cutoff so repeated calls on the
 * same prefix produce byte-identical output. That keeps prompt-prefix caches
 * hot across turns even after compaction has fired.
 */
export function compactHistoryForLLM(
  messages: AgentMessage[],
  limits?: { minimum: number; protect: number },
  /**
   * Optional tunables snapshot. When omitted, defaults to `envTunables()` —
   * env-driven behavior identical to the legacy module-level constants.
   * Runner instances pass `this.tunables` so per-session/per-tier overrides
   * flow through to the turn-budget warning threshold.
   */
  tunables?: CoderTunables,
  /** Per-turn reducer stats observer (telemetry — mig 143). */
  onReducerStats?: (s: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number }) => void,
): AgentMessage[] {
  const effectiveTunables = tunables ?? envTunables();
  // Camada 5 — rolling reduction runs FIRST and is cheap (linear scan,
  // pure function, deterministic). It retires stale repeated reads/searches
  // before the size-based compaction even sees them, so sessions grow
  // sublinearly. Disabled via CODER_ROLLING_REDUCER=0 for diagnostics.
  // DEFAULT: defer-all. In-place rewrites bust the provider prompt-cache
  // from that point on, and telemetry showed a mid-run flush trading ~2k
  // freed chars for a ~70k-token uncached re-prefill. So the per-turn view
  // only DETECTS retirements; they are APPLIED durably by the Compacting
  // node, the one pass that rewrites the prefix anyway. The 32 KiB tranche is
  // now the product invariant; the legacy immediate/defer-all switches were
  // removed after the cache-preservation behavior became authoritative.
  let working = messages;
  const rolled = applyRollingReduction(messages, { flushThresholdChars: 32_768 });
  onReducerStats?.({
    retired: rolled.reduced,
    freedChars: rolled.freedChars,
    pendingRetired: rolled.pendingRetired,
    pendingChars: rolled.pendingChars,
  });
  if (rolled.reduced > 0) {
    console.log(
      `[coder] rolling reducer retired ${rolled.reduced} stale tool_result(s) ` +
        `(~${rolled.freedChars} chars freed, ${rolled.pendingRetired} pending below flush threshold)`,
    );
    working = rolled.messages;
  }
  // Frente B (PR 2 da reavaliação) — char-based `compactMessages` foi
  // REMOVIDO. A compactação destrutiva agora é feita exclusivamente pelo
  // LLM compactor no nó `Compacting` (que dispara em ~75% do effective
  // context window). Aqui ficamos só com a `applyRollingReduction` acima
  // (Camada 5) e a sanitização de tool_use/tool_result orfãos abaixo.
  // O parâmetro `limits` agora é ignorado — assinatura mantida só por
  // compat de chamadores.
  void limits;
  const result = { messages: working, applied: false, prunedBlocks: 0, prunedChars: 0 };
  const total = approxChars(result.messages);
  if (total > effectiveTunables.turnBudgetChars) {
    console.warn(
      `[coder] turn payload ${total} chars exceeds budget ${effectiveTunables.turnBudgetChars}. ` +
      `Lower CODER_PUSH_TIME_CAP or increase CODER_TURN_BUDGET_CHARS.`,
    );
  }

  // Safety nets (orphan tool_result removal → synthetic tool_result
  // injection for orphaned tool_use → consecutive same-role merge) live in
  // `repairToolPairing` — extracted verbatim to core/transcript-repair.ts so
  // the subagent resume path sanitizes captured transcripts with the exact
  // same logic. One implementation, two call sites.
  return repairToolPairing(result.messages);
}
