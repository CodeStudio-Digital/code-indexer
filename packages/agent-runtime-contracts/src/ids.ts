export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, 'SessionId'>;
export type SessionCommandId = Brand<string, 'SessionCommandId'>;
export type AgentRunId = Brand<string, 'AgentRunId'>;
export type AgentRunAttemptId = Brand<string, 'AgentRunAttemptId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type WorkflowStepId = Brand<string, 'WorkflowStepId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type ToolUseId = Brand<string, 'ToolUseId'>;
export type CapabilityId = Brand<string, 'CapabilityId'>;
export type EnvironmentId = Brand<string, 'EnvironmentId'>;
export type WorkspaceLeaseId = Brand<string, 'WorkspaceLeaseId'>;
export type RuntimeEventId = Brand<string, 'RuntimeEventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

export function asSessionId(value: string): SessionId { return value as SessionId; }
export function asSessionCommandId(value: string): SessionCommandId { return value as SessionCommandId; }
export function asAgentRunId(value: string): AgentRunId { return value as AgentRunId; }
export function asAgentRunAttemptId(value: string): AgentRunAttemptId { return value as AgentRunAttemptId; }
export function asRuntimeEventId(value: string): RuntimeEventId { return value as RuntimeEventId; }
export function asCorrelationId(value: string): CorrelationId { return value as CorrelationId; }
export function asToolUseId(value: string): ToolUseId { return value as ToolUseId; }
