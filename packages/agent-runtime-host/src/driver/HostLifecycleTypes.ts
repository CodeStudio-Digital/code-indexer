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
