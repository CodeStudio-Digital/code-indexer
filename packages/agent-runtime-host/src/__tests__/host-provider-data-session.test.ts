import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Capability,
  agentV1Common,
  agentV1Runtime,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { describe, expect, it } from 'vitest';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import {
  encodeAttemptFrame,
  validateAttemptFrame,
} from '../ipc/AttemptFrame.js';
import { createHostPendingDataAttemptChannel } from '../ipc/HostDataAttemptChannel.js';
import type { HostDataHydrationRequest } from '../ipc/HostDataHydration.js';
import { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
import { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';
import { identity } from './attempt-channel-support.js';
import { hydrationSourceFixture } from './data-hydration-source-support.js';
import {
  dataDuplexPair,
  driveDataHydrationRunner,
} from './data-runner-peer-support.js';

const CONNECTION = 'data-provider-connection';
const RUNTIME = 'runtime-provider-instance';
const TRANSFER = 'transfer:provider';
const MAXIMUM = 64 * 1024;
const TOKEN = new Uint8Array(32).fill(0x31);

describe('Host provider Data session', () => {
  it('correlates CapabilityPrepare to a bounded pre-dispatch decision', async () => {
    const setup = await hydratedChannel(fakeProvider(async function* () {
      yield { type: 'done' };
    }));
    const capabilityGateway = new CapabilityGateway(setup.bound.context, {
      async resolve() {
        return {
          case: 'rejected',
          value: create(agentV1Capability.CapabilityRejectedSchema, {
            decisionId: 'decision/deny/1',
            reasonCode: 'policy_denied',
            policyVersion: 'policy/v1',
            decidedAtUnixMs: 10n,
          }),
        };
      },
    }, () => 10n);
    const session = setup.bound.intoProviderSession(
      setup.gateway,
      undefined,
      capabilityGateway,
    );
    const controller = new AbortController();
    const serving = session.run(controller.signal);

    await sendRunnerCapabilityPrepare(setup.runner, setup.limits, 6n);
    const response = await receiveRunnerProviderEvent(setup.runner);

    expect(response.frame.header?.replyToMessageId).toBe('capability-prepare/1');
    expect(response.payload.body.case).toBe('capabilityUpdate');
    if (response.payload.body.case === 'capabilityUpdate') {
      expect(response.payload.body.value.operationId).toBe('capability/tool/1');
      expect(response.payload.body.value.decision.case).toBe('rejected');
    }
    controller.abort(new Error('test complete'));
    await expect(serving).resolves.toBeUndefined();
  });

  it('commits an engine proposal before returning its correlated native receipt', async () => {
    const setup = await hydratedChannel(fakeProvider(async function* () {
      yield { type: 'done' };
    }));
    const committed: bigint[] = [];
    const session = setup.bound.intoProviderSession(setup.gateway, {
      async commit(request) {
        committed.push(request.record.localSequence);
        return create(agentV1SessionStore.CommitSessionRecordReceiptSchema, {
          sessionId: request.identity.sessionId,
          operationId: '66666666-6666-4666-8666-666666666666',
          authority: create(agentV1SessionStore.SessionStoreAuthoritySchema, {
            storageGeneration: agentV1SessionStore.StorageGeneration.RUST_FS_V1,
            leaseEpoch: 3n,
            writerId: 'native/writer/1',
          }),
          globalSequence: 9n,
          kind: agentV1SessionStore.SessionRecordKind.LIFECYCLE_EVENT,
          durability: agentV1SessionStore.SessionDurabilityClass.DURABLE,
          previousCommitSha256: new Uint8Array(32).fill(1),
          payloadSha256: request.expectedPayloadSha256,
          commitSha256: new Uint8Array(32).fill(2),
          payloadBytes: BigInt(toBinary(
            agentV1SessionStore.EngineEventRecordV1Schema,
            request.record,
          ).byteLength),
        });
      },
    });
    const controller = new AbortController();
    const serving = session.run(controller.signal);

    await sendRunnerEngineProposal(setup.runner, setup.limits, 6n);
    const response = await receiveRunnerProviderEvent(setup.runner);
    expect(response.frame.header?.replyToMessageId).toBe('engine-event/1');
    expect(response.payload.body.case).toBe('engineEventCommitted');
    if (response.payload.body.case === 'engineEventCommitted') {
      expect(response.payload.body.value.localSequence).toBe(1n);
      expect(response.payload.body.value.commitReceipt?.globalSequence).toBe(9n);
    }
    expect(committed).toEqual([1n]);

    controller.abort(new Error('test complete'));
    await expect(serving).resolves.toBeUndefined();
  });

  it('hands off the hydrated channel and correlates ProviderStart through terminal', async () => {
    const setup = await hydratedChannel(fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'native answer', phase: 'final_answer' };
      yield { type: 'done' };
    }));
    const session = setup.bound.intoProviderSession(setup.gateway);
    const controller = new AbortController();
    const serving = session.run(controller.signal);

    await sendRunnerProviderStart(setup.runner, setup.limits, 6n);
    const accepted = await receiveRunnerProviderEvent(setup.runner);
    expect(accepted.frame.header?.replyToMessageId).toBe('provider-start/1');
    expect(accepted.payload.body.case).toBe('providerAccepted');
    const text = await receiveRunnerProviderEvent(setup.runner);
    expect(text.frame.header).not.toHaveProperty('replyToMessageId');
    expect(text.payload.body.case).toBe('providerTextDelta');
    if (text.payload.body.case === 'providerTextDelta') {
      expect(text.payload.body.value.text).toBe('native answer');
      expect(text.payload.body.value.eventSequence).toBe(1n);
    }
    const terminal = await receiveRunnerProviderEvent(setup.runner);
    expect(terminal.payload.body.case).toBe('providerTerminal');
    if (terminal.payload.body.case === 'providerTerminal') {
      expect(terminal.payload.body.value.eventSequence).toBe(2n);
      expect(terminal.payload.body.value.classification).toBe(
        agentV1Runtime.ProviderTerminalClassification.COMPLETED,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(setup.gateway.activeOperationCount).toBe(0);

    controller.abort(new Error('test complete'));
    await expect(serving).resolves.toBeUndefined();
  });

  it('receives ProviderCancel while the stream is pending and emits a terminal cancellation', async () => {
    let providerSignal: AbortSignal | undefined;
    const setup = await hydratedChannel(fakeProvider(async function* (request) {
      providerSignal = request.signal;
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    }));
    const session = setup.bound.intoProviderSession(setup.gateway);
    const controller = new AbortController();
    const serving = session.run(controller.signal);

    await sendRunnerProviderStart(setup.runner, setup.limits, 6n);
    await receiveRunnerProviderEvent(setup.runner);
    await sendRunnerProviderCancel(setup.runner, setup.limits, 7n);
    const terminal = await receiveRunnerProviderEvent(setup.runner);

    expect(providerSignal?.aborted).toBe(true);
    expect(terminal.payload.body.case).toBe('providerTerminal');
    if (terminal.payload.body.case === 'providerTerminal') {
      expect(terminal.payload.body.value.classification).toBe(
        agentV1Runtime.ProviderTerminalClassification.CANCELLED,
      );
      expect(terminal.payload.body.value.reasonCode).toBe('runner_cancelled');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(setup.gateway.activeOperationCount).toBe(0);
    controller.abort(new Error('test complete'));
    await expect(serving).resolves.toBeUndefined();
  });

  it('treats Data EOF as graceful only after Control termination begins', async () => {
    const setup = await hydratedChannel(fakeProvider(async function* (request) {
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    }));
    const session = setup.bound.intoProviderSession(setup.gateway);
    const serving = session.run();

    await sendRunnerProviderStart(setup.runner, setup.limits, 6n);
    await receiveRunnerProviderEvent(setup.runner);
    session.beginTermination();
    setup.runner.fail(new Error('authorized runner termination'));

    await expect(serving).resolves.toBeUndefined();
  });
});

async function hydratedChannel(provider: ChatProvider) {
  const limits = frameLimits();
  const pair = dataDuplexPair(limits);
  const source = hydrationSourceFixture();
  const expectedBodies = [Buffer.from('abcdefghij'), Buffer.from('xyz')];
  const runnerHydration = driveDataHydrationRunner(pair.runner, {
    connectionId: CONNECTION,
    runtimeInstanceId: RUNTIME,
    connectionToken: TOKEN,
    limits,
    hardDeadlineAtUnixMs: 90_000n,
    transferId: TRANSFER,
    expectedBodies,
  });
  const pending = createHostPendingDataAttemptChannel({
    transport: pair.host,
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    connectionId: CONNECTION,
    connectionSessionToken: TOKEN,
    protocolVersion: 65_537,
    effectiveLimits: limits,
    maxIpcFrames: 64,
    hardDeadlineAtUnixMs: 90_000n,
    clock: createAuthorityClockForTesting(() => 10n),
  });
  const bound = await pending.bind();
  await bound.hydrate(hydrationRequest(source.source));
  await runnerHydration;
  const gateway = new ProviderGateway({
    runtimeInstanceId: RUNTIME,
    resolver: { resolve: () => provider },
    now: () => 10,
  });
  return { bound, gateway, limits, runner: pair.runner };
}

function hydrationRequest(
  source: ReturnType<typeof hydrationSourceFixture>['source'],
): HostDataHydrationRequest {
  return {
    transferId: TRANSFER,
    maximumChunkBytes: BigInt(MAXIMUM - 1024),
    maxIpcBytes: 64n * 1024n,
    maxIpcFrames: 64,
    maxArtifactBytes: 1024n,
    maxSpoolBytes: 1024n,
    source,
  };
}

function fakeProvider(chat: ChatProvider['chat']): ChatProvider {
  return {
    name: 'test-provider',
    model: 'test-model',
    setModel(model) { this.model = model; },
    chat,
  };
}

async function sendRunnerProviderStart(
  runner: Parameters<typeof receiveRunnerProviderEvent>[0],
  limits: agentV1Common.FrameLimits,
  sequence: bigint,
): Promise<void> {
  const payload = create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'providerStart',
      value: create(agentV1Runtime.ProviderStartSchema, {
        identity: identity(),
        operationId: 'provider-operation/1',
        binding: create(agentV1Runtime.ProviderBindingSchema, {
          effectiveProvider: 'test-provider',
          effectiveModel: 'test-model',
        }),
        messages: [create(agentV1Runtime.ProviderMessageSchema, {
          role: agentV1Runtime.ProviderMessageRole.USER,
          content: [create(agentV1Runtime.ProviderContentBlockSchema, {
            body: {
              case: 'text',
              value: create(agentV1Runtime.ProviderTextContentSchema, {
                body: { case: 'inlineUtf8', value: 'hello' },
              }),
            },
          })],
        })],
        deadlineAtUnixMs: 5_000n,
        idempotencyKey: 'provider-start/idempotency/1',
      }),
    },
  });
  await runner.send(encodeAttemptFrame(
    runnerHeader('provider-start/1', sequence),
    agentV1Runtime.TransportChannel.DATA,
    payload,
    Number(limits.maxFrameBytes),
  ));
}

async function sendRunnerProviderCancel(
  runner: Parameters<typeof receiveRunnerProviderEvent>[0],
  limits: agentV1Common.FrameLimits,
  sequence: bigint,
): Promise<void> {
  const payload = create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'providerCancel',
      value: create(agentV1Runtime.ProviderCancelSchema, {
        identity: identity(),
        operationId: 'provider-operation/1',
        reasonCode: 'runner_cancelled',
        idempotencyKey: 'provider-cancel/idempotency/1',
      }),
    },
  });
  await runner.send(encodeAttemptFrame(
    runnerHeader('provider-cancel/1', sequence),
    agentV1Runtime.TransportChannel.DATA,
    payload,
    Number(limits.maxFrameBytes),
  ));
}

async function sendRunnerEngineProposal(
  runner: Parameters<typeof receiveRunnerProviderEvent>[0],
  limits: agentV1Common.FrameLimits,
  sequence: bigint,
): Promise<void> {
  const record = create(agentV1SessionStore.EngineEventRecordV1Schema, {
    schemaVersion: 1,
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    localSequence: 1n,
    body: {
      case: 'providerStarted',
      value: create(agentV1SessionStore.EngineProviderStartedRecordV1Schema, {
        operationId: 'provider-operation/1',
      }),
    },
  });
  const digest = createHash('sha256').update(toBinary(
    agentV1SessionStore.EngineEventRecordV1Schema,
    record,
  )).digest();
  const payload = create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'engineEventProposal',
      value: create(agentV1Runtime.EngineEventProposalSchema, {
        identity: identity(),
        runtimeInstanceId: RUNTIME,
        record,
        expectedPayloadSha256: digest,
      }),
    },
  });
  await runner.send(encodeAttemptFrame(
    runnerHeader('engine-event/1', sequence),
    agentV1Runtime.TransportChannel.DATA,
    payload,
    Number(limits.maxFrameBytes),
  ));
}

async function sendRunnerCapabilityPrepare(
  runner: Parameters<typeof receiveRunnerProviderEvent>[0],
  limits: agentV1Common.FrameLimits,
  sequence: bigint,
): Promise<void> {
  const encodedJsonInput = new TextEncoder().encode('{"path":"a"}');
  const payload = create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'capabilityPrepare',
      value: create(agentV1Capability.CapabilityPrepareSchema, {
        identity: identity(),
        runtimeInstanceId: RUNTIME,
        operationId: 'capability/tool/1',
        providerOperationId: 'provider-operation/1',
        toolUseId: 'tool/1',
        capabilityId: 'native.read_file',
        capabilityVersion: '1',
        executionClass: agentV1Capability.CapabilityExecutionClass.NATIVE_READ,
        encodedJsonInput,
        inputSha256: createHash('sha256').update(encodedJsonInput).digest(),
        capabilitySetSha256: new Uint8Array(32).fill(3),
        idempotencyKey: 'capability-prepare/tool/1',
        deadlineAtUnixMs: 5_000n,
      }),
    },
  });
  await runner.send(encodeAttemptFrame(
    runnerHeader('capability-prepare/1', sequence),
    agentV1Runtime.TransportChannel.DATA,
    payload,
    Number(limits.maxFrameBytes),
  ));
}

async function receiveRunnerProviderEvent(
  runner: ReturnType<typeof dataDuplexPair>['runner'],
) {
  const bytes = await runner.receive();
  if (!bytes) throw new Error('unexpected provider Data EOF');
  return validateAttemptFrame(bytes, agentV1Runtime.TransportChannel.DATA, MAXIMUM);
}

function runnerHeader(messageId: string, streamSeq: bigint) {
  const authority = identity();
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: CONNECTION,
    messageId,
    sessionId: authority.sessionId,
    commandId: authority.commandId,
    agentRunId: authority.agentRunId,
    attemptId: authority.attemptId,
    executorOwnerId: authority.executorOwnerId,
    fencingEpoch: authority.fencingEpoch,
    correlationId: authority.correlationId,
    rootAgentRunId: authority.rootAgentRunId,
    ownerAgentRunId: authority.ownerAgentRunId,
    streamSeq,
    sentAtUnixMs: 10n,
    deadlineAtUnixMs: 5_000n,
  });
}

function frameLimits() {
  return create(agentV1Common.FrameLimitsSchema, {
    maxFrameBytes: BigInt(MAXIMUM),
    maxChunkBytes: BigInt(MAXIMUM - 1024),
    maxInFlightFrames: 1n,
    maxInFlightBytes: BigInt(MAXIMUM),
    readTimeoutMs: 30_000n,
    writeTimeoutMs: 30_000n,
  });
}
