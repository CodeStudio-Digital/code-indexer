import type { AgentRunId, EnvironmentId, SessionId, WorkspaceLeaseId } from './ids.js';

export interface ArtifactRef {
  artifactId: string;
  kind: string;
  contentHash: string;
  mediaType?: string;
  byteLength?: number;
  redactionPolicyVersion?: string;
}

export interface Claim {
  claimId: string;
  type: string;
  summary: string;
  evidenceRefs: string[];
  riskClass?: string;
}

export interface VerifierResult {
  claimId: string;
  verdict: 'confirmed' | 'rejected' | 'uncertain';
  evidenceRefs: string[];
  rationale: string;
  verifierAgentRunId: AgentRunId;
}

export interface HandoffArtifact {
  handoffId: string;
  schemaVersion: 1;
  sessionId: SessionId;
  fromAgentRunId?: AgentRunId;
  toAgentRunSpecRef?: string;
  goalRef: string;
  decisionsRef: string;
  pendingWorkRef: string;
  transcriptRef: string;
  checkpointRef?: string;
  memoryContextRef?: string;
  environmentRef?: EnvironmentId;
  workspaceLeaseTransfer?: {
    leaseId: WorkspaceLeaseId;
    mode: 'transfer' | 'read_only_reference' | 'none';
  };
  createdAt: string;
  contentHash: string;
}
