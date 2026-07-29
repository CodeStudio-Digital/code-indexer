import { timingSafeEqual } from 'node:crypto';
import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import { validateHostSelection } from './AttemptFrameBootstrapModels.js';
import type {
  HostLaunchState,
  PackedProtocolRange,
} from './HostLaunchAuthority.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import {
  assertSupportedFeatures,
  negotiatedAllowedFeatureBits,
} from './HostNegotiationPolicy.js';

export interface AgentHelloSelection {
  readonly supportedProtocols: PackedProtocolRange;
  readonly supportedFeatureBits: bigint;
}

export type HostHelloLaunchAuthority = Pick<
  HostLaunchState,
  | 'expectedConnectionId'
  | 'expectedConnectionSessionToken'
  | 'expectedContractVersion'
  | 'expectedContractSchemaVersion'
  | 'supportedProtocols'
  | 'heartbeatPolicy'
  | 'featurePolicy'
>;

export function validateAgentHelloForLaunch(
  hello: agentV1Runtime.AgentHello,
  launch: HostLaunchState,
  headerProtocolVersion: number,
): AgentHelloSelection {
  if (!sameBytes(hello.launchNonce, launch.expectedLaunchNonce)) {
    throw bootstrapError('launch_nonce_mismatch', 'AgentHello nonce mismatches launch');
  }
  const provenance = hello.provenance;
  if (provenance?.runtimeInstanceId !== launch.expectedRuntimeInstanceId) {
    throw bootstrapError(
      'runtime_instance_mismatch',
      'AgentHello runtime instance mismatches launch',
    );
  }
  if (!provenanceMatches(provenance, launch.expectedProvenance)) {
    throw bootstrapError(
      'invalid_expected_provenance',
      'AgentHello provenance mismatches launch',
    );
  }
  if (
    hello.contractVersion !== launch.expectedContractVersion
    || hello.contractSchemaVersion !== launch.expectedContractSchemaVersion
  ) {
    throw bootstrapError('contract_mismatch', 'AgentHello contract mismatches launch');
  }
  const supportedProtocols = protocolRangeFromHello(hello);
  if (headerProtocolVersion !== supportedProtocols.maximum) {
    throw bootstrapError(
      'protocol_mismatch',
      'AgentHello header protocol must equal its advertised maximum',
    );
  }
  if (
    supportedProtocols.maximum < launch.supportedProtocols.minimum
    || supportedProtocols.minimum > launch.supportedProtocols.maximum
  ) {
    throw bootstrapError('protocol_mismatch', 'AgentHello has no protocol overlap');
  }
  assertSupportedFeatures(
    hello.supportedFeatureBits,
    launch.featurePolicy,
  );
  runValidator(hello, launch.validateAgentHello);
  return {
    supportedProtocols,
    supportedFeatureBits: hello.supportedFeatureBits,
  };
}

export function validateHostHelloForLaunch(
  hello: agentV1Runtime.HostHello,
  launch: HostHelloLaunchAuthority,
  agent: AgentHelloSelection,
  hardMaximum: number,
  transport: DelimitedByteChannel,
): ReturnType<typeof validateHostSelection> {
  const selected = validateHostSelection(hello, hardMaximum);
  if (selected.connectionId !== launch.expectedConnectionId) {
    throw bootstrapError(
      'connection_mismatch',
      'HostHello connection mismatches provisioned endpoint',
    );
  }
  if (
    !sameBytes(
      hello.connectionSessionToken,
      launch.expectedConnectionSessionToken,
    )
  ) {
    throw bootstrapError(
      'connection_token_mismatch',
      'HostHello connection token mismatches endpoint authority',
    );
  }
  if (
    hello.contractVersion !== launch.expectedContractVersion
    || hello.contractSchemaVersion !== launch.expectedContractSchemaVersion
  ) {
    throw bootstrapError('contract_mismatch', 'HostHello contract mismatches launch');
  }
  if (
    selected.protocolVersion < launch.supportedProtocols.minimum
    || selected.protocolVersion > launch.supportedProtocols.maximum
    || selected.protocolVersion < agent.supportedProtocols.minimum
    || selected.protocolVersion > agent.supportedProtocols.maximum
  ) {
    throw bootstrapError(
      'selected_protocol_unsupported',
      'HostHello protocol is outside the negotiated intersection',
    );
  }
  if (
    hello.heartbeatIntervalMs !== launch.heartbeatPolicy.intervalMs
    || hello.heartbeatTimeoutMs !== launch.heartbeatPolicy.timeoutMs
  ) {
    throw bootstrapError(
      'heartbeat_policy_mismatch',
      'HostHello heartbeat policy mismatches launch authority',
    );
  }
  const negotiatedFeatures = negotiatedAllowedFeatureBits(
    agent.supportedFeatureBits,
    launch.featurePolicy,
  );
  if (
    hello.allowedFeatureBits !== negotiatedFeatures
    || hello.requiredFeatureBits
      !== launch.featurePolicy.requiredFeatureBits
  ) {
    throw bootstrapError(
      'feature_policy_mismatch',
      'HostHello feature policy mismatches launch negotiation',
    );
  }
  const limits = hello.frameLimits!;
  if (
    limits.maxChunkBytes !== BigInt(transport.maximumTransportChunkBytes)
    || limits.readTimeoutMs !== BigInt(transport.readTimeoutMs)
    || limits.writeTimeoutMs !== BigInt(transport.writeTimeoutMs)
  ) {
    throw bootstrapError(
      'transport_limits_mismatch',
      'HostHello transport limits mismatch the physical endpoint',
    );
  }
  return selected;
}

function protocolRangeFromHello(
  hello: agentV1Runtime.AgentHello,
): PackedProtocolRange {
  const range = hello.supportedProtocols;
  if (!range?.minimum || !range.maximum) {
    throw bootstrapError('invalid_protocol_range', 'AgentHello range is missing');
  }
  try {
    const minimum = packProtocolVersion(range.minimum);
    const maximum = packProtocolVersion(range.maximum);
    if (
      range.minimum.major === 0
      || range.maximum.major === 0
      || minimum > maximum
    ) throw new RangeError('invalid protocol range');
    return { minimum, maximum };
  } catch (cause) {
    throw new AttemptFrameBootstrapError(
      'invalid_protocol_range',
      'AgentHello protocol range is invalid',
      { cause },
    );
  }
}

function runValidator(
  hello: agentV1Runtime.AgentHello,
  validator: HostLaunchState['validateAgentHello'],
): void {
  try {
    const validation: unknown = validator(
      clone(agentV1Runtime.AgentHelloSchema, hello),
    );
    if (
      validation !== null
      && typeof validation === 'object'
      && 'then' in validation
    ) {
      void Promise.resolve(validation).catch(() => undefined);
      throw new TypeError('AgentHello validator must be synchronous');
    }
  } catch (cause) {
    throw new AttemptFrameBootstrapError(
      'agent_hello_rejected',
      'AgentHello failed launch policy',
      { cause },
    );
  }
}

function provenanceMatches(
  actual: agentV1Common.RuntimeProvenance | undefined,
  expected: HostLaunchState['expectedProvenance'],
): boolean {
  return (
    actual?.buildId === expected.buildId
    && actual.sourceCommit === expected.sourceCommit
    && actual.pid === expected.pid
    && actual.operatingSystem === expected.operatingSystem
    && actual.architecture === expected.architecture
    && sameBytes(actual.binarySha256, expected.binarySha256)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength
    && left.byteLength > 0
    && timingSafeEqual(left, right)
  );
}

function bootstrapError(
  code: ConstructorParameters<typeof AttemptFrameBootstrapError>[0],
  message: string,
): AttemptFrameBootstrapError {
  return new AttemptFrameBootstrapError(code, message);
}
