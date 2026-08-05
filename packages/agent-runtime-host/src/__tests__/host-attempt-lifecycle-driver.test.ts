import { create, fromBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import type {
  PreparedDurabilityFacts,
} from '../driver/HostLifecycleTypes.js';
import {
  inspectPreparedAttemptReceiptForTesting,
} from '../driver/HostLifecycleReceipts.js';
import {
  beginActivation,
  beginPrepare,
  completeHandshake,
  completePrepare,
  grantForFacts,
  lifecycleHarness,
  prepareAttempt,
  preparedArtifacts,
  preparedContainment,
  preparedSnapshots,
  waitForFrames,
} from './host-lifecycle-driver-support.js';
import {
  framePayloadSha256,
} from '../ipc/AttemptFrame.js';
import {
  attemptPreparedFrame,
  decodeFrame,
  delimit,
  heartbeatFrame,
  inboundAckFrame,
  resourceBudget,
} from './attempt-channel-support.js';

describe('host attempt lifecycle driver', () => {
  it('commits the full vertical path before producing Active', async () => {
    const harness = lifecycleHarness((facts) => {
      const grant = grantForFacts(facts);
      facts.prepare.encodedSpec.fill(99);
      facts.prepared.specSha256.fill(99);
      return grant;
    });
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    prepared.prepare.encodedSpec.fill(77);

    const activation = await beginActivation(harness, prepared.receipt);
    harness.input.write(delimit(activation.ackFrame));
    const active = await activation.promise;

    expect(harness.driver.isFailed).toBe(false);
    expect(harness.durabilityCalls).toHaveLength(1);
    expect(harness.durabilityCalls[0]!.prepare).not.toBe(prepared.prepare);
    const frames = harness.capture.frames().map(decodeFrame);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.header?.streamSeq)).toEqual([
      1n,
      2n,
      3n,
    ]);
    const preparePayload = fromBinary(
      agentV1Runtime.FramePayloadSchema,
      frames[1]!.encodedPayload,
    );
    const activatePayload = fromBinary(
      agentV1Runtime.FramePayloadSchema,
      frames[2]!.encodedPayload,
    );
    expect(preparePayload.body.case).toBe('prepareAttempt');
    expect(activatePayload.body.case).toBe('activateAttempt');
    if (activatePayload.body.case !== 'activateAttempt') {
      throw new Error('ActivateAttempt expected');
    }
    expect(activatePayload.body.value).toMatchObject({
      agentRunVersion: 11n,
      attemptVersion: 13n,
      idempotencyKey: 'activate-idempotency',
    });
    expect(activatePayload.body.value.specSha256).toEqual(
      new Uint8Array(32),
    );
    const authority = harness.driver.consumeActive(active);
    expect(harness.driver.inspectActive(authority)).toMatchObject({
      connectionId: 'provisioned-connection',
      runtimeInstanceId: 'runtime-instance',
      agentRunVersion: 11n,
      attemptVersion: 13n,
      deadlineAtUnixMs: 60_000n,
    });
    expect(harness.driver.inspectActive(authority).signal.aborted).toBe(false);
  });

  it('commits and exposes the latest bounded semantic heartbeat', async () => {
    let now = 10n;
    const harness = lifecycleHarness(undefined, { clock: () => now });
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    const activation = await beginActivation(harness, prepared.receipt);
    harness.input.write(delimit(activation.ackFrame));
    const active = await activation.promise;
    const authority = harness.driver.consumeActive(active);
    const resources = create(agentV1Common.ResourceSampleSchema, {
      residentMemoryBytes: 101n,
      peakResidentMemoryBytes: 202n,
      cpuTimeMs: 303n,
      processCount: 1,
      openFileCount: 404,
      spoolBytes: 0n,
    });

    now = 11n;
    harness.input.write(delimit(heartbeatFrame(
      'heartbeat-4',
      4n,
      { sentAtUnixMs: 11n },
      {
        lastAliveAtUnixMs: 11n,
        lastProgressAtUnixMs: 10n,
        lastEventSeq: 0n,
        resources,
      },
    )));
    await vi.waitFor(() => {
      expect(harness.driver.inspectActive(authority).heartbeat).toBeDefined();
    });

    expect(harness.driver.inspectActive(authority).heartbeat).toMatchObject({
      messageId: 'heartbeat-4',
      observedAtUnixMs: 11n,
      lastAliveAtUnixMs: 11n,
      lastProgressAtUnixMs: 10n,
      lastEventSeq: 0n,
      phase: agentV1Runtime.PhysicalAttemptPhase.ACTIVE,
      resources,
    });
    expect(harness.driver.inspectActive(authority).signal.aborted).toBe(false);
    harness.driver.abort();
  });

  it('revokes Active when the semantic heartbeat deadline expires', async () => {
    let now = 10n;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const harness = lifecycleHarness(undefined, { clock: () => now });
      await completeHandshake(harness);
      const prepared = await completePrepare(harness);
      const activation = await beginActivation(harness, prepared.receipt);
      harness.input.write(delimit(activation.ackFrame));
      const active = await activation.promise;
      const authority = harness.driver.consumeActive(active);
      const snapshot = harness.driver.inspectActive(authority);

      now = 5_010n;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(snapshot.signal.aborted).toBe(true);
      expect(harness.driver.isFailed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends Cancel concurrently with heartbeat receive and revokes on Ack', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    const activation = await beginActivation(harness, prepared.receipt);
    harness.input.write(delimit(activation.ackFrame));
    const active = await activation.promise;
    const authority = harness.driver.consumeActive(active);
    const snapshot = harness.driver.inspectActive(authority);

    const cancellation = harness.driver.cancel(authority, {
      reason: agentV1Runtime.CancelReason.USER_REQUEST,
      reasonCode: 'user_request',
      graceDeadlineAtUnixMs: 1_000n,
      idempotencyKey: 'cancel:active:1',
    });
    await waitForFrames(harness, 4);
    const request = decodeFrame(harness.capture.frames()[3]!);
    const payload = fromBinary(
      agentV1Runtime.FramePayloadSchema,
      request.encodedPayload,
    );
    expect(payload.body).toMatchObject({
      case: 'cancelAttempt',
      value: {
        reason: agentV1Runtime.CancelReason.USER_REQUEST,
        reasonCode: 'user_request',
        graceDeadlineAtUnixMs: 1_000n,
      },
    });
    harness.input.write(delimit(inboundAckFrame(
      'cancel-ack-4',
      4n,
      request.header!.messageId,
      framePayloadSha256(request.encodedPayload),
    )));

    await expect(cancellation).resolves.toBeUndefined();
    expect(snapshot.signal.aborted).toBe(true);
    expect(harness.driver.isFailed).toBe(false);
  });

  it('sends Fence with newer authority and revokes only after its Ack', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    const activation = await beginActivation(harness, prepared.receipt);
    harness.input.write(delimit(activation.ackFrame));
    const active = await activation.promise;
    const authority = harness.driver.consumeActive(active);
    const snapshot = harness.driver.inspectActive(authority);

    const fencing = harness.driver.fence(authority, {
      replacementFencingEpoch: 8n,
      reasonCode: 'superseded',
      fencedAtUnixMs: 10n,
      idempotencyKey: 'fence:active:1',
    });
    await waitForFrames(harness, 4);
    expect(snapshot.signal.aborted).toBe(false);
    const request = decodeFrame(harness.capture.frames()[3]!);
    harness.input.write(delimit(inboundAckFrame(
      'fence-ack-4',
      4n,
      request.header!.messageId,
      framePayloadSha256(request.encodedPayload),
    )));

    await expect(fencing).resolves.toBeUndefined();
    expect(snapshot.signal.aborted).toBe(true);
    expect(harness.driver.isFailed).toBe(false);
  });

  it('hydrates only after Prepare is committed and before accepting Prepared', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    let releaseHydration!: () => void;
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const hydrate = vi.fn(async () => hydrationGate);
    const pending = harness.driver.prepareHydrated(
      prepareAttempt(),
      hydrate,
    );
    await waitForFrames(harness, 2);
    expect(hydrate).toHaveBeenCalledOnce();

    const request = decodeFrame(harness.capture.frames()[1]!);
    harness.input.write(delimit(attemptPreparedFrame(
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
    )));
    let settled = false;
    void pending.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseHydration();
    await expect(pending).resolves.toBeDefined();
    expect(harness.driver.isFailed).toBe(false);
  });

  it('fails closed when lifecycle operations are out of order', async () => {
    const harness = lifecycleHarness();

    await expect(harness.driver.prepare(prepareAttempt())).rejects.toMatchObject({
      code: 'invalid_order',
    });
    expect(harness.driver.isFailed).toBe(true);
    expect(harness.capture.frames()).toHaveLength(0);
    expect(harness.durabilityCalls).toHaveLength(0);
  });

  it('notifies failure observers once and late observers immediately', () => {
    const harness = lifecycleHarness();
    const initial = vi.fn();
    const unsubscribe = harness.driver.observeFailure(initial);

    harness.driver.abort();

    expect(initial).toHaveBeenCalledOnce();
    expect(initial).toHaveBeenCalledWith(expect.objectContaining({
      code: 'driver_failed',
    }));
    const late = vi.fn();
    const unsubscribeLate = harness.driver.observeFailure(late);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith(expect.objectContaining({
      code: 'driver_failed',
    }));

    harness.driver.abort();
    expect(initial).toHaveBeenCalledOnce();
    expect(() => unsubscribe()).not.toThrow();
    expect(() => unsubscribeLate()).not.toThrow();
  });

  it('never sends Activate when durable persistence fails', async () => {
    const harness = lifecycleHarness(async () => {
      throw new Error('durable write failed');
    });
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);

    await expect(harness.driver.activate(prepared.receipt)).rejects.toThrow(
      'durable write failed',
    );
    expect(harness.capture.frames()).toHaveLength(2);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('never sends Activate for a durable grant from another authority', async () => {
    const harness = lifecycleHarness((facts) => grantForFacts(facts, {
      runtimeInstanceId: 'foreign-runtime',
    }));
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);

    await expect(harness.driver.activate(
      prepared.receipt,
    )).rejects.toMatchObject({ code: 'invalid_durable_authority' });
    expect(harness.capture.frames()).toHaveLength(2);
    expect(harness.driver.isFailed).toBe(true);
  });

  it.each([
    ['agent run version', (activate: agentV1Runtime.ActivateAttempt) => {
      activate.agentRunVersion += 1n;
    }],
    ['attempt version', (activate: agentV1Runtime.ActivateAttempt) => {
      activate.attemptVersion += 1n;
    }],
    ['activation nonce', (activate: agentV1Runtime.ActivateAttempt) => {
      activate.activationNonce.fill(8);
    }],
  ])('never sends Activate when %s misses the launch seal', async (
    _field,
    mutate,
  ) => {
    const harness = lifecycleHarness((facts) => {
      const grant = grantForFacts(facts);
      mutate(grant.activate);
      return grant;
    });
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);

    await expect(harness.driver.activate(
      prepared.receipt,
    )).rejects.toMatchObject({ code: 'invalid_durable_authority' });
    expect(harness.capture.frames()).toHaveLength(2);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('rejects a durable grant beyond the sealed launch/spec deadline', async () => {
    const harness = lifecycleHarness((facts) => {
      const grant = grantForFacts(facts);
      grant.activate.deadlineAtUnixMs = 60_001n;
      return grant;
    });
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);

    await expect(harness.driver.activate(
      prepared.receipt,
    )).rejects.toMatchObject({ code: 'invalid_durable_authority' });
    expect(harness.capture.frames()).toHaveLength(2);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('rejects forged Prepared receipts before persistence', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    await completePrepare(harness);

    await expect(harness.driver.activate({} as never)).rejects.toMatchObject({
      code: 'invalid_receipt',
    });
    expect(harness.durabilityCalls).toHaveLength(0);
    expect(harness.capture.frames()).toHaveLength(2);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('rejects a Prepared receipt transplanted from another driver', async () => {
    const owner = lifecycleHarness();
    const target = lifecycleHarness();
    await completeHandshake(owner);
    await completeHandshake(target);
    const prepared = await completePrepare(owner);
    await completePrepare(target);

    await expect(
      target.driver.activate(prepared.receipt),
    ).rejects.toMatchObject({ code: 'invalid_receipt' });
    expect(target.durabilityCalls).toHaveLength(0);
    expect(target.driver.isFailed).toBe(true);
    owner.driver.abort();
  });

  it('revokes and scrubs an unconsumed Prepared receipt on abort', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    const retained = inspectPreparedAttemptReceiptForTesting(
      prepared.receipt,
    );
    if (!retained) throw new Error('Prepared receipt state expected');
    const encodedSpec = retained.prepare.encodedSpec;
    const specDigest = retained.prepared.specSha256;

    harness.driver.abort();

    expect(inspectPreparedAttemptReceiptForTesting(
      prepared.receipt,
    )).toBeUndefined();
    expect(retained.prepare.encodedSpec.byteLength).toBe(0);
    expect(retained.prepare.expectedSnapshots).toHaveLength(0);
    expect(retained.prepared.loadedSnapshots).toHaveLength(0);
    expect(retained.prepared.validatedArtifacts).toHaveLength(0);
    expect(encodedSpec).toEqual(new Uint8Array(encodedSpec.byteLength));
    expect(specDigest).toEqual(new Uint8Array(specDigest.byteLength));
    expect(harness.driver.isFailed).toBe(true);
  });

  it('revokes and scrubs an unconsumed Prepared receipt on deadline', async () => {
    let now = 10n;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const harness = lifecycleHarness(
        (facts) => grantForFacts(facts),
        {
          clock: () => now,
          specDeadlineAtUnixMs: 20n,
          hardDeadlineAtUnixMs: 30n,
        },
      );
      await completeHandshake(harness);
      const prepared = await completePrepare(harness);
      const retained = inspectPreparedAttemptReceiptForTesting(
        prepared.receipt,
      );
      if (!retained) throw new Error('Prepared receipt state expected');
      const encodedSpec = retained.prepare.encodedSpec;

      now = 20n;
      await vi.advanceTimersByTimeAsync(10);

      expect(inspectPreparedAttemptReceiptForTesting(
        prepared.receipt,
      )).toBeUndefined();
      expect(retained.prepare.encodedSpec.byteLength).toBe(0);
      expect(encodedSpec).toEqual(new Uint8Array(encodedSpec.byteLength));
      expect(harness.driver.isFailed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unexpected payload instead of committing Prepared', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const pending = harness.driver.prepare(prepareAttempt());
    await waitForFrames(harness, 2);
    harness.input.write(delimit(heartbeatFrame('heartbeat-2', 2n)));

    await expect(pending).rejects.toMatchObject({
      code: 'unexpected_payload',
    });
    expect(harness.durabilityCalls).toHaveLength(0);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('aborts on EOF without producing Prepared or Active', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const pending = harness.driver.prepare(prepareAttempt());
    await waitForFrames(harness, 2);
    harness.input.end();

    await expect(pending).rejects.toMatchObject({ code: 'unexpected_eof' });
    expect(harness.durabilityCalls).toHaveLength(0);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('reaps a missing AttemptPrepared at the narrower spec deadline', async () => {
    let now = 10n;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const harness = lifecycleHarness(
        (facts) => grantForFacts(facts),
        {
          clock: () => now,
          specDeadlineAtUnixMs: 20n,
          hardDeadlineAtUnixMs: 30n,
        },
      );
      await completeHandshake(harness);
      const pending = harness.driver.prepare(prepareAttempt());
      const rejected = pending.catch((cause: unknown) => cause);
      await waitForFrames(harness, 2);

      now = 20n;
      await vi.advanceTimersByTimeAsync(10);

      await expect(rejected).resolves.toMatchObject({
        code: 'deadline_expired',
      });
      expect(harness.durabilityCalls).toHaveLength(0);
      expect(harness.driver.isFailed).toBe(true);
      expect(harness.capture.frames()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a pending durability barrier and scrubs transferred facts', async () => {
    let now = 10n;
    let receivedFacts: PreparedDurabilityFacts | undefined;
    let receivedSignal: AbortSignal | undefined;
    const harness = lifecycleHarness((facts, context) => {
      receivedFacts = facts;
      receivedSignal = context.signal;
      return new Promise(() => undefined);
    }, {
      clock: () => now,
      specDeadlineAtUnixMs: 20n,
    });
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const activation = harness.driver.activate(prepared.receipt);
      const rejected = activation.catch((cause: unknown) => cause);
      await Promise.resolve();
      await Promise.resolve();
      expect(receivedSignal?.aborted).toBe(false);
      expect(harness.durabilityContexts[0]?.deadlineAtUnixMs).toBe(20n);

      now = 20n;
      await vi.advanceTimersByTimeAsync(10);

      await expect(rejected).resolves.toMatchObject({
        code: 'deadline_expired',
      });
      expect(receivedSignal?.aborted).toBe(true);
      expect(receivedFacts?.prepare.encodedSpec.byteLength).toBe(0);
      expect(receivedFacts?.prepared.loadedSnapshots).toHaveLength(0);
      expect(receivedFacts?.prepared.validatedArtifacts).toHaveLength(0);
      expect(harness.driver.isFailed).toBe(true);
      expect(harness.capture.frames()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores metadata-only replay while waiting for activation Ack', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const prepared = await completePrepare(harness);
    const activation = await beginActivation(harness, prepared.receipt);

    harness.input.write(delimit(
      prepared.preparedFrame,
      activation.ackFrame,
    ));
    const active = await activation.promise;

    const authority = harness.driver.consumeActive(active);
    expect(harness.driver.inspectActive(authority).attemptVersion).toBe(13n);
    expect(harness.capture.frames()).toHaveLength(3);
  });

  it.each([
    ['loaded snapshots', { loadedSnapshots: [] }],
    ['validated artifacts', { validatedArtifacts: [] }],
    [
      'effective resource budget',
      { effectiveResourceBudget: resourceBudget({ maxThreads: 65 }) },
    ],
    [
      'effective containment',
      {
        effectiveContainment: create(
          agentV1Common.ContainmentReportSchema,
          {
            ...preparedContainment(),
            level: agentV1Common.ContainmentLevel.MONITORED,
          },
        ),
      },
    ],
  ])('rejects mismatched %s before commit', async (_name, overrides) => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const started = await beginPrepare(harness, overrides);

    await expect(started.promise).rejects.toMatchObject({
      code: 'prepared_facts_mismatch',
    });
    expect(harness.durabilityCalls).toHaveLength(0);
    expect(harness.driver.isFailed).toBe(true);
  });

  it('accepts reordered manifests and a stronger containment level', async () => {
    const harness = lifecycleHarness();
    await completeHandshake(harness);
    const snapshots = preparedSnapshots().reverse();
    const artifacts = preparedArtifacts().reverse();
    const containment = create(
      agentV1Common.ContainmentReportSchema,
      {
        ...preparedContainment(),
        level: agentV1Common.ContainmentLevel.HARD_AGGREGATE,
      },
    );

    await expect(completePrepare(harness, {
      loadedSnapshots: snapshots,
      validatedArtifacts: artifacts,
      effectiveContainment: containment,
    })).resolves.toMatchObject({ receipt: expect.any(Object) });
    expect(harness.driver.isFailed).toBe(false);
    harness.driver.abort();
  });

  it('keeps Prepared expectations coupled after caller mutation', async () => {
    const harness = lifecycleHarness(
      (facts) => grantForFacts(facts),
      {
        mutateProvisionAfterBinding(provision) {
          provision.resourceBudget.maxThreads = 65;
        },
      },
    );
    await completeHandshake(harness);
    const started = await beginPrepare(harness, {
      effectiveResourceBudget: resourceBudget({ maxThreads: 65 }),
    });

    await expect(started.promise).rejects.toMatchObject({
      code: 'prepared_facts_mismatch',
    });
    expect(harness.durabilityCalls).toHaveLength(0);
    expect(harness.driver.isFailed).toBe(true);
  });

  it.each([
    ['channel timer first', 20n, 20n],
    ['authority timer first', 30n, 20n],
  ])('revokes Active when the %s expires', async (
    _name,
    specDeadlineAtUnixMs,
    activeDeadlineAtUnixMs,
  ) => {
    let now = 10n;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const harness = lifecycleHarness(
        (facts) => {
          const grant = grantForFacts(facts);
          grant.activate.deadlineAtUnixMs = activeDeadlineAtUnixMs;
          return grant;
        },
        {
          clock: () => now,
          specDeadlineAtUnixMs,
          hardDeadlineAtUnixMs: 40n,
        },
      );
      await completeHandshake(harness);
      const prepared = await completePrepare(harness);
      const activation = await beginActivation(harness, prepared.receipt);
      harness.input.write(delimit(activation.ackFrame));
      const active = await activation.promise;
      const handle = harness.driver.consumeActive(active);
      const authority = harness.driver.inspectActive(handle);

      now = authority.deadlineAtUnixMs;
      await vi.advanceTimersByTimeAsync(
        Number(authority.deadlineAtUnixMs - 10n),
      );

      expect(authority.signal.aborted).toBe(true);
      expect(harness.driver.isFailed).toBe(true);
      expect(() => harness.driver.inspectActive(handle)).toThrow(
        expect.objectContaining({ code: 'invalid_order' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
