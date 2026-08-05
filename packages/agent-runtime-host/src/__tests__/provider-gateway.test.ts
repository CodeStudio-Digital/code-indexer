import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type {
  ChatProvider,
  ChatRequest,
} from '@mcp/provider-sdk/adapter.js';
import type { ChatDelta } from '@mcp/provider-sdk/wire.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderGateway,
  type ProviderGatewayEvent,
} from '../provider-gateway/index.js';

const NOW = 1_000;
const DIGEST = new Uint8Array(32).fill(0x22);

describe('ProviderGateway', () => {
  it('adapts a bounded request and emits accepted, stream, usage, and terminal in order', async () => {
    const provider = fakeProvider(async function* (request) {
      expect(request.system).toBe('system');
      expect(request.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      yield { type: 'text_delta', text: 'answer', phase: 'final_answer' };
      yield { type: 'usage', usage: { input_tokens: 3, output_tokens: 2 } };
      yield { type: 'response_id', id: 'response/1', messageCount: 1 };
      yield { type: 'done', stop_reason: 'end_turn' };
    });
    const events: ProviderGatewayEvent[] = [];
    const gateway = createGateway(provider);

    await gateway.run(start(), DIGEST, { emit: (event) => { events.push(event); } });

    expect(events.map((event) => event.case)).toEqual([
      'providerAccepted',
      'providerTextDelta',
      'providerUsage',
      'providerTerminal',
    ]);
    expect((events[1]?.value as agentV1Runtime.ProviderTextDelta).eventSequence).toBe(1n);
    expect((events[2]?.value as agentV1Runtime.ProviderUsageEvent).eventSequence).toBe(2n);
    const terminal = events[3]?.value as agentV1Runtime.ProviderTerminal;
    expect(terminal.eventSequence).toBe(3n);
    expect(terminal.classification).toBe(
      agentV1Runtime.ProviderTerminalClassification.COMPLETED,
    );
    expect(terminal.responseId).toBe('response/1');
    expect(terminal.responseMessageCount).toBe(1n);
    expect(terminal.finalUsage?.outputTokens).toBe(2n);
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('classifies EOF before done as a typed failure and evicts the operation', async () => {
    const provider = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'partial' };
    });
    const events: ProviderGatewayEvent[] = [];
    const gateway = createGateway(provider);

    await gateway.run(start(), DIGEST, { emit: (event) => { events.push(event); } });

    const terminal = events.at(-1)?.value as agentV1Runtime.ProviderTerminal;
    expect(terminal.eventSequence).toBe(2n);
    expect(terminal.classification).toBe(
      agentV1Runtime.ProviderTerminalClassification.FAILED,
    );
    expect(terminal.reasonCode).toBe('provider_eof_before_done');
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('cancels only the exact attempt operation, aborts the provider, and evicts it', async () => {
    const started = deferred<void>();
    let providerSignal: AbortSignal | undefined;
    const provider = fakeProvider(async function* (request) {
      providerSignal = request.signal;
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    });
    const events: ProviderGatewayEvent[] = [];
    const gateway = createGateway(provider);
    const running = gateway.run(start(), DIGEST, { emit: (event) => { events.push(event); } });
    await started.promise;

    gateway.cancel(create(agentV1Runtime.ProviderCancelSchema, {
      identity: identity(),
      operationId: 'provider-operation/1',
      reasonCode: 'user_cancelled',
      idempotencyKey: 'provider-cancel/1',
    }));
    await running;

    expect(providerSignal?.aborted).toBe(true);
    const terminal = events.at(-1)?.value as agentV1Runtime.ProviderTerminal;
    expect(terminal.classification).toBe(
      agentV1Runtime.ProviderTerminalClassification.CANCELLED,
    );
    expect(terminal.reasonCode).toBe('user_cancelled');
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('rejects duplicate operation IDs while the first operation owns the registry', async () => {
    const started = deferred<void>();
    const provider = fakeProvider(async function* (request) {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    });
    const gateway = createGateway(provider);
    const running = gateway.run(start(), DIGEST, { emit: vi.fn() });
    await started.promise;

    await expect(gateway.run(start(), DIGEST, { emit: vi.fn() })).rejects.toMatchObject({
      code: 'provider_operation_conflict',
    });
    const foreign = identity();
    foreign.fencingEpoch = 8n;
    expect(() => gateway.cancel(create(agentV1Runtime.ProviderCancelSchema, {
      identity: foreign,
      operationId: 'provider-operation/1',
      reasonCode: 'foreign_cancel',
      idempotencyKey: 'provider-cancel/foreign',
    }))).toThrow(expect.objectContaining({ code: 'provider_operation_identity_mismatch' }));
    expect(gateway.fenceAttempt(identity())).toBe(1);
    await running;
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('aggregates bounded tool arguments and fails closed when the cap is exceeded', async () => {
    const valid = fakeProvider(async function* () {
      yield { type: 'tool_call_start', id: 'tool/1', name: 'filesystem.read' };
      yield { type: 'tool_call_args', id: 'tool/1', partial_json: '{"pa' };
      yield { type: 'tool_call_args', id: 'tool/1', partial_json: 'th":"a"}' };
      yield { type: 'tool_call_end', id: 'tool/1', name: 'filesystem.read', input: { path: 'a' } };
      yield { type: 'done' };
    });
    const validEvents: ProviderGatewayEvent[] = [];
    await createGateway(valid).run(start(), DIGEST, {
      emit: (event) => { validEvents.push(event); },
    });
    const tool = validEvents.find((event) => event.case === 'providerToolCall');
    expect(tool?.value.eventSequence).toBe(1n);
    expect(new TextDecoder().decode(
      (tool?.value as agentV1Runtime.ProviderToolCall).encodedJsonArguments,
    )).toBe('{"path":"a"}');
    expect((tool?.value as agentV1Runtime.ProviderToolCall).argumentsSha256).toEqual(
      createHash('sha256').update('{"path":"a"}').digest(),
    );

    const oversized = fakeProvider(async function* () {
      yield { type: 'tool_call_start', id: 'tool/1', name: 'filesystem.read' };
      yield { type: 'tool_call_args', id: 'tool/1', partial_json: '{"path":"too-large"}' };
    });
    const failed: ProviderGatewayEvent[] = [];
    await createGateway(oversized, { maxToolArgumentsBytes: 8 }).run(start(), DIGEST, {
      emit: (event) => { failed.push(event); },
    });
    expect((failed.at(-1)?.value as agentV1Runtime.ProviderTerminal).reasonCode)
      .toBe('provider_stream_limit_exceeded');
  });

  it('poisons the operation and releases registry ownership when the durable sink fails', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider = fakeProvider(async function* (request) {
      providerSignal = request.signal;
      yield { type: 'text_delta', text: 'cannot-commit' };
      yield { type: 'done' };
    });
    const gateway = createGateway(provider);
    let emissions = 0;

    await expect(gateway.run(start(), DIGEST, {
      emit: () => {
        emissions += 1;
        if (emissions === 2) throw new Error('disk unavailable');
      },
    })).rejects.toMatchObject({ code: 'provider_sink_failed' });

    expect(providerSignal?.aborted).toBe(true);
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('enforces the hard deadline even when the provider iterator never resolves', async () => {
    vi.useFakeTimers();
    let current = NOW;
    try {
      const started = deferred<void>();
      const provider = fakeProvider(async function* (request) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
            once: true,
          });
        });
      });
      const events: ProviderGatewayEvent[] = [];
      const gateway = new ProviderGateway({
        runtimeInstanceId: 'runtime/provider-host/1',
        resolver: { resolve: () => provider },
        now: () => current,
        limits: { maxOperationMs: 1_000 },
      });
      const candidate = start();
      candidate.deadlineAtUnixMs = BigInt(NOW + 100);
      const running = gateway.run(candidate, DIGEST, {
        emit: (event) => { events.push(event); },
      });
      await started.promise;

      current += 100;
      await vi.advanceTimersByTimeAsync(100);
      await running;

      const terminal = events.at(-1)?.value as agentV1Runtime.ProviderTerminal;
      expect(terminal.reasonCode).toBe('provider_deadline_exceeded');
      expect(terminal.classification).toBe(
        agentV1Runtime.ProviderTerminalClassification.FAILED,
      );
      expect(gateway.activeOperationCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createGateway(
  provider: ChatProvider,
  limits: Record<string, number> = {},
): ProviderGateway {
  return new ProviderGateway({
    runtimeInstanceId: 'runtime/provider-host/1',
    resolver: { resolve: () => provider },
    now: () => NOW,
    limits,
  });
}

function fakeProvider(
  chat: (request: ChatRequest) => AsyncGenerator<ChatDelta>,
): ChatProvider {
  return {
    name: 'test-provider',
    model: 'test-model',
    setModel(model) { this.model = model; },
    chat,
  };
}

function start(): agentV1Runtime.ProviderStart {
  return create(agentV1Runtime.ProviderStartSchema, {
    identity: identity(),
    operationId: 'provider-operation/1',
    binding: create(agentV1Runtime.ProviderBindingSchema, {
      effectiveProvider: 'test-provider',
      effectiveModel: 'test-model',
    }),
    system: create(agentV1Runtime.ProviderTextContentSchema, {
      body: { case: 'inlineUtf8', value: 'system' },
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
    deadlineAtUnixMs: BigInt(NOW + 5_000),
    idempotencyKey: 'provider-start/1',
  });
}

function identity(): agentV1Common.AttemptIdentity {
  return create(agentV1Common.AttemptIdentitySchema, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    agentRunId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    executorOwnerId: 'host/provider',
    fencingEpoch: 7n,
    correlationId: '55555555-5555-4555-8555-555555555555',
    rootAgentRunId: '33333333-3333-4333-8333-333333333333',
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
