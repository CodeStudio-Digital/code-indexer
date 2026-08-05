import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { ChatDelta } from '@mcp/provider-sdk/wire.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import type {
  ProviderGatewayEvent,
  ProviderGatewayLimits,
} from './ProviderGatewayTypes.js';
import {
  boundedText,
  phaseToWire,
  terminalReason,
  usageToWire,
} from './ProviderGatewayValidation.js';
import { canonicalJson, stringifyInput } from './ProviderToolJson.js';

interface PartialToolCall {
  readonly name: string;
  readonly chunks: string[];
  bytes: number;
}

export type ProviderStreamOutcome =
  | { kind: 'continue'; event?: ProviderGatewayEvent }
  | { kind: 'done'; reasonCode: string };

export class ProviderStreamAssembler {
  readonly #tools = new Map<string, PartialToolCall>();
  #sequence = 0n;
  #eventCount = 0;
  #responseId: string | undefined;
  #responseMessageCount: bigint | undefined;
  #lastUsage: agentV1Runtime.ProviderUsage | undefined;

  constructor(
    readonly identity: agentV1Common.AttemptIdentity,
    readonly operationId: string,
    readonly limits: ProviderGatewayLimits,
  ) {}

  get responseId(): string | undefined {
    return this.#responseId;
  }

  get finalUsage(): agentV1Runtime.ProviderUsage | undefined {
    return this.#lastUsage;
  }

  get responseMessageCount(): bigint | undefined {
    return this.#responseMessageCount;
  }

  nextEventSequence(): bigint {
    return this.#nextSequence();
  }

  accept(delta: ChatDelta): ProviderStreamOutcome {
    this.#eventCount += 1;
    if (this.#eventCount > this.limits.maxStreamEvents) {
      throw new ProviderGatewayError(
        'provider_stream_limit_exceeded',
        'provider stream event ceiling exceeded',
      );
    }
    switch (delta.type) {
      case 'text_delta':
        this.#boundedEvent(delta.text);
        return { kind: 'continue', event: this.#text(delta) };
      case 'thinking_delta':
        this.#boundedEvent(delta.text);
        return { kind: 'continue', event: this.#thinking(delta.text) };
      case 'tool_call_start':
        this.#startTool(delta.id, delta.name);
        return { kind: 'continue' };
      case 'tool_call_args':
        this.#appendTool(delta.id, delta.partial_json);
        return { kind: 'continue' };
      case 'tool_call_end':
        return { kind: 'continue', event: this.#endTool(delta.id, delta.name, delta.input) };
      case 'usage':
        this.#lastUsage = usageToWire(delta.usage);
        return { kind: 'continue', event: this.#usage(this.#lastUsage) };
      case 'response_id':
        boundedText(delta.id, 'responseId');
        if (!Number.isSafeInteger(delta.messageCount) || delta.messageCount < 0) {
          throw new ProviderGatewayError(
            'provider_delta_unsupported',
            'provider response message count is invalid',
          );
        }
        this.#responseId = delta.id;
        this.#responseMessageCount = BigInt(delta.messageCount);
        return { kind: 'continue' };
      case 'response_meta':
        return { kind: 'continue' };
      case 'done':
        if (this.#tools.size !== 0) throw toolError('provider ended with incomplete tool calls');
        return {
          kind: 'done',
          reasonCode: terminalReason(
            delta.stop_reason ? `provider_done:${delta.stop_reason}` : 'provider_completed',
          ),
        };
      case 'image_generated':
        throw new ProviderGatewayError(
          'provider_delta_unsupported',
          'image-generated delta has no Provider v1 wire representation',
        );
      default:
        throw new ProviderGatewayError(
          'provider_delta_unsupported',
          'provider emitted an unknown additive delta',
        );
    }
  }

  #text(delta: Extract<ChatDelta, { type: 'text_delta' }>): ProviderGatewayEvent {
    return {
      case: 'providerTextDelta',
      value: create(agentV1Runtime.ProviderTextDeltaSchema, {
        identity: this.identity,
        operationId: this.operationId,
        eventSequence: this.#nextSequence(),
        text: delta.text,
        itemId: delta.itemId,
        phase: phaseToWire(delta.phase),
      }),
    };
  }

  #thinking(text: string): ProviderGatewayEvent {
    return {
      case: 'providerThinkingDelta',
      value: create(agentV1Runtime.ProviderThinkingDeltaSchema, {
        identity: this.identity,
        operationId: this.operationId,
        eventSequence: this.#nextSequence(),
        text,
      }),
    };
  }

  #usage(usage: agentV1Runtime.ProviderUsage): ProviderGatewayEvent {
    return {
      case: 'providerUsage',
      value: create(agentV1Runtime.ProviderUsageEventSchema, {
        identity: this.identity,
        operationId: this.operationId,
        eventSequence: this.#nextSequence(),
        usage,
      }),
    };
  }

  #startTool(id: string, name: string): void {
    boundedText(id, 'toolUseId');
    boundedText(name, 'capabilityName');
    if (this.#tools.has(id)) throw toolError('duplicate provider tool call start');
    if (this.#tools.size >= this.limits.maxBufferedToolCalls) {
      throw new ProviderGatewayError(
        'provider_stream_limit_exceeded',
        'provider buffered tool call ceiling exceeded',
      );
    }
    this.#tools.set(id, { name, chunks: [], bytes: 0 });
  }

  #appendTool(id: string, json: string): void {
    const partial = this.#tools.get(id);
    if (!partial) throw toolError('provider tool arguments precede start');
    const bytes = Buffer.byteLength(json);
    partial.bytes += bytes;
    if (partial.bytes > this.limits.maxToolArgumentsBytes) {
      throw new ProviderGatewayError(
        'provider_stream_limit_exceeded',
        'provider tool arguments exceed byte ceiling',
      );
    }
    partial.chunks.push(json);
  }

  #endTool(id: string, name: string, input: Record<string, unknown>): ProviderGatewayEvent {
    const partial = this.#tools.get(id);
    if (!partial || partial.name !== name) throw toolError('provider tool end does not match start');
    const json = partial.chunks.length > 0
      ? partial.chunks.join('')
      : stringifyInput(input);
    if (Buffer.byteLength(json) > this.limits.maxToolArgumentsBytes) {
      throw new ProviderGatewayError(
        'provider_stream_limit_exceeded',
        'provider tool arguments exceed byte ceiling',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (cause) {
      throw toolError('provider tool arguments are invalid JSON', cause);
    }
    const encodedInput = stringifyInput(input);
    if (Buffer.byteLength(encodedInput) > this.limits.maxToolArgumentsBytes) {
      throw new ProviderGatewayError(
        'provider_stream_limit_exceeded',
        'provider terminal tool input exceeds byte ceiling',
      );
    }
    if (canonicalJson(parsed) !== canonicalJson(JSON.parse(encodedInput))) {
      throw toolError('provider tool argument stream disagrees with terminal input');
    }
    this.#tools.delete(id);
    const encoded = new TextEncoder().encode(json);
    return {
      case: 'providerToolCall',
      value: create(agentV1Runtime.ProviderToolCallSchema, {
        identity: this.identity,
        operationId: this.operationId,
        eventSequence: this.#nextSequence(),
        toolUseId: id,
        capabilityName: name,
        encodedJsonArguments: encoded,
        argumentsSha256: createHash('sha256').update(encoded).digest(),
      }),
    };
  }

  #boundedEvent(value: string): void {
    if (Buffer.byteLength(value) > this.limits.maxEventBytes) {
      throw new ProviderGatewayError(
        'provider_stream_limit_exceeded',
        'provider event exceeds byte ceiling',
      );
    }
  }

  #nextSequence(): bigint {
    this.#sequence += 1n;
    return this.#sequence;
  }
}

function toolError(message: string, cause?: unknown): ProviderGatewayError {
  return new ProviderGatewayError('provider_tool_stream_invalid', message, { cause });
}
