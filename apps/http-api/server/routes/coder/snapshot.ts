/**
 * Session-file snapshot routes (per-session "review diff" UI).
 *
 * Mounted at `/api/coder/sessions/:id/snapshot/*` — exposes the cumulative
 * diff between a session's pre-edit baselines and current on-disk content,
 * plus accept/revert primitives at hunk and file granularity.
 *
 * The handlers are thin: they construct a `SessionSnapshotService` over
 * the filesystem session repository and the project root, then forward to
 * it. No tab state lives in the dashboard — the bundle is the source of
 * truth.
 */
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { resolveSessionWorkspaceRoot } from '../../worktree-reads.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../deps.js';
import {
  parseJsonBody,
  parseSeqParam,
  parseSessionRecordIdParam,
  parseSessionIdParam,
  notFound,
} from '../_helpers.js';
import {
  SessionSnapshotService,
  type FileDiff,
} from '@mcp/services/services/session-snapshots.js';
import { SnapshotReviewPipeline } from '@mcp/services/services/snapshot-review-pipeline.js';
import { filterReviewableDiffs } from '@mcp/services/services/snapshot-review-ignore.js';
import {
  buildEnclosingSymbolContext,
  formatReviewContext,
} from '@mcp/services/services/snapshot-review-context.js';
import { buildSessionIntent } from '@mcp/code-agent/sessions/session-intent.js';
import { mountSnapshotReviewRoutes } from '../snapshot-review-routes.js';
import { mountToolSnapshotRoutes } from './tool-snapshot.js';

export function mountCoderSnapshotRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore, db } = deps;
  const snapshotStore = sessionStore;
  mountToolSnapshotRoutes(app, snapshotStore);
  const service = new SessionSnapshotService(snapshotStore, async (kind, sessionId, projectId) => {
    if (kind !== 'coder') return null;
    const s = await sessionStore.getSession(sessionId);
    if (!s) return null;
    const resolvedProjectId = projectId ?? s.project_id;
    if (resolvedProjectId == null) return null;
    // Snapshot contents remain in the bundle, but reading/reverting files
    // requires a current essential-catalog project. Historical root_path
    // metadata must never revive authority after project removal.
    const p = db.getProject(resolvedProjectId);
    return p && !p.is_synthetic && p.root_path.trim().length > 0
      ? (resolvedProjectId === s.project_id ? await resolveSessionWorkspaceRoot(p.root_path, s) : p.root_path)
      : null;
  });
  const roundReviewPipeline = new SnapshotReviewPipeline(
    deps.pipelineProviderResolver,
    deps.pipelineTelemetrySink,
  );

  const roundSnapshotAllowed = async (
    sessionId: SessionId,
    roundSeq: number,
    roundSnapshotId: string,
  ) => {
    const row = await snapshotStore.getRoundSnapshotById(roundSnapshotId);
    if (
      !row
      || row.session_kind !== 'coder'
      || row.session_id !== sessionId
      || row.round_message_id !== roundSeq
    ) return null;
    const global = await snapshotStore.getBaselineById(row.global_baseline_id);
    if (
      !global
      || global.session_kind !== row.session_kind
      || global.session_id !== row.session_id
      || global.project_id !== row.project_id
      || global.file_path !== row.file_path
    ) return null;
    return row;
  };

  const roundContextRows = async (sessionId: SessionId, roundSeq: number) => {
    const rows = await snapshotStore.listRoundSnapshots('coder', sessionId, roundSeq, { includeClosed: true });
    if (rows.length === 0) return null;
    const baselineById = await snapshotStore.baselineIdentities(sessionId, rows.map(row => row.global_baseline_id));
    return rows.every((row) => {
      const global = baselineById.get(row.global_baseline_id);
      return (
        row.session_kind === 'coder'
        && row.session_id === sessionId
        && row.round_message_id === roundSeq
        && global != null
        && global.session_kind === row.session_kind
        && global.session_id === row.session_id
        && global.project_id === row.project_id
        && global.file_path === row.file_path
      );
    }) ? rows : null;
  };

  app.get('/api/coder/sessions/:id/snapshot', async (c) => {
    const id = parseSessionIdParam(c);
    const includeClosed = c.req.query('includeClosed') === '1';
    const files = await service.listFiles('coder', id, { includeClosed });
    return c.json({ files });
  });

  app.get('/api/coder/sessions/:id/snapshot/file/:baselineId/diff', async (c) => {
    parseSessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const context = Number(c.req.query('context') ?? 3);
    const contextBeforeRaw = c.req.query('contextBefore');
    const contextAfterRaw = c.req.query('contextAfter');
    const diff = await service.getDiff(baselineId, {
      context: Number.isFinite(context) ? context : 3,
      contextBefore: contextBeforeRaw ? Number(contextBeforeRaw) : undefined,
      contextAfter: contextAfterRaw ? Number(contextAfterRaw) : undefined,
    });
    if (!diff) return notFound(c, 'baseline not found');
    return c.json(diff);
  });

  app.get('/api/coder/sessions/:id/snapshot/round/:roundSeq', async (c) => {
    const id = parseSessionIdParam(c);
    const roundSeq = parseSeqParam(c, 'roundSeq');
    const rows = await roundContextRows(id, roundSeq);
    if (!rows) {
      return notFound(c, 'round not found');
    }
    const files = await service.listRoundFiles('coder', id, roundSeq, rows);
    const reviews = await snapshotStore.listRoundReviewFindings('coder', id, roundSeq, rows);
    return c.json({ roundSeq, files, reviews });
  });

  app.get(
    '/api/coder/sessions/:id/snapshot/round/:roundSeq/file/:roundSnapshotId/diff',
    async (c) => {
      const id = parseSessionIdParam(c);
      const roundSeq = parseSeqParam(c, 'roundSeq');
      const roundSnapshotId = parseSessionRecordIdParam(c, 'roundSnapshotId');
      if (!(await roundSnapshotAllowed(id, roundSeq, roundSnapshotId))) {
        return notFound(c, 'round snapshot not found');
      }
      const context = Number(c.req.query('context') ?? 3);
      const contextBeforeRaw = c.req.query('contextBefore');
      const contextAfterRaw = c.req.query('contextAfter');
      const diff = await service.getRoundDiff(roundSnapshotId, {
        context: Number.isFinite(context) ? context : 3,
        contextBefore: contextBeforeRaw ? Number(contextBeforeRaw) : undefined,
        contextAfter: contextAfterRaw ? Number(contextAfterRaw) : undefined,
      });
      if (!diff) return notFound(c, 'round snapshot not found');
      return c.json(diff);
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundSeq/file/:roundSnapshotId/accept-hunk',
    async (c) => {
      const id = parseSessionIdParam(c);
      const roundSeq = parseSeqParam(c, 'roundSeq');
      const roundSnapshotId = parseSessionRecordIdParam(c, 'roundSnapshotId');
      if (!(await roundSnapshotAllowed(id, roundSeq, roundSnapshotId))) {
        return notFound(c, 'round snapshot not found');
      }
      const body = await parseJsonBody<{ fingerprint?: string }>(c);
      if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
      return c.json(await service.acceptRoundHunk(roundSnapshotId, body.fingerprint));
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundSeq/file/:roundSnapshotId/revert-hunk',
    async (c) => {
      const id = parseSessionIdParam(c);
      const roundSeq = parseSeqParam(c, 'roundSeq');
      const roundSnapshotId = parseSessionRecordIdParam(c, 'roundSnapshotId');
      if (!(await roundSnapshotAllowed(id, roundSeq, roundSnapshotId))) {
        return notFound(c, 'round snapshot not found');
      }
      const body = await parseJsonBody<{ fingerprint?: string }>(c);
      if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
      return c.json(await service.revertRoundHunk(roundSnapshotId, body.fingerprint));
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundSeq/file/:roundSnapshotId/accept',
    async (c) => {
      const id = parseSessionIdParam(c);
      const roundSeq = parseSeqParam(c, 'roundSeq');
      const roundSnapshotId = parseSessionRecordIdParam(c, 'roundSnapshotId');
      if (!(await roundSnapshotAllowed(id, roundSeq, roundSnapshotId))) {
        return notFound(c, 'round snapshot not found');
      }
      return c.json(await service.acceptRoundFile(roundSnapshotId));
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundSeq/file/:roundSnapshotId/revert',
    async (c) => {
      const id = parseSessionIdParam(c);
      const roundSeq = parseSeqParam(c, 'roundSeq');
      const roundSnapshotId = parseSessionRecordIdParam(c, 'roundSnapshotId');
      if (!(await roundSnapshotAllowed(id, roundSeq, roundSnapshotId))) {
        return notFound(c, 'round snapshot not found');
      }
      return c.json(await service.revertRoundFile(roundSnapshotId));
    },
  );

  app.post('/api/coder/sessions/:id/snapshot/round/:roundSeq/revert-all', async (c) => {
    const id = parseSessionIdParam(c);
    const roundSeq = parseSeqParam(c, 'roundSeq');
    if (!(await roundContextRows(id, roundSeq))) return notFound(c, 'round not found');
    const body = await parseJsonBody<{ confirm?: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const result = await service.revertRoundAll('coder', id, roundSeq);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/coder/sessions/:id/snapshot/round/:roundSeq/review', async (c) => {
    const id = parseSessionIdParam(c);
    const roundSeq = parseSeqParam(c, 'roundSeq');
    const rows = await roundContextRows(id, roundSeq);
    if (!rows) return notFound(c, 'round not found');
    const diffs = filterReviewableDiffs((await Promise.all(
      rows.map((row) => service.getRoundDiff(row.id, { context: 3 })),
    )).filter((diff): diff is FileDiff => !!diff));
    const pendingHunks = diffs.reduce(
      (sum, diff) => sum + diff.hunks.filter((hunk) => hunk.decision === 'pending').length,
      0,
    );
    if (pendingHunks === 0) {
      await snapshotStore.replaceRoundReviewFindings(rows.map((row) => row.id), []);
      return c.json({ reviews: [], message: 'No pending round diff hunks to review.' });
    }
    let intent: string | null = null;
    try { intent = await buildSessionIntent(sessionStore, id); } catch { /* best effort */ }
    const result = await roundReviewPipeline.review({
      sessionKind: 'coder',
      sessionId: id,
      resolveContext: { sessionId: id },
      diffs,
      contextText: formatReviewContext({
        intent,
        symbols: buildEnclosingSymbolContext(diffs),
      }),
    });
    if (!result.ok) {
      return c.json({
        error: result.error ?? 'review failed',
        code: result.errorCode ?? 'review_pipeline_error',
      }, 502);
    }
    const findings = result.findings.flatMap((finding) => {
      const diff = finding.baselineId != null
        ? diffs.find((candidate) => candidate.baseline.id === finding.baselineId)
        : (() => {
            const pathMatches = diffs.filter(
              (candidate) => candidate.baseline.filePath === finding.filePath,
            );
            return pathMatches.length === 1 ? pathMatches[0] : undefined;
          })();
      if (!diff) return [];
      return [{
        round_snapshot_id: diff.baseline.id,
        hunk_fingerprint: finding.hunkFingerprint ?? null,
        old_line: finding.oldLine ?? null,
        new_line: finding.newLine ?? null,
        severity: finding.severity,
        body: finding.body,
        suggested_fix: finding.suggestedFix ?? null,
        diff_excerpt: finding.diffExcerpt ?? null,
      }];
    });
    const reviews = await snapshotStore.replaceRoundReviewFindings(
      rows.map((row) => row.id),
      findings,
    );
    return c.json({ reviews });
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/accept-hunk', async (c) => {
    parseSessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.acceptHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/revert-hunk', async (c) => {
    parseSessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.revertHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/accept', async (c) => {
    parseSessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const r = await service.acceptFile(baselineId);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/revert', async (c) => {
    parseSessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const r = await service.revertFile(baselineId);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/accept-all', async (c) => {
    const id = parseSessionIdParam(c);
    const r = await service.acceptAll('coder', id);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/revert-all', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ confirm: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const r = await service.revertAll('coder', id);
    return c.json(r);
  });

  mountSnapshotReviewRoutes(app, deps, { scope: 'coder' });
}
