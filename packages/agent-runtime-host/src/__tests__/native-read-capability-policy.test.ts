import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativeReadCapabilityGatewayFactory,
} from '../capability-gateway/NativeReadCapabilityPolicy.js';
import type {
  NativeReadCapabilityPolicyOptions,
} from '../capability-gateway/NativeReadCapabilityPolicyTypes.js';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { identity } from './attempt-channel-support.js';

const NOW = 10_000n;
const RUNTIME = 'runtime/native-read-policy';
const CAPABILITY_SET = new Uint8Array(32).fill(7);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('native read capability product policy', () => {
  it('seals the exact hydrated catalog, canonical root, lease and quotas', async () => {
    const root = await temporaryRoot();
    const gateway = factory(root)(context(), clock());

    const update = await gateway.prepare(prepare());

    expect(update.decision.case).toBe('accepted');
    if (update.decision.case !== 'accepted') throw new Error('grant expected');
    expect(update.decision.value).toMatchObject({
      capabilityId: 'native.read_file',
      capabilityVersion: '1',
      environmentId: 'environment/local',
      environmentVersion: 2n,
      workspaceLeaseId: 'lease/workspace',
      workspaceLeaseVersion: 3n,
      workspaceFencingEpoch: 4n,
      resourceBindingId: 'workspace/root',
      policyVersion: 'native-read/v1',
      issuedAtUnixMs: NOW,
      expiresAtUnixMs: NOW + 500n,
      nativeFilesystemRead: {
        canonicalRootPath: await realpath(root),
        maxReadBytes: 64n * 1024n,
        maxOutputBytes: 72n * 1024n,
        requireUtf8: true,
      },
    });
    expect(update.decision.value.nonce).toHaveLength(32);
  });

  it('rejects a descriptor-set mismatch without granting filesystem authority', async () => {
    const root = await temporaryRoot();
    const gateway = factory(root)(context(), clock());
    const request = prepare();
    request.capabilitySetSha256 = new Uint8Array(32).fill(9);

    const update = await gateway.prepare(request);

    expect(update.decision.case).toBe('rejected');
    if (update.decision.case !== 'rejected') throw new Error('rejection expected');
    expect(update.decision.value.reasonCode).toBe('native_read_not_authorized');
  });

  it('fails closed when the trusted root cannot be canonicalized', async () => {
    const root = join(await temporaryRoot(), 'missing');
    const gateway = factory(root)(context(), clock());

    const update = await gateway.prepare(prepare());

    expect(update.decision.case).toBe('rejected');
    if (update.decision.case !== 'rejected') throw new Error('rejection expected');
    expect(update.decision.value.reasonCode).toBe('native_read_root_unavailable');
  });
});

function factory(rootPath: string) {
  const options: NativeReadCapabilityPolicyOptions = {
    rootPath,
    capabilitySetSha256: CAPABILITY_SET,
    environmentId: 'environment/local',
    environmentVersion: 2n,
    workspaceLease: {
      id: 'lease/workspace',
      version: 3n,
      fencingEpoch: 4n,
    },
    resourceBindingId: 'workspace/root',
    policyVersion: 'native-read/v1',
    grantTtlMs: 500n,
    maxReadBytes: 64n * 1024n,
    maxOutputBytes: 72n * 1024n,
    requireUtf8: true,
  };
  return createNativeReadCapabilityGatewayFactory(options);
}

function prepare(): agentV1Capability.CapabilityPrepare {
  const encodedJsonInput = new TextEncoder().encode('{"path":"sample.txt"}');
  return create(agentV1Capability.CapabilityPrepareSchema, {
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    operationId: 'capability/read/1',
    providerOperationId: 'provider/1',
    toolUseId: 'tool/1',
    capabilityId: 'native.read_file',
    capabilityVersion: '1',
    executionClass: agentV1Capability.CapabilityExecutionClass.NATIVE_READ,
    encodedJsonInput,
    inputSha256: createHash('sha256').update(encodedJsonInput).digest(),
    capabilitySetSha256: CAPABILITY_SET,
    idempotencyKey: 'prepare/read/1',
    deadlineAtUnixMs: NOW + 1_000n,
  });
}

function context(): HostDataBoundContext {
  return Object.freeze({
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    limits: create(agentV1Common.FrameLimitsSchema, {
      maxFrameBytes: 64n * 1024n,
      maxChunkBytes: 32n * 1024n,
      maxInFlightFrames: 1n,
      maxInFlightBytes: 64n * 1024n,
      readTimeoutMs: 1_000n,
      writeTimeoutMs: 1_000n,
    }),
    timeoutMs: 1_000,
  });
}

function clock() {
  return createAuthorityClockForTesting(() => NOW);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'native-read-policy-'));
  roots.push(root);
  return root;
}
