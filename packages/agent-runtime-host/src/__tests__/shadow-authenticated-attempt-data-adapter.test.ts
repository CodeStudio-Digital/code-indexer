import { agentV1Common } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  type AuthenticatedAttemptDataConnectionOwner,
  type ProtectedAttemptDataEndpoint,
  ownAuthenticatedAttemptDataConnection,
  ownProtectedAttemptDataEndpoint,
} from '../adapters/ProtectedAttemptDataEndpoint.js';
import {
  ShadowAuthenticatedAttemptDataAdapter,
  type ShadowAuthenticatedAttemptDataAdapterOptions,
} from '../adapters/ShadowAuthenticatedAttemptDataAdapter.js';
import type {
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import { hostHello } from './attempt-channel-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';
import {
  dataDuplexPair,
  driveDataHydrationRunner,
} from './data-runner-peer-support.js';
import {
  hydrationSourceFixture,
} from './data-hydration-source-support.js';
import {
  acceptedFact,
  containmentFact,
  runnerProvenance,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import { launchAttempt } from './host-supervisor-bootstrap-support.js';

const CONTROL_CONNECTION = 'control:connection';
const DATA_CONNECTION = 'data-connection';
const PULSE_CONNECTION = 'pulse:connection';
const RUNTIME_INSTANCE = 'runtime-instance';
const TRANSFER_ID = 'transfer:adapter';
const DATA_TOKEN = Uint8Array.from(
  { length: 32 },
  (_value, index) => index + 1,
);

describe('ShadowAuthenticatedAttemptDataAdapter', () => {
  it('binds the authenticated Data peer and streams the disk source to commit', async () => {
    const fixture = adapterFixture();
    const adapter = new ShadowAuthenticatedAttemptDataAdapter(
      fixture.options,
    );
    const peer = driveDataHydrationRunner(fixture.runner, {
      connectionId: DATA_CONNECTION,
      runtimeInstanceId: RUNTIME_INSTANCE,
      connectionToken: DATA_TOKEN,
      limits: fixture.limits,
      hardDeadlineAtUnixMs: fixture.hardDeadlineAtUnixMs,
      transferId: TRANSFER_ID,
      expectedBodies: fixture.bodies,
    });

    await expect(adapter.hydrate(
      fixture.snapshot,
      context(),
    )).resolves.toBeUndefined();
    const hydrated = await peer;

    expect(hydrated.map((value) => Buffer.from(value).toString())).toEqual([
      'abcdefghij',
      'xyz',
    ]);
    expect(fixture.endpoint.open).toHaveBeenCalledOnce();
    expect(vi.mocked(fixture.endpoint.open).mock.calls[0]![0]).toMatchObject({
      endpointId: 'data',
      connectionId: DATA_CONNECTION,
      reservationId: 'reservation:test',
      resourceGroupId: 'job:test',
      expectedPeerPid: 42,
      maximumFrameBytes: Number(fixture.limits.maxFrameBytes),
      deadlineAtUnixMs: fixture.specDeadlineAtUnixMs,
    });
    expect(fixture.connection.handoffTransport).toHaveBeenCalledOnce();
    expect(fixture.connection.revokeBeforeHandoff).not.toHaveBeenCalled();
    expect(fixture.source.state.closeCauses).toEqual([undefined]);
    for (const chunk of fixture.source.state.returnedChunks) {
      expect([...chunk]).toEqual(new Array(chunk.byteLength).fill(0));
    }

    adapter.abort();
    expect(fixture.host.isFailed).toBe(true);
  });

  it('rejects divergent durable facts before opening or reading the source', async () => {
    const fixture = adapterFixture();
    const adapter = new ShadowAuthenticatedAttemptDataAdapter(
      fixture.options,
    );
    fixture.snapshot.spawned.resourceGroupId = '';

    await expect(adapter.hydrate(
      fixture.snapshot,
      context(),
    )).rejects.toMatchObject({ code: 'invalid_launch_binding' });
    expect(fixture.endpoint.open).not.toHaveBeenCalled();
    expect(fixture.source.state.returnedChunks).toHaveLength(0);
    expect(fixture.source.state.closeCauses).toHaveLength(1);
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it('revokes a physical Data receipt that is not the durable runner', async () => {
    const fixture = adapterFixture({ peerPid: 43 });
    const adapter = new ShadowAuthenticatedAttemptDataAdapter(
      fixture.options,
    );

    await expect(adapter.hydrate(
      fixture.snapshot,
      context(),
    )).rejects.toMatchObject({ code: 'invalid_connection' });
    expect(fixture.connection.revokeBeforeHandoff).toHaveBeenCalledOnce();
    expect(fixture.connection.handoffTransport).not.toHaveBeenCalled();
    expect(fixture.host.isFailed).toBe(true);
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it('revokes an authenticated Data connection that settles after cancellation', async () => {
    const gate = deferred<AuthenticatedAttemptDataConnectionOwner>();
    const fixture = adapterFixture({ connectionPromise: gate.promise });
    const adapter = new ShadowAuthenticatedAttemptDataAdapter(
      fixture.options,
    );
    const cancellation = new AbortController();
    const hydration = adapter.hydrate(
      fixture.snapshot,
      context(cancellation.signal),
    );
    await waitUntil(() => (
      vi.mocked(fixture.endpoint.open).mock.calls.length === 1
    ));

    cancellation.abort(new Error('stop'));
    await expect(hydration).rejects.toMatchObject({ code: 'aborted' });
    gate.resolve(fixture.connectionOwner);
    await waitUntil(() => (
      vi.mocked(fixture.connection.revokeBeforeHandoff).mock.calls.length === 1
    ));
    expect(fixture.connection.handoffTransport).not.toHaveBeenCalled();
    expect(fixture.host.isFailed).toBe(true);
  });
});

function adapterFixture(config: {
  peerPid?: number;
  connectionPromise?: Promise<AuthenticatedAttemptDataConnectionOwner>;
} = {}) {
  const now = BigInt(Date.now());
  const hardDeadlineAtUnixMs = now + 120_000n;
  const leaseDeadlineAtUnixMs = now + 110_000n;
  const specDeadlineAtUnixMs = now + 100_000n;
  const launch = launchAttempt({
    hardDeadlineAtUnixMs,
    authorityLeaseExpiresAtUnixMs: leaseDeadlineAtUnixMs,
  });
  launch.protectedEndpoints[0]!.connectionId = CONTROL_CONNECTION;
  launch.protectedEndpoints[1]!.connectionId = DATA_CONNECTION;
  launch.protectedEndpoints[1]!.connectionToken = DATA_TOKEN.slice();
  launch.protectedEndpoints[2]!.connectionId = PULSE_CONNECTION;
  const source = hydrationSourceFixture();
  const maximum = launch.protectedEndpoints[1]!.maxFrameBytes;
  const limits = {
    $typeName: 'codestudio.agent.v1.FrameLimits' as const,
    maxFrameBytes: maximum,
    maxChunkBytes: 900n * 1024n,
    maxInFlightFrames: 1n,
    maxInFlightBytes: maximum,
    readTimeoutMs: 30_000n,
    writeTimeoutMs: 30_000n,
    transportCrc32c: false,
  };
  const pair = dataDuplexPair(limits);
  const connection = {
    endpointId: 'data',
    connectionId: DATA_CONNECTION,
    peerPid: config.peerPid ?? 42,
    transport: pair.host,
    handoffTransport: vi.fn(() => pair.host),
    revokeBeforeHandoff: vi.fn(() => ({ kind: 'closed' as const })),
  };
  const connectionOwner = ownAuthenticatedAttemptDataConnection(connection);
  const endpoint: ProtectedAttemptDataEndpoint = {
    open: vi.fn(() => (
      config.connectionPromise ?? Promise.resolve(connectionOwner)
    )),
    abort: vi.fn(() => ({ kind: 'closed' as const })),
  };
  const options: ShadowAuthenticatedAttemptDataAdapterOptions = {
    endpoint: ownProtectedAttemptDataEndpoint(endpoint),
    launch,
    hostHello: hostHello(),
    expectedSnapshots: source.expectedSnapshots,
    expectedArtifacts: source.expectedArtifacts,
    requiredContainmentLevel:
      agentV1Common.ContainmentLevel.HARD_PROCESS,
    requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY],
    specDeadlineAtUnixMs,
    transferId: TRANSFER_ID,
    source: source.source,
    clock: createAuthorityClockForTesting(() => 10n),
  };
  return {
    options,
    endpoint,
    connection,
    connectionOwner,
    host: pair.host,
    runner: pair.runner,
    limits,
    source,
    bodies: [Buffer.from('abcdefghij'), Buffer.from('xyz')],
    snapshot: durableSnapshot(
      now,
      hardDeadlineAtUnixMs,
      launch,
    ),
    hardDeadlineAtUnixMs,
    specDeadlineAtUnixMs,
  };
}

function durableSnapshot(
  now: bigint,
  hardDeadlineAtUnixMs: bigint,
  launch: ReturnType<typeof launchAttempt>,
): DurableSupervisorLaunchSnapshot {
  const accepted = acceptedFact({
    hardDeadlineAtUnixMs,
    acceptedAtUnixMs: now + 1n,
  });
  const expected = launch.expectedRunnerProvenance!;
  const spawned = spawnedFact({
    spawnedAtUnixMs: now + 2n,
    runnerProvenance: runnerProvenance({
      runtimeInstanceId: RUNTIME_INSTANCE,
      buildId: expected.buildId,
      sourceCommit: expected.sourceCommit,
      binarySha256: expected.binarySha256.slice(),
      operatingSystem: expected.operatingSystem,
      architecture: expected.architecture,
    }),
  });
  const containment = containmentFact({
    runtimeInstanceId: RUNTIME_INSTANCE,
    reportedAtUnixMs: now + 3n,
  });
  if (
    accepted.case !== 'launchAccepted'
    || spawned.case !== 'attemptProcessSpawned'
    || containment.case !== 'attemptContainmentReport'
  ) throw new Error('durable fact fixture');
  return {
    accepted: accepted.value,
    spawned: spawned.value,
    containment: containment.value,
    activationAuthoritySeal: activationAuthoritySeal(),
  };
}

function context(signal = new AbortController().signal) {
  return { integrationMode: 'test' as const, signal };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for data adapter state');
}
