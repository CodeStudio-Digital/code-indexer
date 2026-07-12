import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { repairAppPipeline } from '@mcp/app-studio/pipeline/repair.js';
import { parsePipelineState, serializePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { auditAppUxBrief, auditAppWireframePlan } from '@mcp/app-studio/experience/audit.js';
import { dataModelFingerprint, parseAppUxBrief, parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { recoveredUxDraft, recoveredWireframeDraft } from '@mcp/app-studio/experience/recover.js';
import { serializeExperienceArtifact } from '@mcp/app-studio/experience/types.js';
import { auditAppProductModel } from '@mcp/app-studio/product/audit.js';
import { recoverProductModel } from '@mcp/app-studio/product/recover.js';
import { parseAppProductModel, productModelFingerprint, serializeAppProductModel } from '@mcp/app-studio/product/types.js';
import {
  analyzeAppWorkspaceRepair,
  applyAppWorkspaceRepair,
  restoreAppWorkspaceRepair,
  validateAppWorkspaceRepairUndo,
  type AppRepairAction,
  type AppRepairIssue,
  type AppWorkspaceRepairApplication,
  type AppWorkspaceRepairInput,
} from '@mcp/services/app-studio/index.js';
import { notFound, parseIdParam, parseJsonBody } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

type RepairAreaId = 'workspace' | 'database' | 'pipeline';
type RepairAreaStatus = 'healthy' | 'repairable' | 'attention';

interface RepairArea {
  id: RepairAreaId;
  status: RepairAreaStatus;
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string; repairable: boolean }>;
  actions: Array<{ title: string; reason: string }>;
}

function token(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

function builderPort(raw: string | null): number {
  if (!raw) return 5173;
  try {
    const port = (JSON.parse(raw) as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : 5173;
  } catch {
    return 5173;
  }
}

function areaStatus(issues: RepairArea['issues'], actions: RepairArea['actions']): RepairAreaStatus {
  if (issues.some((issue) => !issue.repairable)) return 'attention';
  if (actions.length > 0) return 'repairable';
  return 'healthy';
}

function workspaceArea(id: 'workspace' | 'database', issues: AppRepairIssue[], actions: AppRepairAction[]): RepairArea {
  const areaIssues = issues.filter((issue) => {
    if (id === 'database') return issue.code.includes('database') || issue.code.includes('migration') || issue.code.includes('seed');
    return !issue.code.includes('database') && !issue.code.includes('migration') && !issue.code.includes('seed');
  });
  const areaActions = actions.filter((action) => action.area === id).map(({ title, reason }) => ({ title, reason }));
  return { id, status: areaStatus(areaIssues, areaActions), issues: areaIssues, actions: areaActions };
}

export function mountAppStudioPipelineRepairRoutes(app: Hono, deps: ServerDeps): void {
  const analyze = async (sessionId: number) => {
    const session = deps.appStudioStore.getSession(sessionId);
    if (!session) return null;
    const project = deps.db.getProject(session.project_id);
    if (!project?.root_path) throw new Error('O workspace deste app nao foi encontrado.');

    const spec = parseAppSpec(session.spec_json);
    const approvedSpec = deps.appStudioStore.getLatestApprovedSpecRevision(sessionId);
    const architectureRevision = deps.appStudioStore.getLatestArchitectureRevision(sessionId);
    const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
    const uxRevision = deps.appStudioStore.getLatestUxRevision(sessionId);
    const ux = parseAppUxBrief(uxRevision?.ux_json);
    const wireframeRevision = deps.appStudioStore.getLatestWireframeRevision(sessionId);
    const wireframe = parseAppWireframePlan(wireframeRevision?.wireframe_json);
    const productRevision = deps.appStudioStore.getLatestProductRevision(sessionId);
    const product = parseAppProductModel(productRevision?.product_json);
    const pipelineReport = repairAppPipeline(parsePipelineState(session.pipeline_json), {
      spec,
      approvedSpecRevisionId: approvedSpec?.id ?? null,
      product: productRevision && product ? {
        revisionId: productRevision.id,
        status: productRevision.status,
        baseSpecRevisionId: productRevision.base_spec_revision_id,
        resultSpecRevisionId: productRevision.result_spec_revision_id,
        auditOk: auditAppProductModel(product).ok,
      } : null,
      architecture: architectureRevision && architecture ? {
        revisionId: architectureRevision.id,
        status: architectureRevision.status,
        specRevisionId: architectureRevision.spec_revision_id,
        auditOk: auditAppArchitecture(architecture, spec, product).ok,
      } : null,
      ux: uxRevision && ux ? {
        revisionId: uxRevision.id,
        status: uxRevision.status,
        specRevisionId: uxRevision.spec_revision_id,
        architectureRevisionId: uxRevision.architecture_revision_id,
        dataFingerprint: uxRevision.data_fingerprint,
        auditOk: auditAppUxBrief(ux).ok,
      } : null,
      wireframe: wireframeRevision && wireframe ? {
        status: wireframeRevision.status,
        specRevisionId: wireframeRevision.spec_revision_id,
        architectureRevisionId: wireframeRevision.architecture_revision_id,
        uxRevisionId: wireframeRevision.ux_revision_id,
        dataFingerprint: wireframeRevision.data_fingerprint,
        auditOk: auditAppWireframePlan(wireframe, spec, architecture, product).ok,
      } : null,
      currentDataFingerprint: dataModelFingerprint(spec),
      deployHealthy: deployHealthy(session.deploy_json),
    });
    const workspaceInput: AppWorkspaceRepairInput = {
      workspaceDir: project.root_path,
      appSlug: session.app_slug,
      appName: session.name,
      port: builderPort(project.builder_json),
    };
    const workspace = await analyzeAppWorkspaceRepair(workspaceInput);
    const pipelineIssues = pipelineReport.issues.map((issue) => ({ ...issue, repairable: true }));
    const pipelineActions = pipelineReport.changes.map((change) => ({ title: change.stage_id ?? 'roadmap', reason: change.reason }));
    if (pipelineReport.changed && pipelineActions.length === 0) {
      pipelineActions.push({ title: 'pipeline', reason: 'Reconstruir o estado da jornada a partir das evidencias persistidas.' });
    }
    const pipelineArea: RepairArea = {
      id: 'pipeline',
      status: areaStatus(pipelineIssues, pipelineActions),
      issues: pipelineIssues,
      actions: pipelineActions,
    };
    const areas = [
      workspaceArea('workspace', workspace.issues, workspace.actions),
      workspaceArea('database', workspace.issues, workspace.actions),
      pipelineArea,
    ];
    const report = {
      changed: workspace.changed || pipelineReport.changed,
      healthy: areas.every((area) => area.status === 'healthy'),
      action_count: areas.reduce((sum, area) => sum + area.actions.length, 0),
      areas,
      workspace,
      pipeline_report: pipelineReport,
      pipeline: pipelineReport.pipeline,
    };
    return {
      session,
      workspaceInput,
      report,
      previewToken: token({ pipeline: session.pipeline_json, workspace: workspace.fingerprint, product: productRevision ? { id: productRevision.id, updated_at: productRevision.updated_at } : null }),
    };
  };

  const preview = async (c: Context) => {
    try {
      const analysis = await analyze(parseIdParam(c));
      if (!analysis) return notFound(c);
      return c.json({ preview_token: analysis.previewToken, report: analysis.report });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  };

  const apply = async (c: Context) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ preview_token?: string }>(c);
    try {
      const analysis = await analyze(id);
      if (!analysis) return notFound(c);
      if (!body.preview_token || body.preview_token !== analysis.previewToken) {
        return c.json({ error: 'O app mudou desde a verificacao. Verifique novamente antes de reparar.' }, 409);
      }
      if (!analysis.report.changed) {
        return c.json({ report: analysis.report, repair_id: null, session: analysis.session });
      }

      let application: AppWorkspaceRepairApplication | null = null;
      let experience: { productRevisionId?: number; uxRevisionId?: number; wireframeRevisionId?: number } = {};
      try {
        if (analysis.report.workspace.changed) {
          application = await applyAppWorkspaceRepair(analysis.workspaceInput, analysis.report.workspace);
        }
        const spec = parseAppSpec(analysis.session.spec_json);
        const approvedSpec = deps.appStudioStore.getLatestApprovedSpecRevision(id);
        if (spec && !deps.appStudioStore.getLatestProductRevision(id)) {
          const model = recoverProductModel(spec, approvedSpec?.id ?? null);
          const revision = deps.appStudioStore.saveProductRevision({
            app_session_id: id,
            base_spec_revision_id: approvedSpec?.id ?? null,
            complexity: model.complexity,
            research_fingerprint: productModelFingerprint(model),
            product_json: serializeAppProductModel(model),
            created_by: 'repair',
          });
          experience.productRevisionId = revision.id;
        }
        const architectureRevision = deps.appStudioStore.getLatestApprovedArchitectureRevision(id);
        const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
        if (spec && architectureRevision && !deps.appStudioStore.getLatestUxRevision(id)) {
          const draft = recoveredUxDraft(spec, { specRevisionId: approvedSpec?.id ?? null, architectureRevisionId: architectureRevision.id });
          const revision = deps.appStudioStore.saveUxRevision({ app_session_id: id, spec_revision_id: approvedSpec?.id ?? null, architecture_revision_id: architectureRevision.id, data_fingerprint: draft.data_fingerprint, ux_json: serializeExperienceArtifact(draft), created_by: 'repair' });
          experience.uxRevisionId = revision.id;
        }
        const uxRevision = deps.appStudioStore.getLatestUxRevision(id);
        if (spec && architectureRevision && uxRevision && !deps.appStudioStore.getLatestWireframeRevision(id)) {
          const draft = recoveredWireframeDraft(spec, architecture, { specRevisionId: approvedSpec?.id ?? null, architectureRevisionId: architectureRevision.id, uxRevisionId: uxRevision.id });
          const revision = deps.appStudioStore.saveWireframeRevision({ app_session_id: id, spec_revision_id: approvedSpec?.id ?? null, architecture_revision_id: architectureRevision.id, ux_revision_id: uxRevision.id, data_fingerprint: draft.data_fingerprint, wireframe_json: serializeExperienceArtifact(draft), created_by: 'repair' });
          experience.wireframeRevisionId = revision.id;
        }
        const result = deps.appStudioStore.applyPipelineRepair({
          app_session_id: id,
          before_pipeline_json: analysis.session.pipeline_json,
          after_pipeline_json: serializePipelineState(analysis.report.pipeline),
          report_json: JSON.stringify({ ...analysis.report, application, experience }),
        });
        return c.json({ report: analysis.report, repair_id: result.repair.id, session: result.session });
      } catch (e) {
        if (experience.wireframeRevisionId) deps.appStudioStore.deleteDraftWireframeRevision(id, experience.wireframeRevisionId);
        if (experience.uxRevisionId) deps.appStudioStore.deleteDraftUxRevision(id, experience.uxRevisionId);
        if (experience.productRevisionId) deps.appStudioStore.deleteDraftProductRevision(id, experience.productRevisionId);
        if (application) restoreAppWorkspaceRepair(analysis.workspaceInput.workspaceDir, application);
        throw e;
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  };

  const undo = (c: Context) => {
    const id = Number(c.req.param('id'));
    const repairId = Number(c.req.param('repairId'));
    if (!Number.isFinite(id) || !Number.isFinite(repairId)) return c.json({ error: 'Invalid repair id.' }, 400);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const repair = deps.appStudioStore.getPipelineRepair(repairId);
    if (!repair || repair.app_session_id !== id) return notFound(c);
    try {
      const project = deps.db.getProject(session.project_id);
      if (!project?.root_path) throw new Error('O workspace deste app nao foi encontrado.');
      const stored = JSON.parse(repair.report_json) as { application?: AppWorkspaceRepairApplication | null; experience?: { productRevisionId?: number; uxRevisionId?: number; wireframeRevisionId?: number } };
      if (stored.application) validateAppWorkspaceRepairUndo(project.root_path, stored.application);
      const result = deps.appStudioStore.undoPipelineRepair(id, repairId);
      if (stored.experience?.wireframeRevisionId) deps.appStudioStore.deleteDraftWireframeRevision(id, stored.experience.wireframeRevisionId);
      if (stored.experience?.uxRevisionId) deps.appStudioStore.deleteDraftUxRevision(id, stored.experience.uxRevisionId);
      if (stored.experience?.productRevisionId) deps.appStudioStore.deleteDraftProductRevision(id, stored.experience.productRevisionId);
      if (stored.application) restoreAppWorkspaceRepair(project.root_path, stored.application);
      return c.json({ repair: result.repair, session: result.session });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  };

  app.post('/api/app-studio/sessions/:id/repair/preview', preview);
  app.post('/api/app-studio/sessions/:id/repair', apply);
  app.post('/api/app-studio/sessions/:id/repair/:repairId/undo', undo);
}
