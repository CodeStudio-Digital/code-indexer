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

const UUID_INPUT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_PATTERN.test(value);
}

export function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_INPUT_PATTERN.test(value);
}

function asUuid<T extends string>(value: string, label: string): T {
  if (!isUuidString(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value.toLowerCase() as T;
}

export function asSessionId(value: string): SessionId {
  return asUuid<SessionId>(value, 'session id');
}

export function asSessionCommandId(value: string): SessionCommandId {
  return asUuid<SessionCommandId>(value, 'session command id');
}

export function asAgentRunId(value: string): AgentRunId {
  return asUuid<AgentRunId>(value, 'agent run id');
}

export function asAgentRunAttemptId(value: string): AgentRunAttemptId {
  return asUuid<AgentRunAttemptId>(value, 'agent run attempt id');
}

export function asRuntimeEventId(value: string): RuntimeEventId {
  return asUuid<RuntimeEventId>(value, 'runtime event id');
}

export function asCorrelationId(value: string): CorrelationId {
  return asUuid<CorrelationId>(value, 'correlation id');
}

export function asToolUseId(value: string): ToolUseId { return value as ToolUseId; }
