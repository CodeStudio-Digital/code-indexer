import type {
  AgentRunId,
  CorrelationId,
  SessionCommandId,
  SessionId,
} from './ids.js';
import type { ControlPlaneSchemaVersion } from './version.js';

export type SessionCommandKind =
  | 'start'
  | 'send_message'
  | 'attach'
  | 'resume'
  | 'fork'
  | 'handoff'
  | 'stop'
  | 'inject_message'
  | 'resolve_interaction'
  | 'resolve_tool_approval';

export type SessionCommandStatus =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export interface SessionCommandActor {
  actorId: string;
  actorType: 'user' | 'agent' | 'system' | 'api' | 'organization';
  source: 'dashboard' | 'desktop' | 'cli' | 'http' | 'company' | 'recovery';
}

export interface SessionCommand<T = unknown> {
  schemaVersion: ControlPlaneSchemaVersion;
  commandId: SessionCommandId;
  idempotencyKey: string;
  kind: SessionCommandKind;
  sessionId: SessionId;
  actor: SessionCommandActor;
  expectedSessionVersion?: number;
  requestedAt: string;
  deadlineAt?: string;
  correlationId: CorrelationId;
  payload: T;
}

export interface SessionCommandResult {
  commandId: SessionCommandId;
  status: SessionCommandStatus;
  sessionVersion: number;
  agentRunId?: AgentRunId;
  existingResult?: boolean;
  reasonCode?: string;
  errorRef?: string;
  completedAt?: string;
}
