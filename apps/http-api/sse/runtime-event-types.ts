import type { BufferedEvent } from '../coder-bus.js';
import type { CompanySessionId, SessionId } from '@mcp/session-storage';
export type RuntimeLogKind = 'coder' | 'company';

export type RuntimeSessionId = SessionId | CompanySessionId;

export interface RuntimeEventEnvelope extends BufferedEvent {
  /** Stable identity of the run bus. Older persisted rows may omit it. */
  busId?: string;
  ts: number;
  kind: RuntimeLogKind;
  sessionId: RuntimeSessionId;
  opId?: string;
  groupId?: string;
  agentIndex?: number;
}
