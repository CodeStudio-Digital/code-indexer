import type {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type {
  AttemptFrameReceiverLimits,
} from './AttemptFrameReceiverTypes.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import type {
  HostFeaturePolicy,
  HostHeartbeatPolicy,
} from './HostNegotiationPolicy.js';

export interface PackedProtocolRange {
  readonly minimum: number;
  readonly maximum: number;
}

export interface ExpectedRuntimeProvenance {
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly binarySha256: Uint8Array;
  readonly pid: number;
  readonly operatingSystem: string;
  readonly architecture: string;
}

export interface HostLaunchProvision {
  readonly transport: DelimitedByteChannel;
  readonly expectedIdentity: agentV1Common.AttemptIdentity;
  readonly expectedConnectionId: string;
  readonly expectedConnectionSessionToken: Uint8Array;
  readonly expectedLaunchNonce: Uint8Array;
  readonly expectedRuntimeInstanceId: string;
  readonly expectedContractVersion: string;
  readonly expectedContractSchemaVersion: number;
  readonly expectedProvenance: ExpectedRuntimeProvenance;
  readonly supportedProtocols: PackedProtocolRange;
  readonly resourceBudget: agentV1Common.ResourceBudget;
  readonly hardDeadlineAtUnixMs: bigint;
  readonly heartbeatPolicy: HostHeartbeatPolicy;
  readonly featurePolicy: HostFeaturePolicy;
  readonly validateAgentHello: (
    hello: agentV1Runtime.AgentHello,
  ) => void;
}

export interface HostLaunchState extends HostLaunchProvision {
  readonly receiverLimits: AttemptFrameReceiverLimits;
  readonly maximumResponseTimeoutMs: number;
}
