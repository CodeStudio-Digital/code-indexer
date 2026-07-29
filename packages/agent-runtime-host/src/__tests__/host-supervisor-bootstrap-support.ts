import { Readable } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  HostSupervisorBootstrapProvision,
  HostSupervisorLaunchOptions,
} from '../ipc/HostSupervisorBootstrapTypes.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  HostSupervisorManagementBootstrap,
} from '../ipc/HostSupervisorManagementBootstrap.js';
import { encodeManagementFrame } from '../ipc/ManagementFrame.js';
import {
  BINARY_SHA256,
  captureWritable,
  delimit,
  identity,
  resourceBudget,
} from './attempt-channel-support.js';
import {
  MANAGEMENT_CONNECTION,
  MANAGEMENT_MAXIMUM,
  MANAGEMENT_PROTOCOL,
} from './host-supervisor-fact-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';

export const MANAGEMENT_TOKEN = Uint8Array.from({ length: 32 }, () => 8);
export const SUPERVISOR_NONCE = Uint8Array.from({ length: 32 }, () => 9);

export function expectedProvenance(
  buildId = 'supervisor-build',
): agentV1Supervisor.ExpectedRuntimeProvenance {
  return create(agentV1Supervisor.ExpectedRuntimeProvenanceSchema, {
    buildId,
    sourceCommit: '0123456789abcdef',
    binarySha256: BINARY_SHA256,
    operatingSystem: 'windows',
    architecture: 'x86_64',
  });
}

export function hostSupervisorHello() {
  return create(agentV1Supervisor.HostSupervisorHelloSchema, {
    selectedProtocol: { major: 1, minor: 1 },
    connectionId: MANAGEMENT_CONNECTION,
    contractVersion: 'contract:test-v1',
    contractSchemaVersion: 1,
    expectedSupervisorProvenance: expectedProvenance(),
    allowedRunnerProvenance: [expectedProvenance('runner-build')],
    limits: {
      maxActiveAttempts: 8,
      maxPendingLaunches: 8,
      maxReservedMemoryBytes: 8n * 1024n * 1024n * 1024n,
      maxReservedProcesses: 64,
      hostDisconnectGraceMs: 10_000n,
      runnerPulseTimeoutMs: 5_000n,
    },
    frameLimits: {
      maxFrameBytes: BigInt(MANAGEMENT_MAXIMUM),
      maxChunkBytes: 16n * 1024n,
      maxInFlightFrames: 32n,
      maxInFlightBytes: 2n * 1024n * 1024n,
      readTimeoutMs: 10_000n,
      writeTimeoutMs: 10_000n,
    },
    managementSessionToken: MANAGEMENT_TOKEN,
    requiredContainmentLevel: agentV1Common.ContainmentLevel.MONITORED,
  });
}

export function supervisorHello(
  overrides: Partial<agentV1Supervisor.SupervisorHello> = {},
) {
  const hello = create(agentV1Supervisor.SupervisorHelloSchema, {
    supportedProtocols: {
      minimum: { major: 1, minor: 1 },
      maximum: { major: 1, minor: 1 },
    },
    contractVersion: 'contract:test-v1',
    contractSchemaVersion: 1,
    provenance: {
      runtimeInstanceId: 'supervisor:runtime',
      buildId: 'supervisor-build',
      sourceCommit: '0123456789abcdef',
      binarySha256: BINARY_SHA256,
      pid: 41,
      operatingSystem: 'windows',
      architecture: 'x86_64',
    },
    launchNonce: SUPERVISOR_NONCE,
    containment: {},
  });
  Object.assign(hello, overrides);
  return hello;
}

export function supervisorHelloFrame(
  hello = supervisorHello(),
  headerOverrides: Partial<agentV1Supervisor.ManagementFrameHeader> = {},
): Uint8Array {
  const header = create(agentV1Supervisor.ManagementFrameHeaderSchema, {
    protocolVersion: MANAGEMENT_PROTOCOL,
    connectionId: MANAGEMENT_CONNECTION,
    messageId: 'supervisor-bootstrap',
    streamSeq: 1n,
    sentAtUnixMs: 1n,
  });
  Object.assign(header, headerOverrides);
  return encodeManagementFrame(
    header,
    create(agentV1Supervisor.ManagementPayloadSchema, {
      body: { case: 'supervisorHello', value: hello },
    }),
  );
}

export function launchAttempt(
  overrides: Partial<agentV1Supervisor.LaunchAttemptProcess> = {},
) {
  const launch = create(agentV1Supervisor.LaunchAttemptProcessSchema, {
    identity: identity(),
    resourceBudget: resourceBudget(),
    hardDeadlineAtUnixMs: 70_000n,
    authorityLeaseExpiresAtUnixMs: 60_000n,
    launchNonce: Uint8Array.from({ length: 32 }, () => 5),
    protectedEndpoints: [
      endpoint(agentV1Supervisor.AttemptEndpointKind.CONTROL, 'control', 256 * 1024),
      endpoint(agentV1Supervisor.AttemptEndpointKind.DATA, 'data', 1024 * 1024),
      endpoint(agentV1Supervisor.AttemptEndpointKind.RUNNER_PULSE, 'pulse', 4 * 1024),
    ],
    expectedRunnerProvenance: expectedProvenance('runner-build'),
    idempotencyKey: 'launch:test',
    requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
    activationAuthoritySeal: activationAuthoritySeal(),
  });
  Object.assign(launch, overrides);
  return launch;
}

export function bootstrapHarness(
  frames: readonly Uint8Array[],
  clock: () => bigint = sequenceClock(),
  readable?: Readable,
  hello = hostSupervisorHello(),
) {
  const capture = captureWritable();
  const transport = new DelimitedByteChannel(
    readable ?? Readable.from([delimit(...frames)]),
    capture.writable,
    {
      maximumFrameBytes: MANAGEMENT_MAXIMUM,
      maximumTransportChunkBytes: 16 * 1024,
      readTimeoutMs: 10_000,
      writeTimeoutMs: 10_000,
    },
  );
  const provision: HostSupervisorBootstrapProvision = {
    expectedConnectionId: MANAGEMENT_CONNECTION,
    expectedManagementSessionToken: MANAGEMENT_TOKEN,
    expectedSupervisorLaunchNonce: SUPERVISOR_NONCE,
    hostHello: hello,
    nowUnixMs: clock,
  };
  return {
    capture,
    transport,
    bootstrap: new HostSupervisorManagementBootstrap(transport, provision),
  };
}

export function launchOptions(
  overrides: Partial<HostSupervisorLaunchOptions> = {},
): HostSupervisorLaunchOptions {
  return {
    responseTimeoutMs: 1_000,
    maximumReplayBytes: MANAGEMENT_MAXIMUM,
    trackedMessageIdCapacity: 8,
    durableCommitTimeoutMs: 1_000,
    integrationMode: 'test',
    ...overrides,
  };
}

function endpoint(
  kind: agentV1Supervisor.AttemptEndpointKind,
  endpointId: string,
  maximum: number,
) {
  return create(agentV1Supervisor.ProtectedAttemptEndpointSchema, {
    kind,
    endpointId,
    address: `pipe:${endpointId}`,
    connectionToken: Uint8Array.from({ length: 32 }, () => 6),
    maxFrameBytes: BigInt(maximum),
  });
}

function sequenceClock(): () => bigint {
  const values = [1n, 2n, 5n, 100n, 100n, 100n];
  return () => values.shift() ?? 100n;
}
