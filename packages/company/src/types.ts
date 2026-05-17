import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { CoderSession } from '@mcp/code-agent/sessions/types.js';

// ─── Template ──────────────────────────────────────────────────

/**
 * Conditional / chain shape for `CompanyRoleConfig.skills`. Lets a role
 * declare stack-specific skill picks (`{ when: "session.stack === 'react-ts'", skill: 'ds-components-react' }`)
 * plus auxiliary skills that always come along (`chain`).
 *
 * Resolved at spawn-time via `resolveRoleSkills`. The result is a flat
 * `string[]` of skill IDs that get session-level overrides applied.
 */
export interface RoleSkillsConfig {
  /** Used when no `conditional` branch matches. */
  primary?: string;
  /** Skills always appended after the primary/conditional pick (e.g. shared QA). */
  chain?: string[];
  /**
   * Branches evaluated in order; first matching branch contributes its
   * `skill` as the primary. The `when` expression supports a tiny subset of
   * syntax for safety: `session.<key> === '<literal>'` only.
   */
  conditional?: Array<{ when: string; skill: string }>;
}

export type RoleSkills = string[] | RoleSkillsConfig;

export interface ResolveRoleSkillsContext {
  /** Builder sandbox stack — set by `getSandboxStackForService` at spawn. */
  stack?: string;
}

/**
 * Flatten a `RoleSkills` value (either legacy `string[]` or the v2
 * `RoleSkillsConfig` object) into the final list of skill IDs to enable
 * for the spawning subordinate.
 */
export function resolveRoleSkills(
  skills: RoleSkills | undefined,
  ctx: ResolveRoleSkillsContext,
): string[] {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills;

  const out: string[] = [];

  if (skills.conditional && skills.conditional.length > 0) {
    for (const branch of skills.conditional) {
      if (evalSkillCondition(branch.when, ctx)) {
        if (!out.includes(branch.skill)) out.push(branch.skill);
        break;
      }
    }
  }

  if (out.length === 0 && skills.primary) {
    out.push(skills.primary);
  }

  if (skills.chain && skills.chain.length > 0) {
    for (const s of skills.chain) {
      if (!out.includes(s)) out.push(s);
    }
  }

  return out;
}

/**
 * Evaluate a `when` expression. Whitelisted forms only — anything else
 * returns false. Keeping this tiny prevents arbitrary code execution from
 * a stored template definition.
 *
 * Supported:
 *   - `session.<key> === '<literal>'`
 *   - `session.<key> == '<literal>'`
 */
function evalSkillCondition(expr: string, ctx: ResolveRoleSkillsContext): boolean {
  const m = /^session\.([a-zA-Z_]\w*)\s*===?\s*['"]([^'"]+)['"]$/.exec(expr.trim());
  if (!m) return false;
  const [, key, value] = m;
  switch (key) {
    case 'stack':
      return ctx.stack === value;
    default:
      return false;
  }
}

export interface CompanyRoleConfig {
  role: string;
  provider: string;
  model: string;
  tier: 'bootstrap' | 'navigate' | 'full';
  systemPromptOverride?: string;
  /** Symbolic labels resolved to real project_ids at session creation. */
  projectHints?: string[];
  /**
   * Skills to enable for this role. Either a flat list (legacy) or a
   * conditional/chain config (v2) — see `RoleSkillsConfig`. Resolved via
   * `resolveRoleSkills` at spawn-time, then enforced as session-level
   * skill overrides in `skill_session_config`.
   */
  skills?: RoleSkills;
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
  /**
   * Sampling temperature override for this role. When set, takes precedence
   * over the agent preset's `defaultTemperature` but is itself overridden by
   * a per-session value. Range [0, 1]; resolver clamps. Persisted in
   * `company_templates.roles_json` (no schema change — JSON field).
   */
  temperature?: number;
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
  /**
   * Multi-front via sub-sessions (migration 067): when set, this row is
   * a child "tab" of `parent_session_id` and shares
   * sandbox/projects/kanban/pipelines with the parent. NULL = root
   * session (a parent or a standalone single-tab session).
   */
  parent_session_id: number | null;
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
  orchestrator: import('@mcp/company/orchestrator.js').CompanyOrchestrator;
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
  /**
   * Configured stack name for builder-mode sessions (e.g. `react-ts`).
   * Set from the session config regardless of whether the primary container
   * is currently live — allows the master to operate in builder mode even
   * when `sandbox` is absent (container down, provisioning failure, etc.).
   */
  builderStack?: string;
}

/**
 * What a `CompanyContext` carries for builder mode. Consumed by
 * `runCoder` to swap the default local filesystem/shell ports for
 * sandbox adapters — transparent to every tool.
 */
export interface SandboxBinding {
  driver: import('@mcp/services/sandbox/ports/sandbox-driver.js').ISandboxDriver;
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
  /**
   * Absolute HOST path the container's `workdir` is bind-mounted from
   * (e.g. `D:\MCP\data\virtual-projects\<uuid>`). Present when the
   * sandbox was provisioned with `hostWorkdirMount` set — every
   * `'node-only'` Design System session has this. Tools that run in
   * the host process and need to touch the package filesystem
   * (`npm pack`, `readFile`, hash) translate container paths
   * (`/app/pkg`) to host paths via this field. Without it, host-side
   * `cwd: '/app/pkg'` becomes `\app\pkg` on Windows and ENOENTs.
   */
  hostWorkdirMount?: string;
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
  /** Whether files are builder-owned or an existing user project. */
  mountKind?: 'owned' | 'external';
  /** Whether the image is the MCP default image or built from a project Dockerfile. */
  imageSource?: 'default' | 'project_dockerfile';
  dockerfilePath?: string;
  containerPortOverride?: number;
  skipDefaultCommand?: boolean;
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

// ─── Pipelines ────────────────────────────────────────────────

/**
 * One stage in a pipeline graph. References a `role` from
 * `CompanyRoleConfig`; the executor spawns a subordinate of that role and
 * passes a rendered task derived from `taskTemplate`.
 *
 * V0 supported only `branchMode='linear'`. V1 added `pass-fail`,
 * `by-tag`, `by-text-match` and the visual builder. V2 (chat pipelines)
 * adds:
 *   - `kind: 'agent' | 'validate'` — validators do not invoke the role's
 *     subordinate; they spawn a verdict-only subagent that must call
 *     `submit_verdict` once and stop.
 *   - `model_override` — per-stage provider/model. When set, the chat
 *     executor instantiates a fresh provider via `createCoderProvider`
 *     for this stage instead of inheriting the parent session's.
 *   - `validatorPrompt` — required when `kind === 'validate'`; the
 *     criteria text fed to the validator subagent.
 *   - `requires_confirmation` — reserved (honored in a later PR).
 *
 * The shape stays additively forward-compatible: missing fields default
 * to `kind='agent'` and no override.
 */
export interface PipelineNode {
  id: string;
  label: string;
  role: string;
  /**
   * Mustache-style placeholders supported: `{{initial_input}}`,
   * `{{previous_output}}`, `{{vars.<nodeId>.output}}`. Anything else is
   * left literal so node templates can include their own braces safely.
   */
  taskTemplate: string;
  extraSkills?: string[];
  kanbanTag?: KanbanTag | null;
  kanbanColumnTarget?: KanbanColumn;
  projectId?: number;
  maxAttempts?: number;
  branchMode?: 'linear' | 'pass-fail' | 'by-tag' | 'by-text-match';
  position?: { x: number; y: number };
  /** Default 'agent' (subordinate that performs work). 'validate' = verdict-only subagent. */
  kind?: 'agent' | 'validate';
  /** Per-stage provider/model. When omitted, the executor inherits from the parent session. */
  model_override?: { provider?: string; model?: string } | null;
  /** Required when `kind === 'validate'`. Free-text criteria fed to the validator subagent. */
  validatorPrompt?: string;
  /**
   * Optional read-only tool allowlist for validator stages — names from
   * the parent's tool registry. The validator's effective allowlist is
   * `{ submit_verdict } ∪ validatorTools`. Useful when a verdict requires
   * peeking at files (e.g., `read_file`, `grep_code`, `list_directory`).
   * Empty/unset → validator runs pure-inference.
   */
  validatorTools?: string[];
  /**
   * When true, the executor pauses AFTER this node completes and waits
   * for the operator to approve before advancing to the next stage. The
   * dashboard surfaces an "Approve" button; calling `/resume` (or the
   * dedicated `/confirm` endpoint) resumes by running the next node.
   */
  requires_confirmation?: boolean;
}

export type PipelineEdge =
  | { kind: 'linear';        id: string; from: string; to: string }
  | { kind: 'pass-fail';     id: string; from: string; on: 'pass' | 'fail' | 'review'; to: string }
  | { kind: 'by-tag';        id: string; from: string; tag: KanbanTag;     to: string }
  | { kind: 'by-text-match'; id: string; from: string; pattern: string;    to: string };

export interface PipelineGraph {
  version: 1;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** Optional explicit start. When omitted, the executor picks the unique node with no incoming edge. */
  startNodeId?: string;
}

export interface Pipeline {
  id: number;
  name: string;
  description: string;
  company_session_id: number | null;
  template_id: number | null;
  graph: PipelineGraph;
  version: number;
  created_at: string;
  updated_at: string;
}

export type PipelineExecutionStatus =
  | 'running' | 'paused' | 'completed' | 'failed' | 'aborted';

/**
 * `context` carries the frozen graph snapshot taken at `start` plus the
 * accumulated node outputs (`vars[<nodeId>].output`). The executor only
 * reads from the snapshot, never from the live `pipelines.graph_json`,
 * so editing a pipeline mid-flight cannot mutate a running execution.
 *
 * Exactly one of `company_session_id` / `coder_session_id` is set
 * (DB-level CHECK in migration 077). Company executions belong to the
 * orchestrator path; chat executions are owned by a `coder_sessions` row.
 */
export interface PipelineExecution {
  id: number;
  pipeline_id: number;
  company_session_id: number | null;
  coder_session_id: number | null;
  status: PipelineExecutionStatus;
  current_node_id: string | null;
  initial_input: string;
  context: PipelineExecutionContext;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export interface PipelineExecutionContext {
  snapshot: PipelineGraph;
  vars: Record<string, { output?: string; outcome?: string }>;
}

export type PipelineNodeStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'aborted';

export interface PipelineNodeExecution {
  id: number;
  execution_id: number;
  node_id: string;
  node_label: string;
  role: string;
  status: PipelineNodeStatus;
  agent_run_id: number | null;
  kanban_card_id: number | null;
  /**
   * Reserved for future persisted child sessions (a chat pipeline stage
   * that runs as a real `coder_sessions` row instead of in-memory). NULL
   * today for both company and chat pipelines.
   */
  coder_session_id: number | null;
  input_text: string;
  output_text: string | null;
  outcome_branch: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  /** Serialized `ChatUsage` for chat-pipeline stages so the parent session can roll up tokens. */
  usage_json: string | null;
}

// ─── Agent inbox ─────────────────────────────────────────────

export type InboxKind = 'question' | 'notify';
export type InboxStatus = 'pending' | 'delivered' | 'answered' | 'cancelled' | 'expired';

/**
 * One message between subordinates of the same company session.
 *
 * Either `to_role` or `to_agent_run_id` must be set:
 *   - `to_role` is the loose form, the inbox picks the right run when
 *     several agents are playing the same role
 *   - `to_agent_run_id` pins the message to a specific run
 *
 * `wait_token` is set when the sender called `send_to_agent` with
 * `wait=true` — the InboxQueue uses it to resolve the right pending
 * promise once the answer arrives.
 */
export interface AgentInboxMessage {
  id: number;
  company_session_id: number;
  from_agent_run_id: number;
  from_role: string;
  to_role: string | null;
  to_agent_run_id: number | null;
  kind: InboxKind;
  body: string;
  status: InboxStatus;
  answer: string | null;
  wait_token: string | null;
  created_at: string;
  delivered_at: string | null;
  answered_at: string | null;
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
