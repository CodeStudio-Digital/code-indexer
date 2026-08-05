import { Readable } from 'node:stream';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  DurableSupervisorFactPort,
  HostSupervisorFactDriverOptions,
  HostSupervisorFactHandoff,
  SupervisorLifecycleFact,
} from '../driver/HostSupervisorFactTypes.js';
import {
  createHostSupervisorFactDriverForTesting,
} from '../driver/HostSupervisorFactDriverTesting.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  encodeManagementFrame,
  MANAGEMENT_FRAME_MAX_BYTES,
} from '../ipc/ManagementFrame.js';
import {
  captureWritable,
  delimit,
  identity,
  resourceBudget,
} from './attempt-channel-support.js';

export const MANAGEMENT_MAXIMUM = MANAGEMENT_FRAME_MAX_BYTES;
export const MANAGEMENT_CONNECTION = 'management:test';
export const MANAGEMENT_PROTOCOL = 65_537;
export const LAUNCH_MESSAGE_ID = 'launch:request';
export const RUNTIME_INSTANCE_ID = 'runner:instance';
export const RESERVATION_ID = 'reservation:test';
export const RESOURCE_GROUP_ID = 'job:test';

export function runnerProvenance(
  overrides: Partial<agentV1Common.RuntimeProvenance> = {},
) {
  const value = create(agentV1Common.RuntimeProvenanceSchema, {
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    buildId: 'runner-build',
    sourceCommit: '0123456789abcdef',
    binarySha256: new Uint8Array(32),
    pid: 42,
    operatingSystem: 'windows',
    architecture: 'x86_64',
  });
  Object.assign(value, overrides);
  return value;
}

export function containmentProof(
  overrides: Partial<agentV1Common.ContainmentReport> = {},
) {
  const value = create(agentV1Common.ContainmentReportSchema, {
    level: agentV1Common.ContainmentLevel.HARD_PROCESS,
    capabilities: { processTree: true, memoryLimit: true },
    enforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
    unsupportedLimits: [
      agentV1Common.ResourceLimitKind.CPU_TIME,
      agentV1Common.ResourceLimitKind.WALL_TIME,
      agentV1Common.ResourceLimitKind.PROCESSES,
      agentV1Common.ResourceLimitKind.THREADS,
      agentV1Common.ResourceLimitKind.OPEN_HANDLES,
      agentV1Common.ResourceLimitKind.SCRATCH_BYTES,
    ],
  });
  Object.assign(value, overrides);
  return value;
}

export function lifecyclePayload(
  fact: SupervisorLifecycleFact,
) {
  return create(agentV1Supervisor.ManagementPayloadSchema, { body: fact });
}

export function acceptedFact(
  overrides: Partial<agentV1Supervisor.LaunchAccepted> = {},
): SupervisorLifecycleFact {
  return {
    case: 'launchAccepted',
    value: create(agentV1Supervisor.LaunchAcceptedSchema, {
      identity: identity(),
      reservationId: RESERVATION_ID,
      reservedBudget: resourceBudget(),
      hardDeadlineAtUnixMs: 70_000n,
      acceptedAtUnixMs: 10n,
      ...overrides,
    }),
  };
}

export function rejectedFact(
  overrides: Partial<agentV1Supervisor.LaunchRejected> = {},
): SupervisorLifecycleFact {
  const value = create(agentV1Supervisor.LaunchRejectedSchema, {
    identity: identity(),
    reason: agentV1Supervisor.LaunchRejectionReason.ADMISSION_CLOSED,
    reasonCode: 'admission_closed',
    rejectedAtUnixMs: 10n,
  });
  Object.assign(value, overrides);
  return {
    case: 'launchRejected',
    value,
  };
}

export function spawnedFact(
  overrides: Partial<agentV1Supervisor.AttemptProcessSpawned> = {},
): SupervisorLifecycleFact {
  const value = create(agentV1Supervisor.AttemptProcessSpawnedSchema, {
    identity: identity(),
    runnerProvenance: runnerProvenance(),
    resourceGroupId: RESOURCE_GROUP_ID,
    reservationId: RESERVATION_ID,
    endpointIds: ['control', 'data', 'pulse'],
    spawnedAtUnixMs: 20n,
  });
  Object.assign(value, overrides);
  return {
    case: 'attemptProcessSpawned',
    value,
  };
}

export function containmentFact(
  overrides: Partial<agentV1Supervisor.AttemptContainmentReport> = {},
): SupervisorLifecycleFact {
  const value = create(agentV1Supervisor.AttemptContainmentReportSchema, {
    identity: identity(),
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    requestedBudget: resourceBudget(),
      effectiveContainment: containmentProof(),
    reportedAtUnixMs: 30n,
  });
  Object.assign(value, overrides);
  return {
    case: 'attemptContainmentReport',
    value,
  };
}

export function exitedFact(
  overrides: Partial<agentV1Supervisor.AttemptProcessExited> = {},
): SupervisorLifecycleFact {
  const value = create(agentV1Supervisor.AttemptProcessExitedSchema, {
    identity: identity(),
    runnerProvenance: runnerProvenance(),
    cause: agentV1Supervisor.PhysicalExitCause.CANCELLED,
    exitCode: 0,
    exitedAtUnixMs: 40n,
    finalResources: {
      residentMemoryBytes: 10n,
      peakResidentMemoryBytes: 20n,
      processCount: 1,
    },
  });
  Object.assign(value, overrides);
  return { case: 'attemptProcessExited', value };
}

export function reapedFact(
  overrides: Partial<agentV1Supervisor.AttemptProcessReaped> = {},
): SupervisorLifecycleFact {
  const value = create(agentV1Supervisor.AttemptProcessReapedSchema, {
    identity: identity(),
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    resourceGroupId: RESOURCE_GROUP_ID,
    releasedResources: [
      {
        kind: agentV1Supervisor.ReleasedResourceKind.PROCESS,
        resourceId: 'pid:42',
        releasedCount: 1n,
      },
      {
        kind: agentV1Supervisor.ReleasedResourceKind.RESOURCE_GROUP,
        resourceId: RESOURCE_GROUP_ID,
        releasedCount: 1n,
      },
    ],
    reapedAtUnixMs: 50n,
  });
  Object.assign(value, overrides);
  return { case: 'attemptProcessReaped', value };
}

export function factFrame(
  fact: SupervisorLifecycleFact,
  messageId: string,
  streamSeq: bigint,
  overrides: Partial<agentV1Supervisor.ManagementFrameHeader> = {},
): Uint8Array {
  const replyToMessageId = (
    fact.case === 'launchAccepted' || fact.case === 'launchRejected'
  ) ? LAUNCH_MESSAGE_ID : undefined;
  const header = create(agentV1Supervisor.ManagementFrameHeaderSchema, {
    protocolVersion: MANAGEMENT_PROTOCOL,
    connectionId: MANAGEMENT_CONNECTION,
    messageId,
    replyToMessageId,
    streamSeq,
    sentAtUnixMs: 5n,
  });
  Object.assign(header, overrides);
  return encodeManagementFrame(
    header,
    lifecyclePayload(fact),
  );
}

export function mutateWireHeader(
  encoded: Uint8Array,
  mutate: (header: agentV1Supervisor.ManagementFrameHeader) => void,
): Uint8Array {
  const frame = fromBinary(agentV1Supervisor.ManagementFrameSchema, encoded);
  mutate(frame.header!);
  return toBinary(agentV1Supervisor.ManagementFrameSchema, frame);
}

export function harness(
  frames: readonly Uint8Array[],
  port: DurableSupervisorFactPort,
  options: {
    readable?: Readable;
    writableFailureAt?: number;
    transportMaximum?: number;
    observeTransport?: (transport: DelimitedByteChannel) => void;
    driver?: {
      handoff?: Partial<HostSupervisorFactHandoff>;
      nowUnixMs?: () => bigint;
      durableCommitTimeoutMs?: number;
      commandResponseTimeoutMs?: number;
    };
  } = {},
) {
  const capture = captureWritable(options.writableFailureAt);
  const maximum = options.transportMaximum ?? MANAGEMENT_MAXIMUM;
  const transport = new DelimitedByteChannel(
    options.readable
      ?? Readable.from(frames.length === 0 ? [] : [delimit(...frames)]),
    capture.writable,
    { maximumFrameBytes: maximum },
  );
  options.observeTransport?.(transport);
  const defaults: HostSupervisorFactDriverOptions = {
    handoff: {
      protocolVersion: MANAGEMENT_PROTOCOL,
      connectionId: MANAGEMENT_CONNECTION,
      bootstrapInboundMessageId: 'supervisor-bootstrap',
      committedInboundStreamSeq: 1n,
      committedOutboundStreamSeq: 1n,
      maximumFrameBytes: MANAGEMENT_MAXIMUM,
      maximumReplayBytes: MANAGEMENT_MAXIMUM,
      trackedMessageIdCapacity: 16,
      expectedIdentity: identity(),
      expectedResourceBudget: resourceBudget(),
      launchObservedAtUnixMs: 5n,
      expectedHardDeadlineAtUnixMs: 70_000n,
      negotiatedMaximumReservedMemoryBytes: 8n * 1024n * 1024n * 1024n,
      negotiatedMaximumReservedProcesses: 64,
      expectedRunnerProvenance: create(
        agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
        {
        buildId: 'runner-build',
        sourceCommit: '0123456789abcdef',
        binarySha256: new Uint8Array(32),
        operatingSystem: 'windows',
        architecture: 'x86_64',
        },
      ),
      expectedEndpointIds: ['control', 'data', 'pulse'],
      requiredContainmentLevel:
        agentV1Common.ContainmentLevel.HARD_PROCESS,
      requiredEnforcedLimits: [
        agentV1Common.ResourceLimitKind.MEMORY,
      ],
      expectedLaunchReplyToMessageId: LAUNCH_MESSAGE_ID,
    },
    nowUnixMs: () => 100n,
    durableCommitTimeoutMs: 1_000,
    commandResponseTimeoutMs: 1_000,
    integrationMode: 'test',
  };
  const supplied = options.driver ?? {};
  const driverOptions: HostSupervisorFactDriverOptions = {
    ...defaults,
    ...supplied,
    handoff: {
      ...defaults.handoff,
      ...supplied.handoff,
    },
  };
  return {
    capture,
    transport,
    driverOptions,
    driver: createHostSupervisorFactDriverForTesting(
      transport,
      port,
      driverOptions,
    ),
  };
}

export function directionFrame(): Uint8Array {
  return encodeManagementFrame(
    create(agentV1Supervisor.ManagementFrameHeaderSchema, {
      protocolVersion: MANAGEMENT_PROTOCOL,
      connectionId: MANAGEMENT_CONNECTION,
      messageId: 'wrong-direction',
      streamSeq: 2n,
      sentAtUnixMs: 5n,
    }),
    create(agentV1Supervisor.ManagementPayloadSchema, {
      body: {
        case: 'launchAttemptProcess',
        value: { identity: identity() },
      },
    }),
  );
}
