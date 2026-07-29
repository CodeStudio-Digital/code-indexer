import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  RunnerEndpointProvisioning,
  RunnerEndpointsReadySchema,
  RunnerLaunchHandoffSchema,
  RunnerListenerSlot,
} from '../generated/v1/codestudio/agent/v1/runner_bootstrap_pb.js';
import { agentV1RunnerBootstrap } from '../index.js';
import {
  goldenRunnerEndpointsReady,
  goldenRunnerLaunchHandoff,
  goldenUnixRunnerLaunchHandoff,
} from './support/runner-bootstrap-golden.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const handoffGoldenHex = readFileSync(
  resolve(packageRoot, 'fixtures/v1/runner-launch-handoff.hex'),
  'utf8',
).trim();
const unixHandoffGoldenHex = readFileSync(
  resolve(packageRoot, 'fixtures/v1/runner-launch-handoff-unix.hex'),
  'utf8',
).trim();
const readyGoldenHex = readFileSync(
  resolve(packageRoot, 'fixtures/v1/runner-endpoints-ready.hex'),
  'utf8',
).trim();
const handoffHashDomain = Buffer.from(
  'codestudio.agent.runner-launch-handoff.v1\0',
  'utf8',
);

describe('runner bootstrap wire compatibility', () => {
  it('encodes the shared launch handoff byte-for-byte', () => {
    const encoded = toBinary(
      RunnerLaunchHandoffSchema,
      goldenRunnerLaunchHandoff(),
    );

    expect(Buffer.from(encoded).toString('hex')).toBe(handoffGoldenHex);
    expect(encoded).toHaveLength(777);
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(
      '556814481687ff02e1e750a7e0df7c112f3f775afd61493a6fd85d0c98b8b55d',
    );
  });

  it('preserves opaque authority, uint64 budgets and endpoint provisioning', () => {
    const decoded = fromBinary(
      RunnerLaunchHandoffSchema,
      Buffer.from(handoffGoldenHex, 'hex'),
    );

    expect(decoded.identity?.fencingEpoch).toBe(9_007_199_254_740_993n);
    expect(decoded.reservedResourceBudget?.hardMemoryBytes).toBe(536_870_912n);
    expect(decoded.endpoints).toHaveLength(3);
    expect(decoded.endpoints[0]?.provisioning).toBe(
      RunnerEndpointProvisioning.WINDOWS_CREATE_NAMED_PIPE,
    );
  });

  it('hashes the exact original handoff bytes with the V1 domain', () => {
    const digest = createHash('sha256')
      .update(handoffHashDomain)
      .update(Buffer.from(handoffGoldenHex, 'hex'))
      .digest('hex');

    expect(digest).toBe(
      '807193088d6ac318c4ab3c76790b1417fbcb5ba931330cabb2163ec110aebb6b',
    );
  });

  it('encodes the shared Unix listener handoff byte-for-byte', () => {
    const encoded = toBinary(
      RunnerLaunchHandoffSchema,
      goldenUnixRunnerLaunchHandoff(),
    );
    const decoded = fromBinary(RunnerLaunchHandoffSchema, encoded);

    expect(Buffer.from(encoded).toString('hex')).toBe(unixHandoffGoldenHex);
    expect(decoded.endpoints[0]?.provisioning).toBe(
      RunnerEndpointProvisioning.UNIX_RECEIVE_BOUND_SOCKET,
    );
    expect(decoded.endpoints.map(({ listenerSlot }) => listenerSlot)).toEqual([
      RunnerListenerSlot.CONTROL,
      RunnerListenerSlot.DATA,
      RunnerListenerSlot.RUNNER_PULSE,
    ]);
    expect(decoded.expectedHostPeer?.unixUserId).toBe(1_000);
    expect(decoded.expectedSupervisorPeer?.unixUserId).toBe(1_000);
  });

  it('encodes the shared endpoints-ready acknowledgement byte-for-byte', () => {
    const encoded = toBinary(
      RunnerEndpointsReadySchema,
      goldenRunnerEndpointsReady(),
    );
    const decoded = fromBinary(RunnerEndpointsReadySchema, encoded);

    expect(Buffer.from(encoded).toString('hex')).toBe(readyGoldenHex);
    expect(Buffer.from(decoded.acknowledgedHandoffSha256)).toEqual(
      Buffer.from(
        '807193088d6ac318c4ab3c76790b1417fbcb5ba931330cabb2163ec110aebb6b',
        'hex',
      ),
    );
    expect(decoded.endpoints).toHaveLength(3);
  });

  it('exports both bootstrap schemas through the package root', () => {
    expect(agentV1RunnerBootstrap.RunnerLaunchHandoffSchema.typeName).toBe(
      'codestudio.agent.v1.RunnerLaunchHandoff',
    );
    expect(agentV1RunnerBootstrap.RunnerEndpointsReadySchema.typeName).toBe(
      'codestudio.agent.v1.RunnerEndpointsReady',
    );
  });

  it('binds acknowledgements to exact original bytes, including unknown fields', () => {
    const original = Buffer.concat([
      Buffer.from(handoffGoldenHex, 'hex'),
      Buffer.from([0x98, 0x06, 0x07]), // field 99, varint 7
    ]);
    const decoded = fromBinary(RunnerLaunchHandoffSchema, original);
    const normalized = toBinary(RunnerLaunchHandoffSchema, decoded, {
      writeUnknownFields: false,
    });
    const originalDigest = createHash('sha256')
      .update(handoffHashDomain)
      .update(original)
      .digest('hex');
    const normalizedDigest = createHash('sha256')
      .update(handoffHashDomain)
      .update(normalized)
      .digest('hex');

    expect(Buffer.from(normalized)).toEqual(
      Buffer.from(handoffGoldenHex, 'hex'),
    );
    expect(originalDigest).toBe(
      '27bccbfd8cc7e4d7346bfc3829647926f3e7b4565811c06f154925a28159bb07',
    );
    expect(originalDigest).not.toBe(normalizedDigest);
  });
});
