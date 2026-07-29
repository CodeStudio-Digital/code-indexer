const encoding = vi.hoisted(() => ({
  calls: 0,
  outputs: [] as Uint8Array[],
}));

vi.mock('@bufbuild/protobuf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bufbuild/protobuf')>();
  return {
    ...actual,
    toBinary: vi.fn(() => encoding.outputs[encoding.calls++]!),
  };
});

import { create } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGEMENT_FRAME_MAX_BYTES,
  encodeManagementFrame,
} from '../ipc/ManagementFrame.js';

function header() {
  return create(agentV1Supervisor.ManagementFrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: 'connection:test',
    messageId: 'message:test',
    streamSeq: 1n,
    sentAtUnixMs: 2n,
  });
}

function payload() {
  return create(agentV1Supervisor.ManagementPayloadSchema, {
    body: {
      case: 'managementAck',
      value: {
        acknowledgedMessageId: 'message:prior',
        acknowledgedPayloadSha256: new Uint8Array(32),
        acknowledgedAtUnixMs: 3n,
      },
    },
  });
}

describe('management frame encoding scrub', () => {
  beforeEach(() => {
    encoding.calls = 0;
    encoding.outputs = [];
  });

  it('scrubs the temporary encoded payload after successful encoding', () => {
    const encodedPayload = Uint8Array.of(1, 2, 3);
    const encodedFrame = Uint8Array.of(4, 5, 6);
    encoding.outputs = [encodedPayload, encodedFrame];

    expect(encodeManagementFrame(header(), payload())).toBe(encodedFrame);
    expect(encodedPayload).toEqual(new Uint8Array(3));
    expect(encodedFrame).toEqual(Uint8Array.of(4, 5, 6));
  });

  it('scrubs payload and oversized frame allocations on failure', () => {
    const encodedPayload = Uint8Array.of(1, 2, 3);
    const encodedFrame = new Uint8Array(MANAGEMENT_FRAME_MAX_BYTES + 1);
    encodedFrame.fill(7);
    encoding.outputs = [encodedPayload, encodedFrame];

    expect(() => encodeManagementFrame(header(), payload())).toThrow(
      expect.objectContaining({ code: 'frame_too_large' }),
    );
    expect(encodedPayload).toEqual(new Uint8Array(3));
    expect(encodedFrame.every((value) => value === 0)).toBe(true);
  });
});
