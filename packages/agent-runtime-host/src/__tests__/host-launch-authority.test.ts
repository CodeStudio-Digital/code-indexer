import { inspect } from 'node:util';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BINARY_SHA256,
  BUILD_ID,
  CONNECTION,
  CONNECTION_TOKEN,
  MAXIMUM,
  NONCE,
  SOURCE_COMMIT,
  provisionLaunch,
  resourceBudget,
} from './attempt-channel-support.js';
import {
  createAuthorityClockForTesting,
} from '../ipc/AttemptClock.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  createHostBootstrapAttemptChannelForTesting,
} from '../ipc/HostBootstrapAttemptChannel.js';
import type { HostLaunchBinding } from '../ipc/HostLaunchAuthority.js';

function transport(): DelimitedByteChannel {
  return new DelimitedByteChannel(
    new PassThrough(),
    new PassThrough(),
    { maximumFrameBytes: MAXIMUM },
  );
}

function bootstrap(
  launch: HostLaunchBinding,
) {
  return createHostBootstrapAttemptChannelForTesting(
    { launch },
    createAuthorityClockForTesting(() => 10n),
  );
}

describe('host launch authority', () => {
  it('mints an opaque receipt with no inspectable launch secret', () => {
    const launch = provisionLaunch(transport());

    expect(Object.keys(launch)).toEqual([]);
    const rendered = inspect(launch, { showHidden: true });
    expect(rendered).not.toContain(CONNECTION);
    expect(rendered).not.toContain(Buffer.from(NONCE).toString('hex'));
    expect(rendered).not.toContain(
      Buffer.from(CONNECTION_TOKEN).toString('hex'),
    );
  });

  it('rejects forged and already consumed launch receipts', () => {
    expect(
      () => bootstrap({} as never),
    ).toThrow(expect.objectContaining({ code: 'invalid_launch_binding' }));

    const launch = provisionLaunch(transport());
    const first = bootstrap(launch);
    expect(
      () => bootstrap(launch),
    ).toThrow(expect.objectContaining({ code: 'launch_binding_consumed' }));
    first.abort();
  });

  it.each([
    [
      { expectedLaunchNonce: new Uint8Array(15) },
      'invalid_expected_nonce',
    ],
    [
      { expectedConnectionSessionToken: new Uint8Array(15) },
      'invalid_expected_connection_token',
    ],
    [
      {
        expectedProvenance: {
          buildId: BUILD_ID,
          sourceCommit: SOURCE_COMMIT,
          binarySha256: new Uint8Array(31),
          pid: 42,
          operatingSystem: 'windows',
          architecture: 'x86_64',
        },
      },
      'invalid_expected_provenance',
    ],
    [
      {
        expectedProvenance: {
          buildId: BUILD_ID,
          sourceCommit: SOURCE_COMMIT,
          binarySha256: BINARY_SHA256,
          pid: 0,
          operatingSystem: 'windows',
          architecture: 'x86_64',
        },
      },
      'invalid_expected_provenance',
    ],
    [
      { hardDeadlineAtUnixMs: 0n },
      'invalid_hard_deadline',
    ],
    [
      { resourceBudget: resourceBudget({ maxIpcFrames: 0 }) },
      'invalid_resource_budget',
    ],
    [
      { validateAgentHello: undefined as never },
      'invalid_expected_provenance',
    ],
    [
      {
        heartbeatPolicy: {
          intervalMs: 0n,
          timeoutMs: 5_000n,
        },
      },
      'invalid_heartbeat_policy',
    ],
    [
      {
        heartbeatPolicy: {
          intervalMs: 5_000n,
          timeoutMs: 5_000n,
        },
      },
      'invalid_heartbeat_policy',
    ],
    [
      {
        featurePolicy: {
          allowedFeatureBits: 0b01n,
          requiredFeatureBits: 0b10n,
        },
      },
      'invalid_feature_policy',
    ],
  ])('rejects invalid sealed launch facts %#', (overrides, code) => {
    expect(
      () => provisionLaunch(transport(), overrides),
    ).toThrow(expect.objectContaining({ code }));
  });
});
