import type {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';

export interface HostSupervisorBootstrapProvision {
  readonly expectedConnectionId: string;
  readonly expectedManagementSessionToken: Uint8Array;
  readonly expectedSupervisorLaunchNonce: Uint8Array;
  readonly hostHello: agentV1Supervisor.HostSupervisorHello;
  readonly nowUnixMs: () => bigint;
}

export interface HostSupervisorLaunchOptions {
  /** Physical admission may include executable verification and cold OS startup. */
  readonly launchResponseTimeoutMs?: number;
  readonly responseTimeoutMs: number;
  readonly maximumReplayBytes: number;
  readonly trackedMessageIdCapacity: number;
  readonly durableCommitTimeoutMs: number;
  readonly integrationMode: 'test' | 'shadow';
}

export interface HostSupervisorPolicySnapshot {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly contractVersion: string;
  readonly contractSchemaVersion: number;
  readonly expectedSupervisorProvenance:
    agentV1Supervisor.ExpectedRuntimeProvenance;
  readonly allowedRunnerProvenance:
    readonly agentV1Supervisor.ExpectedRuntimeProvenance[];
  readonly limits: agentV1Supervisor.SupervisorLimits;
  readonly frameLimits: agentV1Common.FrameLimits;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly allowedFeatureBits: bigint;
}

export interface ValidatedHostSupervisorProvision {
  readonly hello: agentV1Supervisor.HostSupervisorHello;
  readonly policy: HostSupervisorPolicySnapshot;
  readonly managementTokenDigest: Uint8Array;
  readonly supervisorNonceDigest: Uint8Array;
}
