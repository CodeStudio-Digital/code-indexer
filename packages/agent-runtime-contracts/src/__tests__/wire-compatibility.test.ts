import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  FrameSchema,
  FramePayloadSchema,
  TransportChannel,
} from '../generated/v1/codestudio/agent/v1/runtime_pb.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const payloadHashDomain = Buffer.from(
  'codestudio.agent.frame-payload.v1\0',
  'utf8',
);
const goldenHex = readFileSync(
  resolve(packageRoot, 'fixtures/v1/frame-ack.hex'),
  'utf8',
).trim();

function goldenPayload() {
  return create(FramePayloadSchema, {
    body: {
      case: 'ack',
      value: {
        acknowledgedMessageId: 'msg:opaque/0',
        acknowledgedPayloadSha256: Uint8Array.from(
          { length: 32 },
          (_, index) => 255 - index,
        ),
        acknowledgedAtUnixMs: 1_784_894_400_456n,
      },
    },
  });
}

function hashEncodedPayload(encodedPayload: Uint8Array): Uint8Array {
  return createHash('sha256')
    .update(payloadHashDomain)
    .update(encodedPayload)
    .digest();
}

function goldenFrame(
  encodedPayload = toBinary(FramePayloadSchema, goldenPayload()),
) {
  return create(FrameSchema, {
    header: {
      protocolVersion: 65_537,
      connectionId: 'conn:alpha',
      messageId: 'msg:opaque/1',
      replyToMessageId: 'msg:prior',
      sessionId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      agentRunId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      executorOwnerId: 'host:desktop',
      fencingEpoch: 9_007_199_254_740_993n,
      correlationId: '55555555-5555-4555-8555-555555555555',
      streamSeq: 18_446_744_073_709_551_614n,
      sentAtUnixMs: 1_784_894_400_123n,
      deadlineAtUnixMs: 1_784_894_460_123n,
      payloadSha256: hashEncodedPayload(encodedPayload),
      operationId: 'operation:read/7',
      toolUseId: '',
    },
    channel: TransportChannel.CONTROL,
    encodedPayload,
  });
}

describe('generated V1 wire compatibility', () => {
  it('encodes the shared golden frame byte-for-byte', () => {
    const bytes = toBinary(FrameSchema, goldenFrame());

    expect(Buffer.from(bytes).toString('hex')).toBe(goldenHex);
    expect(bytes).toHaveLength(400);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'abd5c8d8cb190c25dd143a31d6b26f484f978102e33ea6c1eab53e608b4ff4b1',
    );
  });

  it('preserves uint64, optional presence and the selected oneof case', () => {
    const decoded = fromBinary(FrameSchema, Buffer.from(goldenHex, 'hex'));
    const payload = fromBinary(FramePayloadSchema, decoded.encodedPayload);

    expect(decoded.header?.fencingEpoch).toBe(9_007_199_254_740_993n);
    expect(decoded.header?.streamSeq).toBe(18_446_744_073_709_551_614n);
    expect(decoded.header?.toolUseId).toBe('');
    expect(payload.body.case).toBe('ack');
  });

  it('preserves an unknown enum value for fail-closed validation', () => {
    const bytes = toBinary(FrameSchema, {
      ...goldenFrame(),
      channel: 99 as TransportChannel,
    });
    const decoded = fromBinary(FrameSchema, bytes);

    expect(decoded.channel).toBe(99);
    expect(TransportChannel[decoded.channel]).toBeUndefined();
  });

  it('preserves opaque payload bytes containing an unknown field before payload decode', () => {
    const encodedPayload = Uint8Array.from([
      ...toBinary(FramePayloadSchema, goldenPayload()),
      0x98,
      0x06,
      0x07,
    ]);
    const frameBytes = toBinary(FrameSchema, goldenFrame(encodedPayload));
    const decodedFrame = fromBinary(FrameSchema, frameBytes);

    expect(decodedFrame.encodedPayload).toEqual(encodedPayload);

    const decodedPayload = fromBinary(
      FramePayloadSchema,
      decodedFrame.encodedPayload,
    );
    expect(decodedPayload.body.case).toBe('ack');
  });
});
