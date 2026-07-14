import type { LegacyAppPipelineState } from './legacy.js';
import type { AppSpec } from '../spec/types.js';
import type { AppProductModel } from '../product/types.js';
import type { AppWireframePlan } from '../experience/types.js';
import type { AppApproval, AppDeliveryBlueprint, AppWorkflowState, AppWorkItem, AppWorkItemKind } from './types.js';
import { createAppWorkflowState } from './state.js';

interface LegacyBuildTask { task_id: string; status: 'pending' | 'active' | 'done'; summary: string | null; evidence_json: string | null }
interface LegacyBuildGroup { group_id: string; status: 'pending' | 'active' | 'review' | 'approved' }

export interface LegacyWorkflowContext {
  app_session_id: number;
  pipeline: LegacyAppPipelineState;
  spec: AppSpec | null;
  product: AppProductModel | null;
  wireframe: AppWireframePlan | null;
  build_groups: LegacyBuildGroup[];
  build_tasks: LegacyBuildTask[];
  feature_names: string[];
  refs: AppDeliveryBlueprint['refs'];
}

export interface LegacyWorkflowMigration {
  state: AppWorkflowState;
  work_items: Array<Omit<AppWorkItem, 'created_at' | 'updated_at'>>;
  approvals: Array<Omit<AppApproval, 'id' | 'requested_at' | 'resolved_at'>>;
  blueprint: AppDeliveryBlueprint | null;
}

const approved = (pipeline: LegacyAppPipelineState, ids: string[]): boolean => ids.every((id) => {
  const stage = pipeline.stages.find((item) => item.id === id);
  return !stage || stage.status === 'approved' || stage.status === 'skipped';
});

function kindOfLegacyTask(kind: string): AppWorkItemKind {
  if (kind === 'test-red' || kind === 'mock-contract') return 'contract';
  if (kind === 'test-green' || kind === 'preview' || kind === 'accessibility') return 'verify';
  return 'implement';
}

export function migrateLegacyWorkflow(context: LegacyWorkflowContext): LegacyWorkflowMigration {
  const state = createAppWorkflowState(context.pipeline.v);
  const nowless = (input: Omit<AppWorkItem, 'created_at' | 'updated_at'>) => input;
  const checklistItems = context.wireframe?.checklist_items ?? [];
  const evidenceById = new Map(context.build_tasks.map((task) => [task.task_id, task]));
  const groupById = new Map(context.build_groups.map((group) => [group.group_id, group]));
  const workItems = checklistItems.map((item, index) => {
    const evidence = evidenceById.get(item.id);
    const group = groupById.get(item.slice_id);
    const status = evidence?.status === 'done' || group?.status === 'approved'
      ? 'done'
      : group?.status === 'review'
        ? 'review'
        : evidence?.status === 'active' || group?.status === 'active'
          ? 'running'
          : index === 0
            ? 'ready'
            : 'backlog';
    return nowless({
      id: `legacy:${item.id}`,
      app_session_id: context.app_session_id,
      phase: 'build',
      slice_id: item.slice_id,
      title: item.title,
      outcome: evidence?.summary ?? item.title,
      kind: kindOfLegacyTask(item.kind),
      owner_profile: kindOfLegacyTask(item.kind) === 'verify' ? 'verify' : 'implement',
      priority: 2,
      revision: 1,
      status,
      sort_order: index,
      depends_on: item.depends_on.map((id) => `legacy:${id}`),
      source_ids: [...item.source_ids, ...item.tdd_case_ids.map((id) => `test:${id}`), ...(item.screen_id ? [`screen:${item.screen_id}`] : [])],
      acceptance: item.tdd_case_ids,
      evidence: evidence?.evidence_json
        ? [{ kind: 'legacy', value: evidence.evidence_json }]
        : status === 'done'
          ? [{ kind: 'legacy-migration', value: evidence?.summary ?? `Preserved approved slice ${item.slice_id}.` }]
          : [],
      file_scope: [],
      blocked_reason: null,
      run: null,
    });
  });
  if (workItems.length === 0) {
    context.feature_names.forEach((name, index) => workItems.push(nowless({
      id: `legacy:feature:${name}`,
      app_session_id: context.app_session_id,
      phase: 'build',
      slice_id: null,
      title: name,
      outcome: 'Deliverable preservado da jornada anterior.',
      kind: 'implement', owner_profile: 'implement', priority: 2, revision: 1, status: 'done', sort_order: index,
      depends_on: [], source_ids: [], acceptance: [], evidence: [{ kind: 'legacy-feature', value: name }], file_scope: [], blocked_reason: null, run: null,
    })));
  }

  const approvalRows: LegacyWorkflowMigration['approvals'] = [];
  const addApproval = (type: AppApproval['type'], isApproved: boolean, summary: string) => approvalRows.push({
    app_session_id: context.app_session_id,
    type,
    status: isApproved ? 'approved' : 'changes_requested',
    bundle_revision: 1,
    bundle: context.refs,
    summary,
    feedback: isApproved ? null : 'Importado da jornada anterior; revise o pacote consolidado.',
  });
  addApproval('scope', approved(context.pipeline, ['discovery', 'product']), 'Escopo importado da jornada anterior.');
  addApproval('blueprint', approved(context.pipeline, ['architecture', 'database', 'ux', 'wireframe']), 'Blueprint importado da jornada anterior.');
  addApproval('release', approved(context.pipeline, ['review', 'launch']), 'Release importado da jornada anterior.');

  const blueprint: AppDeliveryBlueprint | null = context.wireframe ? {
    v: 1,
    refs: context.refs,
    slices: context.wireframe.delivery_slices.map((slice) => ({
      id: slice.id,
      capability_ids: slice.capability_ids,
      journey_ids: [],
      source_ids: context.wireframe!.flows.filter((flow) => slice.flow_ids.includes(flow.id)).flatMap((flow) => flow.source_ids),
      screen_ids: slice.screen_ids,
      entity_names: [],
      behavior_ids: [],
      acceptance_test_ids: context.wireframe!.checklist_items.filter((item) => item.slice_id === slice.id).flatMap((item) => item.tdd_case_ids),
      work_item_ids: context.wireframe!.checklist_items.filter((item) => item.slice_id === slice.id).map((item) => `legacy:${item.id}`),
    })),
    test_matrix: context.wireframe.tdd_cases.map((test) => ({
      id: test.id,
      source_ids: test.source_ids,
      slice_id: context.wireframe!.delivery_slices.find((slice) => slice.flow_ids.some((id) => test.flow_ids.includes(id)))?.id ?? 'unassigned',
      kind: 'interface',
    })),
  } : null;

  return { state, work_items: workItems, approvals: approvalRows, blueprint };
}
