import { type CatalogEntry, type CompanySessionId, type FileSessionRepository, type ProjectId, type SessionCatalog, type SessionId, type SessionLocation, type SessionLocator, type SessionMetadata } from '@mcp/session-storage';
import type { AppFitnessReport, AppPlanRevisionStatus, AppPlanV1 } from '@mcp/app-studio/plan/types.js';
export type AppStudioWorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'blocked'
  | 'stale'
  | 'cancelled';

export type AppStudioWorkItemKind =
  | 'research'
  | 'plan'
  | 'contract'
  | 'implement'
  | 'verify'
  | 'release'
  | 'change';

export type AppStudioWorkItemRunStatus =
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'error'
  | 'aborted'
  | 'interrupted'
  | 'cancelled';

export interface AppStudioSession {
  id: SessionId;
  seq: number;
  project_id: ProjectId;
  company_session_id: CompanySessionId | null;
  name: string;
  app_slug: string;
  stack_profile_id: 'cf-fullstack-v1';
  created_at: string;
  updated_at: string;
}

export interface CreateAppStudioSessionInput {
  project_id: ProjectId;
  name: string;
  app_slug: string;
}

export interface AppStudioPlanRevision {
  id: string;
  seq: number;
  app_session_id: SessionId;
  revision_number: number;
  status: AppPlanRevisionStatus;
  plan_json: string;
  fitness_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

export interface SaveAppStudioPlanRevisionInput {
  app_session_id: SessionId | string;
  plan: AppPlanV1;
  fitness: AppFitnessReport;
  created_by?: string;
  expected_revision_number?: number | null;
}

export interface AppStudioWorkItem {
  app_session_id: SessionId;
  id: string;
  seq: number;
  source_id: string;
  plan_revision_id: string;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority: number;
  status: AppStudioWorkItemStatus;
  sort_order: number;
  depends_on_json: string;
  source_ids_json: string;
  acceptance_json: string;
  evidence_json: string;
  file_scope_json: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertAppStudioWorkItemInput {
  app_session_id: SessionId | string;
  /** Stable plan-local identifier. The persisted/public id is a UUID. */
  id: string;
  plan_revision_id: string;
  slice_id?: string | null;
  title: string;
  outcome?: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority?: number;
  status?: AppStudioWorkItemStatus;
  sort_order?: number;
  depends_on_json?: string;
  source_ids_json?: string;
  acceptance_json?: string;
  evidence_json?: string;
  file_scope_json?: string;
  blocked_reason?: string | null;
}

export interface AppStudioWorkItemRun {
  id: string;
  seq: number;
  app_session_id: SessionId;
  work_item_id: string;
  attempt: number;
  role: string;
  company_agent_run_id: string | null;
  coder_session_id: SessionId | null;
  status: AppStudioWorkItemRunStatus;
  runtime_config_hash: string | null;
  idempotency_key: string;
  status_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface CreateAppStudioWorkItemRunInput {
  appSessionId: SessionId | string;
  workItemId: string;
  attempt: number;
  role: string;
  companyAgentRunId?: string | null;
  coderSessionId?: SessionId | string | null;
  status?: AppStudioWorkItemRunStatus;
  runtimeConfigHash?: string | null;
  idempotencyKey?: string;
}

export interface UpdateAppStudioWorkItemRunOptions {
  companyAgentRunId?: string | null;
  coderSessionId?: SessionId | string | null;
  runtimeConfigHash?: string | null;
  statusMessage?: string | null;
}

export interface AppStudioDecision {
  id: string;
  seq: number;
  app_session_id: SessionId;
  plan_revision_id: string;
  question: string;
  options_json: string;
  blocked_work_item_ids_json: string;
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface AppStudioEvent {
  id: string;
  seq: number;
  app_session_id: SessionId;
  kind: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
}

export interface AppStudioDeployment {
  id: string;
  seq: number;
  app_session_id: SessionId;
  plan_revision_id: string;
  status: 'publishing' | 'live' | 'failed';
  url: string | null;
  account: string | null;
  database_id: string | null;
  health_ok: number;
  details_json: string;
  created_at: string;
  updated_at: string;
}

export interface AppStudioStoreHost {
  repository: FileSessionRepository & {
    runExclusive<T>(
      location: SessionLocation,
      operation: () => Promise<T>,
    ): Promise<T>;
  };
  catalog: SessionCatalog;
  locator: SessionLocator;
  getProject(projectId: ProjectId): {
    id: ProjectId;
    root_path: string;
  } | null;
}

export interface AppStudioMetadata {
  seq: number;
  project_id: ProjectId;
  company_session_id: string | null;
  name: string;
  app_slug: string;
  stack_profile_id: 'cf-fullstack-v1';
}

export interface PlanRevisionData {
  revision_number: number;
  status: AppPlanRevisionStatus;
  plan_json: string;
  fitness_json: string;
  created_by: string;
  approved_at: string | null;
}

export interface WorkItemData {
  source_id: string;
  plan_revision_id: string;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority: number;
  status: AppStudioWorkItemStatus;
  sort_order: number;
  depends_on_json: string;
  source_ids_json: string;
  acceptance_json: string;
  evidence_json: string;
  file_scope_json: string;
  blocked_reason: string | null;
}

export interface WorkItemRunData {
  work_item_id: string;
  attempt: number;
  role: string;
  company_agent_run_id: string | null;
  coder_session_id: string | null;
  status: AppStudioWorkItemRunStatus;
  runtime_config_hash: string | null;
  idempotency_key: string;
  status_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface DecisionData {
  plan_revision_id: string;
  question: string;
  options_json: string;
  blocked_work_item_ids_json: string;
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface EventData {
  kind: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  idempotency_key: string | null;
}

export interface DeploymentData {
  plan_revision_id: string;
  status: AppStudioDeployment['status'];
  url: string | null;
  account: string | null;
  database_id: string | null;
  health_ok: number;
  details_json: string;
}

export type AppEntry = CatalogEntry & { session: SessionMetadata };
