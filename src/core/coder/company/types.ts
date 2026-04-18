import type { CoderRunner } from '../core/runner.js';
import type { CoderRunBus } from '../../../apps/http-api/coder-bus.js';
import type { ChatUsage } from '../core/messages.js';
import type { CoderSession } from '../sessions/types.js';

// ─── Template ──────────────────────────────────────────────────

export interface CompanyRoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  systemPromptOverride?: string;
  /** Symbolic labels resolved to real project_ids at session creation. */
  projectHints?: string[];
  /** Skill IDs to enable for this role. When set, configures session-level
   *  skill overrides so only these skills are active during the agent's run. */
  skills?: string[];
}

export interface CompanyTemplate {
  id: number;
  name: string;
  description: string;
  roles: CompanyRoleConfig[];
  created_at: string;
  updated_at: string;
}

// ─── Company Session ───────────────────────────────────────────

export type CompanySessionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';

export interface CompanySession {
  id: number;
  template_id: number | null;
  name: string;
  status: CompanySessionStatus;
  master_session_id: number | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface CompanySessionProject {
  company_session_id: number;
  project_id: number;
  label: string | null;
}

// ─── Agent Run ─────────────────────────────────────────────────

export type AgentRunStatus = 'idle' | 'running' | 'working' | 'waiting' | 'waiting_plan' | 'waiting_question' | 'waiting_tasks' | 'reviewing' | 'blocked' | 'completed' | 'error' | 'aborted' | 'interrupted';

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
}

// ─── Board ─────────────────────────────────────────────────────

export type BoardKind = 'message' | 'decision' | 'question' | 'deliverable' | 'handoff';

export interface BoardEntry {
  id: number;
  company_session_id: number;
  author_role: string;
  agent_run_id: number | null;
  kind: BoardKind;
  content: string;
  mentions: string[];
  created_at: string;
}

// ─── Master Prompts (master ↔ human ask_user / submit_plan) ───

export type MasterPromptKind = 'question' | 'plan';
export type MasterPromptStatus = 'pending' | 'answered' | 'cancelled';

export interface MasterPromptOption {
  label: string;
  value: string;
}

export interface MasterPrompt {
  id: number;
  company_session_id: number;
  agent_run_id: number | null;
  kind: MasterPromptKind;
  runner_block_id: string | null;
  /** Question text or plan text. */
  body: string;
  options: MasterPromptOption[] | null;
  allow_freeform: boolean;
  status: MasterPromptStatus;
  /** Set when kind='question' and status='answered'. */
  answer: string | null;
  /** Set when kind='plan' and status='answered'. */
  approved: boolean | null;
  /** Set when kind='plan' and status='answered'. */
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ─── Runtime handles ───────────────────────────────────────────

/**
 * Context injected into each agent's runCoder call to connect it to the
 * company orchestrator. Stored on ToolContext so tools can access it.
 */
export interface CompanyContext {
  orchestrator: import('./orchestrator.js').CompanyOrchestrator;
  companySessionId: number;
  agentRole: string;
  agentRunId: number | null;
  allowedProjectIds: number[];
  isMaster: boolean;
}

// ─── Kanban ───────────────────────────────────────────────────

export type KanbanColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type KanbanTag = 'bug' | 'feature' | 'refactor' | 'documentation';

export const KANBAN_COLUMNS: KanbanColumn[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

export interface KanbanCard {
  id: number;
  company_session_id: number;
  title: string;
  description: string;
  column: KanbanColumn;
  position: number;
  tag: KanbanTag | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface KanbanChecklistItem {
  id: number;
  card_id: number;
  text: string;
  checked: boolean;
  position: number;
}

export interface KanbanComment {
  id: number;
  card_id: number;
  author_role: string;
  agent_run_id: number | null;
  content: string;
  created_at: string;
}

export interface KanbanCardAgent {
  id: number;
  card_id: number;
  agent_run_id: number;
  role: string;
  assigned_at: string;
  unassigned_at: string | null;
}

export interface KanbanCardDependency {
  id: number;
  card_id: number;
  depends_on_id: number;
  created_at: string;
}

export interface KanbanCardFull extends KanbanCard {
  checklist: KanbanChecklistItem[];
  comments: KanbanComment[];
  agents: KanbanCardAgent[];
  dependencies: KanbanCardDependency[];
  /** IDs of depends_on cards that are NOT in 'done' column */
  blocked_by: number[];
}

// ─── Runtime handles ───────────────────────────────────────────

/** Runtime handle for a running subordinate agent. */
export interface SubordinateHandle {
  agentRunId: number;
  role: string;
  projectIds: number[];
  session: CoderSession;
  runner: CoderRunner;
  bus: CoderRunBus;
  done: Promise<{ reason: string; usage: ChatUsage; error?: string }>;
}
