import { PassThrough } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  HostAttemptLifecycleDriver,
} from '../driver/HostAttemptLifecycleDriver.js';
import {
  createHostAttemptLifecycleDriverForTesting,
} from '../driver/HostAttemptLifecycleDriverTesting.js';
import type {
  DurableActivationGrant,
  HostAttemptLifecycleDriverOptions,
  PreparedDurabilityContext,
  PreparedDurabilityFacts,
} from '../driver/HostLifecycleTypes.js';
import {
  HostLifecycleLaunchAuthority,
  type HostLifecycleLaunchProvision,
} from '../driver/HostLifecycleLaunchAuthority.js';
import type {
  PreparedAttemptReceipt,
} from '../driver/HostLifecycleReceipts.js';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import {
  framePayloadSha256,
} from '../ipc/AttemptFrame.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  MAXIMUM,
  RUNTIME,
  agentHelloFrame,
  attemptPreparedFrame,
  captureWritable,
  decodeFrame,
  delimit,
  hostHello,
  identity,
  inboundAckFrame,
  launchProvision,
  preparePayload,
  resourceBudget,
} from './attempt-channel-support.js';
import {
  ACTIVATION_AGENT_RUN_VERSION,
  ACTIVATION_ATTEMPT_VERSION,
  ACTIVATION_NONCE,
  activationAuthoritySeal,
} from './activation-authority-support.js';

export interface LifecycleHarness {
  readonly driver: HostAttemptLifecycleDriver;
  readonly input: PassThrough;
  readonly capture: ReturnType<typeof captureWritable>;
  readonly durabilityCalls: PreparedDurabilityFacts[];
  readonly durabilityContexts: PreparedDurabilityContext[];
}

type DurabilityHandler = (
  facts: PreparedDurabilityFacts,
  context: PreparedDurabilityContext,
) => Promise<DurableActivationGrant> | DurableActivationGrant;

export function lifecycleHarness(
  handler: DurabilityHandler = (facts) => grantForFacts(facts),
  config: {
    clock?: () => bigint;
    hardDeadlineAtUnixMs?: bigint;
    specDeadlineAtUnixMs?: bigint;
    mutateProvisionAfterBinding?: (
      provision: HostLifecycleLaunchProvision,
    ) => void;
  } = {},
): LifecycleHarness {
  const input = new PassThrough();
  input.write(delimit(agentHelloFrame()));
  const capture = captureWritable();
  const transport = new DelimitedByteChannel(
    input,
    capture.writable,
    { maximumFrameBytes: MAXIMUM },
  );
  const durabilityCalls: PreparedDurabilityFacts[] = [];
  const durabilityContexts: PreparedDurabilityContext[] = [];
  const provision: HostLifecycleLaunchProvision = {
    ...launchProvision(transport, {
      hardDeadlineAtUnixMs:
        config.hardDeadlineAtUnixMs ?? 70_000n,
    }),
    expectedSnapshots: preparedSnapshots(),
    expectedArtifacts: preparedArtifacts(),
    requiredContainmentLevel:
      agentV1Common.ContainmentLevel.HARD_PROCESS,
    requiredEnforcedLimits: [
      agentV1Common.ResourceLimitKind.MEMORY,
    ],
    specDeadlineAtUnixMs:
      config.specDeadlineAtUnixMs ?? 60_000n,
    activationAuthoritySeal: activationAuthoritySeal(),
  };
  const launch = HostLifecycleLaunchAuthority.provision(provision);
  config.mutateProvisionAfterBinding?.(provision);
  const options: HostAttemptLifecycleDriverOptions = {
    launch,
    hostHello: hostHello(),
    outboundTimeoutMs: 10,
    durability: {
      async commitPrepared(facts, context) {
        durabilityCalls.push(facts);
        durabilityContexts.push(context);
        return handler(facts, context);
      },
    },
  };
  const driver = createHostAttemptLifecycleDriverForTesting(
    options,
    createAuthorityClockForTesting(config.clock ?? (() => 10n)),
  );
  return {
    driver,
    input,
    capture,
    durabilityCalls,
    durabilityContexts,
  };
}

export async function completeHandshake(
  harness: LifecycleHarness,
): Promise<void> {
  await harness.driver.handshake();
}

export async function completePrepare(
  harness: LifecycleHarness,
  overrides: PreparedOverrides = {},
): Promise<{
  receipt: PreparedAttemptReceipt;
  preparedFrame: Uint8Array;
  prepare: agentV1Runtime.PrepareAttempt;
}> {
  const started = await beginPrepare(harness, overrides);
  return {
    receipt: await started.promise,
    preparedFrame: started.preparedFrame,
    prepare: started.prepare,
  };
}

type PreparedOverrides = Partial<Pick<
    agentV1Runtime.AttemptPrepared,
    | 'loadedSnapshots'
    | 'validatedArtifacts'
    | 'effectiveResourceBudget'
    | 'effectiveContainment'
>>;

export async function beginPrepare(
  harness: LifecycleHarness,
  overrides: PreparedOverrides = {},
): Promise<{
  promise: Promise<PreparedAttemptReceipt>;
  preparedFrame: Uint8Array;
  prepare: agentV1Runtime.PrepareAttempt;
}> {
  const prepare = prepareAttempt();
  const pending = harness.driver.prepare(prepare);
  await waitForFrames(harness, 2);
  const request = decodeFrame(harness.capture.frames()[1]!);
  const preparedFrame = attemptPreparedFrame(
    'attempt-prepared-2',
    2n,
    request.header!.messageId,
    undefined,
    undefined,
    undefined,
    {
      loadedSnapshots: preparedSnapshots(),
      validatedArtifacts: preparedArtifacts(),
      effectiveResourceBudget: resourceBudget(),
      effectiveContainment: preparedContainment(),
      ...overrides,
    },
  );
  harness.input.write(delimit(preparedFrame));
  return {
    promise: pending,
    preparedFrame,
    prepare,
  };
}

export async function beginActivation(
  harness: LifecycleHarness,
  receipt: PreparedAttemptReceipt,
): Promise<{
  promise: ReturnType<HostAttemptLifecycleDriver['activate']>;
  ackFrame: Uint8Array;
}> {
  const promise = harness.driver.activate(receipt);
  await waitForFrames(harness, 3);
  const request = decodeFrame(harness.capture.frames()[2]!);
  return {
    promise,
    ackFrame: inboundAckFrame(
      'activate-ack-3',
      3n,
      request.header!.messageId,
      framePayloadSha256(request.encodedPayload),
    ),
  };
}

export function grantForFacts(
  facts: PreparedDurabilityFacts,
  overrides: Partial<DurableActivationGrant> = {},
): DurableActivationGrant {
  return {
    connectionId: facts.connectionId,
    runtimeInstanceId: facts.prepared.runtimeInstanceId,
    prepareMessageId: facts.prepareMessageId,
    preparedMessageId: facts.preparedMessageId,
    activate: create(agentV1Runtime.ActivateAttemptSchema, {
      identity: identity(),
      agentRunVersion: ACTIVATION_AGENT_RUN_VERSION,
      attemptVersion: ACTIVATION_ATTEMPT_VERSION,
      deadlineAtUnixMs: 60_000n,
      activationNonce: ACTIVATION_NONCE.slice(),
      specSha256: facts.prepared.specSha256.slice(),
      idempotencyKey: 'activate-idempotency',
    }),
    ...overrides,
  };
}

export function prepareAttempt(): agentV1Runtime.PrepareAttempt {
  const payload = preparePayload();
  if (payload.body.case !== 'prepareAttempt') {
    throw new Error('PrepareAttempt fixture is invalid');
  }
  return create(agentV1Runtime.PrepareAttemptSchema, {
    ...payload.body.value,
    expectedSnapshots: preparedSnapshots(),
  });
}

export function preparedSnapshots(): agentV1Common.SnapshotRef[] {
  return [
    preparedSnapshot('snapshot://capability-set', 3n, 3),
    preparedSnapshot('snapshot://policy', 4n, 4),
  ];
}

function preparedSnapshot(
  ref: string,
  version: bigint,
  fill: number,
): agentV1Common.SnapshotRef {
  return create(agentV1Common.SnapshotRefSchema, {
    ref,
    version,
    contentSha256: new Uint8Array(32).fill(fill),
    origin: 'host-snapshot-store',
    schemaId: 'capability-set',
    schemaVersion: 1,
  });
}

export function preparedArtifacts(): agentV1Artifact.ArtifactRef[] {
  return [
    preparedArtifact('artifact-transcript', 'transcript', 5),
    preparedArtifact('artifact-checkpoint', 'checkpoint', 6),
  ];
}

function preparedArtifact(
  artifactId: string,
  kind: string,
  fill: number,
): agentV1Artifact.ArtifactRef {
  return create(agentV1Artifact.ArtifactRefSchema, {
    artifactId,
    kind,
    contentSha256: new Uint8Array(32).fill(fill),
    mediaType: 'application/x-protobuf',
    byteLength: 128n,
    compression: agentV1Artifact.ArtifactCompression.NONE,
    privacyClass: agentV1Artifact.ArtifactPrivacyClass.INTERNAL,
    redactionPolicyVersion: 'redaction-v1',
    ownerSessionId: identity().sessionId,
  });
}

export function preparedContainment(): agentV1Common.ContainmentReport {
  return create(agentV1Common.ContainmentReportSchema, {
    level: agentV1Common.ContainmentLevel.HARD_PROCESS,
    enforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
    unsupportedLimits: [
      agentV1Common.ResourceLimitKind.CPU_TIME,
      agentV1Common.ResourceLimitKind.WALL_TIME,
      agentV1Common.ResourceLimitKind.PROCESSES,
      agentV1Common.ResourceLimitKind.THREADS,
      agentV1Common.ResourceLimitKind.OPEN_HANDLES,
      agentV1Common.ResourceLimitKind.SCRATCH_BYTES,
    ],
    capabilities: {
      processTree: true,
      memoryLimit: true,
    },
  });
}

export async function waitForFrames(
  harness: LifecycleHarness,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frames = harness.capture.frames();
    if (
      frames.length >= count
      && frames.slice(0, count).every((frame) => {
        try {
          return decodeFrame(frame).header !== undefined;
        } catch {
          return false;
        }
      })
    ) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${count} outbound frames`);
}

export { RUNTIME };
