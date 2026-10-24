import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';
import type { HostCapabilityExecutor } from '../capability-gateway/CapabilityGatewayTypes.js';
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
    await expect(gateway.execute(execute(request, 'grant/1')))
      .rejects.toThrow(/authority is invalid/);
  });

  it('rejects corrupt, expired, or non-JSON prepare input before policy', () => {
    const resolve = vi.fn();
    const gateway = new CapabilityGateway(context(), { resolve }, () => NOW);
    const corrupt = prepare({ encodedJsonInput: new Uint8Array([0xff]) });

    expect(() => gateway.prepare(corrupt)).toThrow(/authority|UTF-8 JSON/);
    expect(() => gateway.prepare(prepare({ deadlineAtUnixMs: NOW }))).toThrow(/authority/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('executes an accepted Host capability exactly once across request replay', async () => {
    const executeHost = vi.fn(async () => ({
      case: 'succeeded' as const,
      schemaId: 'test.host-result.v1',
      schemaVersion: 1,
      encodedResult: new TextEncoder().encode('{"ok":true}'),
      bytesRead: 11n,
      truncated: false,
      durationMs: 2n,
    }));
    const { gateway, request, grantId } = hostGateway(executeHost);
    await gateway.prepare(request);
    const execution = execute(request, grantId);

    const first = await gateway.execute(execution);
    const replay = await gateway.execute(execution);

    expect(first.outcome.case).toBe('succeeded');
    expect(replay).toBe(first);
    expect(executeHost).toHaveBeenCalledOnce();
    expect(gateway.executedOperationCount).toBe(1);
  });

  it('terminalizes a post-start Host executor exception as outcome unknown', async () => {
    const { gateway, request, grantId } = hostGateway(async () => {
      throw new Error('result transport lost after effect');
    });
    await gateway.prepare(request);

    const result = await gateway.execute(execute(request, grantId));

    expect(result.outcome.case).toBe('outcomeUnknown');
    if (result.outcome.case === 'outcomeUnknown') {
      expect(result.outcome.value.reasonCode).toBe('host_executor_result_ambiguous');
    }
  });

  it('rejects execution after the sealed Host grant expires', async () => {
    let observedAt = NOW;
    const executeHost = vi.fn(async () => ({
      case: 'failed' as const,
      reasonCode: 'must_not_execute',
      durationMs: 0n,
    }));
    const { gateway, request, grantId } = hostGateway(
      executeHost,
      () => observedAt,
    );
    await gateway.prepare(request);
    observedAt = NOW + 500n;

    await expect(gateway.execute(execute(request, grantId)))
      .rejects.toThrow(/authority is invalid/);
    expect(executeHost).not.toHaveBeenCalled();
  });

  it('releases large terminal results while permanently refusing another dispatch of retired operations', async () => {
    const executeHost = vi.fn(async () => ({ case: 'failed' as const, reasonCode: 'tool_failed', durationMs: 2n }));
    const { gateway, request, grantId } = hostGateway(executeHost);
    for (let index = 0; index < 1_000; index++) {
      const next = prepare({ ...request, operationId: `operation/${index}`, toolUseId: `tool/${index}` });
      await gateway.prepare(next);
      await gateway.execute(execute(next, grantId));
      const terminal = create(agentV1SessionStore.EngineEventRecordV1Schema, {
        identity: identity(), localSequence: BigInt(index + 1), body: { case: 'capabilityTerminal', value: {
          operationId: next.operationId, toolUseId: next.toolUseId, grantId,
          classification: agentV1SessionStore.EngineCapabilityTerminalClassificationV1.FAILED,
          reasonCode: 'tool_failed', durationMs: 2n,
        } },
      });
      if (terminal.body.case !== 'capabilityTerminal') throw new Error('terminal');
      if (index === 0) {
        terminal.body.value.toolUseId = 'foreign';
        await expect(gateway.retireCommitted(terminal)).rejects.toThrow(/contradicts/);
        expect(gateway.executedOperationCount).toBe(1);
        terminal.body.value.toolUseId = next.toolUseId;
      }
      await gateway.retireCommitted(terminal);
      await gateway.retireCommitted(terminal);
      expect(gateway.preparedOperationCount).toBe(0);
      expect(gateway.executedOperationCount).toBe(0);
      expect(() => gateway.prepare(next)).toThrow(/durable terminal/);
      await expect(gateway.execute(execute(next, grantId))).rejects.toThrow(/no prepared/);
    }
    expect(executeHost).toHaveBeenCalledTimes(1_000);
  });

  it.each(['provider-turn:', 'codex-turn:'])('tombstones %s engine budget refusals without creating a Host grant', async prefix => {
    const gateway = rejectingGateway();
    const provider = prefix + identity().attemptId;
    const request = prepare({ operationId: 'capability:' + Buffer.byteLength(provider) + ':' + provider + ':budget-tool', toolUseId: 'budget-tool' });
    const record = create(agentV1SessionStore.EngineEventRecordV1Schema, { identity: identity(), body: {
      case: 'capabilityRefused', value: { operationId: request.operationId, toolUseId: request.toolUseId,
        decisionId: 'tool-budget:' + identity().attemptId + ':1:0', reasonCode: 'max_tool_calls',
        policyVersion: 'sealed-run-tree-budget:v1', decidedAtUnixMs: NOW },
    } });
    if (record.body.case !== 'capabilityRefused') throw new Error('refusal');
    record.body.value.reasonCode = 'policy_denied';
    await expect(gateway.retireCommitted(record)).rejects.toThrow(/no preparation/);
    record.body.value.reasonCode = 'max_tool_calls';
    await gateway.retireCommitted(record);
    await gateway.retireCommitted(record);
    expect(gateway.preparedOperationCount).toBe(0);
    expect(gateway.executedOperationCount).toBe(0);
    expect(() => gateway.prepare(request)).toThrow(/durable terminal/);
    record.body.value.toolUseId = 'foreign';
    await expect(gateway.retireCommitted(record)).rejects.toThrow(/replay diverged/);
  });

  it('tombstones exact workspace-boundary refusals without authorizing their unopened effects', async () => {
    const gateway = rejectingGateway();
    const provider = 'provider-turn:' + identity().attemptId + ':2';
    const request = prepare({ operationId: 'capability:' + Buffer.byteLength(provider) + ':' + provider + ':wrong-cwd', toolUseId: 'wrong-cwd' });
    const record = create(agentV1SessionStore.EngineEventRecordV1Schema, { identity: identity(), body: {
      case: 'capabilityRefused', value: { operationId: request.operationId, toolUseId: request.toolUseId,
        decisionId: 'workspace-transition:' + identity().attemptId + ':2:1', reasonCode: 'workspace_transition',
        policyVersion: 'sealed-workspace-transition:v1', decidedAtUnixMs: NOW },
    } });
    if (record.body.case !== 'capabilityRefused') throw new Error('refusal');
    record.body.value.decisionId = 'workspace-transition:' + identity().attemptId + ':1:1';
    await expect(gateway.retireCommitted(record)).rejects.toThrow(/no preparation/);
    record.body.value.decisionId = 'workspace-transition:' + identity().attemptId + ':2:1';
    record.body.value.policyVersion = 'unsealed';
    await expect(gateway.retireCommitted(record)).rejects.toThrow(/no preparation/);
    record.body.value.policyVersion = 'sealed-workspace-transition:v1';
    await gateway.retireCommitted(record);
    expect(gateway.preparedOperationCount).toBe(0);
    expect(gateway.executedOperationCount).toBe(0);
    expect(() => gateway.prepare(request)).toThrow(/durable terminal/);
  });

  it('retires denied operations only with the exact durable policy decision', async () => {
    const gateway = rejectingGateway();
    const request = prepare();
    const decision = await gateway.prepare(request);
    if (decision.decision.case !== 'rejected') throw new Error('expected rejection');
    const record = create(agentV1SessionStore.EngineEventRecordV1Schema, {
      identity: identity(), body: { case: 'capabilityRefused', value: {
        decisionId: decision.decision.value.decisionId, reasonCode: decision.decision.value.reasonCode,
        policyVersion: decision.decision.value.policyVersion, decidedAtUnixMs: decision.decision.value.decidedAtUnixMs,
        operationId: request.operationId, toolUseId: request.toolUseId,
      } },
    });
    await gateway.retireCommitted(record);
    expect(gateway.preparedOperationCount).toBe(0);
    expect(() => gateway.prepare(request)).toThrow(/durable terminal/);
  });
});

it.each([
  { count: 4, safe: true, mutates: false, valid: true },
  { count: 1, safe: true, mutates: false, valid: false },
  { count: 5, safe: true, mutates: false, valid: false },
  { count: 2, safe: false, mutates: false, valid: false },
  { count: 2, safe: true, mutates: true, valid: false },
])('validates a Host batch before any dispatch: %j', async ({ count, safe, mutates, valid }) => {
  const dispatch = vi.fn(async () => ({ case: 'failed' as const, reasonCode: 'unused', durationMs: 0n }));
  const { gateway, request, grantId } = hostGateway(dispatch, () => NOW, () => safe);
  const members = [];
  for (let index = 0; index < count; index++) {
    const member = { ...request, operationId: `batch/read/${index}`, toolUseId: `read/${index}`, mutates };
    await gateway.prepare(member); members.push(execute(member, grantId));
  }
  const batch = create(agentV1Capability.CapabilityReadBatchExecuteSchema, {
    identity: identity(), runtimeInstanceId: RUNTIME, batchId: 'batch/1', members,
  });
  if (valid) {
    const detached = await gateway.validateReadBatch(batch);
    batch.members[0]!.grantId = 'changed';
    expect(detached.members[0]!.grantId).toBe(grantId);
    await expect(gateway.validateReadBatch({ ...detached, members: [detached.members[0]!, detached.members[0]!] })).rejects.toThrow();
    await expect(gateway.validateReadBatch({ ...detached, runtimeInstanceId: 'foreign' })).rejects.toThrow();
    await expect(gateway.validateReadBatch({ ...detached, members: [{ ...detached.members[0]!, effectiveInputSha256: new Uint8Array(32) }, detached.members[1]!] })).rejects.toThrow();
  } else await expect(gateway.validateReadBatch(batch)).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
});

function hostGateway(
  executeHost: HostCapabilityExecutor['execute'],
  nowUnixMs: () => bigint = () => NOW,
  isParallelSafe?: HostCapabilityExecutor['isParallelSafe'],
) {
  const request = prepare({
    capabilityId: 'host.test_tool',
    executionClass: agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY,
    mutates: true,
  });
  const grantId = 'grant/host/1';
  const gateway = new CapabilityGateway(context(), {
    async resolve(value) {
      return {
        case: 'accepted',
        value: create(agentV1Capability.SealedExecutionGrantSchema, {
          grantId,
          decisionId: 'decision/host/1',
          capabilityId: value.capabilityId,
          capabilityVersion: value.capabilityVersion,
          operationId: value.operationId,
          toolUseId: value.toolUseId,
          effectiveInputSha256: value.inputSha256,
          executionClass: value.executionClass,
          mutates: value.mutates,
          environmentId: 'environment/local',
          environmentVersion: 1n,
          resourceBindingId: 'binding/host/1',
          constraintsSha256: new Uint8Array(32).fill(8),
          policyVersion: 'policy/v1',
          nonce: new Uint8Array(32).fill(5),
          issuedAtUnixMs: NOW,
          expiresAtUnixMs: NOW + 500n,
        }),
      };
    },
  }, nowUnixMs, undefined, { execute: executeHost, isParallelSafe });
  return { gateway, request, grantId };
}

function execute(
  request: agentV1Capability.CapabilityPrepare,
  grantId: string,
): agentV1Capability.CapabilityExecute {
  return create(agentV1Capability.CapabilityExecuteSchema, {
    identity: request.identity,
    runtimeInstanceId: request.runtimeInstanceId,
    operationId: request.operationId,
    toolUseId: request.toolUseId,
    grantId,
    effectiveInputSha256: request.inputSha256,
    deadlineAtUnixMs: request.deadlineAtUnixMs,
  });
}

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
