import type { CapabilityId, EnvironmentId, WorkspaceLeaseId } from './ids.js';

export type PolicyEffect = 'allow' | 'deny' | 'ask';

export interface ResourceBinding {
  kind: 'path' | 'command' | 'network' | 'database' | 'secret' | 'application' | 'other';
  canonicalValue: string;
  version?: string;
}

export interface PolicyRequest {
  schemaVersion: 1;
  capabilityId: CapabilityId;
  capabilityVersion: string;
  effectiveInputHash: string;
  resources: ResourceBinding[];
  environmentId?: EnvironmentId;
  workspaceLeaseId?: WorkspaceLeaseId;
  fencingEpoch?: number;
  background: boolean;
}

export interface PolicyDecision {
  schemaVersion: 1;
  effect: PolicyEffect;
  reasonCode: string;
  source: string;
  precedence: number;
  constraints: Record<string, unknown>;
  policyVersion: string;
  evaluatedAt: string;
  auditRef?: string;
}

export interface ResourceGrant {
  grantId: string;
  decisionRef: string;
  capabilityId: CapabilityId;
  capabilityVersion: string;
  effectiveInputHash: string;
  resources: ResourceBinding[];
  environmentId?: EnvironmentId;
  workspaceLeaseId?: WorkspaceLeaseId;
  fencingEpoch?: number;
  duration: 'once' | 'session' | 'timeboxed' | 'persistent';
  nonce: string;
  createdAt: string;
  expiresAt?: string;
  consumedAt?: string;
  revokedAt?: string;
}
