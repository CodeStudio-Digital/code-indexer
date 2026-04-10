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

export type AgentRunStatus = 'idle' | 'running' | 'waiting_plan' | 'completed' | 'error' | 'aborted';

export interface CompanyAgentRun {
  id: number;
  company_session_id: number;
  role: string;
  coder_session_id: number;
  project_ids_json: string;
  provider: string;
  model: string;
  status: AgentRunStatus;
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

/** Runtime handle for a running subordinate agent. */
export interface SubordinateHandle {
  agentRunId: number;
  role: string;
  projectIds: number[];
  session: CoderSession;
  runner: CoderRunner;
  bus: CoderRunBus;
  done: Promise<{ reason: string; usage: ChatUsage }>;
}
