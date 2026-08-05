import { Readable, Writable } from 'node:stream';
import { create, fromBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  ATTEMPT_FRAME_MAX_BYTES,
  encodeAttemptFrame,
  encodeBootstrapAttemptFrame,
} from '../ipc/AttemptFrame.js';
import {
  createHostBootstrapAttemptChannelForTesting,
} from '../ipc/HostBootstrapAttemptChannel.js';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  type HostLaunchProvision,
  HostLaunchAuthority,
} from '../ipc/HostLaunchAuthority.js';

export const MAXIMUM = ATTEMPT_FRAME_MAX_BYTES[
  agentV1Runtime.TransportChannel.CONTROL
];
export const NONCE = Uint8Array.from(
  { length: 32 },
  (_value, index) => index + 1,
);
export const CONNECTION_TOKEN = Uint8Array.from(
  { length: 32 },
  (_value, index) => 255 - index,
);
export const BINARY_SHA256 = Uint8Array.from(
  { length: 32 },
  (_value, index) => index,
);
export const CONNECTION = 'provisioned-connection';
export const RUNTIME = 'runtime-instance';
export const BUILD_ID = 'agentd-test-build';
export const SOURCE_COMMIT = '0123456789abcdef';

export function identity() {
  return create(agentV1Common.AttemptIdentitySchema, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    agentRunId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    executorOwnerId: 'owner',
    fencingEpoch: 7n,
    correlationId: '55555555-5555-4555-8555-555555555555',
    rootAgentRunId: '66666666-6666-4666-8666-666666666666',
    ownerAgentRunId: '77777777-7777-4777-8777-777777777777',
  });
}

export function frameHeader(
  messageId: string,
  streamSeq: bigint,
  overrides = {},
) {
  const authority = identity();
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: CONNECTION,
    messageId,
    sessionId: authority.sessionId,
    commandId: authority.commandId,
    agentRunId: authority.agentRunId,
    attemptId: authority.attemptId,
    executorOwnerId: authority.executorOwnerId,
    fencingEpoch: authority.fencingEpoch,
    correlationId: authority.correlationId,
    rootAgentRunId: authority.rootAgentRunId,
    ownerAgentRunId: authority.ownerAgentRunId,
    streamSeq,
    sentAtUnixMs: 1n,
    ...overrides,
  });
}

export function agentHello(overrides = {}) {
  return create(agentV1Runtime.AgentHelloSchema, {
    supportedProtocols: {
      minimum: { major: 1, minor: 1 },
      maximum: { major: 1, minor: 1 },
    },
    contractVersion: '1.0.0',
    contractSchemaVersion: 1,
    provenance: {
      runtimeInstanceId: RUNTIME,
      buildId: BUILD_ID,
      sourceCommit: SOURCE_COMMIT,
      binarySha256: BINARY_SHA256,
      pid: 42,
      operatingSystem: 'windows',
      architecture: 'x86_64',
    },
    launchNonce: NONCE,
    containment: { processTree: true, memoryLimit: true },
    supportedFeatureBits: 0b11n,
    ...overrides,
  });
}

export function hostHello(overrides = {}) {
  return create(agentV1Runtime.HostHelloSchema, {
    selectedProtocol: { major: 1, minor: 1 },
    connectionId: CONNECTION,
    contractVersion: '1.0.0',
    contractSchemaVersion: 1,
    heartbeatIntervalMs: 1_000n,
    heartbeatTimeoutMs: 5_000n,
    frameLimits: {
      maxFrameBytes: BigInt(MAXIMUM),
      maxChunkBytes: BigInt(Math.min(MAXIMUM, 64 * 1024)),
      maxInFlightFrames: 1n,
      maxInFlightBytes: BigInt(MAXIMUM),
      readTimeoutMs: 30_000n,
      writeTimeoutMs: 30_000n,
    },
    connectionSessionToken: CONNECTION_TOKEN,
    allowedFeatureBits: 0b11n,
    requiredFeatureBits: 0b01n,
    ...overrides,
  });
}

export function agentHelloFrame(
  hello = agentHello(),
  headerOverrides = {},
): Uint8Array {
  return encodeBootstrapAttemptFrame(
    frameHeader('agent-hello', 1n, headerOverrides),
    create(agentV1Runtime.FramePayloadSchema, {
      body: { case: 'agentHello', value: hello },
    }),
    MAXIMUM,
  );
}

export function heartbeatFrame(
  messageId: string,
  streamSeq: bigint,
  headerOverrides = {},
  valueOverrides: Partial<Pick<
    agentV1Runtime.Heartbeat,
    | 'lastAliveAtUnixMs'
    | 'lastProgressAtUnixMs'
    | 'lastEventSeq'
    | 'phase'
    | 'resources'
  >> = {},
): Uint8Array {
  return encodeAttemptFrame(
    frameHeader(messageId, streamSeq, headerOverrides),
    agentV1Runtime.TransportChannel.CONTROL,
    create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'heartbeat',
        value: {
          identity: identity(),
          runtimeInstanceId: RUNTIME,
          lastAliveAtUnixMs: 1n,
          lastProgressAtUnixMs: 1n,
          lastEventSeq: 1n,
          phase: agentV1Runtime.PhysicalAttemptPhase.ACTIVE,
          ...valueOverrides,
        },
      },
    }),
    MAXIMUM,
  );
}

export function ackPayload(
  value = 'semantic-operation',
  acknowledgedPayloadSha256: Uint8Array = new Uint8Array(32),
  acknowledgedAtUnixMs = 9n,
) {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'ack',
      value: {
        acknowledgedMessageId: value,
        acknowledgedPayloadSha256,
        acknowledgedAtUnixMs,
      },
    },
  });
}

export function preparePayload() {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'prepareAttempt',
      value: {
        identity: identity(),
        encodedSpec: Uint8Array.of(1),
        expectedSpecSha256: new Uint8Array(32),
        idempotencyKey: 'prepare-idempotency',
        specSchemaVersion: 1,
      },
    },
  });
}

export function activatePayload() {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'activateAttempt',
      value: {
        identity: identity(),
        agentRunVersion: 1n,
        attemptVersion: 1n,
        deadlineAtUnixMs: 60_000n,
        activationNonce: Uint8Array.of(1),
        specSha256: new Uint8Array(32),
        idempotencyKey: 'activate-idempotency',
      },
    },
  });
}

export function attemptPreparedFrame(
  messageId: string,
  streamSeq: bigint,
  replyToMessageId?: string,
  runtimeInstanceId = RUNTIME,
  specSha256: Uint8Array = new Uint8Array(32),
  readyAtUnixMs = 10n,
  overrides: Partial<Pick<
    agentV1Runtime.AttemptPrepared,
    | 'loadedSnapshots'
    | 'validatedArtifacts'
    | 'effectiveResourceBudget'
    | 'effectiveContainment'
  >> = {},
): Uint8Array {
  return encodeAttemptFrame(
    frameHeader(messageId, streamSeq, { replyToMessageId }),
    agentV1Runtime.TransportChannel.CONTROL,
    create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'attemptPrepared',
        value: {
          identity: identity(),
          runtimeInstanceId,
          specSha256,
          readyAtUnixMs,
          ...overrides,
        },
      },
    }),
    MAXIMUM,
  );
}

export function terminalProposalFrame(
  messageId: string,
  streamSeq: bigint,
  terminalPayloadSha256: Uint8Array,
): Uint8Array {
  return encodeAttemptFrame(
    frameHeader(messageId, streamSeq),
    agentV1Runtime.TransportChannel.CONTROL,
    create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'terminalProposal',
        value: {
          identity: identity(),
          runtimeInstanceId: RUNTIME,
          reasonCode: 'completed',
          lastEmittedSequence: 1n,
          terminalPayloadSha256,
        },
      },
    }),
    MAXIMUM,
  );
}

export function terminalCommittedPayload(
  terminalProposalMessageId: string,
  terminalPayloadSha256: Uint8Array,
  committedAtUnixMs = 10n,
) {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'terminalCommitted',
      value: {
        identity: identity(),
        terminalProposalMessageId,
        terminalPayloadSha256,
        agentRunVersion: 1n,
        attemptVersion: 1n,
        committedAtUnixMs,
      },
    },
  });
}

export function inboundAckFrame(
  messageId: string,
  streamSeq: bigint,
  replyToMessageId?: string,
  acknowledgedPayloadSha256: Uint8Array = new Uint8Array(32),
  acknowledgedAtUnixMs = 10n,
): Uint8Array {
  return encodeAttemptFrame(
    frameHeader(messageId, streamSeq, { replyToMessageId }),
    agentV1Runtime.TransportChannel.CONTROL,
    create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'ack',
        value: {
          acknowledgedMessageId: replyToMessageId ?? '',
          acknowledgedPayloadSha256,
          acknowledgedAtUnixMs,
        },
      },
    }),
    MAXIMUM,
  );
}

export function hostBootstrap(
  frames: readonly Uint8Array[],
  options: {
    clock?: () => bigint;
    readable?: Readable;
    writable?: Writable;
    validateAgentHello?: (hello: agentV1Runtime.AgentHello) => void;
  } = {},
) {
  const capture = options.writable ? undefined : captureWritable();
  const writable = options.writable ?? capture!.writable;
  const transport = new DelimitedByteChannel(
    options.readable ?? Readable.from([delimit(...frames)]),
    writable,
    { maximumFrameBytes: MAXIMUM },
  );
  const launch = provisionLaunch(transport, {
    validateAgentHello: options.validateAgentHello ?? (() => undefined),
  });
  const channelOptions = { launch };
  const bootstrap = createHostBootstrapAttemptChannelForTesting(
    channelOptions,
    createAuthorityClockForTesting(options.clock ?? (() => 10n)),
  );
  return { bootstrap, capture, transport };
}

export function provisionLaunch(
  transport: DelimitedByteChannel,
  overrides: Partial<HostLaunchProvision> = {},
) {
  return HostLaunchAuthority.provision(
    launchProvision(transport, overrides),
  );
}

export function launchProvision(
  transport: DelimitedByteChannel,
  overrides: Partial<HostLaunchProvision> = {},
): HostLaunchProvision {
  return {
    transport,
    expectedIdentity: identity(),
    expectedConnectionId: CONNECTION,
    expectedConnectionSessionToken: CONNECTION_TOKEN,
    expectedLaunchNonce: NONCE,
    expectedRuntimeInstanceId: RUNTIME,
    expectedContractVersion: '1.0.0',
    expectedContractSchemaVersion: 1,
    expectedProvenance: {
      buildId: BUILD_ID,
      sourceCommit: SOURCE_COMMIT,
      binarySha256: BINARY_SHA256,
      pid: 42,
      operatingSystem: 'windows',
      architecture: 'x86_64',
    },
    supportedProtocols: { minimum: 65_537, maximum: 65_537 },
    resourceBudget: resourceBudget(),
    hardDeadlineAtUnixMs: 70_000n,
    heartbeatPolicy: {
      intervalMs: 1_000n,
      timeoutMs: 5_000n,
    },
    featurePolicy: {
      allowedFeatureBits: 0b11n,
      requiredFeatureBits: 0b01n,
    },
    validateAgentHello: () => undefined,
    ...overrides,
  };
}

export function resourceBudget(overrides = {}) {
  return create(agentV1Common.ResourceBudgetSchema, {
    softMemoryBytes: 256n * 1024n * 1024n,
    hardMemoryBytes: 512n * 1024n * 1024n,
    cpuTimeMs: 60_000n,
    maxWallMs: 60_000n,
    maxProcesses: 16,
    maxThreads: 64,
    maxOpenHandles: 1_024,
    maxHotTranscriptBytes: 8n * 1024n * 1024n,
    maxIpcFrames: 256,
    maxIpcBytes: 16n * 1024n * 1024n,
    maxSpoolBytes: 16n * 1024n * 1024n,
    maxArtifactBytes: 16n * 1024n * 1024n,
    maxConcurrentTools: 8,
    maxBlockingTasks: 8,
    cancelGraceMs: 1_000n,
    ...overrides,
  });
}

export function captureWritable(failAtWrite?: number) {
  const chunks: Uint8Array[] = [];
  let writes = 0;
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      writes += 1;
      if (writes === failAtWrite) {
        callback(new Error('write failed'));
        return;
      }
      chunks.push(Uint8Array.from(chunk));
      callback();
    },
  });
  writable.on('error', () => undefined);
  return {
    writable,
    bytes: () => concat(chunks),
    frames: () => decodeDelimited(concat(chunks)),
  };
}

export function delimit(...frames: readonly Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const frame of frames) {
    chunks.push(encodeLength(frame.byteLength), frame);
  }
  return concat(chunks);
}

export function decodeFrame(bytes: Uint8Array) {
  return fromBinary(agentV1Runtime.FrameSchema, bytes);
}

function decodeDelimited(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength;) {
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++]!;
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    frames.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return frames;
}

function encodeLength(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Uint8Array.from(bytes);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
