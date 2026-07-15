import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CompactionSummaryV3 } from '@mcp/code-agent/core/summarizer-v3.js';

export type ExternalSessionSource = 'claude-code' | 'codex';

export type ExternalSessionErrorCode =
  | 'unsupported_format'
  | 'source_not_found'
  | 'source_busy'
  | 'source_too_large'
  | 'project_mismatch'
  | 'duplicate_import'
  | 'empty_transcript';

export interface ExternalSessionReference {
  source: ExternalSessionSource;
  source_path: string;
  external_id: string;
  fingerprint?: string;
}

export interface ExternalSessionCandidate {
  source: ExternalSessionSource;
  external_id: string;
  title: string;
  cwd: string | null;
  updated_at: string | null;
  source_model: string | null;
  source_path: string;
  size_bytes: number;
  reference: ExternalSessionReference;
  matches_project?: boolean;
  already_imported_session_id?: number | null;
}

export interface ExternalSessionWarning {
  code: string;
  message: string;
  count?: number;
}

export interface ExternalSessionStats {
  message_count: number;
  user_count: number;
  assistant_count: number;
  tool_call_count: number;
  tool_result_count: number;
}

export interface ExternalSessionPreview extends ExternalSessionCandidate {
  fingerprint: string;
  has_source_summary: boolean;
  stats: ExternalSessionStats;
  warnings: ExternalSessionWarning[];
  reference: ExternalSessionReference & { fingerprint: string };
}

export interface ExternalSessionMessage {
  message: AgentMessage;
  created_at: string | null;
}

export interface ExternalSessionDocument {
  candidate: ExternalSessionCandidate;
  messages: ExternalSessionMessage[];
  source_summary: string | null;
  fingerprint: string;
  stats: ExternalSessionStats;
  warnings: ExternalSessionWarning[];
  diagnostics: Record<string, unknown>;
}

export interface ImportExternalSessionInput {
  project_id: number;
  provider: string;
  model: string;
  agent: string | null;
  title: string;
  source: ExternalSessionSource;
  reference: ExternalSessionReference;
  allow_project_mismatch?: boolean;
}

export interface PersistExternalSessionInput extends ImportExternalSessionInput {
  document: ExternalSessionDocument;
  summary: CompactionSummaryV3;
  diagnostics?: Record<string, unknown>;
}

export interface ImportExternalSessionResult {
  session_id: number;
  source: ExternalSessionSource;
  external_id: string;
  fingerprint: string;
  imported_messages: number;
  warnings: ExternalSessionWarning[];
  used_fallback_summary: boolean;
}

export class ExternalSessionError extends Error {
  constructor(
    public readonly code: ExternalSessionErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExternalSessionError';
  }
}
