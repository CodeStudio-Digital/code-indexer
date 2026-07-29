import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  MANAGEMENT_FRAME_MAX_BYTES,
  ManagementFrameError,
  encodeManagementFrame,
  managementEnvelopeSha256,
  managementPayloadSha256,
  validateManagementFrame,
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

function rawFrame(
  encodedPayload: Uint8Array,
  digest = managementPayloadSha256(encodedPayload),
) {
  return toBinary(
    agentV1Supervisor.ManagementFrameSchema,
    create(agentV1Supervisor.ManagementFrameSchema, {
      header: { ...header(), payloadSha256: digest },
      encodedPayload,
    }),
  );
}

function expectCode(
  action: () => unknown,
  code: ManagementFrameError['code'],
) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe('management frame validation', () => {
  it('uses the normative management payload hash domain', () => {
    expect(
      Buffer.from(managementPayloadSha256(Uint8Array.of(1, 2, 3)))
        .toString('hex'),
    ).toBe(
      '7c6f63d43016b28b39ea3e8bd4fa78dae1b6f4bd20bd5eb2af79659a1ade8977',
    );
  });

  it('uses the normative management envelope hash domain', () => {
    expect(
      Buffer.from(managementEnvelopeSha256(Uint8Array.of(1, 2, 3)))
        .toString('hex'),
    ).toBe(
      'f4625155bdc4559d509f5abdd9745e430624b96f2c921ee31cdf2a0d968aa7ab',
    );
  });

  it('round-trips an allowed management payload', () => {
    const bytes = encodeManagementFrame(header(), payload());
    const validated = validateManagementFrame(bytes);

    expect(validated.payload.body.case).toBe('managementAck');
    expect(validated.frame.header?.payloadSha256).toHaveLength(32);
  });

  it('hashes original bytes and accepts unknown payload fields', () => {
    const opaquePayload = Uint8Array.from([
      ...toBinary(agentV1Supervisor.ManagementPayloadSchema, payload()),
      0x98,
      0x06,
      0x07,
    ]);
    const validated = validateManagementFrame(rawFrame(opaquePayload));

    expect(validated.frame.encodedPayload).toEqual(opaquePayload);
    expect(validated.payload.body.case).toBe('managementAck');
  });

  it('rejects payload mutation and invalid digest lengths', () => {
    const encodedPayload = toBinary(
      agentV1Supervisor.ManagementPayloadSchema,
      payload(),
    );
    const digest = managementPayloadSha256(encodedPayload);
    encodedPayload[encodedPayload.byteLength - 1] ^= 1;
    expectCode(
      () => validateManagementFrame(rawFrame(encodedPayload, digest)),
      'payload_digest_mismatch',
    );

    expectCode(
      () => validateManagementFrame(
        rawFrame(
          toBinary(agentV1Supervisor.ManagementPayloadSchema, payload()),
          new Uint8Array(31),
        ),
      ),
      'invalid_payload_digest',
    );
  });

  it('rejects empty and oversized envelopes before protobuf decode', () => {
    expectCode(
      () => validateManagementFrame(new Uint8Array()),
      'empty_frame',
    );
    expectCode(
      () => validateManagementFrame(
        new Uint8Array(MANAGEMENT_FRAME_MAX_BYTES + 1),
      ),
      'frame_too_large',
    );
  });

  it('rejects malformed envelopes and payloads without throwing raw errors', () => {
    expectCode(
      () => validateManagementFrame(Uint8Array.of(0xff)),
      'malformed_frame',
    );
    expectCode(
      () => validateManagementFrame(rawFrame(Uint8Array.of(0xff))),
      'malformed_payload',
    );
  });

  it('rejects missing headers, empty payloads and missing oneof bodies', () => {
    const missingHeader = toBinary(
      agentV1Supervisor.ManagementFrameSchema,
      create(agentV1Supervisor.ManagementFrameSchema, {
        encodedPayload: toBinary(
          agentV1Supervisor.ManagementPayloadSchema,
          payload(),
        ),
      }),
    );
    expectCode(
      () => validateManagementFrame(missingHeader),
      'missing_header',
    );

    expectCode(
      () => validateManagementFrame(
        rawFrame(new Uint8Array(), managementPayloadSha256(new Uint8Array())),
      ),
      'empty_payload',
    );

    const unknownOnly = Uint8Array.of(0x98, 0x06, 0x07);
    expectCode(
      () => validateManagementFrame(rawFrame(unknownOnly)),
      'missing_payload_body',
    );
  });

  it('rejects encoding a payload outside the management oneof allowlist', () => {
    expectCode(
      () => encodeManagementFrame(
        header(),
        create(agentV1Supervisor.ManagementPayloadSchema),
      ),
      'missing_payload_body',
    );
  });
});
