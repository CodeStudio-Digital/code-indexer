import type { AgentRunId, EnvironmentId, WorkspaceLeaseId } from './ids.js';

export type ExecutionEnvironmentKind = 'host' | 'worktree' | 'sandbox' | 'remote';

export interface ExecutionEnvironmentRequest {
  kind: ExecutionEnvironmentKind;
  projectId?: number;
  root?: string;
  cwd?: string;
  branch?: string;
  baseRevision?: string;
  networkProfile?: string;
  secretProfile?: string;
}

export interface ExecutionEnvironmentRef extends ExecutionEnvironmentRequest {
  environmentId: EnvironmentId;
  status: 'provisioning' | 'ready' | 'degraded' | 'releasing' | 'released' | 'failed';
  version: number;
}

export interface WorkspaceLease {
  leaseId: WorkspaceLeaseId;
  environmentId: EnvironmentId;
  ownerAgentRunId: AgentRunId;
  mode: 'shared_read' | 'exclusive_write';
  fencingEpoch: number;
  status: 'active' | 'expired' | 'released' | 'fenced';
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
  dirty?: boolean;
  version: number;
}
