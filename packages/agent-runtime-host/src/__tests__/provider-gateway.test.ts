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
import { boundaryMessageDigest } from '../native/PreparedBoundaryContext.js';
import {
  ProviderGateway,
  type ProviderGatewayEvent,
} from '../provider-gateway/index.js';
import { ProviderGatewayError } from '../provider-gateway/ProviderGatewayError.js';

const NOW = 1_000;
const DIGEST = new Uint8Array(32).fill(0x22);

describe('ProviderGateway', () => {
  it('charges shared consumption after durable frontier and before resolver, excluding checkpoints', async () => {
    let committed = false;
    const resolve = vi.fn(() => fakeProvider(async function* () { yield { type: 'done' as const }; }));
    const admitOperation = vi.fn(() => {
      expect(committed).toBe(true);
      throw new ProviderGatewayError('provider_run_tree_budget_exhausted', 'shared limit');
    });
    const gateway = new ProviderGateway({ runtimeInstanceId: 'runtime/budget', now: () => NOW, resolver: { resolve }, admitOperation });
    const events: ProviderGatewayEvent[] = [];
    await gateway.run(start(), DIGEST, { emit: event => { events.push(event); } }, async () => { committed = true; });
    expect(admitOperation).toHaveBeenCalledOnce(); expect(resolve).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ case: 'providerTerminal', value: { reasonCode: 'provider_run_tree_budget_exhausted' } });
    await gateway.checkpoint({ ...start(), operationId: 'checkpoint/budget' }, DIGEST, async () => {});
    expect(admitOperation).toHaveBeenCalledOnce(); expect(gateway.activeOperationCount).toBe(0);
  });
  it('commits prepared context before the vendor opens and resets stale response continuation', async () => {
    const request = start(); request.previousResponseId = 'old'; request.previousResponseMessageCount = 1n;
    const context = create(agentV1Runtime.ProviderPreparedBoundaryContextV1Schema, {
      messageIndex: 0, sourceMessageSha256: boundaryMessageDigest(request.messages[0]!), contentUtf8: 'recalled-reference',
    });
    let committed = false;
    const chat = vi.fn(async function* (adapted: ChatRequest) {
      expect(committed).toBe(true); expect(adapted.previousResponseId).toBeUndefined();
      expect(JSON.stringify(adapted.messages)).toContain('recalled-reference');
      yield { type: 'done' as const };
    });
    const prepare = vi.fn(async (_request: agentV1Runtime.ProviderStart, _signal: AbortSignal, _checkpoint: boolean) => ({ context, resetContinuation: true }));
    const gateway = new ProviderGateway({ runtimeInstanceId: 'runtime/prepared', now: () => NOW,
      resolver: { resolve: () => fakeProvider(chat) }, contextPreparation: { prepare } });
    await gateway.run(request, DIGEST, { emit: vi.fn() }, async actual => {
      expect(actual.preparedBoundaryContext?.contentUtf8).toBe(context.contentUtf8);
      expect(actual.previousResponseId).toBeUndefined(); committed = true;
    });
    expect(chat).toHaveBeenCalledOnce(); expect(request.preparedBoundaryContext).toBeUndefined();
    expect(request.previousResponseId).toBe('old');
    await gateway.checkpoint({ ...request, operationId: 'checkpoint/prepared' }, DIGEST, async actual => {
      expect(actual.preparedBoundaryContext?.contentUtf8).toBe(context.contentUtf8);
    });
    expect(prepare.mock.calls.at(-1)?.[2]).toBe(true);
    expect(chat).toHaveBeenCalledOnce();
  });

  it('commits the frontier before draining without opening a provider', async () => {
    const committed = deferred<void>();
    const entered = deferred<void>();
    const stop = new AbortController();
    stop.abort();
    const chat = vi.fn(async function* () { yield { type: 'done' as const }; });
    const gateway = createGateway(fakeProvider(chat));
    gateway.drainWhen(stop.signal);
    const events: ProviderGatewayEvent[] = [];
    const running = gateway.run(start(), DIGEST, { emit: e => { events.push(e); } }, async (_, signal) => {
      expect(signal.aborted).toBe(false); entered.resolve(); await committed.promise;
      expect(signal.aborted).toBe(false);
    });
    await entered.promise;
    expect(events.map(e => e.case)).toEqual(['providerAccepted']);
    committed.resolve(); await running;
    expect(chat).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ case: 'providerTerminal', value: {
      classification: agentV1Runtime.ProviderTerminalClassification.CANCELLED, reasonCode: 'ipc_identity_budget' } });
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('settles a stalled provider stream when another channel approaches its bound', async () => {
    const stop = new AbortController();
    const first = deferred<void>();
    const provider = fakeProvider(async function* () {
      yield { type: 'text_delta', text: 'partial' };
      await new Promise(() => {});
    });
    const gateway = createGateway(provider); gateway.drainWhen(stop.signal);
    const events: ProviderGatewayEvent[] = [];
    const running = gateway.run(start(), DIGEST, { emit: e => {
      events.push(e); if (e.case === 'providerTextDelta') first.resolve();
    } });
    await first.promise; stop.abort(); await running;
    expect(events.map(e => e.case)).toEqual(['providerAccepted', 'providerTextDelta', 'providerTerminal']);
    expect(events.at(-1)).toMatchObject({ value: { reasonCode: 'ipc_identity_budget', eventSequence: 2n } });
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('does not call a failed checkpoint a confirmed budget interruption', async () => {
    const stop = new AbortController(); stop.abort();
    const chat = vi.fn(async function* () { yield { type: 'done' as const }; });
    const gateway = createGateway(fakeProvider(chat)); gateway.drainWhen(stop.signal);
    const events: ProviderGatewayEvent[] = [];
    await gateway.run(start(), DIGEST, { emit: e => { events.push(e); } }, async () => { throw new Error('ENOSPC'); });
    expect(chat).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ value: { classification: agentV1Runtime.ProviderTerminalClassification.FAILED,
      reasonCode: 'provider_failed' } });
  });

  it('numbers coalesced output contiguously and preserves usage and tool ordering', async () => {
    const provider = fakeProvider(async function* () {
      for (let index = 0; index < 1_000; index++) yield { type: 'text_delta', text: 'x', itemId: 'answer' };
      yield { type: 'tool_call_start', id: 'read/1', name: 'read_file' };
      yield { type: 'tool_call_end', id: 'read/1', name: 'read_file', input: { path: 'a' } };
      yield { type: 'usage', usage: { input_tokens: 3, output_tokens: 1_000 } };
      yield { type: 'done' };
    });
    const events: ProviderGatewayEvent[] = [];
    await createGateway(provider).run(start(), DIGEST, { emit: event => { events.push(event); } });
    const sequenced = events.filter(event => event.case !== 'providerAccepted');
    expect(sequenced.map(event => event.value.eventSequence)).toEqual(sequenced.map((_, index) => BigInt(index + 1)));
    expect(events.filter(event => event.case === 'providerTextDelta').map(event => event.value.text).join('')).toBe('x'.repeat(1_000));
    expect(events.length).toBeLessThan(20);
    expect(events.slice(-3).map(event => event.case)).toEqual(['providerToolCall', 'providerUsage', 'providerTerminal']);
    expect((events.at(-1)?.value as agentV1Runtime.ProviderTerminal).finalUsage?.outputTokens).toBe(1_000n);
  });

  it('checkpoints without resolving a provider and waits for durable acknowledgement', async () => {
    const committed = deferred<void>();
    const entered = deferred<void>();
    const resolver = vi.fn(() => { throw new Error('checkpoint must not resolve credentials'); });
    const gateway = new ProviderGateway({ runtimeInstanceId: 'runtime/checkpoint', resolver: { resolve: resolver }, now: () => NOW });
    let returned = false;
    const pending = gateway.checkpoint(start(), DIGEST, async () => { entered.resolve(); await committed.promise; })
      .then(() => { returned = true; });
    await entered.promise;
    expect(returned).toBe(false);
    expect(gateway.activeOperationCount).toBe(1);
    committed.resolve(); await pending;
    expect(returned).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
    expect(gateway.activeOperationCount).toBe(0);
  });

  it.each(['disk full', 'cancelled'])('does not acknowledge a checkpoint after %s', async failure => {
    const resolver = vi.fn(() => { throw new Error('unexpected provider'); });
    const gateway = new ProviderGateway({ runtimeInstanceId: 'runtime/checkpoint', resolver: { resolve: resolver }, now: () => NOW });
    const entered = deferred<void>();
    const commit = vi.fn(async () => {
      entered.resolve();
      if (failure === 'disk full') throw new Error('ENOSPC');
      await new Promise(() => {});
    });
    const pending = gateway.checkpoint(start(), DIGEST, commit);
    const rejected = expect(pending).rejects.toThrow(failure === 'disk full' ? 'ENOSPC' : 'attempt_fenced');
    await entered.promise;
    if (failure === 'cancelled') gateway.fenceAttempt(identity());
    await rejected;
    expect(commit).toHaveBeenCalledOnce();
    expect(resolver).not.toHaveBeenCalled();
    expect(gateway.activeOperationCount).toBe(0);
  });

  it('opens the provider only after the durable frontier is confirmed', async () => {
    const committed = deferred<void>();
    const entered = deferred<void>();
    const chat = vi.fn(async function* () { yield { type: 'done' as const, stop_reason: 'end_turn' }; });
    const gateway = createGateway(fakeProvider(chat));
    const running = gateway.run(start(), DIGEST, { emit: vi.fn() }, async (_start, signal) => {
      expect(signal.aborted).toBe(false); entered.resolve(); await committed.promise;
    });
    await entered.promise;
    expect(chat).not.toHaveBeenCalled();
    committed.resolve(); await running;
    expect(chat).toHaveBeenCalledOnce();
  });

  it('does not open the provider after checkpoint disk failure or cancellation', async () => {
    for (const cancel of [false, true]) {
      const entered = deferred<void>();
      const chat = vi.fn(async function* () { yield { type: 'done' as const, stop_reason: 'end_turn' }; });
      const gateway = createGateway(fakeProvider(chat));
      const events: ProviderGatewayEvent[] = [];
      const running = gateway.run(start(), DIGEST, { emit: (event) => { events.push(event); } }, async () => {
        entered.resolve();
        if (cancel) await new Promise(() => {});
        else throw new Error('ENOSPC');
      });
      await entered.promise;
      if (cancel) gateway.cancel(create(agentV1Runtime.ProviderCancelSchema, {
        identity: identity(), operationId: start().operationId, idempotencyKey: 'cancel/frontier', reasonCode: 'cancelled',
      }));
      await running;
      expect(chat).not.toHaveBeenCalled();
      expect((events.at(-1)?.value as agentV1Runtime.ProviderTerminal).classification).toBe(cancel
        ? agentV1Runtime.ProviderTerminalClassification.CANCELLED : agentV1Runtime.ProviderTerminalClassification.FAILED);
    }
  });

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
