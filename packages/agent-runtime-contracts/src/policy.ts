import type {
  AgentRunId,
  CapabilityId,
  EnvironmentId,
  SessionCommandId,
  SessionId,
  ToolUseId,
  WorkspaceLeaseId,
} from './ids.js';
import type { SessionCommandActor } from './commands.js';
import type { CapabilityDescriptor } from './capabilities.js';
import type { ExecutionEnvironmentRef, WorkspaceLease } from './environment.js';

export type PolicyEffect = 'allow' | 'deny' | 'ask';

export type ResourceConstraint =
  | { kind: 'path'; root: string; access: 'read' | 'write'; followSymlinks: boolean }
  | { kind: 'command'; executable: string; argRules?: string[] }
  | { kind: 'network'; domains: string[]; methods?: string[] }
  | { kind: 'database'; databaseId: string; operations: string[] }
  | { kind: 'secret'; secretIds: string[]; exposure: 'handle-only' | 'environment' }
  | { kind: 'application'; appId: string; operations: string[] }
  | { kind: 'workspace_lease'; leaseId: WorkspaceLeaseId };

/** RFC-6902 style patch proposed by policy; caller re-validates and re-evaluates. */
export type JsonPatch = Array<{
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  from?: string;
  value?: unknown;
}>;

/**
 * Short-lived, versioned snapshot of the effective input resolved by the
 * Environment Broker before a decision. Must be revalidated immediately
 * before the side effect and converted into a sealed execution handle.
 */
export interface ResourceBinding {
  bindingId: string;
  effectiveInputHash: string;
  canonicalInputRef: string;
  canonicalResources: ResourceConstraint[];
  environmentId: EnvironmentId;
  environmentVersion: number;
  workspaceLeaseId?: WorkspaceLeaseId;
  workspaceLeaseVersion?: number;
  workspaceFencingEpoch?: number;
  resolvedAt: string;
  expiresAt: string;
}

export interface InvocationApprovalBinding {
  decisionId: string;
  toolUseId: ToolUseId;
  capabilityId: CapabilityId;
  capabilityVersion: string;
  policyVersion: string;
  resourceBindingId: string;
  effectiveInputHash: string;
  environmentId: EnvironmentId;
  environmentVersion: number;
  workspaceLeaseId?: WorkspaceLeaseId;
  workspaceLeaseVersion?: number;
  workspaceFencingEpoch?: number;
  expiresAt: string;
  nonce: string;
}

export interface PolicyRequest {
  schemaVersion: 1;
  actor: SessionCommandActor;
  sessionId: SessionId;
  commandId: SessionCommandId;
  agentRunId?: AgentRunId;
  capability: CapabilityDescriptor;
  invocation: {
    toolUseId: ToolUseId;
    parentToolUseId?: ToolUseId;
    input: unknown;
    effectiveInputHash: string;
    nested: boolean;
  };
  environment: ExecutionEnvironmentRef;
  workspaceLease?: WorkspaceLease;
  resourceBinding: ResourceBinding;
  planState?: { mode: 'none' | 'plan' | 'spec'; approved: boolean };
  taskScope?: { taskId: string; allowedResources: ResourceConstraint[] };
  organizationPolicyVersion?: string;
  sessionPolicyVersion: string;
}

export type PolicySourceType =
  | 'system'
  | 'organization'
  | 'project'
  | 'user'
  | 'session'
  | 'grant'
  | 'hook';

export interface PolicyDecision {
  decisionId: string;
  effect: PolicyEffect;
  reasonCode: string;
  explanation: string;
  precedence: number;
  sources: Array<{
    sourceType: PolicySourceType;
    sourceRef: string;
    outcome: 'allow' | 'deny' | 'ask' | 'abstain';
  }>;
  constraints: ResourceConstraint[];
  inputPatch?: JsonPatch;
  approval?: {
    prompt: string;
    binding: InvocationApprovalBinding;
    allowedDurations: Array<'once' | 'session' | 'timeboxed' | 'persistent'>;
    recommendedDuration: 'once' | 'session' | 'timeboxed' | 'persistent';
  };
  requiresReevaluation: boolean;
  audit: {
    capabilityId: CapabilityId;
    capabilityVersion: string;
    policyVersion: string;
    decidedAt: string;
  };
}

export interface PolicyGrantBase {
  grantId: string;
  subject: { actorId: string; projectId?: string; sessionId?: SessionId };
  capabilities: Array<{ capabilityId: CapabilityId; capabilityVersion: string }>;
  constraints: ResourceConstraint[];
  issuedBy: string;
  issuedFromDecisionId: string;
  policyVersion: string;
  revokedAt?: string;
}

export type PolicyGrant =
  | (PolicyGrantBase & {
      duration: 'once';
      binding: InvocationApprovalBinding;
      expiresAt: string;
      consumption: {
        status: 'unconsumed' | 'consumed' | 'revoked';
        consumedByToolUseId?: ToolUseId;
        consumedAt?: string;
      };
    })
  | (PolicyGrantBase & {
      duration: 'session' | 'timeboxed' | 'persistent';
      expiresAt?: string;
      binding?: never;
    });
