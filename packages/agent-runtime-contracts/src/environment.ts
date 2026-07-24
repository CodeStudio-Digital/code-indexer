import type { AgentRunId, EnvironmentId, WorkspaceLeaseId } from './ids.js';

export type ExecutionEnvironmentKind = 'host' | 'worktree' | 'container' | 'remote';
export type WorkspaceAccess = 'read_only' | 'exclusive_write';

export interface ExecutionEnvironmentRequest {
  kind: ExecutionEnvironmentKind | 'auto';
  projectId: string;
  baseRevision?: string;
  access: WorkspaceAccess;
  sandboxRequired?: boolean;
  networkProfile?: string;
  secretProfile?: string;
  retention: 'ephemeral' | 'retain_on_failure' | 'persistent';
}

export interface ExecutionEnvironmentRef {
  environmentId: EnvironmentId;
  kind: ExecutionEnvironmentKind;
  status: 'provisioning' | 'ready' | 'degraded' | 'offline' | 'releasing' | 'released';
  projectId: string;
  rootRef: string;
  cwdRef: string;
  branch?: string;
  baseRevision?: string;
  runtimeRef?: string;
  networkBrokerRef?: string;
  secretBrokerRef?: string;
  version: number;
}

export interface WorkspaceLease {
  leaseId: WorkspaceLeaseId;
  environmentId: EnvironmentId;
  ownerAgentRunId: AgentRunId;
  access: WorkspaceAccess;
  status: 'acquiring' | 'active' | 'expired' | 'releasing' | 'released' | 'orphaned' | 'fenced';
  rootRef: string;
  branch?: string;
  baseRevision?: string;
  acquiredAt: string;
  expiresAt?: string;
  heartbeatAt?: string;
  cleanupPolicy: 'retain' | 'remove_if_clean' | 'snapshot_then_remove';
  /** CodeStudio extension: monotonic fencing epoch shared with executor leases. */
  fencingEpoch: number;
  /** CodeStudio extension: the leased worktree carries uncommitted changes. */
  dirty?: boolean;
  version: number;
}
