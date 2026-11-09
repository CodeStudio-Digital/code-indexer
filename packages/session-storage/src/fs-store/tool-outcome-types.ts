import type { JsonValue, SessionId } from '../types.js';

export type FsToolOutcomeResolutionKind = 'verified_terminal' | 'verified_not_applied' | 'user_acknowledged';
export interface FsToolOutcomeEvidence {
  source: 'host_receipt' | 'native_read_only' | 'user_review';
  summary: string;
  reference?: string;
}
export interface FsToolOutcomeIncident {
  occurrenceId: string;
  toolUseId: string;
  toolName: string;
  args: JsonValue | null;
  /** Zero denotes a host observation with no parent conversation message. */
  messageSeq: number;
  toolCallId?: string;
  runId?: string;
  sourceReference?: string;
}
export interface FsToolOutcomeIncidentRecord extends FsToolOutcomeIncident {
  schema_version: 1;
  operationId: string;
  sourceReference: string;
  recordedAt: string;
}
export interface FsRecordToolOutcomeIncidentInput {
  sessionId: SessionId | string;
  operationId: string;
  toolUseId: string;
  toolName: string;
  args: JsonValue;
  runId?: string;
  sourceReference: string;
}
export interface FsRecordToolOutcomeIncidentResult {
  incident: FsToolOutcomeIncident;
  state: FsToolOutcomeState;
}
/** An append-only decision about specific observations, never a replacement
 * tool result or a claim that the original operation succeeded. */
export interface FsToolOutcomeResolutionRecord {
  schema_version: 1;
  id: string;
  operationId: string;
  toolUseId: string;
  occurrenceIds: readonly string[];
  kind: FsToolOutcomeResolutionKind;
  evidence: FsToolOutcomeEvidence;
  recordedAt: string;
}
export interface FsToolOutcomeState {
  incidents: FsToolOutcomeIncident[];
  pending: FsToolOutcomeIncident[];
  resolved: FsToolOutcomeResolutionRecord[];
  unresolvedToolUseIds: string[];
  /** An ID is resolved only when none of its observations remains pending. */
  resolvedToolUseIds: string[];
}
export interface FsResolveToolOutcomeInput {
  sessionId: SessionId | string;
  toolUseId: string;
  expectedOccurrenceIds: readonly string[];
  operationId: string;
  resolution: { kind: FsToolOutcomeResolutionKind; evidence: FsToolOutcomeEvidence };
}
export interface FsResolveToolOutcomeResult {
  resolution: FsToolOutcomeResolutionRecord;
  state: FsToolOutcomeState;
}
