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
  /**
   * Concrete project ids this role is bound to in THIS session. When set,
   * `spawn_subordinate_agent` auto-resolves `project_id` (single binding) or
   * enforces that the master-supplied id is one of them (multi-binding).
   * Empty/undefined = unbound (legacy free-form behaviour).
   *
   * Session-level only; never persisted in `company_templates.roles_json`
   * because project ids don't exist until a session is created.
   */
  projectIds?: number[];
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

/**
 * Entry in the per-session "allowed models" pool. When non-empty, the
 * master can only spawn subordinates using (provider, model) tuples
 * listed here. Replaces the previous free-form picking that let the
 * master hallucinate provider/model strings.
 */
export interface AllowedModel {
  provider: string;
  model: string;
  /** Short human label shown in the master's prompt (e.g. "Sonnet 4 — balanced"). */
  label?: string;
  /** Hint rendered to the master to guide selection (e.g. "cheap, use for trivia"). */
  notes?: string;
  /** When true, this entry is used when the master spawns without specifying provider/model. */
  is_default?: boolean;
}

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
  /** Null = active; non-null = belongs to that archived snapshot (migration 038). */
  archive_id: number | null;
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
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: number | null;
}

// ─── Master Prompts (master ↔ human ask_user / submit_plan) ───

export type MasterPromptKind = 'question' | 'plan';
export type MasterPromptStatus = 'pending' | 'answered' | 'cancelled';

export interface MasterPromptOption {
  label: string;
  value: string;
}

export interface CompanySessionArchive {
  id: number;
  company_session_id: number;
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
  /**
   * Builder-mode sandbox binding. When present, filesystem/shell tools
   * are routed into the container referenced here instead of touching
   * the host filesystem. Populated by `SandboxService` after a successful
   * provision; absent for normal (non-builder) company sessions.
   */
  sandbox?: SandboxBinding;
}

/**
 * What a `CompanyContext` carries for builder mode. Consumed by
 * `runCoder` to swap the default local filesystem/shell ports for
 * sandbox adapters — transparent to every tool.
 */
export interface SandboxBinding {
  driver: import('../../sandbox/ports/sandbox-driver.js').ISandboxDriver;
  /**
   * Current container id for the bound (session, serviceId?) pair.
   *
   * Implemented as a live getter by `SandboxService` so that reads
   * always reflect the latest id known to `SandboxManager`. When a
   * container is destroyed and recreated (retry, orphan recovery,
   * `forceRecreate`), long-lived agents keep their binding reference
   * and automatically pick up the new id on their next tool call —
   * no rehydrate event or binding invalidation required. Fallback is
   * the id captured at construction time, preserving behavior when the
   * manager hasn't rehydrated yet.
   */
  containerId: string;
  /** Absolute container-side workdir (e.g. `/app`). Used as cwd for tools. */
  workdir: string;
  /** Public URL the dashboard iframes — kept here so tools/prompts can reference it. */
  previewUrl: string;
  /**
   * Stable per-session service identifier (e.g. 'main', 'frontend', 'api').
   * Present when the session runs multiple microservices; legacy single-
   * container sessions default to `'main'`. Used by tools and event
   * publishers to distinguish which container an action targeted.
   */
  serviceId?: string;
}

/**
 * One entry in `BuilderSessionConfig.services` — the multi-microservice
 * form. Each describes a container to provision for the session, joined
 * into a shared docker network so they can address each other by hostname.
 */
export interface BuilderServiceConfig {
  /** Stable identifier; doubles as the in-network hostname. */
  serviceId: string;
  /** Human-readable label shown in the dashboard; falls back to serviceId. */
  name?: string;
  /** Free-form stack key validated by the scaffolder registry at runtime. */
  stack: string;
  /** Optional per-service CPU/memory/pids override. */
  limits?: {
    memory?: string;
    cpus?: string;
    pids?: number;
  };
  /** When true, this service is the default preview iframe shown by the UI. */
  primary?: boolean;
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
  /** Null = active; non-null = belongs to that archived snapshot. */
  archive_id: number | null;
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
