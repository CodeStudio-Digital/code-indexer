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
  /** Release a policy seal only after its terminal record is durably acknowledged. */
  retire?(request: ValidatedCapabilityPrepare, decision: agentV1Capability.CapabilityUpdate): void;
}

export type HostCapabilityExecutionOutcome =
  | {
    readonly case: 'succeeded';
    readonly schemaId: string;
    readonly schemaVersion: number;
    readonly encodedResult: Uint8Array;
    readonly bytesRead: bigint;
    readonly truncated: boolean;
    readonly durationMs: bigint;
  }
  | {
    readonly case: 'failed' | 'cancelled' | 'outcomeUnknown';
    readonly reasonCode: string;
    readonly durationMs: bigint;
  };

export interface HostCapabilityExecutor {
  /** Must derive this from the sealed Host registry, never from runner flags. */
  isParallelSafe?(request: ValidatedCapabilityPrepare, grant: agentV1Capability.SealedExecutionGrant): boolean;
  execute(
    request: ValidatedCapabilityPrepare,
    grant: agentV1Capability.SealedExecutionGrant,
  ): Promise<HostCapabilityExecutionOutcome>;
}

export interface CapabilityGatewayLimits {
  readonly maximumPreparedOperations: number;
  readonly maximumRetiredOperations?: number;
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
}

export const DEFAULT_CAPABILITY_GATEWAY_LIMITS: CapabilityGatewayLimits = Object.freeze({
  maximumPreparedOperations: 64,
  maximumRetiredOperations: 100_000,
  maximumInputBytes: 1024 * 1024,
  maximumOutputBytes: 1024 * 1024,
});

