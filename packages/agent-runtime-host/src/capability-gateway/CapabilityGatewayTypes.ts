import type {
  agentV1Capability,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';

export interface ValidatedCapabilityPrepare {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly runtimeInstanceId: string;
  readonly operationId: string;
  readonly providerOperationId: string;
  readonly toolUseId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly executionClass: agentV1Capability.CapabilityExecutionClass;
  readonly mutates: boolean;
  readonly encodedJsonInput: Uint8Array;
  readonly inputSha256: Uint8Array;
  readonly capabilitySetSha256: Uint8Array;
  readonly idempotencyKey: string;
  readonly deadlineAtUnixMs: bigint;
}

export type CapabilityResolution =
  | { readonly case: 'rejected'; readonly value: agentV1Capability.CapabilityRejected }
  | {
    readonly case: 'approvalRequired';
    readonly value: agentV1Capability.CapabilityApprovalRequired;
  }
  | { readonly case: 'accepted'; readonly value: agentV1Capability.SealedExecutionGrant };

export interface CapabilityDecisionResolver {
  resolve(request: ValidatedCapabilityPrepare): Promise<CapabilityResolution>;
}

export interface CapabilityGatewayLimits {
  readonly maximumPreparedOperations: number;
  readonly maximumInputBytes: number;
}

export const DEFAULT_CAPABILITY_GATEWAY_LIMITS: CapabilityGatewayLimits = Object.freeze({
  maximumPreparedOperations: 64,
  maximumInputBytes: 1024 * 1024,
});

