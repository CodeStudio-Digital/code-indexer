import { clone } from '@bufbuild/protobuf';
import {
  agentV1Runtime,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { RustHostAttemptCoordinator } from '../driver/RustHostAttemptCoordinator.js';
import type {
  AuthenticatedAttemptControlPort,
  AuthenticatedAttemptDataPort,
  AuthenticatedAttemptLifecyclePort,
  RustHostManagementBootstrapPort,
  RustHostManagementFactPort,
  RustHostManagementLaunchPort,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import type {
  DurableSupervisorFactPort,
  HostSupervisorFactStep,
  SupervisorLifecycleFact,
} from '../driver/HostSupervisorFactTypes.js';
import { framePayloadSha256 } from '../ipc/AttemptFrame.js';
import {
  decodeFrame,
  delimit,
  inboundAckFrame,
  attemptPreparedFrame,
  resourceBudget,
} from './attempt-channel-support.js';
import {
  lifecycleHarness,
  grantForFacts,
  prepareAttempt,
  preparedArtifacts,
  preparedContainment,
  preparedSnapshots,
  waitForFrames,
} from './host-lifecycle-driver-support.js';
import {
  acceptedFact,
  containmentFact,
  rejectedFact,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import {
  launchAttempt,
  launchOptions,
} from './host-supervisor-bootstrap-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';

describe('RustHostAttemptCoordinator', () => {
  it('opens control only after durable containment and awaits activation ACK', async () => {
    const events: string[] = [];
    const management = managementFixture([
      acceptedFact(),
      spawnedFact(),
      containmentFact(),
    ], events);
    const runtime = lifecycleHarness();
    const control = controlPort(async (launch) => {
      events.push('control:open');
      expect(launch.containment.runtimeInstanceId).toBe('runner:instance');
      expect(launch.activationAuthoritySeal).toEqual(
        activationAuthoritySeal(),
      );
      return runtime.driver;
    });
    const coordinator = coordinatorFor(management.bootstrap, control, events);
    const running = coordinator.run({
      launch: launchAttempt(),
      prepare: prepareAttempt(),
    });

    await waitForFrames(runtime, 2);
    expect(events).toEqual([
      'management:hello',
      'management:launch',
      'durable:launchAccepted',
      'ack:launchAccepted',
      'durable:attemptProcessSpawned',
      'ack:attemptProcessSpawned',
      'durable:attemptContainmentReport',
      'ack:attemptContainmentReport',
      'control:open',
    ]);
    runtime.input.write(delimit(preparedReply(runtime)));
    await waitForFrames(runtime, 3);
    let settled = false;
    void running.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await immediate();
    expect(settled).toBe(false);

    runtime.input.write(delimit(activationAck(runtime)));
    const result = await running;
    expect(result.kind).toBe('active');
    if (result.kind !== 'active') throw new Error('active result expected');
    expect(coordinator.inspectActive(result.authority)).toMatchObject({
      connectionId: 'provisioned-connection',
      runtimeInstanceId: 'runtime-instance',
    });
    expect(runtime.durabilityCalls).toHaveLength(1);
    coordinator.abort();
  });

  it('never opens control after a durable launch rejection', async () => {
    const events: string[] = [];
    const management = managementFixture([rejectedFact()], events);
    const control = controlPort(async () => {
      throw new Error('control must remain closed');
    });
    const coordinator = coordinatorFor(management.bootstrap, control, events);

    await expect(coordinator.run({
      launch: launchAttempt(),
      prepare: prepareAttempt(),
    })).resolves.toEqual({
      kind: 'launch_rejected',
      reasonCode: 'admission_closed',
    });
    expect(control.open).not.toHaveBeenCalled();
    expect(management.facts.abort).toHaveBeenCalledOnce();
    expect(coordinator.isFailed).toBe(false);
  });

  it('snapshots launch and prepare before the first asynchronous boundary', async () => {
    const gate = deferred<void>();
    const events: string[] = [];
    const management = managementFixture([
      acceptedFact(),
      spawnedFact(),
      containmentFact(),
    ], events, gate.promise);
    let observedPrepare: agentV1Runtime.PrepareAttempt | undefined;
    const lifecycle = immediateLifecycle((prepare) => {
      observedPrepare = clone(agentV1Runtime.PrepareAttemptSchema, prepare);
    });
    const control = controlPort(async () => lifecycle);
    const coordinator = coordinatorFor(management.bootstrap, control, events);
    const launch = launchAttempt();
    const prepare = prepareAttempt();
    const expectedNonce = launch.launchNonce.slice();
    const expectedToken = launch.protectedEndpoints[0]!.connectionToken.slice();
    const expectedSeal = launch.activationAuthoritySeal!
      .activationNonceSha256.slice();
    const expectedSpec = prepare.encodedSpec.slice();
    const running = coordinator.run({ launch, prepare });

    launch.launchNonce.fill(99);
    launch.protectedEndpoints[0]!.connectionToken.fill(98);
    launch.activationAuthoritySeal!.activationNonceSha256.fill(96);
    prepare.encodedSpec.fill(97);
    gate.resolve();
    await expect(running).resolves.toMatchObject({ kind: 'active' });

    expect(management.observedNonce).toEqual(expectedNonce);
    expect(management.observedToken).toEqual(expectedToken);
    expect(management.observedSeal).toEqual(expectedSeal);
    expect(observedPrepare?.encodedSpec).toEqual(expectedSpec);
    coordinator.abort();
  });

  it('aborts bootstrap exactly once and never advances launch', async () => {
    const blocked = deferred<RustHostManagementLaunchPort>();
    const bootstrap: RustHostManagementBootstrapPort = {
      establish: vi.fn(() => blocked.promise),
      abort: vi.fn(() => blocked.reject(new Error('bootstrap aborted'))),
    };
    const control = controlPort(async () => immediateLifecycle());
    const coordinator = coordinatorFor(bootstrap, control, []);
    const cancellation = new AbortController();
    const running = coordinator.run(runInput(), cancellation.signal);

    cancellation.abort(new Error('stop'));
    await expect(running).rejects.toThrow();
    expect(bootstrap.abort).toHaveBeenCalledOnce();
    expect(control.open).not.toHaveBeenCalled();
  });

  it('aborts the fact stream exactly once and never opens control', async () => {
    const blocked = deferred<HostSupervisorFactStep>();
    const facts: RustHostManagementFactPort = {
      processNext: vi.fn(() => blocked.promise),
      abort: vi.fn(() => blocked.reject(new Error('facts aborted'))),
    };
    const launch: RustHostManagementLaunchPort = {
      launch: vi.fn(async () => facts),
      abort: vi.fn(),
    };
    const bootstrap: RustHostManagementBootstrapPort = {
      establish: vi.fn(async () => launch),
      abort: vi.fn(),
    };
    const control = controlPort(async () => immediateLifecycle());
    const coordinator = coordinatorFor(bootstrap, control, []);
    const cancellation = new AbortController();
    const running = coordinator.run(runInput(), cancellation.signal);
    await waitUntil(() => vi.mocked(facts.processNext).mock.calls.length === 1);

    cancellation.abort(new Error('stop'));
    await expect(running).rejects.toThrow();
    expect(facts.abort).toHaveBeenCalledOnce();
    expect(control.open).not.toHaveBeenCalled();
  });

  it('aborts control exactly once and never starts lifecycle', async () => {
    const events: string[] = [];
    const management = managementFixture([
      acceptedFact(),
      spawnedFact(),
      containmentFact(),
    ], events);
    const blocked = deferred<AuthenticatedAttemptLifecyclePort>();
    const lifecycle = immediateLifecycle();
    const control: AuthenticatedAttemptControlPort = {
      open: vi.fn(() => blocked.promise),
      abort: vi.fn(),
    };
    const coordinator = coordinatorFor(management.bootstrap, control, events);
    const cancellation = new AbortController();
    const running = coordinator.run(runInput(), cancellation.signal);
    await waitUntil(() => vi.mocked(control.open).mock.calls.length === 1);

    cancellation.abort(new Error('stop'));
    await expect(running).rejects.toThrow();
    blocked.resolve(lifecycle);
    await waitUntil(() => vi.mocked(lifecycle.abort).mock.calls.length === 1);
    expect(control.abort).toHaveBeenCalledOnce();
    expect(lifecycle.handshake).not.toHaveBeenCalled();
    expect(lifecycle.abort).toHaveBeenCalledOnce();
    expect(management.facts.abort).toHaveBeenCalledOnce();
  });

  it('rejects an already-aborted control open and revokes its late lifecycle', async () => {
    const events: string[] = [];
    const management = managementFixture([
      acceptedFact(),
      spawnedFact(),
      containmentFact(),
    ], events);
    const blocked = deferred<AuthenticatedAttemptLifecyclePort>();
    const lifecycle = immediateLifecycle();
    const cancellation = new AbortController();
    const control: AuthenticatedAttemptControlPort = {
      open: vi.fn(() => {
        cancellation.abort(new Error('synchronous stop'));
        return blocked.promise;
      }),
      abort: vi.fn(),
    };
    const coordinator = coordinatorFor(management.bootstrap, control, events);

    await expect(coordinator.run(
      runInput(),
      cancellation.signal,
    )).rejects.toMatchObject({ code: 'aborted' });
    expect(control.abort).toHaveBeenCalledOnce();
    expect(management.facts.abort).toHaveBeenCalledOnce();

    blocked.resolve(lifecycle);
    await waitUntil(() => vi.mocked(lifecycle.abort).mock.calls.length === 1);
    expect(lifecycle.handshake).not.toHaveBeenCalled();
  });

  it('closes management when Active expires inside the lifecycle', async () => {
    let now = 10n;
    const events: string[] = [];
    const management = managementFixture([
      acceptedFact(),
      spawnedFact(),
      containmentFact(),
    ], events);
    const runtime = lifecycleHarness(
      (facts) => grantForFacts(facts),
      { clock: () => now },
    );
    const control = controlPort(async () => runtime.driver);
    const coordinator = coordinatorFor(management.bootstrap, control, events);
    const running = coordinator.run(runInput());

    await waitForFrames(runtime, 2);
    runtime.input.write(delimit(preparedReply(runtime)));
    await waitForFrames(runtime, 3);
    runtime.input.write(delimit(activationAck(runtime)));
    const result = await running;
    if (result.kind !== 'active') throw new Error('active result expected');

    now = 60_000n;
    expect(() => runtime.driver.tick()).toThrow();
    expect(coordinator.isFailed).toBe(true);
    expect(runtime.driver.isFailed).toBe(true);
    expect(management.facts.abort).toHaveBeenCalledOnce();
    expect(() => coordinator.inspectActive(result.authority)).toThrow();
  });

  it('runs every revocation when one adapter abort throws', async () => {
    const events: string[] = [];
    const management = managementFixture([
      acceptedFact(),
      spawnedFact(),
      containmentFact(),
    ], events);
    const lifecycle = immediateLifecycle();
    const control = controlPort(async () => lifecycle);
    const coordinator = coordinatorFor(management.bootstrap, control, events);
    await coordinator.run(runInput());
    vi.mocked(management.facts.abort).mockImplementationOnce(() => {
      throw new Error('fact adapter cleanup failed');
    });

    expect(() => coordinator.abort(new Error('stop'))).not.toThrow();
    expect(management.facts.abort).toHaveBeenCalledOnce();
    expect(lifecycle.abort).toHaveBeenCalledOnce();
    expect(coordinator.isFailed).toBe(true);
  });
});

function coordinatorFor(
  bootstrap: RustHostManagementBootstrapPort,
  control: AuthenticatedAttemptControlPort,
  events: string[],
): RustHostAttemptCoordinator {
  const durableFacts: DurableSupervisorFactPort = {
    commit: vi.fn(async (fact) => {
      events.push(`durable:${fact.case}`);
    }),
  };
  return new RustHostAttemptCoordinator({
    bootstrap,
    durableFacts,
    management: launchOptions(),
    control,
    data: dataPort(),
  });
}

function managementFixture(
  sequence: SupervisorLifecycleFact[],
  events: string[],
  establishGate: Promise<void> = Promise.resolve(),
) {
  let durableFacts: DurableSupervisorFactPort | undefined;
  let index = 0;
  let observedNonce: Uint8Array | undefined;
  let observedToken: Uint8Array | undefined;
  let observedSeal: Uint8Array | undefined;
  const facts: RustHostManagementFactPort = {
    processNext: vi.fn(async (signal) => {
      const fact = sequence[index++];
      if (!fact || !durableFacts) throw new Error('unexpected fact receive');
      await durableFacts.commit(fact, {
        connectionId: 'management:test',
        messageId: `fact:${index}`,
        streamSeq: BigInt(index + 1),
        payloadSha256: new Uint8Array(32),
        envelopeSha256: new Uint8Array(32),
        observedAtUnixMs: 100n,
      }, {
        signal: signal ?? new AbortController().signal,
        deadlineAtUnixMs: 1_000n,
        idempotencyKey: `fact:${index}`,
      });
      if (signal?.aborted) throw new Error('fact processing aborted');
      events.push(`ack:${fact.case}`);
      return {
        kind: 'committed' as const,
        factCase: fact.case,
        messageId: `fact:${index}`,
      };
    }),
    abort: vi.fn(),
  };
  const launch: RustHostManagementLaunchPort = {
    launch: vi.fn(async (candidate, port) => {
      events.push('management:launch');
      observedNonce = candidate.launchNonce.slice();
      observedToken = candidate.protectedEndpoints[0]?.connectionToken.slice();
      observedSeal = candidate.activationAuthoritySeal
        ?.activationNonceSha256.slice();
      durableFacts = port;
      return facts;
    }),
    abort: vi.fn(),
  };
  const bootstrap: RustHostManagementBootstrapPort = {
    establish: vi.fn(async () => {
      events.push('management:hello');
      await establishGate;
      return launch;
    }),
    abort: vi.fn(),
  };
  return {
    bootstrap,
    facts,
    get observedNonce() { return observedNonce; },
    get observedToken() { return observedToken; },
    get observedSeal() { return observedSeal; },
  };
}

function controlPort(
  open: AuthenticatedAttemptControlPort['open'],
): AuthenticatedAttemptControlPort {
  return { open: vi.fn(open), abort: vi.fn() };
}

function dataPort(): AuthenticatedAttemptDataPort {
  return {
    hydrate: vi.fn(async () => undefined),
    abort: vi.fn(),
  };
}

function immediateLifecycle(
  onPrepare: (prepare: agentV1Runtime.PrepareAttempt) => void = () => undefined,
): AuthenticatedAttemptLifecyclePort {
  const authority = Object.freeze({});
  return {
    handshake: vi.fn(async () => ({} as never)),
    prepare: vi.fn(async (prepare) => {
      onPrepare(prepare);
      return Object.freeze({}) as never;
    }),
    prepareHydrated: vi.fn(async (prepare, hydrate) => {
      onPrepare(prepare);
      await hydrate();
      return Object.freeze({}) as never;
    }),
    activate: vi.fn(async () => Object.freeze({}) as never),
    consumeActive: vi.fn(() => authority as never),
    inspectActive: vi.fn(() => ({
      signal: new AbortController().signal,
    }) as never),
    abort: vi.fn(),
    tick: vi.fn(),
    observeFailure: vi.fn(() => () => undefined),
    isFailed: false,
  };
}

function runInput() {
  return { launch: launchAttempt(), prepare: prepareAttempt() };
}

function preparedReply(
  runtime: ReturnType<typeof lifecycleHarness>,
): Uint8Array {
  const request = decodeFrame(runtime.capture.frames()[1]!);
  return attemptPreparedFrame(
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
    },
  );
}

function activationAck(
  runtime: ReturnType<typeof lifecycleHarness>,
): Uint8Array {
  const request = decodeFrame(runtime.capture.frames()[2]!);
  return inboundAckFrame(
    'activate-ack-3',
    3n,
    request.header!.messageId,
    framePayloadSha256(request.encodedPayload),
  );
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
    await immediate();
  }
  throw new Error('timed out waiting for coordinator phase');
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
