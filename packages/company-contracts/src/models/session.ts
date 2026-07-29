export type CompanySessionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';
export type CompanyRuntimeKind = 'company' | 'app_studio';

/**
 * Server-resolved runtime surface. Persist only `runtime_kind`; the remaining
 * fields are derived so clients and workers cannot widen a session's powers by
 * editing config_json.
 */
export interface CompanySessionCapabilities {
  runtimeKind: CompanyRuntimeKind;
  appStudioSessionId: string | null;
  promptProfile: 'company' | 'app_studio';
  toolProfile: 'company' | 'app_studio';
  autonomyPolicy: 'company' | 'controlled_app_work';
  workSource: 'company_kanban' | 'app_workflow';
  allowAppTools: boolean;
  allowCompanyKanban: boolean;
  allowCompanyPipelines: boolean;
  allowCompanyScheduler: boolean;
  allowAppScheduler: boolean;
  allowFreeSubordinateSpawn: boolean;
}

export interface CompanySession {
  id: string;
  template_id: number | null;
  /** Selects the server-owned orchestration capability for this session. */
  runtime_kind: CompanyRuntimeKind;
  name: string;
  status: CompanySessionStatus;
  master_session_id: string | null;
  config_json: string;
  /**
   * Multi-front via sub-sessions (migration 067): when set, this row is
   * a child "tab" of `parent_session_id` and shares
   * sandbox/projects/kanban/pipelines with the parent. NULL = root
   * session (a parent or a standalone single-tab session).
   */
  parent_session_id: string | null;
  /**
   * Soft-delete timestamp (migration 087). Set when a sub-session
   * ("front") is archived from `FrontTabsBar`; `listChildSessions`
   * filters these out so the tab stays gone after reload. NULL for
   * active sessions and for parent rows (which use the reset flow).
   */
  archived_at?: string | null;
  /**
   * P15c — set by `recoverStaleAgentRuns()` at boot when a `running`
   * session is swept back to `paused` (the server crashed/restarted
   * mid-run). Cleared by `clearSessionRecoveryFlag` on next resurrection.
   */
  recovered_at?: string | null;
  /** Free-form reason for the most recent recovery (e.g. 'server_restart'). */
  recovered_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanySessionProject {
  company_session_id: string;
  project_id: number;
  label: string | null;
}

export interface CompanySessionArchive {
  id: string;
  company_session_id: string;
  archived_at: string;
  reason: string | null;
  included_kanban: boolean;
  included_sandbox: boolean;
  stats: {
    agent_runs: number;
    board_entries: number;
    master_prompts: number;
    kanban_cards: number;
  };
}
