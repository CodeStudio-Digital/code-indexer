import type {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';

export type SupervisorLifecycleFactCase =
  | 'launchAccepted'
  | 'launchRejected'
  | 'attemptProcessSpawned'
  | 'attemptContainmentReport';

export type SupervisorLifecycleFact = Extract<
  agentV1Supervisor.ManagementPayload['body'],
  { case: SupervisorLifecycleFactCase }
>;

export interface SupervisorFactBinding {
  readonly connectionId: string;
  readonly messageId: string;
  readonly replyToMessageId?: string;
  readonly streamSeq: bigint;
  readonly payloadSha256: Uint8Array;
  readonly envelopeSha256: Uint8Array;
  readonly observedAtUnixMs: bigint;
}

export interface DurableSupervisorFactCommitControl {
  /** Aborts on the caller cancellation or the driver's mandatory timeout. */
  readonly signal: AbortSignal;
  /** Absolute owner-clock deadline paired with the bounded local timer. */
  readonly deadlineAtUnixMs: bigint;
  /** Stable digest-derived key for idempotent commit or reconciliation. */
  readonly idempotencyKey: string;
}

/**
 * Implemented by the host's single durable writer. Resolving means the fact is
 * committed and can be acknowledged; rejecting must leave it unacknowledged.
 * After `control.signal` aborts, a concrete port must guarantee no later
 * durable effect, or reconcile idempotently using `control.idempotencyKey`.
 * Late settlement never restores this poisoned channel or authorizes an ACK.
 */
export interface DurableSupervisorFactPort {
  commit(
    fact: SupervisorLifecycleFact,
    binding: SupervisorFactBinding,
    control: DurableSupervisorFactCommitControl,
  ): Promise<void>;
}

export interface HostSupervisorFactHandoff {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly bootstrapInboundMessageId: string;
  readonly committedInboundStreamSeq: bigint;
  readonly committedOutboundStreamSeq: bigint;
  readonly maximumFrameBytes: number;
  readonly maximumReplayBytes: number;
  readonly trackedMessageIdCapacity: number;
  readonly expectedIdentity: agentV1Common.AttemptIdentity;
  readonly expectedResourceBudget: agentV1Common.ResourceBudget;
  readonly launchObservedAtUnixMs: bigint;
  readonly expectedHardDeadlineAtUnixMs: bigint;
  readonly negotiatedMaximumReservedMemoryBytes: bigint;
  readonly negotiatedMaximumReservedProcesses: number;
  readonly expectedRunnerProvenance:
    agentV1Supervisor.ExpectedRuntimeProvenance;
  readonly expectedEndpointIds: readonly string[];
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
  readonly expectedLaunchReplyToMessageId: string;
}

export interface HostSupervisorFactDriverOptions {
  readonly handoff: HostSupervisorFactHandoff;
  readonly nowUnixMs: () => bigint;
  readonly durableCommitTimeoutMs: number;
  readonly integrationMode: 'test' | 'shadow';
}

export type HostSupervisorFactStep =
  | {
    readonly kind: 'committed';
    readonly factCase: SupervisorLifecycleFactCase;
    readonly messageId: string;
  }
  | {
    readonly kind: 'replayed';
    readonly factCase: SupervisorLifecycleFactCase;
    readonly messageId: string;
  };
