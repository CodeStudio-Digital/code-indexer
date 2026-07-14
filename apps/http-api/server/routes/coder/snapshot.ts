/**
 * Session-file snapshot routes (per-session "review diff" UI).
 *
 * Mounted at `/api/coder/sessions/:id/snapshot/*` — exposes the cumulative
 * diff between a session's pre-edit baselines and current on-disk content,
 * plus accept/revert primitives at hunk and file granularity.
 *
 * The handlers are thin: they construct a `SessionSnapshotService` over
 * the existing `SessionStore` DB handle and the project root, then forward
 * to it. No tab state lives in the dashboard — the service is the source
 * of truth.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
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

export function mountCoderSnapshotRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore, db } = deps;
  const snapshotStore = new SessionFileSnapshotStore(sessionStore.getDb());
  const service = new SessionSnapshotService(snapshotStore, (kind, sessionId, projectId) => {
    if (kind !== 'coder') return null;
    const s = sessionStore.getSession(sessionId);
    if (!s) return null;
    // Global session: a baseline may belong to a linked secondary project; use
    // its project_id when present, else the session's primary project.
    const p = db.getProject(projectId ?? s.project_id);
    return p?.root_path ?? null;
  });
  const roundReviewPipeline = new SnapshotReviewPipeline(
    deps.pipelineProviderResolver,
    deps.pipelineTelemetrySink,
  );

  const roundBelongsToSession = (sessionId: number, roundMessageId: number): boolean => {
    const row = sessionStore.getDb().prepare(
      `SELECT 1 FROM coder_messages
        WHERE id = ? AND session_id = ? AND role = 'user'
          AND COALESCE(is_meta, 0) = 0
        LIMIT 1`,
    ).get(roundMessageId, sessionId);
    return !!row;
  };

  const roundSnapshotAllowed = (
    sessionId: number,
    roundMessageId: number,
    roundSnapshotId: number,
  ) => {
    const row = snapshotStore.getRoundSnapshotById(roundSnapshotId);
    if (
      !row
      || row.session_kind !== 'coder'
      || row.session_id !== sessionId
      || row.round_message_id !== roundMessageId
    ) return null;
    const global = snapshotStore.getBaselineById(row.global_baseline_id);
    if (
      !global
      || global.session_kind !== row.session_kind
      || global.session_id !== row.session_id
      || global.project_id !== row.project_id
      || global.file_path !== row.file_path
    ) return null;
    return row;
  };

  const roundContextRows = (sessionId: number, roundMessageId: number) => {
    if (!roundBelongsToSession(sessionId, roundMessageId)) return null;
    const rows = snapshotStore.listRoundSnapshots('coder', sessionId, roundMessageId, {
      includeClosed: true,
    });
    return rows.every((row) => !!roundSnapshotAllowed(sessionId, roundMessageId, row.id))
      ? rows
      : null;
  };

  app.get('/api/coder/sessions/:id/snapshot', async (c) => {
    const id = parseIdParam(c);
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const includeClosed = c.req.query('includeClosed') === '1';
    const files = await service.listFiles('coder', id, { includeClosed });
    return c.json({ files });
  });

  app.get('/api/coder/sessions/:id/snapshot/file/:baselineId/diff', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    if (!Number.isFinite(baselineId)) return c.json({ error: 'bad baselineId' }, 400);
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

  app.get('/api/coder/sessions/:id/snapshot/round/:roundMessageId', async (c) => {
    const id = parseIdParam(c);
    const roundMessageId = parseIdParam(c, 'roundMessageId');
    if (!Number.isFinite(id) || !Number.isFinite(roundMessageId)) {
      return c.json({ error: 'bad id' }, 400);
    }
    if (!roundContextRows(id, roundMessageId)) {
      return notFound(c, 'round not found');
    }
    const files = await service.listRoundFiles('coder', id, roundMessageId);
    const reviews = snapshotStore.listRoundReviewFindings('coder', id, roundMessageId);
    return c.json({ roundMessageId, files, reviews });
  });

  app.get(
    '/api/coder/sessions/:id/snapshot/round/:roundMessageId/file/:roundSnapshotId/diff',
    async (c) => {
      const id = parseIdParam(c);
      const roundMessageId = parseIdParam(c, 'roundMessageId');
      const roundSnapshotId = parseIdParam(c, 'roundSnapshotId');
      if (!Number.isFinite(id) || !Number.isFinite(roundMessageId) || !Number.isFinite(roundSnapshotId)) {
        return c.json({ error: 'bad id' }, 400);
      }
      if (!roundSnapshotAllowed(id, roundMessageId, roundSnapshotId)) {
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
    '/api/coder/sessions/:id/snapshot/round/:roundMessageId/file/:roundSnapshotId/accept-hunk',
    async (c) => {
      const id = parseIdParam(c);
      const roundMessageId = parseIdParam(c, 'roundMessageId');
      const roundSnapshotId = parseIdParam(c, 'roundSnapshotId');
      if (!roundSnapshotAllowed(id, roundMessageId, roundSnapshotId)) {
        return notFound(c, 'round snapshot not found');
      }
      const body = await parseJsonBody<{ fingerprint?: string }>(c);
      if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
      return c.json(await service.acceptRoundHunk(roundSnapshotId, body.fingerprint));
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundMessageId/file/:roundSnapshotId/revert-hunk',
    async (c) => {
      const id = parseIdParam(c);
      const roundMessageId = parseIdParam(c, 'roundMessageId');
      const roundSnapshotId = parseIdParam(c, 'roundSnapshotId');
      if (!roundSnapshotAllowed(id, roundMessageId, roundSnapshotId)) {
        return notFound(c, 'round snapshot not found');
      }
      const body = await parseJsonBody<{ fingerprint?: string }>(c);
      if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
      return c.json(await service.revertRoundHunk(roundSnapshotId, body.fingerprint));
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundMessageId/file/:roundSnapshotId/accept',
    async (c) => {
      const id = parseIdParam(c);
      const roundMessageId = parseIdParam(c, 'roundMessageId');
      const roundSnapshotId = parseIdParam(c, 'roundSnapshotId');
      if (!roundSnapshotAllowed(id, roundMessageId, roundSnapshotId)) {
        return notFound(c, 'round snapshot not found');
      }
      return c.json(await service.acceptRoundFile(roundSnapshotId));
    },
  );

  app.post(
    '/api/coder/sessions/:id/snapshot/round/:roundMessageId/file/:roundSnapshotId/revert',
    async (c) => {
      const id = parseIdParam(c);
      const roundMessageId = parseIdParam(c, 'roundMessageId');
      const roundSnapshotId = parseIdParam(c, 'roundSnapshotId');
      if (!roundSnapshotAllowed(id, roundMessageId, roundSnapshotId)) {
        return notFound(c, 'round snapshot not found');
      }
      return c.json(await service.revertRoundFile(roundSnapshotId));
    },
  );

  app.post('/api/coder/sessions/:id/snapshot/round/:roundMessageId/revert-all', async (c) => {
    const id = parseIdParam(c);
    const roundMessageId = parseIdParam(c, 'roundMessageId');
    if (!roundContextRows(id, roundMessageId)) return notFound(c, 'round not found');
    const body = await parseJsonBody<{ confirm?: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const result = await service.revertRoundAll('coder', id, roundMessageId);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post('/api/coder/sessions/:id/snapshot/round/:roundMessageId/review', async (c) => {
    const id = parseIdParam(c);
    const roundMessageId = parseIdParam(c, 'roundMessageId');
    const rows = roundContextRows(id, roundMessageId);
    if (!rows) return notFound(c, 'round not found');
    const diffs = filterReviewableDiffs((await Promise.all(
      rows.map((row) => service.getRoundDiff(row.id, { context: 3 })),
    )).filter((diff): diff is FileDiff => !!diff));
    const pendingHunks = diffs.reduce(
      (sum, diff) => sum + diff.hunks.filter((hunk) => hunk.decision === 'pending').length,
      0,
    );
    if (pendingHunks === 0) {
      snapshotStore.replaceRoundReviewFindings(rows.map((row) => row.id), []);
      return c.json({ reviews: [], message: 'No pending round diff hunks to review.' });
    }
    let intent: string | null = null;
    try { intent = buildSessionIntent(sessionStore, id); } catch { /* best effort */ }
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
    const reviews = snapshotStore.replaceRoundReviewFindings(
      rows.map((row) => row.id),
      findings,
    );
    return c.json({ reviews });
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/accept-hunk', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.acceptHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/revert-hunk', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.revertHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/accept', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const r = await service.acceptFile(baselineId);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/file/:baselineId/revert', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const r = await service.revertFile(baselineId);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/accept-all', async (c) => {
    const id = parseIdParam(c);
    const r = await service.acceptAll('coder', id);
    return c.json(r);
  });

  app.post('/api/coder/sessions/:id/snapshot/revert-all', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ confirm: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const r = await service.revertAll('coder', id);
    return c.json(r);
  });

  mountSnapshotReviewRoutes(app, deps, { scope: 'coder' });
}
