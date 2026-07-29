import { createHash, timingSafeEqual } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  AttemptFrameError,
  type AttemptFrameErrorCode,
} from './AttemptFrameError.js';
import {
  assertAttemptChannel,
  assertPayloadAllowed,
} from './AttemptFrameChannel.js';
import {
  ATTEMPT_FRAME_MAX_BYTES,
  assertAttemptFrameSize,
  type AttemptTransportChannel,
} from './AttemptFrameLimits.js';
import { validatePayloadIdentity } from './AttemptPayloadIdentity.js';
import { validateFrameHeader } from './FrameHeaderValidation.js';

export { AttemptFrameError, type AttemptFrameErrorCode };
export {
  ATTEMPT_FRAME_MAX_BYTES,
  type AttemptTransportChannel,
} from './AttemptFrameLimits.js';

const PAYLOAD_HASH_DOMAIN = Buffer.from(
  'codestudio.agent.frame-payload.v1\0',
  'utf8',
);
const ENVELOPE_HASH_DOMAIN = Buffer.from(
  'codestudio.agent.frame-envelope.v1\0',
  'utf8',
);

export interface ValidatedOpaqueAttemptFrame {
  frame: agentV1Runtime.Frame;
  identity: agentV1Common.AttemptIdentity;
  protocolVersion: number;
  connectionId: string;
  messageId: string;
  payloadDigest: Uint8Array;
  envelopeDigest: Uint8Array;
}

export interface ValidatedAttemptFrame extends ValidatedOpaqueAttemptFrame {
  payload: agentV1Runtime.FramePayload;
}

export function framePayloadSha256(
  encodedPayload: Uint8Array,
): Uint8Array {
  return createHash('sha256')
    .update(PAYLOAD_HASH_DOMAIN)
    .update(encodedPayload)
    .digest();
}

export function frameEnvelopeSha256(
  encodedFrame: Uint8Array,
): Uint8Array {
  return createHash('sha256')
    .update(ENVELOPE_HASH_DOMAIN)
    .update(encodedFrame)
    .digest();
}

export function encodeAttemptFrame(
  header: agentV1Runtime.FrameHeader,
  channel: AttemptTransportChannel,
  payload: agentV1Runtime.FramePayload,
  negotiatedMaximum: number,
  capturePayloadDigest?: (digest: Uint8Array) => void,
): Uint8Array {
  assertAttemptChannel(channel);
  assertPayloadAllowed(channel, payload);
  const validatedHeader = validateFrameHeader(header);
  validatePayloadIdentity(payload, validatedHeader.identity);
  const encodedPayload = toBinary(
    agentV1Runtime.FramePayloadSchema,
    payload,
  );
  if (encodedPayload.byteLength === 0) {
    throw new AttemptFrameError(
      'empty_payload',
      'attempt frame payload cannot be empty',
    );
  }
  const payloadDigest = framePayloadSha256(encodedPayload);
  const encodedFrame = toBinary(
    agentV1Runtime.FrameSchema,
    create(agentV1Runtime.FrameSchema, {
      header: {
        ...header,
        payloadSha256: payloadDigest,
      },
      channel,
      encodedPayload,
    }),
  );
  assertAttemptFrameSize(
    encodedFrame,
    channel,
    negotiatedMaximum,
  );
  capturePayloadDigest?.(payloadDigest.slice());
  return encodedFrame;
}

export function validateAttemptFrame(
  encodedFrame: Uint8Array,
  expectedChannel: AttemptTransportChannel,
  negotiatedMaximum: number,
): ValidatedAttemptFrame {
  return decodeAttemptPayload(validateOpaqueAttemptFrame(
    encodedFrame,
    expectedChannel,
    negotiatedMaximum,
  ));
}

export function validateOpaqueAttemptFrame(
  encodedFrame: Uint8Array,
  expectedChannel: AttemptTransportChannel,
  negotiatedMaximum: number,
): ValidatedOpaqueAttemptFrame {
  assertAttemptChannel(expectedChannel);
  assertAttemptFrameSize(
    encodedFrame,
    expectedChannel,
    negotiatedMaximum,
  );

  let frame: agentV1Runtime.Frame;
  try {
    frame = fromBinary(agentV1Runtime.FrameSchema, encodedFrame);
  } catch (cause) {
    throw new AttemptFrameError(
      'malformed_frame',
      'attempt frame envelope is malformed',
      { cause },
    );
  }
  if (!frame.header) {
    throw new AttemptFrameError('missing_header', 'attempt frame header is required');
  }
  const validatedHeader = validateFrameHeader(frame.header);
  assertAttemptChannel(frame.channel);
  if (frame.channel !== expectedChannel) {
    throw new AttemptFrameError(
      'channel_mismatch',
      `frame channel ${frame.channel} does not match endpoint ${expectedChannel}`,
    );
  }
  if (frame.encodedPayload.byteLength === 0) {
    throw new AttemptFrameError(
      'empty_payload',
      'attempt frame payload cannot be empty',
    );
  }

  const expectedDigest = frame.header.payloadSha256;
  if (expectedDigest.byteLength !== 32) {
    throw new AttemptFrameError(
      'invalid_payload_digest',
      'attempt frame payload digest must contain 32 bytes',
    );
  }
  const actualDigest = framePayloadSha256(frame.encodedPayload);
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new AttemptFrameError(
      'payload_digest_mismatch',
      'attempt frame payload digest does not match its opaque bytes',
    );
  }

  return {
    frame,
    identity: validatedHeader.identity,
    protocolVersion: validatedHeader.protocolVersion,
    connectionId: validatedHeader.connectionId,
    messageId: validatedHeader.messageId,
    payloadDigest: actualDigest,
    envelopeDigest: frameEnvelopeSha256(encodedFrame),
  };
}

export function encodeBootstrapAttemptFrame(
  header: agentV1Runtime.FrameHeader,
  payload: agentV1Runtime.FramePayload,
  hardMaximum: number,
): Uint8Array {
  return encodeAttemptFrame(
    header,
    agentV1Runtime.TransportChannel.CONTROL,
    payload,
    hardMaximum,
  );
}

export function validateOpaqueBootstrapAttemptFrame(
  encodedFrame: Uint8Array,
  hardMaximum: number,
): ValidatedOpaqueAttemptFrame {
  return validateOpaqueAttemptFrame(
    encodedFrame,
    agentV1Runtime.TransportChannel.CONTROL,
    hardMaximum,
  );
}

export function decodeAttemptPayload(
  opaque: ValidatedOpaqueAttemptFrame,
): ValidatedAttemptFrame {
  let payload: agentV1Runtime.FramePayload;
  try {
    payload = fromBinary(
      agentV1Runtime.FramePayloadSchema,
      opaque.frame.encodedPayload,
    );
  } catch (cause) {
    throw new AttemptFrameError(
      'malformed_payload',
      'attempt frame payload is malformed',
      { cause },
    );
  }
  assertPayloadAllowed(
    opaque.frame.channel as AttemptTransportChannel,
    payload,
  );
  validatePayloadIdentity(payload, opaque.identity);
  return {
    ...opaque,
    payload,
  };
}
