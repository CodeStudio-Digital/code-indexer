import type {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type {
  HostLifecycleLaunchBinding,
} from './HostLifecycleLaunchAuthority.js';

export type {
  PreparedFactsExpectation,
} from './PreparedFactsTypes.js';

export interface PreparedDurabilityFacts {
  readonly connectionId: string;
  readonly prepareMessageId: string;
  readonly preparedMessageId: string;
  readonly prepare: agentV1Runtime.PrepareAttempt;
  readonly prepared: agentV1Runtime.AttemptPrepared;
}

export interface DurableActivationGrant {
  readonly connectionId: string;
  readonly runtimeInstanceId: string;
  readonly prepareMessageId: string;
  readonly preparedMessageId: string;
  readonly activate: agentV1Runtime.ActivateAttempt;
}

export interface ActiveAttemptAuthorityFacts {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly connectionId: string;
  readonly runtimeInstanceId: string;
  readonly agentRunVersion: bigint;
  readonly attemptVersion: bigint;
  readonly specSha256: Uint8Array;
  readonly activationNonce: Uint8Array;
  readonly deadlineAtUnixMs: bigint;
}

export interface ActiveAttemptAuthoritySnapshot
  extends ActiveAttemptAuthorityFacts {
  readonly signal: AbortSignal;
  readonly heartbeat?: HostHeartbeatSnapshot;
}

export interface HostHeartbeatSnapshot {
  readonly messageId: string;
  readonly observedAtUnixMs: bigint;
  readonly lastAliveAtUnixMs: bigint;
  readonly lastProgressAtUnixMs: bigint;
  readonly lastEventSeq: bigint;
  readonly phase: agentV1Runtime.PhysicalAttemptPhase;
  readonly resources: agentV1Common.ResourceSample;
}

export interface HostCancelAttemptRequest {
  readonly reason: agentV1Runtime.CancelReason;
  readonly reasonCode: string;
  readonly graceDeadlineAtUnixMs: bigint;
  readonly idempotencyKey: string;
}

export interface HostFenceAttemptRequest {
  readonly replacementFencingEpoch: bigint;
  readonly reasonCode: string;
  readonly fencedAtUnixMs: bigint;
  readonly idempotencyKey: string;
}

export interface HostReapAttemptRequest {
  readonly runtimeInstanceId: string;
  readonly reapDeadlineAtUnixMs: bigint;
  readonly reasonCode: string;
  readonly idempotencyKey: string;
}

export interface PreparedDurabilityPort {
  commitPrepared(
    facts: PreparedDurabilityFacts,
    context: PreparedDurabilityContext,
  ): Promise<DurableActivationGrant>;
}

export interface PreparedDurabilityContext {
  readonly signal: AbortSignal;
  readonly deadlineAtUnixMs: bigint;
}

export interface HostAttemptLifecycleDriverOptions {
  readonly launch: HostLifecycleLaunchBinding;
  readonly hostHello: agentV1Runtime.HostHello;
  readonly durability: PreparedDurabilityPort;
  readonly outboundTimeoutMs: number;
}
