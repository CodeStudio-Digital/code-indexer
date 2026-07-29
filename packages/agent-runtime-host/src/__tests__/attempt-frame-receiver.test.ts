import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_FRAME_MAX_BYTES,
  AttemptFrameError,
  encodeAttemptFrame,
  frameEnvelopeSha256,
  framePayloadSha256,
  validateAttemptFrame,
} from '../ipc/AttemptFrame.js';
import {
  AttemptFrameReceiver,
  AttemptFrameReceiverError,
  MAX_REPLAY_WINDOW_ENTRIES,
} from '../ipc/AttemptFrameReceiver.js';
import {
  AttemptCorrelationAuthority,
} from '../ipc/AttemptCorrelationAuthority.js';
import {
  mintNegotiatedSeed,
} from '../ipc/AttemptFrameSeed.js';
import { MAX_FRAME_IDENTIFIER_BYTES } from '../ipc/FrameHeaderValidation.js';

const MAXIMUM = ATTEMPT_FRAME_MAX_BYTES[
  agentV1Runtime.TransportChannel.CONTROL
];
const TEST_REPLAY_BYTES = MAXIMUM * 4;
const RUNTIME = 'runtime-instance';

function identity(overrides = {}) {
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
    ...overrides,
  });
}

function header(overrides = {}) {
  const authority = identity();
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: 'connection',
    messageId: 'message-2',
    sessionId: authority.sessionId,
    commandId: authority.commandId,
    agentRunId: authority.agentRunId,
    attemptId: authority.attemptId,
    executorOwnerId: authority.executorOwnerId,
    fencingEpoch: authority.fencingEpoch,
    correlationId: authority.correlationId,
    rootAgentRunId: authority.rootAgentRunId,
    ownerAgentRunId: authority.ownerAgentRunId,
    streamSeq: 2n,
    sentAtUnixMs: 1n,
    ...overrides,
  });
}

function ack(value = 'acknowledged') {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'ack',
      value: {
        acknowledgedMessageId: value,
        acknowledgedPayloadSha256: new Uint8Array(32),
        acknowledgedAtUnixMs: 1n,
      },
    },
  });
}

function encoded(
  payload = ack(),
  headerOverrides = {},
): Uint8Array {
  return encodeAttemptFrame(
    header(headerOverrides),
    agentV1Runtime.TransportChannel.CONTROL,
    payload,
    MAXIMUM,
  );
}

function raw(
  payload: agentV1Runtime.FramePayload,
  candidateHeader: agentV1Runtime.FrameHeader,
): Uint8Array {
  const encodedPayload = toBinary(agentV1Runtime.FramePayloadSchema, payload);
  return toBinary(agentV1Runtime.FrameSchema, create(
    agentV1Runtime.FrameSchema,
    {
      header: {
        ...candidateHeader,
        payloadSha256: framePayloadSha256(encodedPayload),
      },
      channel: agentV1Runtime.TransportChannel.CONTROL,
      encodedPayload,
    },
  ));
}

function receiver(
  seedOverrides = {},
  limitOverrides = {},
) {
  const seed = mintNegotiatedSeed({
    protocolVersion: 65_537,
    connectionId: 'connection',
    runtimeInstanceId: RUNTIME,
    identity: identity(),
    channel: agentV1Runtime.TransportChannel.CONTROL,
    direction: 'host_to_runner',
    maximumFrameBytes: MAXIMUM,
    streamWatermark: 1n,
    bootstrapMessageId: 'bootstrap',
    bootstrapBinding: {},
    ...seedOverrides,
  });
  return new AttemptFrameReceiver(seed, {
    replayCapacity: 2,
    totalIdentityCapacity: 8,
    maxReplayBytes: TEST_REPLAY_BYTES,
    ...limitOverrides,
  }, new AttemptCorrelationAuthority(8));
}

function expectCode(
  action: () => unknown,
  code: AttemptFrameError['code'] | AttemptFrameReceiverError['code'],
) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function takePending(channel: AttemptFrameReceiver, bytes: Uint8Array) {
  const outcome = channel.beginReceive(bytes, () => 2n);
  if (outcome.kind !== 'pending') throw new Error('expected pending');
  return outcome.pending;
}

function commitAccepted(channel: AttemptFrameReceiver, bytes: Uint8Array) {
  const pending = takePending(channel, bytes);
  channel.commit(pending, channel.acceptedOutcome());
}

describe('attempt frame header authority', () => {
  it('rejects default headers and invalid scalar metadata', () => {
    expectCode(
      () => validateAttemptFrame(
        raw(ack(), create(agentV1Runtime.FrameHeaderSchema)),
        agentV1Runtime.TransportChannel.CONTROL,
        MAXIMUM,
      ),
      'invalid_protocol_version',
    );
    expectCode(() => encoded(ack(), { fencingEpoch: 0n }), 'invalid_fencing_epoch');
    expectCode(() => encoded(ack(), { streamSeq: 0n }), 'invalid_stream_seq');
    expectCode(
      () => encoded(ack(), { sentAtUnixMs: 10n, deadlineAtUnixMs: 9n }),
      'invalid_deadline',
    );
    expectCode(
      () => encoded(ack(), { sentAtUnixMs: 10n, deadlineAtUnixMs: 10n }),
      'invalid_deadline',
    );
  });

  it('enforces identifiers and the complete payload identity', () => {
    expect(() => encoded(ack(), {
      connectionId: 'x'.repeat(MAX_FRAME_IDENTIFIER_BYTES),
    })).not.toThrow();
    expectCode(
      () => encoded(ack(), {
        connectionId: 'x'.repeat(MAX_FRAME_IDENTIFIER_BYTES + 1),
      }),
      'invalid_header_identifier',
    );
    const payload = create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'prepareAttempt',
        value: {
          identity: identity({
            rootAgentRunId: '88888888-8888-4888-8888-888888888888',
          }),
        },
      },
    });
    expectCode(
      () => validateAttemptFrame(
        raw(payload, header()),
        agentV1Runtime.TransportChannel.CONTROL,
        MAXIMUM,
      ),
      'payload_identity_mismatch',
    );
  });
});

describe('transactional attempt frame receiver', () => {
  it('does not advance before commit and consumes payload exactly once', () => {
    const channel = receiver();
    const bytes = encoded();
    const pending = takePending(channel, bytes);
    expect(channel.streamWatermark).toBe(1n);
    expect(channel.hasPending).toBe(true);
    const first = pending.takeBodyAndDigest();
    expect(first.body.case).toBe('ack');
    expect(first.payloadDigest).toHaveLength(32);
    expectCode(() => pending.takeBodyAndDigest(), 'pending_payload_consumed');
    expectCode(() => channel.beginReceive(bytes, () => 2n), 'pending_inbound_active');
    expect(channel.isPoisoned).toBe(false);
    channel.commit(pending, channel.acceptedOutcome());
    expect(channel.streamWatermark).toBe(2n);
  });

  it('replays only committed exact bytes with digest and bounded outcome', () => {
    const channel = receiver();
    const bytes = encoded();
    const pending = takePending(channel, bytes);
    channel.commit(pending, channel.boundedResponse(Uint8Array.of(7, 8, 9)));
    const outcome = channel.beginReceive(bytes, () => 2n);
    expect(outcome.kind).toBe('replay');
    if (outcome.kind !== 'replay') return;
    expect(outcome.replay.envelopeDigest).toEqual(frameEnvelopeSha256(bytes));
    expect(outcome.replay.outcome.responseBytes()).toEqual(Uint8Array.of(7, 8, 9));
  });

  it('replays a committed frame after its deadline but rejects a fresh expiry', () => {
    const bytes = encoded(ack(), { deadlineAtUnixMs: 3n });
    const committed = receiver();
    commitAccepted(committed, bytes);
    expect(committed.beginReceive(bytes, () => 4n).kind).toBe('replay');

    const fresh = receiver();
    expectCode(
      () => fresh.beginReceive(bytes, () => 3n),
      'deadline_expired',
    );
  });

  it('blocks conflicts including unknown original envelope fields', () => {
    const channel = receiver();
    const bytes = encoded();
    commitAccepted(channel, bytes);
    const changed = Uint8Array.from([...bytes, 0xa0, 0x06, 0x01]);
    expectCode(() => channel.beginReceive(changed, () => 2n), 'message_id_conflict');
    expect(channel.isPoisoned).toBe(true);
  });

  it('rejects foreign outcomes and handler rejection without committing', () => {
    const first = receiver();
    const second = receiver();
    const pending = takePending(first, encoded());
    expectCode(
      () => first.commit(pending, second.acceptedOutcome()),
      'invalid_replay_outcome',
    );
    expect(first.streamWatermark).toBe(1n);

    const rejected = receiver();
    const rejectedPending = takePending(rejected, encoded());
    rejected.reject(rejectedPending);
    expect(rejected.streamWatermark).toBe(1n);
    expect(rejected.isPoisoned).toBe(true);
  });

  it('turns evictions into tombstones and fails closed at total capacity', () => {
    const tombstones = receiver({}, {
      replayCapacity: 1,
      totalIdentityCapacity: 3,
    });
    const second = encoded(ack(), { messageId: 'two', streamSeq: 2n });
    const third = encoded(ack(), { messageId: 'three', streamSeq: 3n });
    commitAccepted(tombstones, second);
    commitAccepted(tombstones, third);
    expect(tombstones.tombstoneCount).toBe(2);
    expectCode(() => tombstones.beginReceive(second, () => 2n), 'message_id_retired');

    const full = receiver({}, {
      replayCapacity: 2,
      totalIdentityCapacity: 2,
    });
    commitAccepted(full, second);
    expectCode(() => full.beginReceive(third, () => 2n), 'identity_capacity_exhausted');
  });

  it('accounts shared replay buffers once and frees bytes on tombstoning', () => {
    const second = encoded(ack(), { messageId: 'two', streamSeq: 2n });
    const third = encoded(ack(), { messageId: 'three', streamSeq: 3n });
    const shared = receiver({}, {
      replayCapacity: 2,
      totalIdentityCapacity: 8,
      maxReplayBytes: 3,
    });
    const outcome = shared.boundedResponse(Uint8Array.of(1, 2, 3));
    shared.commit(takePending(shared, second), outcome);
    shared.commit(takePending(shared, third), outcome);
    expect(shared.replayBytes).toBe(3);

    const evicting = receiver({}, {
      replayCapacity: 1,
      totalIdentityCapacity: 4,
      maxReplayBytes: 3,
    });
    evicting.commit(
      takePending(evicting, second),
      evicting.boundedResponse(Uint8Array.of(1, 2, 3)),
    );
    evicting.commit(
      takePending(evicting, third),
      evicting.boundedResponse(Uint8Array.of(4, 5, 6)),
    );
    expect(evicting.replayBytes).toBe(3);
    expect(evicting.tombstoneCount).toBe(2);
    expectCode(() => evicting.beginReceive(second, () => 2n), 'message_id_retired');
  });

  it('poisons before publishing an outcome that exceeds replay byte budget', () => {
    const channel = receiver({}, { maxReplayBytes: 3 });
    const second = encoded(ack(), { messageId: 'two', streamSeq: 2n });
    channel.commit(
      takePending(channel, second),
      channel.boundedResponse(Uint8Array.of(1, 2, 3)),
    );
    const third = encoded(ack(), { messageId: 'three', streamSeq: 3n });
    const pending = takePending(channel, third);
    expectCode(
      () => channel.commit(
        pending,
        channel.boundedResponse(Uint8Array.of(4, 5, 6)),
      ),
      'replay_byte_budget_exhausted',
    );
    expect(channel.streamWatermark).toBe(2n);
    expect(channel.isPoisoned).toBe(true);
  });

  it('rejects stale context, deadlines, direction and int64 overflow', () => {
    expectCode(
      () => receiver({ protocolVersion: 65_538 }).beginReceive(encoded(), () => 2n),
      'protocol_mismatch',
    );
    expectCode(
      () => receiver({ connectionId: 'other' }).beginReceive(encoded(), () => 2n),
      'connection_mismatch',
    );
    expectCode(
      () => receiver({
        identity: identity({ fencingEpoch: 8n }),
      }).beginReceive(encoded(), () => 2n),
      'identity_mismatch',
    );
    expectCode(
      () => receiver().beginReceive(encoded(ack(), {
        deadlineAtUnixMs: 10n,
      }), () => 10n),
      'deadline_expired',
    );
    const agentHello = create(agentV1Runtime.FramePayloadSchema, {
      body: { case: 'agentHello', value: {} },
    });
    expectCode(
      () => receiver().beginReceive(encoded(agentHello), () => 2n),
      'direction_mismatch',
    );
    expectCode(
      () => receiver().beginReceive(encoded(), () => 1n << 63n),
      'invalid_observed_at',
    );
  });

  it('authenticates seeds and bounds receiver capacities', () => {
    expectCode(
      () => new AttemptFrameReceiver({} as never, {
        replayCapacity: 2,
        totalIdentityCapacity: 8,
        maxReplayBytes: TEST_REPLAY_BYTES,
      }, new AttemptCorrelationAuthority(8)),
      'invalid_seed',
    );
    expectCode(
      () => receiver({}, {
        replayCapacity: MAX_REPLAY_WINDOW_ENTRIES + 1,
        totalIdentityCapacity: MAX_REPLAY_WINDOW_ENTRIES + 1,
        maxReplayBytes: TEST_REPLAY_BYTES,
      }),
      'replay_window_too_large',
    );
  });

  it('returns protobuf clones instead of mutable internal references', () => {
    const channel = receiver();
    const pending = takePending(channel, encoded());
    const mutated = pending.header();
    mutated.messageId = 'mutated';
    expect(pending.header().messageId).toBe('message-2');
    const mutatedIdentity = pending.identity();
    mutatedIdentity.attemptId = 'mutated';
    expect(pending.identity().attemptId).toBe(
      '44444444-4444-4444-8444-444444444444',
    );
  });

  it('scrubs pending payloads and replay history on failure', () => {
    const pendingChannel = receiver();
    const pending = takePending(pendingChannel, encoded());
    pendingChannel.fail();

    expectCode(() => pending.header(), 'invalid_pending');
    expectCode(() => pending.identity(), 'invalid_pending');
    expectCode(() => pending.binding(), 'invalid_pending');
    expectCode(() => pending.takeBodyAndDigest(), 'invalid_pending');
    expect(pendingChannel.hasPending).toBe(false);
    expect(pendingChannel.replayEntryCount).toBe(0);
    expect(pendingChannel.tombstoneCount).toBe(0);
    expect(pendingChannel.replayBytes).toBe(0);

    const replayChannel = receiver();
    const committed = takePending(replayChannel, encoded());
    replayChannel.commit(
      committed,
      replayChannel.boundedResponse(Uint8Array.of(7, 8, 9)),
    );
    expect(replayChannel.replayBytes).toBe(3);
    replayChannel.fail();
    expect(replayChannel.replayEntryCount).toBe(0);
    expect(replayChannel.tombstoneCount).toBe(0);
    expect(replayChannel.replayBytes).toBe(0);
  });
});
