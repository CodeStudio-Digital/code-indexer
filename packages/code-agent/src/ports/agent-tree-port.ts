import type { SubagentParent, SubagentRunResult, SubagentSpec } from '../tools/implement-subagent.js';
import type { ToolResult } from '../core/tool.js';

export type AgentTreeMessageKind = 'message' | 'followup' | 'input';
export interface AgentTreeMessageRequest { to: string; message: string; kind: AgentTreeMessageKind; invocationId: string; signal?: AbortSignal }
export interface AgentTreeMessageReceipt { id: string; target: string; status: 'queued' | 'started'; interrupted: boolean; jobId?: string }

export type AgentTreeEvent = 'agents_group_start' | 'agent_progress' | 'agents_group_end'
  | 'workflow_run_started' | 'workflow_step_update' | 'workflow_run_finished';

export interface AgentTreeReconciliation {
  outcome: 'terminal' | 'outcome_unknown';
  stepStatus?: 'completed' | 'partial' | 'failed';
  reason?: string;
  resultRef?: string;
  summary?: string;
  detail: string;
}

export interface AgentTreeMember {
  path: string;
  role: string;
  agent_run_id: string;
  status: 'starting' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
  is_self: boolean;
  is_master: boolean;
  provider?: string;
  model?: string;
  is_alive?: boolean;
}

export interface AgentTreeWaitResult {
  kind: 'all_done' | 'attention' | 'timeout';
  agents: AgentTreeMember[];
}

/** One host-owned executor for the entire native tree. Admission must reserve
 * the shared budget and child identity before launching; completion includes
 * durable transcript and physical drain. An absent port never permits a
 * native parent to fall through to a legacy child runner. */
export interface AgentTreePort {
  readonly runtimeGeneration: 'rust_v1';
  readonly ownerAgentRunId: string;
  message?(request: AgentTreeMessageRequest): Promise<AgentTreeMessageReceipt>;
  background?(input: { invocationId: string; task: unknown; signal?: AbortSignal }, run: (signal: AbortSignal) => Promise<ToolResult>): Promise<ToolResult>;
  collect?(options: { jobId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<ToolResult>;
  list?(options: { signal?: AbortSignal }): Promise<AgentTreeMember[]>;
  wait?(options: { targets: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<AgentTreeWaitResult>;
  emit?(event: AgentTreeEvent, data: unknown): void;
  reconcile?(reference: string, options: { signal?: AbortSignal }): Promise<AgentTreeReconciliation>;
  readTranscript?(reference: string, options: { maxChars?: number; signal?: AbortSignal }): Promise<string>;
  run(parent: SubagentParent, spec: SubagentSpec): Promise<SubagentRunResult>;
}
