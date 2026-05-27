import type { KanbanColumn, KanbanTag } from './kanban.js';

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
  /**
   * Default 'agent' (subordinate that performs work). 'validate' = verdict-only subagent.
   * 'spec' = subordinate that authors a specification (agentId='spec') and pauses for human
   * approval before the next node runs. The SDD built-in template wires a 'spec' node
   * followed by an 'agent' implementer and a 'validate' qa-validator.
   */
  kind?: 'agent' | 'validate' | 'spec';
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
