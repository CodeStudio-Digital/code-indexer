import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import {
  parseJsonBody,
  parseSessionIdParam,
  parseSessionRecordIdParam,
  notFound,
} from './_helpers.js';
import type {
  SessionReviewStorePort,
  SessionSnapshotStorePort,
  SnapshotReviewComment,
  SnapshotReviewCommentStatus,
  SnapshotReviewSeverity,
} from '@mcp/services/services/session-snapshot-port.js';
import { SessionSnapshotService, type FileDiff } from '@mcp/services/services/session-snapshots.js';
import { SnapshotReviewPipeline } from '@mcp/services/services/snapshot-review-pipeline.js';
import { filterReviewableDiffs } from '@mcp/services/services/snapshot-review-ignore.js';
import {
  buildEnclosingSymbolContext,
  formatReviewContext,
} from '@mcp/services/services/snapshot-review-context.js';
import { buildSessionIntent } from '@mcp/code-agent/sessions/session-intent.js';
import type { SessionId } from '@mcp/session-storage';

type Scope = 'coder' | 'company';

interface ReviewMessageDelivery {
  ok: boolean;
  pending?: 'interactive_wait';
  code?: 'OUTCOME_UNKNOWN';
  error?: string;
}

interface MountOptions {
  scope: Scope;
  listCoderSessionIds?: (
    companySessionId: SessionId,
  ) => SessionId[] | Promise<SessionId[]>;
  /**
   * Optional server-side delivery of the compiled review feedback. When
   * provided (company scope), `/submit` injects the message straight into
   * the master via the orchestrator instead of relying on a frontend chat
   * callback. Coder scope omits this and forwards via the chat stream, so
   * the two paths never double-deliver the same review.
   */
  deliverMessage?: (
    sessionId: SessionId,
    message: string,
  ) => ReviewMessageDelivery | Promise<ReviewMessageDelivery>;
}

interface CommentBody {
  baselineId: string;
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
  return async (
    kind: 'coder' | 'company',
    sessionId: SessionId,
    projectId?: number | null,
  ): Promise<string | null> => {
    if (kind !== 'coder') return null;
    const session = await deps.sessionStore.getSession(sessionId);
    if (!session) return null;
    if (projectId != null && projectId < 0) {
      return (await deps.sessionStore.listSessionFilesystemRoots(sessionId))
        .find((root) => root.seq === -projectId)?.root_path ?? null;
    }
    // Global session: honor the baseline's project_id (linked secondary root),
    // falling back to the session's primary project.
    const targetProjectId = projectId ?? session.project_id;
    if (targetProjectId == null) return null;
    const project = deps.db.getProject(targetProjectId);
    return project && !project.is_synthetic && project.root_path.trim().length > 0
      ? project.root_path
      : null;
  };
}

async function coderIdsFor(
  scope: Scope,
  sessionId: SessionId,
  opts: MountOptions,
): Promise<SessionId[]> {
  if (scope === 'coder') return [sessionId];
  return await opts.listCoderSessionIds?.(sessionId) ?? [];
}

async function activeBaselineIds(
  snapshotStore: SessionSnapshotStorePort<SessionId, string>,
  scope: Scope,
  sessionId: SessionId,
  opts: MountOptions,
): Promise<string[]> {
  return (await Promise.all(
    (await coderIdsFor(scope, sessionId, opts)).map((id) =>
      snapshotStore.listActiveBaselineIds('coder', id),
    ),
  )).flat();
}

async function allBaselineIds(
  snapshotStore: SessionSnapshotStorePort<SessionId, string>,
  scope: Scope,
  sessionId: SessionId,
  opts: MountOptions,
): Promise<string[]> {
  return (await Promise.all(
    (await coderIdsFor(scope, sessionId, opts)).map(async (id) =>
      (await snapshotStore.listBaselines('coder', id, {
        includeClosed: true,
      })).map((baseline) => baseline.id),
    ),
  )).flat();
}

async function loadDiffs(
  service: SessionSnapshotService<SessionId, string>,
  baselineIds: string[],
): Promise<FileDiff<string>[]> {
  const diffs: FileDiff<string>[] = [];
  for (const baselineId of baselineIds) {
    const diff = await service.getDiff(baselineId, { context: 3 });
    if (diff) diffs.push(diff);
  }
  return diffs;
}

async function listComments(
  snapshotStore: SessionSnapshotStorePort<SessionId, string>,
  reviewStore: SessionReviewStorePort<SessionId, string>,
  scope: Scope,
  sessionId: SessionId,
  opts: MountOptions,
): Promise<SnapshotReviewComment<string>[]> {
  if (scope === 'coder') return await reviewStore.listComments('coder', sessionId);
  return reviewStore.listCommentsByBaselineIds(
    await allBaselineIds(snapshotStore, scope, sessionId, opts),
  );
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

function excerptFor(diff: FileDiff<string>, fingerprint?: string | null): string | null {
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

function buildFeedbackMessage(comments: SnapshotReviewComment<string>[]): string {
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
  const snapshotStore = deps.sessionStore;
  const reviewStore = deps.sessionStore;
  const snapshotService = new SessionSnapshotService(snapshotStore, projectRootResolver(deps));
  const pipeline = new SnapshotReviewPipeline(deps.pipelineProviderResolver, deps.pipelineTelemetrySink);

  app.get(routeBase(scope), async (c) => {
    const sessionId = parseSessionIdParam(c);
    return c.json({
      runs: await reviewStore.listRuns(scope, sessionId),
      comments: await listComments(snapshotStore, reviewStore, scope, sessionId, opts),
    });
  });

  app.post(`${routeBase(scope)}/comments`, async (c) => {
    const sessionId = parseSessionIdParam(c);
    const body = await parseJsonBody<CommentBody>(c);
    const baselineId = asString(body.baselineId);
    const filePath = asString(body.filePath);
    const text = asString(body.body);
    if (!baselineId || !filePath || !text) {
      return c.json({ error: 'baselineId, filePath and body required' }, 400);
    }
    const allowed = new Set(
      await allBaselineIds(snapshotStore, scope, sessionId, opts),
    );
    if (!allowed.has(baselineId)) return c.json({ error: 'baseline outside session' }, 403);
    const comment = await reviewStore.createComment({
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
    const sessionId = parseSessionIdParam(c);
    const commentId = parseSessionRecordIdParam(c, 'commentId');
    const allowed = new Set(
      (await listComments(snapshotStore, reviewStore, scope, sessionId, opts))
        .map((comment) => comment.id),
    );
    if (!allowed.has(commentId)) return notFound(c, 'comment not found');
    const body = await parseJsonBody<{
      status?: SnapshotReviewCommentStatus;
      body?: string;
      severity?: SnapshotReviewSeverity;
      suggestedFix?: string | null;
    }>(c);
    const comment = await reviewStore.updateComment(commentId, {
      status: normalizeStatus(body.status),
      body: asString(body.body) ?? undefined,
      severity: body.severity === undefined ? undefined : normalizeSeverity(body.severity),
      suggested_fix: body.suggestedFix === undefined ? undefined : asString(body.suggestedFix),
    });
    if (!comment) return notFound(c, 'comment not found');
    return c.json({ comment });
  });

  app.post(`${routeBase(scope)}/auto`, async (c) => {
    const sessionId = parseSessionIdParam(c);
    const run = await reviewStore.createRun({
      session_kind: scope,
      session_id: sessionId,
      source: 'auto',
    });
    // Skip internal/never-reviewed paths (.mcp-indexer/**, .git, node_modules, dist).
    const diffs = filterReviewableDiffs(
      await loadDiffs(
        snapshotService,
        await activeBaselineIds(snapshotStore, scope, sessionId, opts),
      ),
    );
    const pendingHunks = diffs.reduce(
      (sum, diff) => sum + (diff.diffDisabled ? 0 : diff.hunks.filter((h) => h.decision === 'pending').length),
      0,
    );
    if (pendingHunks === 0) {
      await reviewStore.completeRun(run.id, {
        status: 'completed',
        raw_response: '{"findings":[]}',
      });
      return c.json({
        run: await reviewStore.getRun(run.id),
        comments: [],
        message: 'No pending snapshot diff hunks to review.',
      });
    }
    // Reviewer context: enclosing symbols always; session intent only for
    // coder scope (a company review aggregates N coder sessions — no single
    // intent applies).
    let intent: string | null = null;
    if (scope === 'coder') {
      try {
        intent = await buildSessionIntent(deps.sessionStore, sessionId);
      } catch {
        /* best-effort */
      }
    }
    const result = await pipeline.review({
      sessionKind: scope,
      sessionId,
      resolveContext: scope === 'coder' ? { sessionId } : { companySessionId: sessionId },
      diffs,
      contextText: formatReviewContext({
        intent,
        symbols: buildEnclosingSymbolContext(diffs),
      }),
    });
    if (!result.ok) {
      await reviewStore.completeRun(run.id, {
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
        run: await reviewStore.getRun(run.id),
      }, status);
    }
    await reviewStore.completeRun(run.id, {
      status: 'completed',
      provider_id: result.providerId ?? null,
      model_id: result.modelId ?? null,
      raw_response: result.raw,
    });
    const comments = (await Promise.all(result.findings.map(async (finding) => {
      const diff = diffs.find((d) =>
        d.baseline.id === finding.baselineId || d.baseline.filePath === finding.filePath,
      );
      if (!diff) return null;
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
    }))).filter((comment): comment is SnapshotReviewComment<string> => comment != null);
    return c.json({ run: await reviewStore.getRun(run.id), comments });
  });

  app.post(`${routeBase(scope)}/submit`, async (c) => {
    const sessionId = parseSessionIdParam(c);
    const body = await parseJsonBody<{ commentIds: string[] }>(c);
    const ids = Array.isArray(body.commentIds)
      ? body.commentIds.filter(
          (id): id is string =>
            typeof id === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id),
        )
      : [];
    const allowed = new Set(
      (await listComments(snapshotStore, reviewStore, scope, sessionId, opts))
        .map((comment) => comment.id),
    );
    const comments = (await reviewStore
      .listCommentsByIds(ids))
      .filter((cmt) => allowed.has(cmt.id) && cmt.status !== 'dismissed' && cmt.status !== 'sent');
    if (comments.length === 0) return c.json({ error: 'no comments to submit' }, 400);
    const message = buildFeedbackMessage(comments);
    const delivery = await opts.deliverMessage?.(sessionId, message);
    // A company-side delivery refusal is retryable. Do not irreversibly mark
    // those comments as sent until the worker acknowledges the message.
    if (delivery?.ok !== false) {
      await reviewStore.markSent(comments.map((cmt) => cmt.id));
    }
    return c.json({
      message,
      comments: await reviewStore.listCommentsByIds(comments.map((cmt) => cmt.id)),
      delivered: delivery ? delivery.ok : null,
      pending: delivery?.pending ?? null,
      delivery_code: delivery?.code ?? null,
      delivery_error: delivery?.error ?? null,
      retry_safe: delivery?.code !== 'OUTCOME_UNKNOWN',
    });
  });
}
