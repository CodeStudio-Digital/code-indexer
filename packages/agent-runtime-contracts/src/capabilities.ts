import type { AgentRunId, CapabilityId } from './ids.js';
import type { ExecutionEnvironmentKind } from './environment.js';

export type SideEffectOutcome =
  | 'not_started'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown';

export interface SideEffectContract {
  kind: 'none' | 'local' | 'external';
  idempotency: 'none' | 'caller_key' | 'provider_key';
  idempotencyKeyField?: string;
  safeRetryStages: Array<'before_dispatch' | 'rejected_before_accept' | 'confirmed_not_started'>;
  outcomeProbeCapabilityId?: CapabilityId;
  compensationCapabilityId?: CapabilityId;
  ambiguousOutcome: 'mark_outcome_unknown' | 'require_reconciliation';
}

export interface CapabilitySource {
  kind: 'native' | 'mcp_internal' | 'mcp_external' | 'plugin' | 'skill' | 'remote';
  providerId: string;
  serverId?: string;
  provenanceRef?: string;
  metadataTrust: 'local' | 'attested' | 'untrusted';
}

export interface CapabilityVisibility {
  defaultTier: string;
  searchable: boolean;
  promptSummaryClass: 'always' | 'discoverable' | 'hidden';
}

export interface CapabilityExecution {
  class: 'read' | 'write' | 'execute' | 'control';
  mutates: boolean;
  parallelSafe: boolean;
  repeatPolicy: 'stable' | 'volatile' | 'pollable' | 'mutating';
  sideEffect: SideEffectContract;
  timeoutPolicy: string;
  cancellation: 'cooperative' | 'hard-kill' | 'unsupported';
}

export interface CapabilityRequirements {
  environmentKinds?: ExecutionEnvironmentKind[];
  sandboxRequired?: boolean;
  networkScopes?: string[];
  secretScopes?: string[];
  interactive?: boolean;
}

export interface CapabilityDescriptor {
  capabilityId: CapabilityId;
  version: string;
  name: string;
  aliases: string[];
  displayName: string;
  description: string;
  source: CapabilitySource;
  inputSchema: object;
  outputSchema?: object;
  visibility: CapabilityVisibility;
  execution: CapabilityExecution;
  requirements: CapabilityRequirements;
  riskClassifierRef: string;
  outputPolicyRef: string;
  lifecycleRef?: string;
  enabled: boolean;
}

/**
 * Resolved projection for one AgentRun. Authorization is NOT part of this
 * contract — final allow/deny/ask belongs to the Policy Engine (D-005).
 */
export interface ResolvedCapabilitySet {
  ref: string;
  hash: string;
  catalogVersion: string;
  agentRunId: AgentRunId;
  registered: CapabilityId[];
  visible: CapabilityId[];
  eligible: CapabilityId[];
  disabled: Array<{ capabilityId: CapabilityId; reason: string }>;
  providerDescriptorsRef: string;
  promptSummaryRef: string;
  resolvedAt: string;
}
