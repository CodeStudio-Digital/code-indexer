import type { SessionCommandActor } from './commands.js';
import type {
  AgentRunAttemptId,
  AgentRunId,
  CorrelationId,
  OperationId,
  RuntimeEventId,
  SessionCommandId,
  SessionId,
  ToolUseId,
  WorkflowId,
  WorkflowStepId,
} from './ids.js';
import type { ControlPlaneSchemaVersion } from './version.js';

export type RuntimeEventClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const CONTROL_PLANE_EVENT_TYPES = {
  commandAccepted: 'command.accepted',
  commandSucceeded: 'command.succeeded',
  commandRejected: 'command.rejected',
  commandFailed: 'command.failed',
  commandCancelled: 'command.cancelled',
  agentRunCreated: 'agent_run.created',
  agentRunStarted: 'agent_run.started',
  toolApprovalRequested: 'tool.approval.requested',
  toolApprovalResolved: 'tool.approval.resolved',
  interactionRequested: 'interaction.requested',
  interactionResolved: 'interaction.resolved',
  providerSwapped: 'provider.swapped',
  providerFallback: 'provider.fallback',
  historyCompacted: 'history.compacted',
  workflowRunStarted: 'workflow.run.started',
  workflowRunFinished: 'workflow.run.finished',
  agentsGroupStarted: 'agents.group.started',
  agentsGroupFinished: 'agents.group.finished',
  worktreeEntered: 'worktree.entered',
  worktreeExited: 'worktree.exited',
  toolInvocationStarted: 'tool.invocation.started',
  toolInvocationCompleted: 'tool.invocation.completed',
  transcriptPersisted: 'transcript.persisted',
  agentRunCompleted: 'agent_run.completed',
  agentRunFailed: 'agent_run.failed',
  agentRunAborted: 'agent_run.aborted',
  agentRunInterrupted: 'agent_run.interrupted',
} as const;

export type ControlPlaneEventType = typeof CONTROL_PLANE_EVENT_TYPES[keyof typeof CONTROL_PLANE_EVENT_TYPES];

const EVENT_CLASSES: Record<ControlPlaneEventType, RuntimeEventClass> = {
  [CONTROL_PLANE_EVENT_TYPES.commandAccepted]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.commandSucceeded]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.commandRejected]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.commandFailed]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.commandCancelled]: 'A',
  // Class A per 14-target-control-plane-contracts.md §15: run created is a
  // command/control event appended synchronously before the effect.
  [CONTROL_PLANE_EVENT_TYPES.agentRunCreated]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.agentRunStarted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.toolApprovalRequested]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.toolApprovalResolved]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.interactionRequested]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.interactionResolved]: 'A',
  [CONTROL_PLANE_EVENT_TYPES.providerSwapped]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.providerFallback]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.historyCompacted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.workflowRunStarted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.workflowRunFinished]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.agentsGroupStarted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.agentsGroupFinished]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.worktreeEntered]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.worktreeExited]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.toolInvocationStarted]: 'B',
  [CONTROL_PLANE_EVENT_TYPES.toolInvocationCompleted]: 'B',
  [CONTROL_PLANE_EVENT_TYPES.transcriptPersisted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.agentRunCompleted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.agentRunFailed]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.agentRunAborted]: 'C',
  [CONTROL_PLANE_EVENT_TYPES.agentRunInterrupted]: 'C',
};

export interface RuntimeEventRedaction {
  policyVersion: string;
  fields: string[];
  secretRefs: string[];
}

export interface RuntimeEventEnvelopeV1<T = unknown> {
  schemaVersion: ControlPlaneSchemaVersion;
  eventId: RuntimeEventId;
  eventClass: RuntimeEventClass;
  partitionKey: string;
  globalSeq: number;
  sessionId: SessionId;
  commandId?: SessionCommandId;
  agentRunId?: AgentRunId;
  attemptId?: AgentRunAttemptId;
  workflowId?: WorkflowId;
  workflowStepId?: WorkflowStepId;
  operationId?: OperationId;
  toolUseId?: ToolUseId;
  parentEventId?: RuntimeEventId;
  causationId?: RuntimeEventId | SessionCommandId;
  correlationId: CorrelationId;
  type: string;
  occurredAt: string;
  recordedAt: string;
  actor: SessionCommandActor;
  payload: T;
  payloadHash: string;
  idempotencyKey?: string;
  redaction: RuntimeEventRedaction;
}

export interface RuntimeEventContext {
  sessionId: SessionId;
  commandId: SessionCommandId;
  agentRunId: AgentRunId;
  attemptId: AgentRunAttemptId;
  correlationId: CorrelationId;
  actor: SessionCommandActor;
}

export interface ProjectionCursor {
  projectionId: string;
  partitionKey: string;
  lastGlobalSeq: number;
  projectionVersion: string;
  updatedAt: string;
}

export function runtimeEventClass(type: ControlPlaneEventType): RuntimeEventClass {
  return EVENT_CLASSES[type];
}
