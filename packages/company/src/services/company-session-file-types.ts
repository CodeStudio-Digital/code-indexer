import { type AgentRunId, type CompanySessionId, type SessionId } from '@mcp/session-storage';
import type { CompanySessionIdentity } from '@mcp/company-contracts';
import type { AgentRunStatus, BoardKind, CompanyAgentDispatchSource, CompanyRuntimeKind, InboxKind, InboxPriority, InboxStatus, MasterPrompt, MasterPromptKind, MasterPromptOption } from '@mcp/company/types.js';
export interface CompanySessionFileSnapshot extends CompanySessionIdentity {
  id: CompanySessionId;
  template_id: number | null;
  runtime_kind: CompanyRuntimeKind;
  name: string;
  status: string;
  master_session_id: SessionId | null;
  config_json: string;
  parent_session_id: CompanySessionId | null;
  archived_at: string | null;
  recovered_at: string | null;
  recovered_reason: string | null;
  project_ids: number[];
  project_labels: Record<string, string | null>;
  created_at: string;
  updated_at: string;
}

export interface CompanyAgentRunFileRow {
  id: AgentRunId;
  /** Stable entity-envelope creation order; unrelated to board_watermark_seq. */
  seq: number;
  company_session_id: CompanySessionId;
  role: string;
  coder_session_id: SessionId;
  project_ids_json: string;
  provider: string;
  model: string;
  configured_provider: string;
  configured_model: string;
  dispatch_source: CompanyAgentDispatchSource;
  fallback_reason: string | null;
  status: AgentRunStatus;
  status_message: string;
  archive_id: string | null;
  board_watermark_seq: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCompanyAgentRunFileInput {
  id?: string;
  role: string;
  coder_session_id: SessionId | string;
  project_ids: readonly number[];
  provider: string;
  model: string;
  configured_provider?: string;
  configured_model?: string;
  dispatch_source?: CompanyAgentDispatchSource;
  fallback_reason?: string | null;
  status?: AgentRunStatus;
  status_message?: string;
}

export interface UpdateCompanyAgentRunRuntimeInput {
  configuredProvider?: string;
  configuredModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  dispatchSource?: CompanyAgentDispatchSource;
  fallbackReason?: string | null;
}

export interface ReadCompanyBoardFileOptions {
  sinceSeq?: number;
  limit?: number;
  kind?: BoardKind;
}

export interface CreateCompanyInboxFileInput {
  id?: string;
  fromSessionId?: string;
  origin?: 'agent' | 'operator';
  fromAgentRunId: AgentRunId | string;
  fromRole: string;
  toRole?: string | null;
  toAgentRunId?: AgentRunId | string | null;
  kind: InboxKind;
  body: string;
  waitToken?: string | null;
  threadId?: string | null;
  replyToMessageId?: string | null;
  priority?: InboxPriority;
  contextJson?: string | null;
}

export interface ListCompanyInboxFileOptions {
  status?: InboxStatus | readonly InboxStatus[];
  toRole?: string;
  toAgentRunId?: AgentRunId | string;
  fromAgentRunId?: AgentRunId | string;
  limit?: number;
}

export interface CreateCompanyMasterPromptFileInput {
  agent_run_id: string | null;
  kind: MasterPromptKind;
  runner_block_id?: string | null;
  body: string;
  options?: MasterPromptOption[] | null;
  allow_freeform?: boolean;
}

export type ResolveCompanyMasterPromptFileInput =
  | { kind: 'question'; answer: string }
  | { kind: 'plan'; approved: boolean; feedback?: string };

export type CompanyMasterPromptDeliveryClaim =
  | { kind: 'claimed'; prompt: MasterPrompt; token: string }
  | {
      kind:
        | 'not_pending'
        | 'delivery_in_progress'
        | 'outcome_unknown'
        | 'payload_conflict';
      prompt: MasterPrompt | null;
    };

export type MasterPromptDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'outcome_unknown';
