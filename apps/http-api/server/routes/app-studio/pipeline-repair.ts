import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { repairAppPipeline } from '@mcp/app-studio/pipeline/repair.js';
import { parsePipelineState, serializePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { notFound, parseIdParam, parseJsonBody } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

function token(raw: string | null): string {
  return createHash('sha256').update(raw ?? '<null>').digest('hex');
}

function deployHealthy(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { health_ok?: boolean } | null;
    return parsed?.health_ok === true;
  } catch {
    return false;
  }
}

export function mountAppStudioPipelineRepairRoutes(app: Hono, deps: ServerDeps): void {
  const analyze = (sessionId: number) => {
    const session = deps.appStudioStore.getSession(sessionId);
    if (!session) return null;
    const spec = parseAppSpec(session.spec_json);
    const approvedSpec = deps.appStudioStore.getLatestApprovedSpecRevision(sessionId);
    const architectureRevision = deps.appStudioStore.getLatestArchitectureRevision(sessionId);
    const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
    return {
      session,
      report: repairAppPipeline(parsePipelineState(session.pipeline_json), {
        spec,
        approvedSpecRevisionId: approvedSpec?.id ?? null,
        architecture: architectureRevision && architecture ? {
          status: architectureRevision.status,
          specRevisionId: architectureRevision.spec_revision_id,
          auditOk: auditAppArchitecture(architecture, spec).ok,
        } : null,
        deployHealthy: deployHealthy(session.deploy_json),
      }),
    };
  };

  app.post('/api/app-studio/sessions/:id/pipeline/repair/preview', (c) => {
    const id = parseIdParam(c);
    const analysis = analyze(id);
    if (!analysis) return notFound(c);
    return c.json({
      preview_token: token(analysis.session.pipeline_json),
      report: analysis.report,
    });
  });

  app.post('/api/app-studio/sessions/:id/pipeline/repair', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ preview_token?: string }>(c);
    const analysis = analyze(id);
    if (!analysis) return notFound(c);
    if (!body.preview_token || body.preview_token !== token(analysis.session.pipeline_json)) {
      return c.json({ error: 'A jornada mudou desde a verificacao. Verifique novamente antes de reparar.' }, 409);
    }
    if (!analysis.report.changed) {
      return c.json({ report: analysis.report, repair_id: null, session: analysis.session });
    }
    try {
      const after = serializePipelineState(analysis.report.pipeline);
      const result = deps.appStudioStore.applyPipelineRepair({
        app_session_id: id,
        before_pipeline_json: analysis.session.pipeline_json,
        after_pipeline_json: after,
        report_json: JSON.stringify(analysis.report),
      });
      return c.json({ report: analysis.report, repair_id: result.repair.id, session: result.session });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.post('/api/app-studio/sessions/:id/pipeline/repair/:repairId/undo', (c) => {
    const id = Number(c.req.param('id'));
    const repairId = Number(c.req.param('repairId'));
    if (!Number.isFinite(id) || !Number.isFinite(repairId)) return c.json({ error: 'Invalid repair id.' }, 400);
    if (!deps.appStudioStore.getSession(id)) return notFound(c);
    try {
      const result = deps.appStudioStore.undoPipelineRepair(id, repairId);
      return c.json({ repair: result.repair, session: result.session });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });
}
