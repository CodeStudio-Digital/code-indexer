import { PassThrough } from 'node:stream';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { AttemptControlAdapterError } from '../adapters/AttemptControlAdapterError.js';
import {
  type AuthenticatedAttemptControlConnectionOwner,
  type ProtectedAttemptControlEndpoint,
  ownAuthenticatedAttemptControlConnection,
  ownProtectedAttemptControlEndpoint,
} from '../adapters/ProtectedAttemptControlEndpoint.js';
import {
  ShadowAuthenticatedAttemptControlAdapter,
  type ShadowAuthenticatedAttemptControlAdapterOptions,
} from '../adapters/ShadowAuthenticatedAttemptControlAdapter.js';
import { HostAttemptLifecycleDriver } from '../driver/HostAttemptLifecycleDriver.js';
import type {
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  MAXIMUM,
  agentHello,
  agentHelloFrame,
  captureWritable,
  delimit,
  hostHello,
} from './attempt-channel-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';
import {
  preparedArtifacts,
  preparedSnapshots,
} from './host-lifecycle-driver-support.js';
import {
  acceptedFact,
  containmentFact,
  runnerProvenance,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import {
  launchAttempt,
} from './host-supervisor-bootstrap-support.js';

const CONTROL_CONNECTION = 'control:connection';
const DATA_CONNECTION = 'data:connection';
const PULSE_CONNECTION = 'pulse:connection';

describe('ShadowAuthenticatedAttemptControlAdapter', () => {
  it('binds durable facts and hands off only the authenticated control transport', async () => {
    const fixture = adapterFixture();
    const expectedDeadline = fixture.options.specDeadlineAtUnixMs;
    const originalNonce = fixture.options.launch.launchNonce.slice();
    const originalToken = fixture.options.hostHello
      .connectionSessionToken.slice();
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );

    fixture.options.launch.launchNonce.fill(91);
    fixture.options.launch.protectedEndpoints[0]!.connectionToken.fill(92);
    fixture.options.hostHello.connectionSessionToken.fill(93);
    fixture.options.launch.activationAuthoritySeal!
      .activationNonceSha256.fill(94);

    const lifecycle = await adapter.open(fixture.snapshot, context());

    expect(lifecycle).toBeInstanceOf(HostAttemptLifecycleDriver);
    expect(fixture.endpoint.open).toHaveBeenCalledOnce();
    const expectation = vi.mocked(fixture.endpoint.open).mock.calls[0]![0];
    expect(expectation).toMatchObject({
      endpointId: 'control',
      connectionId: CONTROL_CONNECTION,
      reservationId: 'reservation:test',
      resourceGroupId: 'job:test',
      expectedPeerPid: 42,
      maximumFrameBytes: MAXIMUM,
      deadlineAtUnixMs: expectedDeadline,
    });
    expect(Object.keys(expectation).sort()).toEqual([
      'connectionId',
      'deadlineAtUnixMs',
      'endpointId',
      'expectedPeerPid',
      'maximumFrameBytes',
      'reservationId',
      'resourceGroupId',
      'signal',
    ]);
    expect(fixture.connection.handoffTransport).toHaveBeenCalledOnce();
    expect(fixture.connection.revokeBeforeHandoff).not.toHaveBeenCalled();
    expect(fixture.endpoint.abort).not.toHaveBeenCalled();
    expect(originalNonce).not.toEqual(
      fixture.options.launch.launchNonce,
    );
    expect(originalToken).not.toEqual(
      fixture.options.hostHello.connectionSessionToken,
    );

    fixture.input.write(delimit(agentHelloFrame(agentHello({
      launchNonce: originalNonce,
      provenance: runnerProvenance({
        binarySha256:
          fixture.snapshot.spawned.runnerProvenance!.binarySha256.slice(),
      }),
    }), { connectionId: CONTROL_CONNECTION })));
    await expect(lifecycle.handshake()).resolves.toMatchObject({
      provenance: { runtimeInstanceId: 'runner:instance' },
    });
    lifecycle.abort();
    expect(fixture.transport.isFailed).toBe(true);
  });

  it('rejects divergent durable facts before opening the endpoint', async () => {
    const fixture = adapterFixture();
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );
    const containment = containmentFact({
      runtimeInstanceId: 'other-runtime',
      reportedAtUnixMs: fixture.now + 3n,
    });
    if (containment.case !== 'attemptContainmentReport') {
      throw new Error('containment fixture');
    }
    const snapshot = {
      ...fixture.snapshot,
      containment: containment.value,
    };

    await expect(adapter.open(snapshot, context())).rejects.toMatchObject({
      code: 'invalid_launch_binding',
    });
    expect(fixture.endpoint.open).not.toHaveBeenCalled();
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
    expect(fixture.connection.handoffTransport).not.toHaveBeenCalled();
  });

  it('rejects a missing resource-group owner before opening the endpoint', async () => {
    const fixture = adapterFixture();
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );
    fixture.snapshot.spawned.resourceGroupId = '';

    await expect(adapter.open(
      fixture.snapshot,
      context(),
    )).rejects.toMatchObject({ code: 'invalid_launch_binding' });
    expect(fixture.endpoint.open).not.toHaveBeenCalled();
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it('revokes a physical receipt whose peer PID is not the durable runner', async () => {
    const fixture = adapterFixture({ peerPid: 43 });
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );

    await expect(
      adapter.open(fixture.snapshot, context()),
    ).rejects.toMatchObject({ code: 'invalid_connection' });

    expect(fixture.connection.revokeBeforeHandoff).toHaveBeenCalledOnce();
    expect(fixture.connection.handoffTransport).not.toHaveBeenCalled();
    expect(fixture.transport.isFailed).toBe(true);
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it.each([
    ['endpoint ID', { endpointId: 'other-control' }],
    ['connection ID', { connectionId: 'other-connection' }],
    ['physical cap', { maximumFrameBytes: MAXIMUM / 2 }],
  ])('rejects a physical %s mismatch before handoff', async (
    _label,
    config,
  ) => {
    const fixture = adapterFixture(config);
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );

    await expect(
      adapter.open(fixture.snapshot, context()),
    ).rejects.toMatchObject({ code: 'invalid_connection' });
    expect(fixture.connection.revokeBeforeHandoff).toHaveBeenCalledOnce();
    expect(fixture.connection.handoffTransport).not.toHaveBeenCalled();
    expect(fixture.transport.isFailed).toBe(true);
  });

  it('rejects a substituted transport and closes both physical channels', async () => {
    const substitute = controlTransport();
    const fixture = adapterFixture({ handedOffTransport: substitute });
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );

    await expect(
      adapter.open(fixture.snapshot, context()),
    ).rejects.toMatchObject({ code: 'invalid_connection' });
    expect(fixture.connection.handoffTransport).toHaveBeenCalledOnce();
    expect(fixture.connection.revokeBeforeHandoff).toHaveBeenCalledOnce();
    expect(fixture.transport.isFailed).toBe(true);
    expect(substitute.isFailed).toBe(true);
  });

  it('revokes an authenticated connection that settles after cancellation', async () => {
    const gate = deferred<AuthenticatedAttemptControlConnectionOwner>();
    const fixture = adapterFixture({ connectionPromise: gate.promise });
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );
    const cancellation = new AbortController();
    const opening = adapter.open(
      fixture.snapshot,
      context(cancellation.signal),
    );
    await waitUntil(() => (
      vi.mocked(fixture.endpoint.open).mock.calls.length === 1
    ));

    cancellation.abort(new Error('stop'));
    await expect(opening).rejects.toMatchObject({ code: 'aborted' });
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();

    gate.resolve(fixture.connectionOwner);
    await waitUntil(() => (
      vi.mocked(fixture.connection.revokeBeforeHandoff).mock.calls.length === 1
    ));
    expect(fixture.connection.handoffTransport).not.toHaveBeenCalled();
    expect(fixture.transport.isFailed).toBe(true);
  });

  it('does not call the physical opener for an already-aborted signal', async () => {
    const fixture = adapterFixture();
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );
    const cancellation = new AbortController();
    cancellation.abort(new Error('already stopped'));

    await expect(adapter.open(
      fixture.snapshot,
      context(cancellation.signal),
    )).rejects.toMatchObject({ code: 'aborted' });
    expect(fixture.endpoint.open).not.toHaveBeenCalled();
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it('fails closed when a caller attempts to enable production mode', async () => {
    const fixture = adapterFixture();
    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );

    await expect(adapter.open(fixture.snapshot, {
      integrationMode: 'production',
      signal: new AbortController().signal,
    } as never)).rejects.toMatchObject({ code: 'invalid_provision' });
    expect(fixture.endpoint.open).not.toHaveBeenCalled();
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it.each([
    ['duplicate connection', (options: ShadowAuthenticatedAttemptControlAdapterOptions) => {
      options.launch.protectedEndpoints[1]!.connectionId =
        CONTROL_CONNECTION;
    }],
    ['wrong data cap', (options: ShadowAuthenticatedAttemptControlAdapterOptions) => {
      options.launch.protectedEndpoints[1]!.maxFrameBytes = 1024n;
    }],
    ['missing pulse connection', (options: ShadowAuthenticatedAttemptControlAdapterOptions) => {
      options.launch.protectedEndpoints[2]!.connectionId = '';
    }],
  ])('rejects %s while consuming and revoking the endpoint owner', (
    _label,
    mutate,
  ) => {
    const fixture = adapterFixture();
    mutate(fixture.options);

    expect(() => new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    )).toThrowError(AttemptControlAdapterError);
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
    expect(fixture.endpoint.open).not.toHaveBeenCalled();
  });

  it('prevents a protected endpoint owner from being installed twice', () => {
    const fixture = adapterFixture();
    const first = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );

    expect(() => new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    )).toThrowError(expect.objectContaining({
      code: 'ownership_consumed',
    }));

    first.abort();
    expect(fixture.endpoint.abort).toHaveBeenCalledOnce();
  });

  it('prevents one authenticated connection from minting two owners', () => {
    const fixture = adapterFixture();

    expect(() => ownAuthenticatedAttemptControlConnection(
      fixture.connection,
    )).toThrowError(expect.objectContaining({
      code: 'ownership_consumed',
    }));

    const adapter = new ShadowAuthenticatedAttemptControlAdapter(
      fixture.options,
    );
    adapter.abort();
  });
});

function adapterFixture(config: {
  peerPid?: number;
  endpointId?: string;
  connectionId?: string;
  maximumFrameBytes?: number;
  handedOffTransport?: DelimitedByteChannel;
  connectionPromise?: Promise<AuthenticatedAttemptControlConnectionOwner>;
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
  launch.protectedEndpoints[2]!.connectionId = PULSE_CONNECTION;
  const hello = hostHello({
    connectionId: CONTROL_CONNECTION,
    connectionSessionToken:
      launch.protectedEndpoints[0]!.connectionToken.slice(),
  });
  const input = new PassThrough();
  const transport = controlTransport(config.maximumFrameBytes, input);
  const connection = {
    endpointId: config.endpointId ?? 'control',
    connectionId: config.connectionId ?? CONTROL_CONNECTION,
    peerPid: config.peerPid ?? 42,
    transport,
    handoffTransport: vi.fn(() => (
      config.handedOffTransport ?? transport
    )),
    revokeBeforeHandoff: vi.fn(() => ({ kind: 'closed' as const })),
  };
  const connectionOwner = ownAuthenticatedAttemptControlConnection(
    connection,
  );
  const endpoint: ProtectedAttemptControlEndpoint = {
    open: vi.fn(() => (
      config.connectionPromise ?? Promise.resolve(connectionOwner)
    )),
    abort: vi.fn(() => ({ kind: 'closed' as const })),
  };
  const endpointOwner = ownProtectedAttemptControlEndpoint(endpoint);
  const options: ShadowAuthenticatedAttemptControlAdapterOptions = {
    endpoint: endpointOwner,
    launch,
    hostHello: hello,
    supportedProtocols: { minimum: 65_537, maximum: 65_537 },
    expectedSnapshots: preparedSnapshots(),
    expectedArtifacts: preparedArtifacts(),
    requiredContainmentLevel:
      agentV1Common.ContainmentLevel.HARD_PROCESS,
    requiredEnforcedLimits: [
      agentV1Common.ResourceLimitKind.MEMORY,
    ],
    specDeadlineAtUnixMs,
    outboundTimeoutMs: 10_000,
    durability: {
      commitPrepared: vi.fn(async () => {
        throw new Error('durability is outside adapter tests');
      }),
    },
    validateAgentHello: vi.fn(),
  };
  return {
    now,
    options,
    endpoint,
    connection,
    connectionOwner,
    transport,
    input,
    snapshot: durableSnapshot(now, hardDeadlineAtUnixMs, launch),
  };
}

function durableSnapshot(
  now: bigint,
  hardDeadlineAtUnixMs: bigint,
  launch: agentV1Supervisor.LaunchAttemptProcess,
): DurableSupervisorLaunchSnapshot {
  const accepted = acceptedFact({
    hardDeadlineAtUnixMs,
    acceptedAtUnixMs: now + 1n,
  });
  const expected = launch.expectedRunnerProvenance!;
  const spawned = spawnedFact({
    spawnedAtUnixMs: now + 2n,
    runnerProvenance: runnerProvenance({
      buildId: expected.buildId,
      sourceCommit: expected.sourceCommit,
      binarySha256: expected.binarySha256.slice(),
      operatingSystem: expected.operatingSystem,
      architecture: expected.architecture,
    }),
  });
  const containment = containmentFact({ reportedAtUnixMs: now + 3n });
  if (
    accepted.case !== 'launchAccepted'
    || spawned.case !== 'attemptProcessSpawned'
    || containment.case !== 'attemptContainmentReport'
  ) throw new Error('durable fact fixture');
  return Object.freeze({
    accepted: accepted.value,
    spawned: spawned.value,
    containment: containment.value,
    activationAuthoritySeal: activationAuthoritySeal(),
  });
}

function controlTransport(
  maximumFrameBytes = MAXIMUM,
  input = new PassThrough(),
): DelimitedByteChannel {
  const capture = captureWritable();
  return new DelimitedByteChannel(
    input,
    capture.writable,
    {
      maximumFrameBytes,
      maximumTransportChunkBytes: 64 * 1024,
      readTimeoutMs: 30_000,
      writeTimeoutMs: 30_000,
    },
  );
}

function context(
  signal = new AbortController().signal,
) {
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
  throw new Error('timed out waiting for control adapter state');
}
