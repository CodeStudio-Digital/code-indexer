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

export interface CompanyAgentRun {
  id: number;
  company_session_id: number;
  role: string;
  coder_session_id: number;
  project_ids_json: string;
  provider: string;
  model: string;
  status: AgentRunStatus;
  status_message: string;
  created_at: string;
  updated_at: string;
  /** Null = active; non-null = belongs to that archived snapshot (migration 038). */
  archive_id: number | null;
}
