import { emptyLegacyPipeline, parseLegacyPipeline } from '@mcp/app-studio/workflow/legacy.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import { parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { migrateLegacyWorkflow } from '@mcp/app-studio/workflow/migration.js';
import { deriveAppWorkflowState, parseAppWorkflowState, serializeAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import type { AppApproval, AppDecisionRequest, AppDeliveryBlueprint, AppWorkflowView, AppWorkItem } from '@mcp/app-studio/workflow/types.js';
import type { AppStudioApproval, AppStudioDecisionRequest, AppStudioWorkItem } from '@mcp/store/app-studio-store.js';
import type { ServerDeps } from '../../deps.js';

const json = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export function hydrateWorkflowWorkItem({ depends_on_json, source_ids_json, acceptance_json, evidence_json, file_scope_json, run_json, ...row }: AppStudioWorkItem): AppWorkItem {
  return {
    ...row,
    depends_on: json(depends_on_json, []),
    source_ids: json(source_ids_json, []),
    acceptance: json(acceptance_json, []),
    evidence: json(evidence_json, []),
    file_scope: json(file_scope_json, []),
    run: json(run_json, null),
  };
}

const hydrateApproval = ({ bundle_json, ...row }: AppStudioApproval): AppApproval => ({ ...row, bundle: json(bundle_json, {}) });
const hydrateDecision = ({ options_json, blocked_work_item_ids_json, ...row }: AppStudioDecisionRequest): AppDecisionRequest => ({
  ...row,
  options: json(options_json, []),
  blocked_work_item_ids: json(blocked_work_item_ids_json, []),
});

function ensureCoordinator(deps: ServerDeps, appSessionId: number): number | null {
  const session = deps.appStudioStore.getSession(appSessionId);
  if (!session) return null;
  if (session.coordinator_session_id && deps.sessionStore.getSession(session.coordinator_session_id)) {
    deps.sessionStore.setSessionAgent(session.coordinator_session_id, 'app_orchestrator');
    return session.coordinator_session_id;
  }
  const sessions = deps.sessionStore.listSessions(session.project_id, { archived: null });
  const candidate = sessions.filter((item) => item.agent === 'app_orchestrator').sort((a, b) => a.id - b.id)[0]
    ?? sessions.filter((item) => item.agent === 'builder' && item.title === session.name).sort((a, b) => a.id - b.id)[0];
  if (!candidate) {
    const configured = deps.providerStore.getGeneralDefault();
    const fallback = deps.providerStore.getDefaultProviderAndModel();
    const provider = configured
      ? (deps.providerStore.getProvider(configured.providerId)?.kind ?? configured.providerId)
      : fallback.kind;
    const created = deps.sessionStore.createSession({
      project_id: session.project_id,
      title: session.name,
      provider,
      model: configured?.modelId ?? fallback.model ?? '',
      agent: 'app_orchestrator',
    });
    deps.appStudioStore.setCoordinatorSessionId(session.id, created.id);
    return created.id;
  }
  deps.sessionStore.setSessionAgent(candidate.id, 'app_orchestrator');
  deps.appStudioStore.setCoordinatorSessionId(session.id, candidate.id);
  return candidate.id;
}

function migrateIfNeeded(deps: ServerDeps, appSessionId: number): void {
  const session = deps.appStudioStore.getSession(appSessionId);
  if (!session || parseAppWorkflowState(session.pipeline_json)) return;
  const legacy = parseLegacyPipeline(session.pipeline_json) ?? emptyLegacyPipeline();
  const productRevision = deps.appStudioStore.getLatestProductRevision(session.id);
  const wireframeRevision = deps.appStudioStore.getLatestWireframeRevision(session.id);
  const specRevision = deps.appStudioStore.getLatestApprovedSpecRevision(session.id);
  const architectureRevision = deps.appStudioStore.getLatestArchitectureRevision(session.id);
  const uxRevision = deps.appStudioStore.getLatestUxRevision(session.id);
  const product = parseAppProductModel(productRevision?.product_json);
  const wireframe = parseAppWireframePlan(wireframeRevision?.wireframe_json);
  const legacyBuild = wireframeRevision
    ? deps.appStudioStore.readLegacyBuildProgress(wireframeRevision.id)
    : { groups: [], tasks: [] };
  const migration = migrateLegacyWorkflow({
    app_session_id: session.id,
    pipeline: legacy,
    spec: parseAppSpec(session.spec_json),
    product,
    wireframe,
    build_groups: legacyBuild.groups,
    build_tasks: legacyBuild.tasks,
    feature_names: deps.appStudioStore.readLegacyFeatureNames(session.id),
    refs: {
      spec_revision_id: specRevision?.id ?? null,
      product_revision_id: productRevision?.id ?? null,
      architecture_revision_id: architectureRevision?.id ?? null,
      ux_revision_id: uxRevision?.id ?? null,
      wireframe_revision_id: wireframeRevision?.id ?? null,
    },
  });
  deps.appStudioStore.applyWorkflowMigration({
    sessionId: session.id,
    sourceVersion: legacy.v,
    previousStateJson: session.pipeline_json,
    workflowJson: serializeAppWorkflowState(migration.state),
    workItems: migration.work_items.map((item) => ({
      ...item,
      depends_on_json: JSON.stringify(item.depends_on),
      source_ids_json: JSON.stringify(item.source_ids),
      acceptance_json: JSON.stringify(item.acceptance),
      evidence_json: JSON.stringify(item.evidence),
      file_scope_json: JSON.stringify(item.file_scope),
      run_json: item.run ? JSON.stringify(item.run) : null,
    })),
    approvals: migration.approvals.map((approval) => ({
      type: approval.type,
      status: approval.status,
      bundleRevision: approval.bundle_revision,
      bundleJson: JSON.stringify(approval.bundle),
      summary: approval.summary,
      feedback: approval.feedback,
    })),
    blueprintJson: migration.blueprint ? JSON.stringify(migration.blueprint) : null,
  });
}

export function getAppWorkflowView(deps: ServerDeps, appSessionId: number): AppWorkflowView | null {
  const session = deps.appStudioStore.getSession(appSessionId);
  if (!session) return null;
  migrateIfNeeded(deps, appSessionId);
  const current = deps.appStudioStore.getSession(appSessionId)!;
  const coordinator = ensureCoordinator(deps, appSessionId);
  const state = parseAppWorkflowState(current.pipeline_json);
  if (!state) return null;
  const workItems = deps.appStudioStore.listWorkItems(appSessionId).map(hydrateWorkflowWorkItem);
  const approvals = deps.appStudioStore.listApprovals(appSessionId).map(hydrateApproval);
  const decisions = deps.appStudioStore.listDecisionRequests(appSessionId).map(hydrateDecision);
  const blueprintRow = deps.appStudioStore.getLatestDeliveryBlueprint(appSessionId);
  const blueprint = json<AppDeliveryBlueprint | null>(blueprintRow?.blueprint_json, null);
  const derived = deriveAppWorkflowState(state, approvals, workItems);
  if (serializeAppWorkflowState(derived) !== current.pipeline_json) {
    deps.appStudioStore.setWorkflowStateJson(appSessionId, serializeAppWorkflowState(derived));
  }
  return {
    state: derived,
    work_items: workItems,
    approvals,
    decisions,
    blueprint,
    coordinator_session_id: coordinator,
    attention: {
      approval_ids: approvals.filter((item) => item.status === 'pending').map((item) => item.id),
      decision_ids: decisions.filter((item) => item.status === 'open').map((item) => item.id),
    },
  };
}
