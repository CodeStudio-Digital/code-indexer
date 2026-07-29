import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_FRAME_MAX_BYTES,
  AttemptFrameError,
  encodeAttemptFrame as encodeAttemptFrameRaw,
  frameEnvelopeSha256,
  framePayloadSha256,
  validateAttemptFrame as validateAttemptFrameRaw,
} from '../ipc/AttemptFrame.js';

function encodeAttemptFrame(
  candidateHeader: agentV1Runtime.FrameHeader,
  channel: agentV1Runtime.TransportChannel.CONTROL | agentV1Runtime.TransportChannel.DATA,
  payload: agentV1Runtime.FramePayload,
) {
  return encodeAttemptFrameRaw(
    candidateHeader,
    channel,
    payload,
    ATTEMPT_FRAME_MAX_BYTES[channel],
  );
}

function validateAttemptFrame(
  bytes: Uint8Array,
  channel: agentV1Runtime.TransportChannel.CONTROL | agentV1Runtime.TransportChannel.DATA,
) {
  const maximum = channel === agentV1Runtime.TransportChannel.DATA
    ? ATTEMPT_FRAME_MAX_BYTES[agentV1Runtime.TransportChannel.DATA]
    : ATTEMPT_FRAME_MAX_BYTES[agentV1Runtime.TransportChannel.CONTROL];
  return validateAttemptFrameRaw(bytes, channel, maximum);
}

function header() {
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: 'connection:test',
    messageId: 'message:test',
    sessionId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    agentRunId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    executorOwnerId: 'host:test',
    fencingEpoch: 7n,
    correlationId: '55555555-5555-4555-8555-555555555555',
    rootAgentRunId: '66666666-6666-4666-8666-666666666666',
    ownerAgentRunId: '77777777-7777-4777-8777-777777777777',
    streamSeq: 1n,
    sentAtUnixMs: 1n,
    payloadSha256: new Uint8Array(),
  });
}

function ackPayload() {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'ack',
      value: {
        acknowledgedMessageId: 'message:prior',
        acknowledgedPayloadSha256: new Uint8Array(32),
        acknowledgedAtUnixMs: 2n,
      },
    },
  });
}

function rawFrame(
  channel: agentV1Runtime.TransportChannel,
  encodedPayload: Uint8Array,
  digest = framePayloadSha256(encodedPayload),
) {
  return toBinary(
    agentV1Runtime.FrameSchema,
    create(agentV1Runtime.FrameSchema, {
      header: { ...header(), payloadSha256: digest },
      channel,
      encodedPayload,
    }),
  );
}

function expectCode(action: () => unknown, code: AttemptFrameError['code']) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe('attempt frame validation', () => {
  it('matches the Rust envelope hash golden vector', () => {
    expect(Buffer.from(frameEnvelopeSha256(Uint8Array.of(1, 2, 3))).toString('hex'))
      .toBe('d78caaf18be448a28b86c6a19fc9c3dde58c6ef2f149a882b8e8b8fe28b51b28');
  });

  it('round-trips an allowed control payload', () => {
    const bytes = encodeAttemptFrame(
      header(),
      agentV1Runtime.TransportChannel.CONTROL,
      ackPayload(),
    );

    const validated = validateAttemptFrame(
      bytes,
      agentV1Runtime.TransportChannel.CONTROL,
    );

    expect(validated.payload.body.case).toBe('ack');
    expect(validated.frame.header?.payloadSha256).toHaveLength(32);
  });

  it('rejects legacy and non-canonical operational identities at the frame boundary', () => {
    expectCode(
      () => encodeAttemptFrame(
        { ...header(), sessionId: 'session:1' },
        agentV1Runtime.TransportChannel.CONTROL,
        ackPayload(),
      ),
      'invalid_header_identifier',
    );
    expectCode(
      () => encodeAttemptFrame(
        {
          ...header(),
          sessionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        },
        agentV1Runtime.TransportChannel.CONTROL,
        ackPayload(),
      ),
      'invalid_header_identifier',
    );
  });

  it('hashes opaque bytes before decoding and accepts an unknown payload field', () => {
    const encodedPayload = Uint8Array.from([
      ...toBinary(agentV1Runtime.FramePayloadSchema, ackPayload()),
      0x98,
      0x06,
      0x07,
    ]);
    const validated = validateAttemptFrame(
      rawFrame(agentV1Runtime.TransportChannel.CONTROL, encodedPayload),
      agentV1Runtime.TransportChannel.CONTROL,
    );

    expect(validated.frame.encodedPayload).toEqual(encodedPayload);
    expect(validated.payload.body.case).toBe('ack');
  });

  it('rejects payload mutation against the original digest', () => {
    const encodedPayload = toBinary(
      agentV1Runtime.FramePayloadSchema,
      ackPayload(),
    );
    const digest = framePayloadSha256(encodedPayload);
    encodedPayload[encodedPayload.byteLength - 1] ^= 1;

    expectCode(
      () => validateAttemptFrame(
        rawFrame(
          agentV1Runtime.TransportChannel.CONTROL,
          encodedPayload,
          digest,
        ),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'payload_digest_mismatch',
    );
  });

  it('rejects cross-wired physical channels', () => {
    const bytes = encodeAttemptFrame(
      header(),
      agentV1Runtime.TransportChannel.CONTROL,
      ackPayload(),
    );

    expectCode(
      () => validateAttemptFrame(
        bytes,
        agentV1Runtime.TransportChannel.DATA,
      ),
      'channel_mismatch',
    );
  });

  it('rejects unknown channels before payload dispatch', () => {
    const encodedPayload = toBinary(
      agentV1Runtime.FramePayloadSchema,
      ackPayload(),
    );

    expectCode(
      () => validateAttemptFrame(
        rawFrame(99 as agentV1Runtime.TransportChannel, encodedPayload),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'unsupported_channel',
    );
  });

  it('rejects control messages on the data channel', () => {
    const encodedPayload = toBinary(
      agentV1Runtime.FramePayloadSchema,
      ackPayload(),
    );

    expectCode(
      () => validateAttemptFrame(
        rawFrame(agentV1Runtime.TransportChannel.DATA, encodedPayload),
        agentV1Runtime.TransportChannel.DATA,
      ),
      'payload_not_allowed_on_channel',
    );
  });

  it('rejects missing headers, empty payloads and malformed payloads', () => {
    const noHeader = toBinary(
      agentV1Runtime.FrameSchema,
      create(agentV1Runtime.FrameSchema, {
        channel: agentV1Runtime.TransportChannel.CONTROL,
        encodedPayload: Uint8Array.of(1),
      }),
    );
    expectCode(
      () => validateAttemptFrame(
        noHeader,
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'missing_header',
    );

    expectCode(
      () => validateAttemptFrame(
        rawFrame(
          agentV1Runtime.TransportChannel.CONTROL,
          new Uint8Array(),
        ),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'empty_payload',
    );

    expectCode(
      () => validateAttemptFrame(
        rawFrame(
          agentV1Runtime.TransportChannel.CONTROL,
          Uint8Array.of(0xff),
        ),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'malformed_payload',
    );
  });

  it('rejects invalid digest lengths and missing oneof bodies', () => {
    const payload = toBinary(
      agentV1Runtime.FramePayloadSchema,
      ackPayload(),
    );
    expectCode(
      () => validateAttemptFrame(
        rawFrame(
          agentV1Runtime.TransportChannel.CONTROL,
          payload,
          new Uint8Array(31),
        ),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'invalid_payload_digest',
    );

    const noBody = toBinary(
      agentV1Runtime.FramePayloadSchema,
      create(agentV1Runtime.FramePayloadSchema),
    );
    expectCode(
      () => validateAttemptFrame(
        rawFrame(agentV1Runtime.TransportChannel.CONTROL, noBody),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'empty_payload',
    );
  });

  it('rejects an oversized envelope before protobuf decoding', () => {
    expectCode(
      () => validateAttemptFrame(
        new Uint8Array(
          ATTEMPT_FRAME_MAX_BYTES[
            agentV1Runtime.TransportChannel.CONTROL
          ] + 1,
        ),
        agentV1Runtime.TransportChannel.CONTROL,
      ),
      'frame_too_large',
    );
  });

  it('rejects management and pulse endpoints for this envelope', () => {
    const bytes = encodeAttemptFrame(
      header(),
      agentV1Runtime.TransportChannel.CONTROL,
      ackPayload(),
    );

    expectCode(
      () => validateAttemptFrame(
        bytes,
        agentV1Runtime.TransportChannel.MANAGEMENT as never,
      ),
      'unsupported_channel',
    );
    expectCode(
      () => validateAttemptFrame(
        bytes,
        agentV1Runtime.TransportChannel.PULSE as never,
      ),
      'unsupported_channel',
    );
  });
});
