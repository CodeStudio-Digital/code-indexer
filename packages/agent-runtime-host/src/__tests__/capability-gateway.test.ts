import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { identity } from './attempt-channel-support.js';

const NOW = 10_000n;
const RUNTIME = 'runtime/capability';

describe('CapabilityGateway', () => {
  it('returns and replays a bounded rejection without resolving policy twice', async () => {
    const resolve = vi.fn(async () => ({
      case: 'rejected' as const,
      value: create(agentV1Capability.CapabilityRejectedSchema, {
        decisionId: 'decision/deny/1',
        reasonCode: 'policy_denied',
        policyVersion: 'policy/v1',
        decidedAtUnixMs: NOW,
      }),
    }));
    const gateway = new CapabilityGateway(context(), { resolve }, () => NOW);
    const request = prepare();

    const first = await gateway.prepare(request);
    const replay = await gateway.prepare(request);

    expect(first.decision.case).toBe('rejected');
    expect(replay).toBe(first);
    expect(resolve).toHaveBeenCalledOnce();
    expect(gateway.preparedOperationCount).toBe(1);
  });

  it('fails closed when an operation replay changes its input', async () => {
    const gateway = rejectingGateway();
    await gateway.prepare(prepare());
    const divergent = prepare({ encodedJsonInput: new TextEncoder().encode('{"path":"b"}') });
    divergent.inputSha256 = digest(divergent.encodedJsonInput);

    expect(() => gateway.prepare(divergent)).toThrow(/replay diverged/);
  });

  it('accepts only a grant sealed to the exact invocation and deadline', async () => {
    const request = prepare();
    const gateway = new CapabilityGateway(context(), {
      async resolve(value) {
        const readBinding = create(
          agentV1Capability.NativeFilesystemReadBindingSchema,
          {
            canonicalRootPath: process.cwd(),
            maxReadBytes: 64n * 1024n,
            maxOutputBytes: 64n * 1024n,
            requireUtf8: true,
          },
        );
        return {
          case: 'accepted',
          value: create(agentV1Capability.SealedExecutionGrantSchema, {
            grantId: 'grant/1',
            decisionId: 'decision/allow/1',
            capabilityId: value.capabilityId,
            capabilityVersion: value.capabilityVersion,
            operationId: value.operationId,
            toolUseId: value.toolUseId,
            effectiveInputSha256: value.inputSha256,
            executionClass: value.executionClass,
            mutates: value.mutates,
            environmentId: 'environment/local',
            environmentVersion: 1n,
            workspaceLeaseId: 'lease/1',
            workspaceLeaseVersion: 2n,
            workspaceFencingEpoch: 3n,
            resourceBindingId: 'binding/1',
            constraintsSha256: digest(toBinary(
              agentV1Capability.NativeFilesystemReadBindingSchema,
              readBinding,
            )),
            policyVersion: 'policy/v1',
            nonce: new Uint8Array(32).fill(5),
            issuedAtUnixMs: NOW,
            expiresAtUnixMs: NOW + 500n,
            nativeFilesystemRead: readBinding,
          }),
        };
      },
    }, () => NOW);

    const update = await gateway.prepare(request);

    expect(update.decision.case).toBe('accepted');
    expect(update.operationId).toBe(request.operationId);
  });

  it('rejects corrupt, expired, or non-JSON prepare input before policy', () => {
    const resolve = vi.fn();
    const gateway = new CapabilityGateway(context(), { resolve }, () => NOW);
    const corrupt = prepare({ encodedJsonInput: new Uint8Array([0xff]) });

    expect(() => gateway.prepare(corrupt)).toThrow(/authority|UTF-8 JSON/);
    expect(() => gateway.prepare(prepare({ deadlineAtUnixMs: NOW }))).toThrow(/authority/);
    expect(resolve).not.toHaveBeenCalled();
  });
});

function rejectingGateway(): CapabilityGateway {
  return new CapabilityGateway(context(), {
    async resolve() {
      return {
        case: 'rejected',
        value: create(agentV1Capability.CapabilityRejectedSchema, {
          decisionId: 'decision/deny/1',
          reasonCode: 'policy_denied',
          policyVersion: 'policy/v1',
          decidedAtUnixMs: NOW,
        }),
      };
    },
  }, () => NOW);
}

function prepare(
  overrides: Partial<Omit<
    agentV1Capability.CapabilityPrepare,
    '$typeName' | '$unknown'
  >> = {},
): agentV1Capability.CapabilityPrepare {
  const encodedJsonInput = overrides.encodedJsonInput
    ?? new TextEncoder().encode('{"path":"a"}');
  return create(agentV1Capability.CapabilityPrepareSchema, {
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    operationId: 'capability/tool/1',
    providerOperationId: 'provider/1',
    toolUseId: 'tool/1',
    capabilityId: 'native.read_file',
    capabilityVersion: '1',
    executionClass: agentV1Capability.CapabilityExecutionClass.NATIVE_READ,
    encodedJsonInput,
    inputSha256: digest(encodedJsonInput),
    capabilitySetSha256: new Uint8Array(32).fill(3),
    idempotencyKey: 'capability-prepare/tool/1',
    deadlineAtUnixMs: NOW + 1_000n,
    ...overrides,
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

function digest(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}
