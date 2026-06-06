/**
 * reviewSessionSnapshots — run the configured snapshot_review/reviewer pipeline
 * over the ACTIVE snapshots of a single coder session and return the findings.
 *
 * This is the one source of truth for the "review a session's pending changes"
 * recipe that used to live inline in snapshot-review-routes.ts (`/auto`). It is
 * reused by:
 *   - the code-agent `self_review` tool (reviews ctx.sessionId), and
 *   - the master `review_subordinate_work` tool (reviews a subordinate's
 *     resolved coder_session_id).
 *
 * Snapshots are always recorded under session_kind='coder' keyed by the
 * runner's own coder_session_id (even subordinates), so this only ever needs a
 * coder session id.
 *
 * When `reviewStore` is supplied, the review run + findings are persisted so
 * they also show up in the dashboard Snapshots panel (source 'auto'), exactly
 * like the human-triggered "Revisão automática" button.
 */
import type { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import type { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import type { FileDiff, SessionSnapshotService } from './session-snapshots.js';
import type {
  SnapshotReviewFinding,
  SnapshotReviewPipeline,
} from './snapshot-review-pipeline.js';
import { filterReviewableDiffs } from './snapshot-review-ignore.js';

export interface ReviewSessionDeps {
  snapshotStore: SessionFileSnapshotStore;
  snapshotService: SessionSnapshotService;
  pipeline: SnapshotReviewPipeline;
  /** When present, persists the run + comments so the Snapshots panel shows them. */
  reviewStore?: SessionFileReviewStore;
}

export interface ReviewSessionOutcome {
  ok: boolean;
  pendingHunks: number;
  findings: SnapshotReviewFinding[];
  providerId?: string;
  modelId?: string;
  errorCode?: string;
  error?: string;
}

const DIFF_CONTEXT = 3;

async function loadDiffs(
  service: SessionSnapshotService,
  baselineIds: number[],
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  for (const baselineId of baselineIds) {
    const diff = await service.getDiff(baselineId, { context: DIFF_CONTEXT });
    if (diff) diffs.push(diff);
  }
  return diffs;
}

function countPendingHunks(diffs: FileDiff[]): number {
  return diffs.reduce(
    (sum, diff) =>
      sum + (diff.diffDisabled ? 0 : diff.hunks.filter((h) => h.decision === 'pending').length),
    0,
  );
}

/** Mirror of `excerptFor` in snapshot-review-routes.ts — a fallback diff snippet. */
function excerptFor(diff: FileDiff, fingerprint?: string | null): string | null {
  if (diff.diffDisabled) return null;
  const hunk = fingerprint
    ? diff.hunks.find((h) => h.fingerprint === fingerprint)
    : diff.hunks.find((h) => h.decision === 'pending');
  if (!hunk) return null;
  const lines = hunk.lines.slice(0, 40).map((line) => {
    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
    return `${prefix}${line.content}`;
  });
  return [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...lines,
  ].join('\n');
}

function persistComments(
  reviewStore: SessionFileReviewStore,
  runId: number,
  diffs: FileDiff[],
  findings: SnapshotReviewFinding[],
): void {
  for (const finding of findings) {
    const diff = diffs.find(
      (d) => d.baseline.id === finding.baselineId || d.baseline.filePath === finding.filePath,
    );
    if (!diff) continue;
    reviewStore.createComment({
      run_id: runId,
      baseline_id: diff.baseline.id,
      source: 'auto',
      status: 'open',
      file_path: diff.baseline.filePath,
      hunk_fingerprint: finding.hunkFingerprint ?? null,
      old_line: finding.oldLine ?? null,
      new_line: finding.newLine ?? null,
      severity: finding.severity,
      body: finding.body,
      suggested_fix: finding.suggestedFix ?? null,
      diff_excerpt: finding.diffExcerpt ?? excerptFor(diff, finding.hunkFingerprint),
    });
  }
}

export async function reviewSessionSnapshots(
  deps: ReviewSessionDeps,
  coderSessionId: number,
): Promise<ReviewSessionOutcome> {
  const { snapshotStore, snapshotService, pipeline, reviewStore } = deps;
  const baselineIds = snapshotStore.listActiveBaselineIds('coder', coderSessionId);
  // Drop internal/never-reviewed paths (.mcp-indexer/**, .git, node_modules,
  // dist) up front so they don't count toward pendingHunks or reach the model.
  const diffs = filterReviewableDiffs(await loadDiffs(snapshotService, baselineIds));
  const pendingHunks = countPendingHunks(diffs);

  const run = reviewStore?.createRun({
    session_kind: 'coder',
    session_id: coderSessionId,
    source: 'auto',
  });

  if (pendingHunks === 0) {
    if (run) reviewStore!.completeRun(run.id, { status: 'completed', raw_response: '{"findings":[]}' });
    return { ok: true, pendingHunks: 0, findings: [] };
  }

  const result = await pipeline.review({
    sessionKind: 'coder',
    sessionId: coderSessionId,
    resolveContext: { sessionId: coderSessionId },
    diffs,
  });

  if (!result.ok) {
    if (run) {
      reviewStore!.completeRun(run.id, {
        status: 'error',
        provider_id: result.providerId ?? null,
        model_id: result.modelId ?? null,
        raw_response: result.raw,
        error: result.error ?? 'review failed',
      });
    }
    return {
      ok: false,
      pendingHunks,
      findings: [],
      providerId: result.providerId,
      modelId: result.modelId,
      errorCode: result.errorCode,
      error: result.error,
    };
  }

  if (run) {
    reviewStore!.completeRun(run.id, {
      status: 'completed',
      provider_id: result.providerId ?? null,
      model_id: result.modelId ?? null,
      raw_response: result.raw,
    });
    persistComments(reviewStore!, run.id, diffs, result.findings);
  }

  return {
    ok: true,
    pendingHunks,
    findings: result.findings,
    providerId: result.providerId,
    modelId: result.modelId,
  };
}
