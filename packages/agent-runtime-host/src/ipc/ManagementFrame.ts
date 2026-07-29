import { createHash, timingSafeEqual } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { scrubManagementPayload } from './ManagementPayloadScrub.js';

const PAYLOAD_HASH_DOMAIN = Buffer.from(
  'codestudio.agent.management-payload.v1\0',
  'utf8',
);
const ENVELOPE_HASH_DOMAIN = Buffer.from(
  'codestudio.agent.management-envelope.v1\0',
  'utf8',
);

export const MANAGEMENT_FRAME_MAX_BYTES = 64 * 1024;

export type ManagementFrameErrorCode =
  | 'empty_frame'
  | 'frame_too_large'
  | 'malformed_frame'
  | 'missing_header'
  | 'empty_payload'
  | 'invalid_payload_digest'
  | 'payload_digest_mismatch'
  | 'malformed_payload'
  | 'missing_payload_body';

export class ManagementFrameError extends Error {
  constructor(
    readonly code: ManagementFrameErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagementFrameError';
  }
}

export interface ValidatedManagementFrame {
  frame: agentV1Supervisor.ManagementFrame;
  payload: agentV1Supervisor.ManagementPayload;
}

export function managementPayloadSha256(
  encodedPayload: Uint8Array,
): Uint8Array {
  return createHash('sha256')
    .update(PAYLOAD_HASH_DOMAIN)
    .update(encodedPayload)
    .digest();
}

export function managementEnvelopeSha256(
  encodedFrame: Uint8Array,
): Uint8Array {
  return createHash('sha256')
    .update(ENVELOPE_HASH_DOMAIN)
    .update(encodedFrame)
    .digest();
}

export function encodeManagementFrame(
  header: agentV1Supervisor.ManagementFrameHeader,
  payload: agentV1Supervisor.ManagementPayload,
): Uint8Array {
  assertPayloadBody(payload);
  let encodedPayload: Uint8Array | undefined;
  let encodedFrame: Uint8Array | undefined;
  try {
    encodedPayload = toBinary(
      agentV1Supervisor.ManagementPayloadSchema,
      payload,
    );
    encodedFrame = toBinary(
      agentV1Supervisor.ManagementFrameSchema,
      create(agentV1Supervisor.ManagementFrameSchema, {
        header: {
          ...header,
          payloadSha256: managementPayloadSha256(encodedPayload),
        },
        encodedPayload,
      }),
    );
    assertFrameSize(encodedFrame);
    return encodedFrame;
  } catch (cause) {
    encodedFrame?.fill(0);
    throw cause;
  } finally {
    encodedPayload?.fill(0);
  }
}

/**
 * Bounds the original envelope before protobuf decoding, then verifies the
 * opaque payload integrity before decoding the management-only oneof.
 * Connection authentication is handled separately by the handshake.
 */
export function validateManagementFrame(
  encodedFrame: Uint8Array,
): ValidatedManagementFrame {
  assertFrameSize(encodedFrame);

  let frame: agentV1Supervisor.ManagementFrame;
  try {
    frame = fromBinary(
      agentV1Supervisor.ManagementFrameSchema,
      encodedFrame,
    );
  } catch (cause) {
    throw new ManagementFrameError(
      'malformed_frame',
      'management frame envelope is malformed',
      { cause },
    );
  }
  let actualDigest: Uint8Array | undefined;
  let payload: agentV1Supervisor.ManagementPayload | undefined;
  let succeeded = false;
  try {
    if (!frame.header) {
      throw new ManagementFrameError(
        'missing_header',
        'management frame header is required',
      );
    }
    if (frame.encodedPayload.byteLength === 0) {
      throw new ManagementFrameError(
        'empty_payload',
        'management frame payload cannot be empty',
      );
    }
    const expectedDigest = frame.header.payloadSha256;
    if (expectedDigest.byteLength !== 32) {
      throw new ManagementFrameError(
        'invalid_payload_digest',
        'management payload digest must contain 32 bytes',
      );
    }
    actualDigest = managementPayloadSha256(frame.encodedPayload);
    if (!timingSafeEqual(expectedDigest, actualDigest)) {
      throw new ManagementFrameError(
        'payload_digest_mismatch',
        'management payload digest does not match its opaque bytes',
      );
    }
    payload = fromBinary(
      agentV1Supervisor.ManagementPayloadSchema,
      frame.encodedPayload,
    );
    assertPayloadBody(payload);
    succeeded = true;
    return { frame, payload };
  } catch (cause) {
    if (cause instanceof ManagementFrameError) throw cause;
    throw new ManagementFrameError(
      'malformed_payload',
      'management frame payload is malformed',
      { cause },
    );
  } finally {
    actualDigest?.fill(0);
    if (!succeeded) {
      frame.header?.payloadSha256.fill(0);
      frame.encodedPayload.fill(0);
      scrubManagementPayload(payload);
    }
  }
}

function assertFrameSize(encodedFrame: Uint8Array): void {
  if (encodedFrame.byteLength === 0) {
    throw new ManagementFrameError(
      'empty_frame',
      'management frame cannot be empty',
    );
  }
  if (encodedFrame.byteLength > MANAGEMENT_FRAME_MAX_BYTES) {
    throw new ManagementFrameError(
      'frame_too_large',
      `management frame has ${encodedFrame.byteLength} bytes; maximum is ${MANAGEMENT_FRAME_MAX_BYTES}`,
    );
  }
}

function assertPayloadBody(
  payload: agentV1Supervisor.ManagementPayload,
): void {
  if (payload.body.case === undefined) {
    throw new ManagementFrameError(
      'missing_payload_body',
      'management payload body is required',
    );
  }
}
