import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import {
  SessionFileReviewStore,
  type SnapshotReviewComment,
  type SnapshotReviewCommentStatus,
  type SnapshotReviewSeverity,
} from '@mcp/store/session-file-review-store.js';
import { SessionSnapshotService, type FileDiff } from '@mcp/services/services/session-snapshots.js';
import { SnapshotReviewPipeline } from '@mcp/services/services/snapshot-review-pipeline.js';
import { filterReviewableDiffs } from '@mcp/services/services/snapshot-review-ignore.js';

type Scope = 'coder' | 'company';

interface MountOptions {
  scope: Scope;
  listCoderSessionIds?: (companySessionId: number) => number[];
  /**
   * Optional server-side delivery of the compiled review feedback. When
   * provided (company scope), `/submit` injects the message straight into
   * the master via the orchestrator instead of relying on a frontend chat
   * callback. Coder scope omits this and forwards via the chat stream, so
   * the two paths never double-deliver the same review.
   */
  deliverMessage?: (
    sessionId: number,
    message: string,
  ) => { ok: boolean; pending?: 'interactive_wait' };
}

interface CommentBody {
  baselineId: number;
  filePath: string;
  hunkFingerprint?: string | null;
  oldLine?: number | null;
  newLine?: number | null;
  severity?: SnapshotReviewSeverity;
  body: string;
  suggestedFix?: string | null;
  diffExcerpt?: string | null;
}

function routeBase(scope: Scope): string {
  return `/api/${scope}/sessions/:id/snapshot/reviews`;
}

function projectRootResolver(deps: ServerDeps) {
  return (kind: 'coder' | 'company', sessionId: number, projectId?: number | null): string | null => {
    if (kind !== 'coder') return null;
    const session = deps.sessionStore.getSession(sessionId);
    if (!session) return null;
    // Global session: honor the baseline's project_id (linked secondary root),
    // falling back to the session's primary project.
    const project = deps.db.getProject(projectId ?? session.project_id);
    return project?.root_path ?? null;
  };
}

function coderIdsFor(scope: Scope, sessionId: number, opts: MountOptions): number[] {
  if (scope === 'coder') return [sessionId];
  return opts.listCoderSessionIds?.(sessionId) ?? [];
}

function activeBaselineIds(
  snapshotStore: SessionFileSnapshotStore,
  scope: Scope,
  sessionId: number,
  opts: MountOptions,
): number[] {
  return coderIdsFor(scope, sessionId, opts).flatMap((id) =>
    snapshotStore.listActiveBaselineIds('coder', id),
  );
}

function allBaselineIds(
  snapshotStore: SessionFileSnapshotStore,
  scope: Scope,
  sessionId: number,
  opts: MountOptions,
): number[] {
  return coderIdsFor(scope, sessionId, opts).flatMap((id) =>
    snapshotStore.listBaselines('coder', id, { includeClosed: true }).map((b) => b.id),
  );
}

async function loadDiffs(
  service: SessionSnapshotService,
  baselineIds: number[],
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  for (const baselineId of baselineIds) {
    const diff = await service.getDiff(baselineId, { context: 3 });
    if (diff) diffs.push(diff);
  }
  return diffs;
}

function listComments(
  snapshotStore: SessionFileSnapshotStore,
  reviewStore: SessionFileReviewStore,
  scope: Scope,
  sessionId: number,
  opts: MountOptions,
): SnapshotReviewComment[] {
  if (scope === 'coder') return reviewStore.listComments('coder', sessionId);
  return reviewStore.listCommentsByBaselineIds(allBaselineIds(snapshotStore, scope, sessionId, opts));
}

function normalizeSeverity(value: unknown): SnapshotReviewSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low'
    ? value
    : null;
}

function normalizeStatus(value: unknown): SnapshotReviewCommentStatus | undefined {
  return value === 'open' || value === 'accepted' || value === 'dismissed' || value === 'sent'
    ? value
    : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

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
  return [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...lines].join('\n');
}

function buildFeedbackMessage(comments: SnapshotReviewComment[]): string {
  const blocks = comments.map((c, index) => {
    const loc = [
      `file=${c.file_path}`,
      `baselineId=${c.baseline_id}`,
      c.hunk_fingerprint ? `hunk=${c.hunk_fingerprint}` : null,
      c.old_line != null ? `oldLine=${c.old_line}` : null,
      c.new_line != null ? `newLine=${c.new_line}` : null,
    ].filter(Boolean).join(' ');
    return [
      `## ${index + 1}. ${c.source} ${c.severity ? `[${c.severity}]` : ''}`.trim(),
      loc,
      '',
      c.diff_excerpt ? `Diff excerpt:\n\`\`\`diff\n${c.diff_excerpt}\n\`\`\`` : null,
      `Comment:\n${c.body}`,
      c.suggested_fix ? `Suggested fix:\n${c.suggested_fix}` : null,
    ].filter(Boolean).join('\n');
  });
  return [
    'Snapshot review feedback',
    '',
    'Please inspect and address the accepted review items below. Each item includes the file, baseline, line/hunk metadata, diff excerpt when available, and reviewer comment.',
    '',
    ...blocks,
  ].join('\n');
}

export function mountSnapshotReviewRoutes(
  app: Hono,
  deps: ServerDeps,
  opts: MountOptions,
): void {
  const { scope } = opts;
  const snapshotStore = new SessionFileSnapshotStore(deps.sessionStore.getDb());
  const reviewStore = new SessionFileReviewStore(deps.sessionStore.getDb());
  const snapshotService = new SessionSnapshotService(snapshotStore, projectRootResolver(deps));
  const pipeline = new SnapshotReviewPipeline(deps.pipelineProviderResolver, deps.pipelineTelemetrySink);

  app.get(routeBase(scope), async (c) => {
    const sessionId = parseIdParam(c);
    if (!Number.isFinite(sessionId)) return c.json({ error: 'bad id' }, 400);
    return c.json({
      runs: reviewStore.listRuns(scope, sessionId),
      comments: listComments(snapshotStore, reviewStore, scope, sessionId, opts),
    });
  });

  app.post(`${routeBase(scope)}/comments`, async (c) => {
    const sessionId = parseIdParam(c);
    if (!Number.isFinite(sessionId)) return c.json({ error: 'bad id' }, 400);
    const body = await parseJsonBody<CommentBody>(c);
    const baselineId = asNumber(body.baselineId);
    const filePath = asString(body.filePath);
    const text = asString(body.body);
    if (!baselineId || !filePath || !text) {
      return c.json({ error: 'baselineId, filePath and body required' }, 400);
    }
    const allowed = new Set(allBaselineIds(snapshotStore, scope, sessionId, opts));
    if (!allowed.has(baselineId)) return c.json({ error: 'baseline outside session' }, 403);
    const comment = reviewStore.createComment({
      baseline_id: baselineId,
      source: 'manual',
      status: 'open',
      file_path: filePath,
      hunk_fingerprint: asString(body.hunkFingerprint),
      old_line: asNumber(body.oldLine),
      new_line: asNumber(body.newLine),
      severity: normalizeSeverity(body.severity),
      body: text,
      suggested_fix: asString(body.suggestedFix),
      diff_excerpt: asString(body.diffExcerpt),
    });
    return c.json({ comment });
  });

  app.patch(`${routeBase(scope)}/comments/:commentId`, async (c) => {
    const sessionId = parseIdParam(c);
    const commentId = parseIdParam(c, 'commentId');
    if (!Number.isFinite(sessionId) || !Number.isFinite(commentId)) {
      return c.json({ error: 'bad id' }, 400);
    }
    const allowed = new Set(listComments(snapshotStore, reviewStore, scope, sessionId, opts).map((x) => x.id));
    if (!allowed.has(commentId)) return notFound(c, 'comment not found');
    const body = await parseJsonBody<{
      status?: SnapshotReviewCommentStatus;
      body?: string;
      severity?: SnapshotReviewSeverity;
      suggestedFix?: string | null;
    }>(c);
    const comment = reviewStore.updateComment(commentId, {
      status: normalizeStatus(body.status),
      body: asString(body.body) ?? undefined,
      severity: body.severity === undefined ? undefined : normalizeSeverity(body.severity),
      suggested_fix: body.suggestedFix === undefined ? undefined : asString(body.suggestedFix),
    });
    if (!comment) return notFound(c, 'comment not found');
    return c.json({ comment });
  });

  app.post(`${routeBase(scope)}/auto`, async (c) => {
    const sessionId = parseIdParam(c);
    if (!Number.isFinite(sessionId)) return c.json({ error: 'bad id' }, 400);
    const run = reviewStore.createRun({ session_kind: scope, session_id: sessionId, source: 'auto' });
    // Skip internal/never-reviewed paths (.mcp-indexer/**, .git, node_modules, dist).
    const diffs = filterReviewableDiffs(
      await loadDiffs(snapshotService, activeBaselineIds(snapshotStore, scope, sessionId, opts)),
    );
    const pendingHunks = diffs.reduce(
      (sum, diff) => sum + (diff.diffDisabled ? 0 : diff.hunks.filter((h) => h.decision === 'pending').length),
      0,
    );
    if (pendingHunks === 0) {
      reviewStore.completeRun(run.id, {
        status: 'completed',
        raw_response: '{"findings":[]}',
      });
      return c.json({
        run: reviewStore.getRun(run.id),
        comments: [],
        message: 'No pending snapshot diff hunks to review.',
      });
    }
    const result = await pipeline.review({
      sessionKind: scope,
      sessionId,
      resolveContext: scope === 'coder' ? { sessionId } : { companySessionId: sessionId },
      diffs,
    });
    if (!result.ok) {
      reviewStore.completeRun(run.id, {
        status: 'error',
        provider_id: result.providerId ?? null,
        model_id: result.modelId ?? null,
        raw_response: result.raw,
        error: result.error ?? 'review failed',
      });
      const configErrors = new Set([
        'review_pipeline_unconfigured',
        'review_pipeline_provider_unsupported',
        'review_pipeline_missing_credentials',
      ]);
      const status = configErrors.has(result.errorCode ?? '') ? 409 : 502;
      return c.json({
        error: result.error ?? 'review failed',
        code: result.errorCode ?? 'review_pipeline_error',
        run: reviewStore.getRun(run.id),
      }, status);
    }
    reviewStore.completeRun(run.id, {
      status: 'completed',
      provider_id: result.providerId ?? null,
      model_id: result.modelId ?? null,
      raw_response: result.raw,
    });
    const comments = result.findings.flatMap((finding) => {
      const diff = diffs.find((d) =>
        d.baseline.id === finding.baselineId || d.baseline.filePath === finding.filePath,
      );
      if (!diff) return [];
      return reviewStore.createComment({
        run_id: run.id,
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
    });
    return c.json({ run: reviewStore.getRun(run.id), comments });
  });

  app.post(`${routeBase(scope)}/submit`, async (c) => {
    const sessionId = parseIdParam(c);
    if (!Number.isFinite(sessionId)) return c.json({ error: 'bad id' }, 400);
    const body = await parseJsonBody<{ commentIds: number[] }>(c);
    const ids = Array.isArray(body.commentIds) ? body.commentIds.filter(Number.isFinite) : [];
    const allowed = new Set(listComments(snapshotStore, reviewStore, scope, sessionId, opts).map((x) => x.id));
    const comments = reviewStore
      .listCommentsByIds(ids)
      .filter((cmt) => allowed.has(cmt.id) && cmt.status !== 'dismissed' && cmt.status !== 'sent');
    if (comments.length === 0) return c.json({ error: 'no comments to submit' }, 400);
    const message = buildFeedbackMessage(comments);
    reviewStore.markSent(comments.map((cmt) => cmt.id));
    const delivery = opts.deliverMessage?.(sessionId, message);
    return c.json({
      message,
      comments: reviewStore.listCommentsByIds(comments.map((cmt) => cmt.id)),
      delivered: delivery ? delivery.ok : null,
      pending: delivery?.pending ?? null,
    });
  });
}
