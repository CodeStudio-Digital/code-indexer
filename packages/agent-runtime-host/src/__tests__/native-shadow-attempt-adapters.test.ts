import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import {
  framePayloadSha256,
} from '../ipc/AttemptFrame.js';
import {
  deriveShadowAttemptDataFrameLimits,
} from '../adapters/ShadowAttemptDataPlanValidation.js';
import {
  createNativeShadowAttemptAdapters,
  type NativeHostBridgeBinding,
} from '../native/index.js';
import {
  agentHello,
  agentHelloFrame,
  attemptPreparedFrame,
  decodeFrame,
  hostHello,
  inboundAckFrame,
  resourceBudget,
} from './attempt-channel-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';
import {
  hydrationSourceFixture,
} from './data-hydration-source-support.js';
import {
  driveDataHydrationRunner,
} from './data-runner-peer-support.js';
import {
  grantForFacts,
  prepareAttempt,
} from './host-lifecycle-driver-support.js';
import {
  acceptedFact,
  containmentFact,
  containmentProof,
  runnerProvenance,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import { launchAttempt } from './host-supervisor-bootstrap-support.js';
import { nativeBridgePeer } from './native-host-bridge-peer-support.js';

const CONTROL_CONNECTION = 'provisioned-connection';
const DATA_CONNECTION = 'native:data';
const TRANSFER_ID = 'native:hydration';

describe('NativeShadowAttemptAdapters', () => {
  it('uses one native owner through Hello, hydration, Prepare and Activate', async () => {
    const now = BigInt(Date.now());
    const hardDeadline = now + 120_000n;
    const specDeadline = now + 90_000n;
    const launch = launchAttempt({
      hardDeadlineAtUnixMs: hardDeadline,
      authorityLeaseExpiresAtUnixMs: now + 110_000n,
    });
    launch.protectedEndpoints[0]!.connectionId = CONTROL_CONNECTION;
    launch.protectedEndpoints[1]!.connectionId = DATA_CONNECTION;
    launch.protectedEndpoints[2]!.connectionId = 'native:pulse';
    const controlToken =
      launch.protectedEndpoints[0]!.connectionToken.slice();
    const dataToken = launch.protectedEndpoints[1]!.connectionToken.slice();
    const launchNonce = launch.launchNonce.slice();
    const provenance = runnerProvenance({
      binarySha256:
        launch.expectedRunnerProvenance!.binarySha256.slice(),
    });
    const hello = hostHello({
      connectionId: CONTROL_CONNECTION,
      connectionSessionToken: controlToken,
    });
    const source = hydrationSourceFixture();
    const dataLimits = deriveShadowAttemptDataFrameLimits(
      launch.protectedEndpoints[1]!.maxFrameBytes,
      launch.resourceBudget!,
    );
    const peer = nativeBridgePeer({
      controlConnectionId: CONTROL_CONNECTION,
      dataConnectionId: DATA_CONNECTION,
      peerPid: 42,
      controlLimits: hello.frameLimits!,
      dataLimits,
    });
    const binding: NativeHostBridgeBinding = {
      nativeHostBridgeAbi: vi.fn(),
      openHostAttemptBridge: vi.fn(async () => peer.channels),
    };
    const durable = durableSnapshot(now, hardDeadline, provenance);
    const adapters = createNativeShadowAttemptAdapters({
      binding,
      launch,
      openDeadlineAtUnixMs: now + 60_000n,
      control: {
        hostHello: hello,
        supportedProtocols: { minimum: 65_537, maximum: 65_537 },
        expectedSnapshots: source.expectedSnapshots,
        expectedArtifacts: source.expectedArtifacts,
        requiredContainmentLevel:
          agentV1Common.ContainmentLevel.HARD_PROCESS,
        requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
        specDeadlineAtUnixMs: specDeadline,
        outboundTimeoutMs: 1_000,
        durability: {
          commitPrepared: vi.fn(async (facts) => {
            const grant = grantForFacts(facts);
            grant.activate.deadlineAtUnixMs = specDeadline;
            return grant;
          }),
        },
        validateAgentHello: vi.fn(),
      },
      data: {
        hostHello: hello,
        expectedSnapshots: source.expectedSnapshots,
        expectedArtifacts: source.expectedArtifacts,
        requiredContainmentLevel:
          agentV1Common.ContainmentLevel.HARD_PROCESS,
        requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
        specDeadlineAtUnixMs: specDeadline,
        transferId: TRANSFER_ID,
        source: source.source,
        clock: createAuthorityClockForTesting(() => 10n),
      },
    });

    const lifecycle = await adapters.control.open(durable, context());
    const runner = driveRunner(peer, {
      launchNonce,
      provenance,
      dataToken,
      dataLimits,
      hardDeadline,
      snapshots: source.expectedSnapshots,
      artifacts: source.expectedArtifacts,
    });
    await expect(lifecycle.handshake()).resolves.toMatchObject({
      provenance: { runtimeInstanceId: 'runner:instance' },
    });
    const prepare = prepareAttempt();
    prepare.expectedSnapshots = [...source.expectedSnapshots];
    const prepared = await lifecycle.prepareHydrated(
      prepare,
      () => adapters.data.hydrate(durable, context()),
    );
    const active = await lifecycle.activate(prepared);
    expect(lifecycle.consumeActive(active)).toBeDefined();
    await expect(runner).resolves.toBeUndefined();
    expect(binding.openHostAttemptBridge).toHaveBeenCalledOnce();
    lifecycle.abort();
    adapters.data.abort();
    await settled();
    expect(peer.isClosed).toBe(true);
  });
});

function durableSnapshot(
  now: bigint,
  hardDeadline: bigint,
  provenance: agentV1Common.RuntimeProvenance,
) {
  const accepted = acceptedFact({
    hardDeadlineAtUnixMs: hardDeadline,
    acceptedAtUnixMs: now,
  });
  const spawned = spawnedFact({
    spawnedAtUnixMs: now + 1n,
    runnerProvenance: provenance,
  });
  const containment = containmentFact({ reportedAtUnixMs: now + 2n });
  if (
    accepted.case !== 'launchAccepted'
    || spawned.case !== 'attemptProcessSpawned'
    || containment.case !== 'attemptContainmentReport'
  ) throw new Error('durable fixture');
  return {
    accepted: accepted.value,
    spawned: spawned.value,
    containment: containment.value,
    activationAuthoritySeal: activationAuthoritySeal(),
  };
}

async function driveRunner(
  peer: ReturnType<typeof nativeBridgePeer>,
  options: {
    launchNonce: Uint8Array;
    provenance: agentV1Common.RuntimeProvenance;
    dataToken: Uint8Array;
    dataLimits: agentV1Common.FrameLimits;
    hardDeadline: bigint;
    snapshots: readonly agentV1Common.SnapshotRef[];
    artifacts: readonly agentV1Artifact.ArtifactRef[];
  },
): Promise<void> {
  await peer.control.send(agentHelloFrame(agentHello({
    launchNonce: options.launchNonce,
    provenance: options.provenance,
  }), { connectionId: CONTROL_CONNECTION }));
  await peer.control.receive();
  const prepare = decodeFrame((await peer.control.receive())!);
  await driveDataHydrationRunner(peer.data, {
    connectionId: DATA_CONNECTION,
    runtimeInstanceId: 'runner:instance',
    connectionToken: options.dataToken,
    limits: options.dataLimits,
    hardDeadlineAtUnixMs: options.hardDeadline,
    transferId: TRANSFER_ID,
    expectedBodies: [Buffer.from('abcdefghij'), Buffer.from('xyz')],
  });
  await peer.control.send(attemptPreparedFrame(
    'native:prepared',
    2n,
    prepare.header!.messageId,
    'runner:instance',
    new Uint8Array(32),
    BigInt(Date.now()),
    {
      loadedSnapshots: [...options.snapshots],
      validatedArtifacts: [...options.artifacts],
      effectiveResourceBudget: resourceBudget(),
      effectiveContainment: containmentProof(),
    },
  ));
  const activate = decodeFrame((await peer.control.receive())!);
  await peer.control.send(inboundAckFrame(
    'native:active',
    3n,
    activate.header!.messageId,
    framePayloadSha256(activate.encodedPayload),
    BigInt(Date.now()),
  ));
}

function context() {
  return {
    integrationMode: 'test' as const,
    signal: new AbortController().signal,
  };
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
