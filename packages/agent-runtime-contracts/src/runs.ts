import type {
  AgentRunAttemptId,
  AgentRunId,
  EnvironmentId,
  SessionCommandId,
  SessionId,
  WorkspaceLeaseId,
} from './ids.js';
import type { ExecutionEnvironmentRequest } from './environment.js';
import type { ControlPlaneSchemaVersion } from './version.js';

export type AgentRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'detached'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'interrupted';

export type AgentRunTerminalStatus = Extract<AgentRunStatus, 'completed' | 'failed' | 'aborted' | 'interrupted'>;
export type AgentRunWaitMode = 'foreground' | 'background';

export interface ResolutionReason {
  code: string;
  dimension: string;
  requested?: string;
  effective?: string;
  detail?: string;
}

export interface AgentRunBudget {
  maxTurns?: number;
  maxWallMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxAgents?: number;
  maxDepth?: number;
  maxCostUsd?: number;
}

export type VerifierPolicy =
  | { mode: 'off' }
  | { mode: 'selective'; claimTypes?: string[]; riskClasses?: string[]; independentModel?: string }
  | { mode: 'required'; claimTypes: string[]; independentModel?: string };

export interface AgentRunSpec {
  schemaVersion: ControlPlaneSchemaVersion;
  sessionId: SessionId;
  commandId: SessionCommandId;
  ownerAgentRunId?: AgentRunId;
  parentAgentRunId?: AgentRunId;
  spawnDepth: number;
  role: string;
  agentDefinitionId: string;
  task: { text: string; attachments?: string[] };
  requestedProvider?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  requestedPreset?: string;
  requestedCapabilityProfile: string;
  requestedEnvironment: ExecutionEnvironmentRequest;
  waitMode: AgentRunWaitMode;
  budget: AgentRunBudget;
  verifierPolicy?: VerifierPolicy;
  idempotencyKey: string;
}

export interface AgentRun {
  agentRunId: AgentRunId;
  specVersion: number;
  sessionId: SessionId;
  commandId: SessionCommandId;
  ownerAgentRunId?: AgentRunId;
  parentAgentRunId?: AgentRunId;
  spawnDepth: number;
  role: string;
  status: AgentRunStatus;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveReasoningEffort?: string;
  effectivePreset?: string;
  downgradeReasons: ResolutionReason[];
  capabilitySetRef?: string;
  environmentId?: EnvironmentId;
  workspaceLeaseId?: WorkspaceLeaseId;
  activeAttemptId?: AgentRunAttemptId;
  presetResolutionRef?: string;
  terminalReason?: string;
  transcriptRef?: string;
  checkpointRef?: string;
  resultRef?: string;
  policySnapshotRef?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  version: number;
}

export interface ExecutorLease {
  ownerId: string;
  fencingEpoch: number;
  status: 'active' | 'expired' | 'released' | 'fenced';
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface AgentRunAttempt {
  attemptId: AgentRunAttemptId;
  agentRunId: AgentRunId;
  ordinal: number;
  trigger: 'initial' | 'resume' | 'provider_fallback' | 'worker_recovery';
  executorLease: ExecutorLease;
  status: 'starting' | 'running' | 'terminal';
  runnerRunId?: string;
  providerRequestRefs: string[];
  checkpointInputRef?: string;
  terminalReason?: string;
  errorRef?: string;
  startedAt: string;
  finishedAt?: string;
  version: number;
}

const TERMINAL = new Set<AgentRunStatus>(['completed', 'failed', 'aborted', 'interrupted']);
const TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(['starting', 'aborted', 'interrupted']),
  starting: new Set(['running', 'failed', 'aborted', 'interrupted']),
  running: new Set(['waiting', 'stopping', 'completed', 'failed', 'aborted', 'interrupted']),
  waiting: new Set(['running', 'detached', 'stopping', 'completed', 'failed', 'aborted', 'interrupted']),
  detached: new Set(['running', 'stopping', 'completed', 'failed', 'aborted', 'interrupted']),
  stopping: new Set(['completed', 'failed', 'aborted', 'interrupted']),
  completed: new Set(),
  failed: new Set(),
  aborted: new Set(),
  interrupted: new Set(),
};

export function isTerminalAgentRunStatus(status: AgentRunStatus): status is AgentRunTerminalStatus {
  return TERMINAL.has(status);
}

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return from === to || TRANSITIONS[from].has(to);
}
