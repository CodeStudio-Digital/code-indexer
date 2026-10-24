/**
 * Pure decision rules for the studio auto-fix loop — extracted from
 * useAutoFix so they are unit-testable without React. The hook owns the
 * mutable counters (attempts, watermark, cooldown) and feeds them in here
 * every tick; this module answers "what should this tick do?".
 *
 * Policy:
 *   - While the agent is busy, never fire — mid-run errors are transient
 *     (the agent edits → HMR resurfaces them) and injecting fixes into a
 *     running session just derails it.
 *   - At the busy→idle edge, everything captured during the run is only a
 *     SUSPECT: the agent may have already fixed it. The caller advances the
 *     `suspectBefore` watermark to "now" and, when a suspect exists,
 *     reloads the preview once (revalidation). Errors that still exist
 *     re-emit after the reload; fixed ones stay silent.
 *   - When idle, fire only on problems emitted AFTER the watermark and
 *     still fresh — i.e. evidence about the preview's CURRENT state
 *     (post-revalidation re-emissions, or new errors hit while browsing).
 */

export const MAX_ATTEMPTS = 3;
export const COOLDOWN_MS = 12_000;
export const TICK_MS = 2_000;
/**
 * How long an emission counts as evidence of the current preview state.
 * Kept above COOLDOWN_MS + 2×TICK_MS so a problem that arrives right after
 * a fire is still fresh once the cooldown clears — otherwise it could age
 * out while blocked and never fire at all.
 */
export const FRESH_MS = 17_000;

/** Minimal problem shape the policy needs (usePreviewProblems' Problem fits). */
export interface AutoFixProblem {
  signature: string;
  kind: 'runtime' | 'network' | 'console';
  ts: number;
}

export interface AutoFixPolicyInput<P extends AutoFixProblem> {
  /** Current problems feed, oldest → newest (usePreviewProblems order). */
  problems: readonly P[];
  /** Auto-fire attempts per problem signature. */
  attempts: ReadonlyMap<string, number>;
  /** Live busy state of the chat session bound to this preview. */
  busyNow: boolean;
  /** Busy state observed on the previous tick (edge detection). */
  prevBusy: boolean;
  /** Watermark: only problems emitted after this instant may fire. */
  suspectBefore: number;
  /** Timestamp of the last auto-fire (global cooldown). */
  lastFireAt: number;
  now: number;
}

type AutoFixDecision<P extends AutoFixProblem> =
  | { kind: 'skip' }
  /**
   * Busy→idle edge. The caller must advance the watermark to `now`; when
   * `revalidate` is true it should also reload the preview so still-real
   * errors re-emit past the new watermark.
   */
  | { kind: 'edge'; revalidate: boolean }
  | { kind: 'fire'; target: P };

export function decideAutoFix<P extends AutoFixProblem>(
  input: AutoFixPolicyInput<P>,
): AutoFixDecision<P> {
  const { problems, attempts, busyNow, prevBusy, suspectBefore, lastFireAt, now } = input;
  // Console warnings are never auto-fixed; exhausted signatures are dead.
  const candidates = problems.filter(
    (p) => p.kind !== 'console' && (attempts.get(p.signature) ?? 0) < MAX_ATTEMPTS,
  );

  if (busyNow) return { kind: 'skip' };

  if (prevBusy) {
    // Suspects = candidates (re-)emitted since the previous watermark, i.e.
    // during the run that just ended. Entries older than that already had
    // their chance (and immortal badge leftovers must not cause a reload
    // churn at every future run end).
    const revalidate = candidates.some((p) => p.ts > suspectBefore);
    return { kind: 'edge', revalidate };
  }

  if (now - lastFireAt < COOLDOWN_MS) return { kind: 'skip' };
  // Newest first — fix the most recent evidence of the current state.
  const target = [...candidates]
    .reverse()
    .find((p) => p.ts > suspectBefore && now - p.ts <= FRESH_MS);
  return target ? { kind: 'fire', target } : { kind: 'skip' };
}
