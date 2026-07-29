/**
 * Fate tracking for review findings (Onda 2 do review nativo de IA).
 *
 * The outcome of every past finding is already persisted and was ignored:
 * comment status (accepted/dismissed) plus a signal only this IDE has — the
 * hunk fingerprint. A fingerprint that no longer exists among the file's
 * current hunks means the flagged region was RE-EDITED after the finding
 * (fingerprint invalidation, snapshot-hunks.ts), i.e. the finding was acted
 * on even without an explicit "accept". That closes the loop:
 *
 *   observe fates → aggregate per (kind × severity) → feed the next review
 *   with suppression + few-shot-negative priors, so noisy categories go
 *   quiet IN THIS REPO while critical findings are never suppressed.
 */
import type {
  SnapshotReviewComment,
  SessionReviewStorePort,
} from './session-snapshot-port.js';
import type {
  ReviewFateOutcome,
  ReviewIntelPort,
} from './review-intel-port.js';
import type { FileDiff } from './session-snapshots.js';

/** Explicit verdicts below this precision (with enough samples) get the
 *  "report only with explicit line evidence" nudge. Critical is exempt. */
const SUPPRESS_PRECISION = 0.3;
const SUPPRESS_MIN_SAMPLES = 5;
const FEW_SHOT_DISMISSALS = 3;
const MAX_PRIORS_CHARS = 2_000;

function fateOf(
  comment: SnapshotReviewComment<string>,
  fingerprintsByFile: Map<string, Set<string>>,
): ReviewFateOutcome {
  if (comment.status === 'accepted') return 'accepted';
  if (comment.status === 'dismissed') return 'dismissed';
  const current = fingerprintsByFile.get(comment.file_path);
  if (comment.hunk_fingerprint && current && !current.has(comment.hunk_fingerprint)) {
    return 'reedited';
  }
  return 'ignored';
}

/**
 * Observe the fate of every existing comment of this session against the
 * CURRENT diffs. Called at review time, before the new run — cheap, idempotent
 * (latest observation wins), best-effort.
 */
export async function recordSessionFates<
  SessionKey extends string,
  RecordId extends string,
>(
  reviewStore: SessionReviewStorePort<SessionKey, RecordId>,
  intelStore: ReviewIntelPort<SessionKey, RecordId>,
  sessionKind: string,
  sessionId: SessionKey,
  diffs: FileDiff<RecordId>[],
): Promise<void> {
  try {
    const comments = await reviewStore.listComments(sessionKind, sessionId);
    if (comments.length === 0) return;
    const fingerprintsByFile = new Map<string, Set<string>>();
    for (const diff of diffs) {
      fingerprintsByFile.set(
        diff.baseline.filePath,
        new Set(diff.hunks.map((h) => h.fingerprint)),
      );
    }
    for (const comment of comments) {
      await intelStore.recordFate({
        comment_id: comment.id,
        session_kind: sessionKind,
        session_id: sessionId,
        category: comment.kind ?? 'defect',
        severity: comment.severity,
        file_path: comment.file_path,
        outcome: fateOf(comment, fingerprintsByFile),
      });
    }
  } catch {
    /* fate tracking must never break the review */
  }
}

/**
 * Build the calibration section for the reviewer prompt from the aggregated
 * fates: suppression nudges for low-precision categories plus the most
 * recent explicit dismissals as few-shot negatives. Null when there is no
 * signal yet (cold start behaves exactly like today).
 */
export async function buildReviewPriors<
  SessionKey extends string,
  RecordId extends string,
>(
  intelStore: ReviewIntelPort<SessionKey, RecordId>,
  projectId?: number,
): Promise<string | null> {
  try {
    const lines: string[] = [];
    for (const agg of await intelStore.aggregateFates(projectId)) {
      if (agg.severity === 'critical') continue; // never suppress critical
      const verdicts = agg.accepted + agg.dismissed;
      if (verdicts < SUPPRESS_MIN_SAMPLES) continue;
      const precision = agg.accepted / verdicts;
      if (precision >= SUPPRESS_PRECISION) continue;
      lines.push(
        `- ${agg.category} findings at severity "${agg.severity ?? 'unknown'}" were dismissed ` +
          `${agg.dismissed}/${verdicts} times in this repo — only report one with explicit ` +
          'line evidence and a concrete failure scenario.',
      );
    }
    const dismissals = await intelStore.recentDismissals(
      FEW_SHOT_DISMISSALS,
      projectId,
    );
    if (dismissals.length > 0) {
      lines.push('Recently dismissed by the owner (do NOT repeat without new evidence):');
      for (const d of dismissals) {
        lines.push(`- [${d.severity ?? '?'}] ${d.file_path}: ${d.body.slice(0, 200)}`);
      }
    }
    if (lines.length === 0) return null;
    return lines.join('\n').slice(0, MAX_PRIORS_CHARS);
  } catch {
    return null;
  }
}
