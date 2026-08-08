import type { AttemptAuthority } from '../facade/types.js';

export type OssEngineCandidate = 'codex_app_server' | 'goose_api';

export interface OssEngineCapability {
  capabilityId: string;
  canonicalName: string;
  description: string;
  descriptorDigest: string;
  inputSchema: Readonly<Record<string, unknown>>;
  mutates: boolean;
}

export interface OssEngineAttemptSpec {
  candidate: OssEngineCandidate;
  candidateVersion: string;
  protocolVersion: string;
  protocolSchemaDigest: string;
  authority: AttemptAuthority;
  cwd: string;
  prompt: string;
  model?: string;
  capabilities: readonly OssEngineCapability[];
}

export type OssEngineToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export type OssEngineToolOutcome =
  | 'completed'
  | 'failed'
  | 'declined'
  | 'outcome_unknown';

export interface OssEngineToolCall {
  authority: AttemptAuthority;
  threadId: string;
  turnId: string;
  callId: string;
  capability: OssEngineCapability;
  arguments: Readonly<Record<string, unknown>>;
}

export interface OssEngineToolReceipt {
  callId: string;
  accepted: boolean;
  started: boolean;
  outcome: OssEngineToolOutcome;
  contentItems: readonly OssEngineToolContentItem[];
}

export interface OssEngineToolHostPort {
  invoke(call: OssEngineToolCall, signal: AbortSignal): Promise<OssEngineToolReceipt>;
}

export type OssEngineEventKind =
  | 'engine_initialized'
  | 'thread_started'
  | 'turn_started'
  | 'agent_message_delta'
  | 'reasoning_delta'
  | 'tool_call_terminal'
  | 'built_in_request_denied'
  | 'warning'
  | 'turn_terminal'
  | 'temporary_state_deleted';

export interface OssEngineEvent {
  kind: OssEngineEventKind;
  attemptId: string;
  occurredAt: string;
  threadId?: string;
  turnId?: string;
  callId?: string;
  text?: string;
  status?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface OssEngineRunMetrics {
  startedAt: string;
  completedAt: string;
  initializeMs: number;
  threadStartMs: number;
  turnStartMs: number;
  firstDeltaMs?: number;
  dynamicToolCount: number;
  toolCallCount: number;
  deniedBuiltInRequestCount: number;
  observedBypassToolCount: number;
  temporaryStateDeleted: boolean;
}

export interface OssEngineRunResult {
  candidate: OssEngineCandidate;
  candidateVersion: string;
  protocolVersion: string;
  protocolSchemaDigest: string;
  attemptId: string;
  threadId: string;
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  metrics: OssEngineRunMetrics;
}

export interface OssEngineClockPort {
  now(): Date;
}

export type OssEngineEventSink = (event: OssEngineEvent) => void | Promise<void>;
