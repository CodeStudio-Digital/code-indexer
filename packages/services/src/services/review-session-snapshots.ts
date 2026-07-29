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
import type { ReviewIntelPort } from './review-intel-port.js';
import type {
  SessionReviewStorePort,
  SessionSnapshotStorePort,
} from './session-snapshot-port.js';
import type { FileDiff, SessionSnapshotService } from './session-snapshots.js';
import type {
  SnapshotReviewFinding,
  SnapshotReviewPipeline,
} from './snapshot-review-pipeline.js';
import { filterReviewableDiffs } from './snapshot-review-ignore.js';
import { parseDeclarationName, type ReviewReferenceLookup } from './review-absences.js';
import { findEnclosingDeclLine } from './code-reader.js';
import { buildReviewBundle } from './review-bundle.js';
import type { IntentContractCompiler, IntentObligation } from './intent-contract.js';
import { buildReviewPriors, recordSessionFates } from './review-fates.js';

export interface ReviewSessionDeps<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  snapshotStore: SessionSnapshotStorePort<SessionKey, RecordId>;
  snapshotService: SessionSnapshotService<SessionKey, RecordId>;
  pipeline: SnapshotReviewPipeline;
  /** When present, persists the run + comments so the Snapshots panel shows them. */
  reviewStore?: SessionReviewStorePort<SessionKey, RecordId>;
  /** When present, absence detection runs (review-absences.ts): untouched
   *  call sites of contract-changed symbols become a "references to verify"
   *  prompt section + kind=missing_change findings. Failures are swallowed —
   *  an index hiccup must never break the review. */
  referenceLookup?: ReviewReferenceLookup;
  /** When present (with reviewStore), finding fates are observed before the
   *  run and calibration priors are injected into the prompt (review-fates). */
  intelStore?: ReviewIntelPort<SessionKey, RecordId>;
  /** Scopes the calibration priors to this project — without it the
   *  aggregates would cross every project on the machine. */
  projectId?: number;
  /** When present, the session intent is compiled into obligations and the
   *  review judges alignment too (intent-contract.ts). */
  intentCompiler?: IntentContractCompiler;
}

export interface ReviewSessionOutcome {
  ok: boolean;
  pendingHunks: number;
  findings: SnapshotReviewFinding[];
  /** Compiled intent contract used by this review (null = contract-less). */
  obligations?: IntentObligation[] | null;
  providerId?: string;
  modelId?: string;
  errorCode?: string;
  error?: string;
}

export interface ReviewSessionOptions {
  /** Author note (1-3 sentences) from the `self_review` tool's `focus` param. */
  focus?: string | null;
  /** Session intent (title + original request + task list), built by the
   *  entrypoint — services cannot read coder session messages itself. */
  intent?: string | null;
  /** Recorded verification evidence (code-agent review-evidence.ts), built by
   *  the entrypoint — services cannot read the tool-call history itself. */
  evidence?: string | null;
}

const DIFF_CONTEXT = 3;

async function loadDiffs<
  SessionKey extends string,
  RecordId extends string,
>(
  service: SessionSnapshotService<SessionKey, RecordId>,
  baselineIds: RecordId[],
): Promise<FileDiff<RecordId>[]> {
  const diffs: FileDiff<RecordId>[] = [];
  for (const baselineId of baselineIds) {
    const diff = await service.getDiff(baselineId, { context: DIFF_CONTEXT });
    if (diff) diffs.push(diff);
  }
  return diffs;
}

function countPendingHunks<RecordId extends string>(
  diffs: FileDiff<RecordId>[],
): number {
  return diffs.reduce(
    (sum, diff) =>
      sum + (diff.diffDisabled ? 0 : diff.hunks.filter((h) => h.decision === 'pending').length),
    0,
  );
}

/** Mirror of `excerptFor` in snapshot-review-routes.ts — a fallback diff snippet. */
function excerptFor<RecordId extends string>(
  diff: FileDiff<RecordId>,
  fingerprint?: string | null,
): string | null {
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

/** Enclosing-symbol name for a finding's line — an anchor that survives the
 *  fingerprint invalidation a re-edit causes. Best-effort. */
function symbolAnchorFor<RecordId extends string>(
  diff: FileDiff<RecordId>,
  line: number | null | undefined,
): string | null {
  if (line == null || diff.currentContent == null) return null;
  try {
    const declLine = findEnclosingDeclLine(diff.currentContent, line);
    const text = diff.currentContent.split('\n')[declLine - 1];
    return text ? parseDeclarationName(text) : null;
  } catch {
    return null;
  }
}

async function persistComments<
  SessionKey extends string,
  RecordId extends string,
>(
  reviewStore: SessionReviewStorePort<SessionKey, RecordId>,
  runId: RecordId,
  diffs: FileDiff<RecordId>[],
  findings: SnapshotReviewFinding[],
): Promise<void> {
  for (const finding of findings) {
    const kind = finding.kind ?? 'defect';
    let diff = diffs.find(
      (d) => d.baseline.id === finding.baselineId || d.baseline.filePath === finding.filePath,
    );
    // unfulfilled_obligation may reference a file that does not exist yet —
    // anchor it on the first baseline so it still reaches the panel.
    if (!diff && kind === 'unfulfilled_obligation') diff = diffs[0];
    if (!diff) continue;
    // Findings pointing OUTSIDE the diff (missing_change → untouched file,
    // unfulfilled_obligation → expected file): anchor the comment on the
    // motivating baseline, carry the real location in the body, and drop
    // line anchors that belong to the other file.
    const external = kind === 'missing_change' || kind === 'unfulfilled_obligation';
    const prefix =
      kind === 'missing_change'
        ? `[missing change → ${finding.filePath}${finding.newLine != null ? `:${finding.newLine}` : ''}] `
        : kind === 'unfulfilled_obligation'
          ? `[unfulfilled obligation${finding.obligationId ? ` ${finding.obligationId}` : ''}] `
          : kind === 'scope_creep'
            ? '[scope creep] '
            : '';
    await reviewStore.createComment({
      run_id: runId,
      baseline_id: diff.baseline.id,
      source: 'auto',
      status: 'open',
      file_path: diff.baseline.filePath,
      hunk_fingerprint: external ? null : finding.hunkFingerprint ?? null,
      old_line: external ? null : finding.oldLine ?? null,
      new_line: external ? null : finding.newLine ?? null,
      severity: finding.severity,
      kind,
      obligation_id: finding.obligationId ?? null,
      symbol_anchor: external ? null : symbolAnchorFor(diff, finding.newLine ?? finding.oldLine),
      body: prefix + finding.body,
      suggested_fix: finding.suggestedFix ?? null,
      diff_excerpt:
        finding.diffExcerpt ?? (external ? null : excerptFor(diff, finding.hunkFingerprint)),
    });
  }
}

export async function reviewSessionSnapshots<
  SessionKey extends string,
  RecordId extends string,
>(
  deps: ReviewSessionDeps<SessionKey, RecordId>,
  coderSessionId: SessionKey,
  opts: ReviewSessionOptions = {},
): Promise<ReviewSessionOutcome> {
  const { snapshotStore, snapshotService, pipeline, reviewStore } = deps;
  const baselineIds = await snapshotStore.listActiveBaselineIds('coder', coderSessionId);
  // Drop internal/never-reviewed paths (.mcp-indexer/**, .git, node_modules,
  // dist) up front so they don't count toward pendingHunks or reach the model.
  const diffs = filterReviewableDiffs(await loadDiffs(snapshotService, baselineIds));
  const pendingHunks = countPendingHunks(diffs);

  const run = reviewStore
    ? await reviewStore.createRun({
    session_kind: 'coder',
    session_id: coderSessionId,
    source: 'auto',
      })
    : undefined;

  if (pendingHunks === 0) {
    if (run) {
      await reviewStore!.completeRun(run.id, {
        status: 'completed',
        raw_response: '{"findings":[]}',
      });
    }
    return { ok: true, pendingHunks: 0, findings: [] };
  }

  // Close the learning loop BEFORE the new run: observe the fate of prior
  // findings (accepted / dismissed / region re-edited / ignored) and turn the
  // aggregate into calibration priors for this review. Best-effort.
  let priors: string | null = null;
  if (deps.intelStore && reviewStore) {
    await recordSessionFates(
      reviewStore,
      deps.intelStore,
      'coder',
      coderSessionId,
      diffs,
    );
    priors = await buildReviewPriors(deps.intelStore, deps.projectId);
  }

  // Compile the intent contract (cached per intent hash) — null degrades to
  // a contract-less review.
  let obligations: IntentObligation[] | null = null;
  if (deps.intentCompiler && opts.intent?.trim()) {
    obligations = await deps.intentCompiler.compile({
      sessionKind: 'coder',
      sessionId: coderSessionId,
      resolveContext: { sessionId: String(coderSessionId) },
      intentSource: opts.intent,
    });
  }

  const bundle = await buildReviewBundle({
    sessionKind: 'coder',
    sessionId: coderSessionId,
    diffs,
    focus: opts.focus,
    intent: opts.intent,
    evidence: opts.evidence,
    priors,
    referenceLookup: deps.referenceLookup,
    obligations,
  });

  const result = await pipeline.review({
    sessionKind: 'coder',
    sessionId: coderSessionId,
    resolveContext: { sessionId: String(coderSessionId) },
    diffs,
    contextText: bundle.contextText,
    absencesText: bundle.absencesText,
    contractText: bundle.contractText,
  });

  if (!result.ok) {
    if (run) {
      await reviewStore!.completeRun(run.id, {
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
    await reviewStore!.completeRun(run.id, {
      status: 'completed',
      provider_id: result.providerId ?? null,
      model_id: result.modelId ?? null,
      raw_response: result.raw,
    });
    await persistComments(reviewStore!, run.id, diffs, result.findings);
  }

  return {
    ok: true,
    pendingHunks,
    findings: result.findings,
    obligations,
    providerId: result.providerId,
    modelId: result.modelId,
  };
}
