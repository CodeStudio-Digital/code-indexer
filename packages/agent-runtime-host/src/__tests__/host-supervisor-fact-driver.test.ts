import { createHash } from 'node:crypto';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  DurableSupervisorFactCommitControl,
  DurableSupervisorFactPort,
  SupervisorFactBinding,
} from '../driver/HostSupervisorFactTypes.js';
import { validateManagementFrame } from '../ipc/ManagementFrame.js';
import {
  acceptedFact,
  containmentFact,
  directionFrame,
  factFrame,
  harness,
  MANAGEMENT_CONNECTION,
  MANAGEMENT_MAXIMUM,
  MANAGEMENT_PROTOCOL,
  mutateWireHeader,
  rejectedFact,
  RESERVATION_ID,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import { identity } from './attempt-channel-support.js';

function successfulPort() {
  return { commit: vi.fn(async () => undefined) };
}

function decodedAck(encoded: Uint8Array) {
  const validated = validateManagementFrame(encoded);
  if (validated.payload.body.case !== 'managementAck') {
    throw new TypeError('expected ManagementAck');
  }
  return {
    header: validated.frame.header!,
    ack: validated.payload.body.value,
  };
}

function expectCode(
  action: Promise<unknown>,
  code: HostSupervisorFactError['code'],
) {
  return expect(action).rejects.toMatchObject({ code });
}

describe('HostSupervisorFactDriver', () => {
  it('emits the exact correlated ACK only after durable commit resolves', async () => {
    let release!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let durableBinding: SupervisorFactBinding | undefined;
    let durableControl: DurableSupervisorFactCommitControl | undefined;
    const port = {
      commit: vi.fn((
        _fact,
        binding: SupervisorFactBinding,
        control: DurableSupervisorFactCommitControl,
      ) => {
        durableBinding = binding;
        durableControl = control;
        return commitGate;
      }),
    };
    const inbound = factFrame(acceptedFact(), 'accepted', 2n);
    const expectedDigest = validateManagementFrame(inbound)
      .frame.header!.payloadSha256;
    const { capture, driver } = harness([inbound], port);

    const processing = driver.processNext();
    await vi.waitFor(() => expect(port.commit).toHaveBeenCalledOnce());
    expect(capture.frames()).toHaveLength(0);
    expect(durableControl?.signal.aborted).toBe(false);
    expect(durableControl?.deadlineAtUnixMs).toBe(1_100n);
    expect(durableControl?.idempotencyKey).toBe(
      `management-supervisor-fact:v1:${
        Buffer.from(durableBinding!.envelopeSha256).toString('hex')
      }`,
    );
    release();
    await expect(processing).resolves.toMatchObject({
      kind: 'committed',
      factCase: 'launchAccepted',
    });

    const frames = capture.frames();
    expect(frames).toHaveLength(1);
    const { header, ack } = decodedAck(frames[0]!);
    expect(header.streamSeq).toBe(2n);
    expect(header.connectionId).toBe(MANAGEMENT_CONNECTION);
    expect(header.replyToMessageId).toBe('accepted');
    expect(ack.acknowledgedMessageId).toBe('accepted');
    expect(ack.acknowledgedPayloadSha256).toEqual(expectedDigest);
    expect(durableBinding?.envelopeSha256).toEqual(
      createHash('sha256')
        .update(Buffer.from(
          'codestudio.agent.management-envelope.v1\0',
          'utf8',
        ))
        .update(inbound)
        .digest(),
    );
  });

  it('replays byte-identical ACK without recommitting the fact', async () => {
    const port = successfulPort();
    const inbound = factFrame(acceptedFact(), 'accepted', 2n);
    const { capture, driver } = harness([inbound, inbound], port);

    await driver.processNext();
    await expect(driver.processNext()).resolves.toMatchObject({
      kind: 'replayed',
      messageId: 'accepted',
    });

    expect(port.commit).toHaveBeenCalledTimes(1);
    const frames = capture.frames();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual(frames[0]);
  });

  it('commits and ACKs LaunchRejected as a terminal lifecycle outcome', async () => {
    const port = successfulPort();
    const rejected = factFrame(rejectedFact(), 'rejected', 2n);
    const afterTerminal = factFrame(acceptedFact(), 'accepted-after', 3n);
    const { capture, driver } = harness(
      [rejected, afterTerminal],
      port,
    );

    await expect(driver.processNext()).resolves.toEqual({
      kind: 'committed',
      factCase: 'launchRejected',
      messageId: 'rejected',
    });
    expect(port.commit).toHaveBeenCalledOnce();
    const acknowledgement = decodedAck(capture.frames()[0]!);
    expect(acknowledgement.header.replyToMessageId).toBe('rejected');
    expect(acknowledgement.ack.acknowledgedMessageId).toBe('rejected');

    await expectCode(driver.processNext(), 'invalid_lifecycle_order');
    expect(port.commit).toHaveBeenCalledOnce();
    expect(capture.frames()).toHaveLength(1);
  });

  it('rejects V1 launch rejection domain detail before durability', async () => {
    const port = successfulPort();
    const rejected = harness([
      factFrame(
        rejectedFact({ redactedDetail: 'capacity unavailable' }),
        'rejected',
        2n,
      ),
    ], port);

    await expectCode(rejected.driver.processNext(), 'invalid_fact');
    expect(port.commit).not.toHaveBeenCalled();
    expect(rejected.capture.frames()).toHaveLength(0);
  });

  it('keeps ACK authority private from a mutating durable port', async () => {
    const accepted = factFrame(acceptedFact(), 'accepted', 2n);
    const spawned = factFrame(spawnedFact(), 'spawned', 3n);
    const expectedDigest = validateManagementFrame(accepted)
      .frame.header!.payloadSha256;
    const port: DurableSupervisorFactPort = {
      async commit(fact, binding) {
        binding.payloadSha256.fill(0xff);
        binding.envelopeSha256.fill(0xff);
        if (fact.case === 'launchAccepted') {
          fact.value.reservationId = 'mutated';
          (fact as { case: string }).case = 'launchRejected';
        }
      },
    };
    const { capture, driver } = harness([accepted, spawned], port);

    await expect(driver.processNext()).resolves.toMatchObject({
      factCase: 'launchAccepted',
    });
    await expect(driver.processNext()).resolves.toMatchObject({
      factCase: 'attemptProcessSpawned',
    });

    const first = decodedAck(capture.frames()[0]!);
    expect(first.ack.acknowledgedPayloadSha256).toEqual(expectedDigest);
  });

  it('does not ACK a rejected durable commit, abort, EOF, or write failure', async () => {
    const rejectedCommit = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      { commit: vi.fn(async () => { throw new Error('db failed'); }) },
    );
    await expectCode(
      rejectedCommit.driver.processNext(),
      'durable_commit_failed',
    );
    expect(rejectedCommit.capture.frames()).toHaveLength(0);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let durableControl: DurableSupervisorFactCommitControl | undefined;
    const abortingPort = {
      commit: vi.fn((
        _fact,
        _binding,
        control: DurableSupervisorFactCommitControl,
      ) => {
        durableControl = control;
        return blocked;
      }),
    };
    const aborted = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      abortingPort,
    );
    const controller = new AbortController();
    const processing = aborted.driver.processNext(controller.signal);
    await vi.waitFor(() => expect(abortingPort.commit).toHaveBeenCalledOnce());
    expect(aborted.capture.frames()).toHaveLength(0);
    controller.abort(new Error('stop'));
    await expectCode(processing, 'aborted');
    expect(durableControl?.signal.aborted).toBe(true);
    expect(aborted.capture.frames()).toHaveLength(0);
    release();
    await blocked;
    await Promise.resolve();
    expect(aborted.driver.isPoisoned).toBe(true);
    expect(aborted.capture.frames()).toHaveLength(0);

    const eof = harness([], successfulPort());
    await expectCode(eof.driver.processNext(), 'unexpected_eof');
    expect(eof.capture.frames()).toHaveLength(0);

    const write = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      successfulPort(),
      { writableFailureAt: 1 },
    );
    await expectCode(write.driver.processNext(), 'invalid_frame');
    expect(write.capture.frames()).toHaveLength(0);
  });

  it('cannot lose caller abort while establishing durable commit control', async () => {
    const caller = new AbortController();
    const stop = new Error('abort inside owner clock');
    let clockCalls = 0;
    const port = successfulPort();
    const attempt = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      port,
      {
        driver: {
          nowUnixMs: () => {
            clockCalls += 1;
            if (clockCalls === 2) caller.abort(stop);
            return 100n;
          },
        },
      },
    );

    await expect(attempt.driver.processNext(caller.signal)).rejects
      .toMatchObject({
        code: 'aborted',
        cause: stop,
      });
    expect(clockCalls).toBe(2);
    expect(port.commit).not.toHaveBeenCalled();
    expect(attempt.capture.frames()).toHaveLength(0);
    expect(attempt.driver.isPoisoned).toBe(true);
  });

  it('enforces lifecycle links and never commits or ACKs a mismatched fact', async () => {
    const port = successfulPort();
    const frames = [
      factFrame(acceptedFact(), 'accepted', 2n),
      factFrame(
        spawnedFact({ reservationId: 'reservation:foreign' }),
        'spawned',
        3n,
      ),
    ];
    const { capture, driver } = harness(frames, port);

    await driver.processNext();
    await expectCode(driver.processNext(), 'invalid_fact');
    expect(port.commit).toHaveBeenCalledTimes(1);
    expect(capture.frames()).toHaveLength(1);
  });

  it('accepts only exact handoff identity and runtime correlation', async () => {
    const foreign = identity();
    foreign.attemptId = '88888888-8888-4888-8888-888888888888';
    const identityHarness = harness(
      [factFrame(acceptedFact({ identity: foreign }), 'accepted', 2n)],
      successfulPort(),
    );
    await expectCode(identityHarness.driver.processNext(), 'invalid_fact');
    expect(identityHarness.capture.frames()).toHaveLength(0);

    const port = successfulPort();
    const runtimeHarness = harness([
      factFrame(acceptedFact(), 'accepted', 2n),
      factFrame(spawnedFact(), 'spawned', 3n),
      factFrame(
        containmentFact({ runtimeInstanceId: 'runner:foreign' }),
        'containment',
        4n,
      ),
    ], port);
    await runtimeHarness.driver.processNext();
    await runtimeHarness.driver.processNext();
    await expectCode(runtimeHarness.driver.processNext(), 'invalid_fact');
    expect(port.commit).toHaveBeenCalledTimes(2);
    expect(runtimeHarness.capture.frames()).toHaveLength(2);
  });

  it('rejects invalid connection, protocol, sequence, digest, and direction', async () => {
    const valid = factFrame(acceptedFact(), 'accepted', 2n);
    const wrongDigest = fromBinary(
      agentV1Supervisor.ManagementFrameSchema,
      valid.slice(),
    );
    wrongDigest.header!.payloadSha256[0] ^= 1;
    const cases: Array<[Uint8Array, HostSupervisorFactError['code']]> = [
      [
        mutateWireHeader(valid, (header) => {
          header.connectionId = 'management:foreign';
        }),
        'connection_mismatch',
      ],
      [
        mutateWireHeader(valid, (header) => {
          header.protocolVersion = MANAGEMENT_PROTOCOL + 1;
        }),
        'protocol_mismatch',
      ],
      [
        mutateWireHeader(valid, (header) => { header.streamSeq = 4n; }),
        'sequence_mismatch',
      ],
      [
        toBinary(agentV1Supervisor.ManagementFrameSchema, wrongDigest),
        'invalid_frame',
      ],
      [directionFrame(), 'payload_direction'],
    ];

    for (const [frame, code] of cases) {
      const attempt = harness([frame], successfulPort());
      await expectCode(attempt.driver.processNext(), code);
      expect(attempt.capture.frames()).toHaveLength(0);
      expect(attempt.driver.isPoisoned).toBe(true);
    }
  });

  it('keeps retired IDs permanent and closes on tombstone exhaustion', async () => {
    const port = successfulPort();
    const retired = harness([
      factFrame(acceptedFact(), 'old-id', 2n),
      factFrame(spawnedFact(), 'spawned', 3n),
      factFrame(containmentFact(), 'old-id', 4n),
    ], port);
    await retired.driver.processNext();
    await retired.driver.processNext();
    await expectCode(retired.driver.processNext(), 'message_id_retired');
    expect(port.commit).toHaveBeenCalledTimes(2);
    expect(retired.capture.frames()).toHaveLength(2);

    const capacityPort = successfulPort();
    const exhausted = harness([
      factFrame(acceptedFact(), 'accepted', 2n),
      factFrame(spawnedFact(), 'spawned', 3n),
      factFrame(containmentFact(), 'containment', 4n),
    ], capacityPort, {
      driver: {
        handoff: {
          trackedMessageIdCapacity: 3,
        },
      },
    });
    await exhausted.driver.processNext();
    await exhausted.driver.processNext();
    await expectCode(
      exhausted.driver.processNext(),
      'identity_capacity_exhausted',
    );
    expect(capacityPort.commit).toHaveBeenCalledTimes(2);
  });

  it('rejects a transplanted frame cap and destroys the transport', () => {
    let observedTransport:
      | import('../ipc/DelimitedByteChannel.js').DelimitedByteChannel
      | undefined;
    expect(() => harness(
      [factFrame(rejectedFact(), 'rejected', 2n)],
      successfulPort(),
      {
        transportMaximum: MANAGEMENT_MAXIMUM - 1,
        observeTransport: (transport) => { observedTransport = transport; },
      },
    )).toThrow(expect.objectContaining({ code: 'invalid_handoff' }));
    expect(observedTransport?.isFailed).toBe(true);
  });

  it('seals handoff authority and rejects an insufficient replay budget', async () => {
    const snapshot = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      successfulPort(),
    );
    snapshot.driverOptions.handoff.expectedIdentity.attemptId = 'mutated';
    (snapshot.driverOptions.handoff as { maximumFrameBytes: number })
      .maximumFrameBytes = 1;
    await expect(snapshot.driver.processNext()).resolves.toMatchObject({
      factCase: 'launchAccepted',
    });

    const port = successfulPort();
    const exhausted = harness(
      [factFrame(acceptedFact(), 'accepted', 2n)],
      port,
      { driver: { handoff: { maximumReplayBytes: 1 } } },
    );
    await expectCode(
      exhausted.driver.processNext(),
      'replay_capacity_exhausted',
    );
    expect(port.commit).not.toHaveBeenCalled();
    expect(exhausted.capture.frames()).toHaveLength(0);
  });
});
