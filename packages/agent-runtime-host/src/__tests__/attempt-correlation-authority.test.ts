import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  AttemptCorrelationAuthority,
} from '../ipc/AttemptCorrelationAuthority.js';

const DIGEST = Uint8Array.from(
  { length: 32 },
  (_value, index) => index,
);

function ack(
  acknowledgedMessageId: string,
  digest: Uint8Array,
  acknowledgedAtUnixMs: bigint,
) {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'ack',
      value: {
        acknowledgedMessageId,
        acknowledgedPayloadSha256: digest,
        acknowledgedAtUnixMs,
      },
    },
  });
}

function authority(): AttemptCorrelationAuthority {
  const value = new AttemptCorrelationAuthority(4);
  const request = create(agentV1Runtime.FramePayloadSchema, {
    body: { case: 'activateAttempt', value: {} },
  });
  value.registerNew(
    'activate-request',
    value.captureNew(request),
    DIGEST,
    100n,
  );
  return value;
}

function prepareRequest(expectedSpecSha256 = DIGEST) {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'prepareAttempt',
      value: { expectedSpecSha256 },
    },
  });
}

function prepared(
  specSha256 = DIGEST,
  readyAtUnixMs = 15n,
) {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'attemptPrepared',
      value: {
        runtimeInstanceId: 'runtime',
        specSha256,
        readyAtUnixMs,
      },
    },
  });
}

function bindRequest() {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'bindAttemptChannel',
      value: { runtimeInstanceId: 'runtime' },
    },
  });
}

function bound(boundAtUnixMs: bigint) {
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'attemptChannelBound',
      value: {
        runtimeInstanceId: 'runtime',
        channel: agentV1Runtime.TransportChannel.DATA,
        boundAtUnixMs,
      },
    },
  });
}

describe('attempt correlation authority', () => {
  it('authenticates Ack identity, payload digest, and timestamp', () => {
    expect(() => authority().validateInbound(
      ack('activate-request', DIGEST, 110n),
      'activate-request',
      120n,
    )).not.toThrow();
  });

  it.each([
    [ack('other-request', DIGEST, 110n), 120n],
    [ack('activate-request', new Uint8Array(32), 110n), 120n],
    [ack('activate-request', DIGEST, 49n), 120n],
    [ack('activate-request', DIGEST, 171n), 120n],
  ])('rejects forged Ack facts %#', (payload, observedAtUnixMs) => {
    expect(() => authority().validateInbound(
      payload,
      'activate-request',
      observedAtUnixMs,
    )).toThrow(expect.objectContaining({ code: 'correlation_mismatch' }));
  });

  it('requires response payloads to reference a compatible request', () => {
    const value = new AttemptCorrelationAuthority(4);
    value.registerNew(
      'prepare-request',
      value.captureNew(prepareRequest()),
      DIGEST,
      10n,
    );

    expect(() => value.validateInbound(
      ack('prepare-request', DIGEST, 15n),
      'prepare-request',
      20n,
    )).toThrow(expect.objectContaining({ code: 'correlation_mismatch' }));
    expect(() => value.validateInbound(
      prepared(),
      'prepare-request',
      20n,
    )).not.toThrow();
  });

  it('accepts only bounded local peer clock skew for Data bind', () => {
    const value = new AttemptCorrelationAuthority(4);
    value.registerNew(
      'bind-request',
      value.captureNew(bindRequest()),
      DIGEST,
      100n,
    );

    expect(() => value.validateInbound(
      bound(99n),
      'bind-request',
      100n,
    )).not.toThrow();
    expect(() => value.validateInbound(
      bound(49n),
      'bind-request',
      100n,
    )).toThrow(expect.objectContaining({ code: 'correlation_mismatch' }));
    expect(() => value.validateInbound(
      bound(151n),
      'bind-request',
      100n,
    )).toThrow(expect.objectContaining({ code: 'correlation_mismatch' }));
  });

  it.each([
    [prepared(new Uint8Array(32), 15n), 20n],
    [prepared(DIGEST, 9n), 20n],
    [prepared(DIGEST, 21n), 20n],
  ])('rejects forged AttemptPrepared facts %#', (payload, observedAtUnixMs) => {
    const value = new AttemptCorrelationAuthority(4);
    value.registerNew(
      'prepare-request',
      value.captureNew(prepareRequest()),
      DIGEST,
      10n,
    );

    expect(() => value.validateInbound(
      payload,
      'prepare-request',
      observedAtUnixMs,
    )).toThrow(expect.objectContaining({ code: 'correlation_mismatch' }));
  });
});
