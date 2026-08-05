import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import type { ChatDelta } from '@mcp/provider-sdk/wire.js';
import { validateAttemptIdentity } from '../ipc/FrameHeaderValidation.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import { ProviderOperationRegistry } from './ProviderOperationRegistry.js';
import { adaptProviderRequest } from './ProviderRequestAdapter.js';
import { ProviderStreamAssembler } from './ProviderStreamAssembler.js';
import {
  DEFAULT_PROVIDER_GATEWAY_LIMITS,
  type ProviderGatewayDependencies,
  type ProviderGatewayEvent,
  type ProviderGatewayEventSinkPort,
  type ProviderGatewayLimits,
} from './ProviderGatewayTypes.js';
import {
  boundedText,
  terminalReason,
  validateGatewayLimits,
  validateProviderStart,
} from './ProviderGatewayValidation.js';

export class ProviderGateway {
  readonly #limits: ProviderGatewayLimits;
  readonly #registry: ProviderOperationRegistry;
  readonly #now: () => number;

  constructor(readonly dependencies: ProviderGatewayDependencies) {
    this.#limits = { ...DEFAULT_PROVIDER_GATEWAY_LIMITS, ...dependencies.limits };
    validateGatewayLimits(this.#limits);
    boundedText(dependencies.runtimeInstanceId, 'runtimeInstanceId');
    this.#registry = new ProviderOperationRegistry(this.#limits.maxActiveOperations);
    this.#now = dependencies.now ?? Date.now;
  }

  get activeOperationCount(): number {
    return this.#registry.size;
  }

  async run(
    start: agentV1Runtime.ProviderStart,
    requestPayloadSha256: Uint8Array,
    sink: ProviderGatewayEventSinkPort,
  ): Promise<void> {
    const openedAt = this.#now();
    validateProviderStart(start, requestPayloadSha256, openedAt, this.#limits);
    const identity = start.identity;
    const binding = start.binding;
    const lease = this.#registry.reserve(start.operationId, identity);
    const signal = lease.controller.signal;
    const deadline = Number(start.deadlineAtUnixMs);
    const timer = setTimeout(() => lease.controller.abort(new ProviderGatewayError(
      'provider_deadline_exceeded',
      'provider operation reached its hard deadline',
    )), deadline - openedAt);
    let sinkHealthy = true;
    let assembler: ProviderStreamAssembler | undefined;
    try {
      await this.#emit(sink, {
        case: 'providerAccepted',
        value: create(agentV1Runtime.ProviderAcceptedSchema, {
          identity,
          runtimeInstanceId: this.dependencies.runtimeInstanceId,
          operationId: start.operationId,
          requestPayloadSha256,
          acceptedAtUnixMs: BigInt(openedAt),
        }),
      });
      const iterator = await openProviderIterator(
        start,
        binding,
        this.dependencies,
        this.#limits,
        signal,
      );
      assembler = new ProviderStreamAssembler(identity, start.operationId, this.#limits);
      try {
        for (;;) {
          const next = await nextWithAbort(iterator, signal);
          if (next.done) throw new ProviderGatewayError(
            'provider_eof_before_done',
            'provider stream ended before a terminal event',
          );
          const outcome = assembler.accept(next.value);
          if (outcome.kind === 'done') {
            await this.#emit(sink, terminalEvent(
              identity,
              start.operationId,
              assembler,
              agentV1Runtime.ProviderTerminalClassification.COMPLETED,
              outcome.reasonCode,
              this.#now(),
            ));
            return;
          }
          if (outcome.event) await this.#emit(sink, outcome.event);
        }
      } finally {
        if (iterator.return) void iterator.return().catch(() => undefined);
      }
    } catch (cause) {
      if (cause instanceof ProviderGatewayError && cause.code === 'provider_sink_failed') {
        sinkHealthy = false;
        lease.controller.abort(cause);
        throw cause;
      }
      if (sinkHealthy) {
        const error = gatewayFailure(cause, signal);
        const classification = error.code === 'provider_cancelled'
          ? agentV1Runtime.ProviderTerminalClassification.CANCELLED
          : agentV1Runtime.ProviderTerminalClassification.FAILED;
        await this.#emit(sink, terminalEvent(
          identity,
          start.operationId,
          assembler,
          classification,
          error.code === 'provider_cancelled' ? error.message : error.code,
          this.#now(),
        ));
      }
    } finally {
      clearTimeout(timer);
      lease.release();
    }
  }

  cancel(cancel: agentV1Runtime.ProviderCancel): void {
    if (!cancel.identity) throw new ProviderGatewayError(
      'invalid_provider_request',
      'provider cancel identity is required',
    );
    validateAttemptIdentity(cancel.identity);
    boundedText(cancel.operationId, 'operationId');
    boundedText(cancel.idempotencyKey, 'idempotencyKey');
    this.#registry.abort(cancel.operationId, cancel.identity, new ProviderGatewayError(
      'provider_cancelled',
      terminalReason(cancel.reasonCode || 'provider_cancelled'),
    ));
  }

  fenceAttempt(identity: agentV1Common.AttemptIdentity): number {
    validateAttemptIdentity(identity);
    return this.#registry.abortAttempt(identity, new ProviderGatewayError(
      'provider_cancelled',
      'attempt_fenced',
    ));
  }

  async #emit(sink: ProviderGatewayEventSinkPort, event: ProviderGatewayEvent): Promise<void> {
    try {
      await sink.emit(event);
    } catch (cause) {
      throw new ProviderGatewayError('provider_sink_failed', 'provider event sink failed', { cause });
    }
  }
}

async function openProviderIterator(
  start: agentV1Runtime.ProviderStart,
  binding: agentV1Runtime.ProviderBinding,
  dependencies: ProviderGatewayDependencies,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
): Promise<AsyncIterator<ChatDelta>> {
  const request = await raceAbort(
    adaptProviderRequest(start, dependencies.artifactReader, limits, signal),
    signal,
  );
  const provider = await raceAbort(
    Promise.resolve(dependencies.resolver.resolve(binding, signal)),
    signal,
  );
  assertResolvedBinding(provider, binding);
  return provider.chat(request)[Symbol.asyncIterator]();
}

function assertResolvedBinding(
  provider: ChatProvider,
  binding: agentV1Runtime.ProviderBinding,
): void {
  if (provider.name !== binding.effectiveProvider || provider.model !== binding.effectiveModel) {
    throw new ProviderGatewayError(
      'provider_binding_mismatch',
      'resolved provider does not match the sealed effective binding',
    );
  }
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  return raceAbort(iterator.next(), signal);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function gatewayFailure(cause: unknown, signal: AbortSignal): ProviderGatewayError {
  if (signal.aborted && signal.reason instanceof ProviderGatewayError) return signal.reason;
  if (cause instanceof ProviderGatewayError) return cause;
  return new ProviderGatewayError('provider_failed', 'provider operation failed', { cause });
}

function terminalEvent(
  identity: agentV1Common.AttemptIdentity,
  operationId: string,
  assembler: ProviderStreamAssembler | undefined,
  classification: agentV1Runtime.ProviderTerminalClassification,
  reasonCode: string,
  now: number,
): ProviderGatewayEvent {
  const eventSequence = assembler?.nextEventSequence() ?? 1n;
  return {
    case: 'providerTerminal',
    value: create(agentV1Runtime.ProviderTerminalSchema, {
      identity,
      operationId,
      eventSequence,
      classification,
      reasonCode: terminalReason(reasonCode),
      responseId: assembler?.responseId,
      responseMessageCount: assembler?.responseMessageCount,
      finalUsage: assembler?.finalUsage,
      completedAtUnixMs: BigInt(now),
    }),
  };
}
