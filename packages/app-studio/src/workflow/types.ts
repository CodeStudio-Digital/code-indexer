export const APP_WORKFLOW_PHASE_IDS = ['define', 'blueprint', 'build', 'deliver'] as const;
export type AppWorkflowPhaseId = (typeof APP_WORKFLOW_PHASE_IDS)[number];

export type AppWorkflowPhaseStatus = 'locked' | 'active' | 'attention' | 'complete';
export type AppWorkItemStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'stale' | 'cancelled';
export type AppWorkItemKind = 'research' | 'plan' | 'contract' | 'implement' | 'verify' | 'release' | 'change';
export type AppApprovalType = 'scope' | 'blueprint' | 'release';
export type AppApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'superseded';

export interface AppWorkflowBundleRefs {
  spec_revision_id?: number | null;
  product_revision_id?: number | null;
  architecture_revision_id?: number | null;
  ux_revision_id?: number | null;
  wireframe_revision_id?: number | null;
  delivery_blueprint_id?: number | null;
}

export interface AppWorkflowPhase {
  id: AppWorkflowPhaseId;
  status: AppWorkflowPhaseStatus;
  bundle: AppWorkflowBundleRefs;
}

export interface AppWorkflowState {
  v: 5;
  phases: AppWorkflowPhase[];
  release_unlocked: boolean;
  migrated_from: number | null;
  migrated_at: string | null;
}

export interface AppWorkItem {
  id: string;
  app_session_id: number;
  phase: AppWorkflowPhaseId;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: AppWorkItemKind;
  owner_profile: string;
  priority: number;
  revision: number;
  status: AppWorkItemStatus;
  sort_order: number;
  depends_on: string[];
  source_ids: string[];
  acceptance: string[];
  evidence: Array<{ kind: string; value: string; recorded_at?: string }>;
  file_scope: string[];
  blocked_reason: string | null;
  run: { mode?: 'inline' | 'subagent'; run_id?: string; agent?: string; corrects_work_item_id?: string } | null;
  created_at: string;
  updated_at: string;
}

export interface AppApproval {
  id: number;
  app_session_id: number;
  type: AppApprovalType;
  status: AppApprovalStatus;
  bundle_revision: number;
  bundle: AppWorkflowBundleRefs;
  summary: string;
  feedback: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface AppDecisionRequest {
  id: number;
  app_session_id: number;
  question: string;
  options: Array<{ label: string; value: string }>;
  blocked_work_item_ids: string[];
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface AppVerticalSlice {
  id: string;
  capability_ids: string[];
  journey_ids: string[];
  source_ids: string[];
  screen_ids: string[];
  entity_names: string[];
  behavior_ids: string[];
  acceptance_test_ids: string[];
  work_item_ids: string[];
}

export interface AppDeliveryBlueprint {
  v: 1;
  refs: AppWorkflowBundleRefs;
  slices: AppVerticalSlice[];
  test_matrix: Array<{ id: string; source_ids: string[]; slice_id: string; kind: string }>;
}

export interface AppWorkflowEvent {
  id: number;
  app_session_id: number;
  kind: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: string;
}

export interface AppWorkflowView {
  state: AppWorkflowState;
  work_items: AppWorkItem[];
  approvals: AppApproval[];
  decisions: AppDecisionRequest[];
  blueprint: AppDeliveryBlueprint | null;
  coordinator_session_id: number | null;
  attention: { approval_ids: number[]; decision_ids: number[] };
}
