export type AgentRunStatus =
  | 'idle'
  | 'running'
  | 'working'
  | 'waiting'
  | 'waiting_plan'
  | 'waiting_question'
  | 'waiting_tasks'
  | 'reviewing'
  | 'blocked'
  | 'completed'
  | 'error'
  | 'aborted'
  | 'paused'
  | 'interrupted';

export type CompanyAgentDispatchSource =
  | 'company'
  | 'manual'
  | 'scheduler'
  | 'fanout'
  | 'app_studio'
  | 'retry';

export interface CompanyAgentRun {
  id: string;
  company_session_id: string;
  role: string;
  coder_session_id: string;
  project_ids_json: string;
  provider: string;
  model: string;
  /** Provider/model selected by the persisted role before any explicit fallback. */
  configured_provider: string;
  configured_model: string;
  /** Runtime entry point that created this run. */
  dispatch_source: CompanyAgentDispatchSource;
  /** Null unless an explicitly configured fallback changed the effective model. */
  fallback_reason: string | null;
  status: AgentRunStatus;
  status_message: string;
  created_at: string;
  updated_at: string;
  /** Null = active; non-null = belongs to that archived snapshot (migration 038). */
  archive_id: string | null;
}
