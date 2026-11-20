import type { AgentMessage } from '../../messages.js';
import { applyRollingReduction } from '../../compaction.js';
import { repairToolPairing } from '../../transcript-repair.js';
/**
 * Per-turn history transformer applied right before the request hits the
 * provider. Push-time truncation already bounds each block; this view only
 * detects rolling-reduction retirements (applied durably by the Compacting
 * node) and repairs tool_use/tool_result pairing. Destructive compaction is
 * the LLM compactor's job. The transformation is pure and deterministic, so
 * repeated calls on the same prefix keep prompt-prefix caches hot.
 */
export function compactHistoryForLLM(
  messages: AgentMessage[],
  /** Per-turn reducer stats observer (telemetry — mig 143). */
  onReducerStats?: (s: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number }) => void,
): AgentMessage[] {
  // Camada 5 — rolling reduction runs FIRST and is cheap (linear scan,
  // pure function, deterministic). It retires stale repeated reads/searches
  // before the size-based compaction even sees them, so sessions grow
  // sublinearly. Always on (no env switch).
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
  const result = { messages: working, applied: false, prunedBlocks: 0, prunedChars: 0 };

  // Safety nets (orphan tool_result removal → synthetic tool_result
  // injection for orphaned tool_use → consecutive same-role merge) live in
  // `repairToolPairing` — extracted verbatim to core/transcript-repair.ts so
  // the subagent resume path sanitizes captured transcripts with the exact
  // same logic. One implementation, two call sites.
  return repairToolPairing(result.messages);
}
