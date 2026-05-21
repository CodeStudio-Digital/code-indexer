import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type {
  AgentMessage,
  ChatDelta,
  ChatProviderResponseMeta,
  ContentBlock,
} from '@mcp/code-agent/core/messages.js';

type AnthropicResolvedRequestModel = {
  apiModel: string;
  requestedModel?: string;
  displayModel?: string;
  maxTokens?: number;
  betas?: string[];
  thinking?: Record<string, unknown>;
  outputConfig?: Record<string, unknown>;
  effort?: string | null;
};

type AnthropicStreamUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

type AnthropicStreamEvent = {
  type: string;
  index?: number;
  message?: { usage?: Partial<AnthropicStreamUsage> };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  usage?: { output_tokens?: number };
};

type AnthropicHeadersLike = {
  get(name: string): string | null;
  forEach(callback: (value: string, key: string) => void): void;
};

type AnthropicResponseLike = {
  status: number;
  ok: boolean;
  headers: AnthropicHeadersLike;
};

type AnthropicRawStreamResult = {
  stream: AsyncIterable<AnthropicStreamEvent>;
  response: AnthropicResponseLike | null;
  requestId: string | null | undefined;
};

/**
 * Anthropic chat adapter with tool use and streaming.
 *
 * Translates the normalized AgentMessage format to Anthropic's
 * messages.create() schema and re-emits stream events as ChatDelta.
 */
export class AnthropicChatProvider implements ChatProvider {
  readonly name: string;
  model: string;
  private client: Anthropic;
  private defaultMetadata?: Anthropic.Metadata;
  private defaultBetas?: string[];
  private defaultTemperature?: number;
  private defaultMaxTokens?: number;
  private defaultThinking?: Record<string, unknown>;
  private defaultOutputConfig?: Record<string, unknown>;
  private defaultSystemPrefixBlocks?: Anthropic.TextBlockParam[];
  private resolveModel?: (model: string, req: ChatRequest) => AnthropicResolvedRequestModel;
  private useBetaMessages: boolean;
  private streamViaCreate: boolean;

  constructor(opts: {
    apiKey?: string;
    authToken?: string;
    baseURL?: string;
    model?: string;
    defaultHeaders?: Record<string, string>;
    defaultMetadata?: Anthropic.Metadata;
    defaultBetas?: string[];
    defaultTemperature?: number;
    defaultMaxTokens?: number;
    defaultThinking?: Record<string, unknown>;
    defaultOutputConfig?: Record<string, unknown>;
    systemPrefixBlocks?: Anthropic.TextBlockParam[];
    resolveModel?: (model: string, req: ChatRequest) => AnthropicResolvedRequestModel;
    maxRetries?: number;
    streamViaCreate?: boolean;
    dangerouslyAllowBrowser?: boolean;
    fetch?: typeof fetch;
    useBetaMessages?: boolean;
    name?: string;
  }) {
    this.name = opts.name ?? 'anthropic';
    this.model = opts.model ?? 'claude-sonnet-4-6';
    this.defaultMetadata = opts.defaultMetadata;
    this.defaultBetas = opts.defaultBetas;
    this.defaultTemperature = opts.defaultTemperature;
    this.defaultMaxTokens = opts.defaultMaxTokens;
    this.defaultThinking = opts.defaultThinking;
    this.defaultOutputConfig = opts.defaultOutputConfig;
    this.defaultSystemPrefixBlocks = opts.systemPrefixBlocks;
    this.resolveModel = opts.resolveModel;
    this.useBetaMessages = opts.useBetaMessages ?? false;
    this.streamViaCreate = opts.streamViaCreate ?? false;
    this.client = new Anthropic({
      apiKey: opts.authToken ? null : (opts.apiKey ?? process.env.ANTHROPIC_API_KEY),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
      ...(opts.dangerouslyAllowBrowser !== undefined
        ? { dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser }
        : {}),
      ...(opts.fetch ? { fetch: opts.fetch as unknown as ClientOptions['fetch'] } : {}),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const messages = req.messages.map(toAnthropicMessage).filter((m): m is Anthropic.MessageParam => m !== null);
    const tools: Anthropic.Tool[] = req.tools.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
      // Cache breakpoint on the LAST tool covers the entire tools[] array.
      ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    // Claude Code OAuth requires the canonical billing+identity prefix at the
    // start of the system array (mirrors Og8/Mg8 in the upstream bundle).
    // Cache the whole system on the LAST block — that breakpoint covers every
    // preceding block, identical across every turn.
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    if (this.defaultSystemPrefixBlocks?.length) {
      systemBlocks.push(...this.defaultSystemPrefixBlocks);
    }
    if (req.system) {
      systemBlocks.push({ type: 'text', text: req.system });
    }
    if (systemBlocks.length > 0) {
      const lastIdx = systemBlocks.length - 1;
      systemBlocks[lastIdx] = {
        ...systemBlocks[lastIdx],
        cache_control: { type: 'ephemeral' as const },
      };
    }

    const resolvedModel = this.resolveModel?.(this.model, req);
    const thinking = resolvedModel?.thinking ?? (req.thinking ? this.defaultThinking : undefined);
    const outputConfig = resolvedModel?.outputConfig ?? this.defaultOutputConfig;

    // Anthropic extended thinking requires either temperature=1 or omitted.
    // The runner's `resolveTemperature` already returns undefined when thinking
    // is on for this provider, but guard here too — defense in depth keeps the
    // adapter safe if a caller bypasses the resolver.
    const temperature = thinking
      ? undefined
      : (req.inference?.temperature ?? this.defaultTemperature);

    // Anthropic API requires max_tokens > budget_tokens. The default
    // max_tokens (8192) is smaller than a typical thinking budget (32000),
    // so auto-bump max_tokens to leave ~4k of headroom for the actual output.
    const baseMaxTokens = resolvedModel?.maxTokens ?? this.defaultMaxTokens ?? 8192;
    const budgetTokens =
      thinking && typeof (thinking as { budget_tokens?: number }).budget_tokens === 'number'
        ? (thinking as { budget_tokens: number }).budget_tokens
        : 0;
    const max_tokens = thinking ? Math.max(baseMaxTokens, budgetTokens + 4096) : baseMaxTokens;

    const params = {
      model: resolvedModel?.apiModel ?? this.model,
      max_tokens,
      system: systemBlocks.length > 0 ? systemBlocks : undefined,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      metadata: this.defaultMetadata,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(this.useBetaMessages && (resolvedModel?.betas ?? this.defaultBetas)?.length
        ? { betas: resolvedModel?.betas ?? this.defaultBetas }
        : {}),
    };
    let stream: AsyncIterable<AnthropicStreamEvent>;
    let finalMessage: (() => Promise<{ usage?: Partial<AnthropicStreamUsage> }>) | null = null;
    let responseMeta: ChatProviderResponseMeta | null = null;
    if (this.streamViaCreate) {
      const raw = await this.createRawStream(params, req.signal);
      stream = raw.stream;
      responseMeta = buildAnthropicResponseMeta({
        params,
        response: raw.response,
        requestId: raw.requestId,
        resolvedModel,
        useBetaMessages: this.useBetaMessages,
      });
    } else if (this.useBetaMessages) {
      const helper = this.client.beta.messages.stream(
        params as Parameters<typeof this.client.beta.messages.stream>[0],
      );
      const wrapped = await helper.withResponse();
      stream = wrapped.data as AsyncIterable<AnthropicStreamEvent>;
      finalMessage = () => helper.finalMessage() as Promise<{ usage?: Partial<AnthropicStreamUsage> }>;
      responseMeta = buildAnthropicResponseMeta({
        params,
        response: wrapped.response,
        requestId: wrapped.request_id,
        resolvedModel,
        useBetaMessages: true,
      });
    } else {
      const helper = this.client.messages.stream(params as Anthropic.MessageStreamParams);
      const wrapped = await helper.withResponse();
      stream = wrapped.data as AsyncIterable<AnthropicStreamEvent>;
      finalMessage = () => helper.finalMessage() as Promise<{ usage?: Partial<AnthropicStreamUsage> }>;
      responseMeta = buildAnthropicResponseMeta({
        params,
        response: wrapped.response,
        requestId: wrapped.request_id,
        resolvedModel,
        useBetaMessages: false,
      });
    }

    if (responseMeta) {
      yield { type: 'response_meta', meta: responseMeta };
    }

    // Track in-progress tool uses indexed by content block index
    const toolBlocks = new Map<number, { id: string; name: string; jsonAcc: string }>();
    const usage: AnthropicStreamUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    let sawUsage = false;

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          const messageUsage = event.message?.usage;
          if (messageUsage) {
            usage.input_tokens = messageUsage.input_tokens ?? usage.input_tokens;
            usage.output_tokens = messageUsage.output_tokens ?? usage.output_tokens;
            usage.cache_creation_input_tokens =
              messageUsage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens;
            usage.cache_read_input_tokens =
              messageUsage.cache_read_input_tokens ?? usage.cache_read_input_tokens;
            sawUsage = true;
          }
          break;
        }
        case 'content_block_start': {
          const block = event.content_block;
          if (block?.type === 'tool_use' && event.index !== undefined && block.id && block.name) {
            toolBlocks.set(event.index, { id: block.id, name: block.name, jsonAcc: '' });
            yield { type: 'tool_call_start', id: block.id, name: block.name };
          }
          break;
        }
        case 'content_block_delta': {
          const d = event.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            yield { type: 'text_delta', text: d.text };
          } else if (
            d?.type === 'input_json_delta' &&
            typeof d.partial_json === 'string' &&
            event.index !== undefined
          ) {
            const tb = toolBlocks.get(event.index);
            if (tb) {
              tb.jsonAcc += d.partial_json;
              yield { type: 'tool_call_args', id: tb.id, partial_json: d.partial_json };
            }
          }
          break;
        }
        case 'content_block_stop': {
          if (event.index === undefined) break;
          const tb = toolBlocks.get(event.index);
          if (tb) {
            let input: Record<string, unknown> = {};
            try {
              input = tb.jsonAcc ? JSON.parse(tb.jsonAcc) : {};
            } catch {
              input = { _raw: tb.jsonAcc };
            }
            yield { type: 'tool_call_end', id: tb.id, name: tb.name, input };
            toolBlocks.delete(event.index);
          }
          break;
        }
        case 'message_delta': {
          if (event.usage) {
            usage.output_tokens = event.usage.output_tokens ?? usage.output_tokens;
            sawUsage = true;
          }
          break;
        }
        case 'message_stop':
          yield { type: 'done' };
          break;
        default:
          break;
      }
    }

    if (finalMessage) {
      // Final usage from the completed message is more complete on the SDK helper.
      const final = await finalMessage();
      if (final.usage) {
        yield {
          type: 'usage',
          usage: {
            input_tokens: final.usage.input_tokens ?? 0,
            output_tokens: final.usage.output_tokens ?? 0,
            cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
          },
        };
      }
      return;
    }

    if (sawUsage) {
      yield {
        type: 'usage',
        usage,
      };
    }
  }

  private async createRawStream(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AnthropicRawStreamResult> {
    const requestOptions = signal ? { signal } : undefined;
    if (this.useBetaMessages) {
      const response = await this.client.beta.messages.create(
        { ...params, stream: true } as Parameters<typeof this.client.beta.messages.create>[0],
        requestOptions,
      ).withResponse();
      return {
        stream: response.data as AsyncIterable<AnthropicStreamEvent>,
        response: response.response,
        requestId: response.request_id,
      };
    }
    const response = await this.client.messages.create(
      { ...params, stream: true } as Anthropic.MessageCreateParamsStreaming,
      requestOptions,
    ).withResponse();
    return {
      stream: response.data as AsyncIterable<AnthropicStreamEvent>,
      response: response.response,
      requestId: response.request_id,
    };
  }
}

function buildAnthropicResponseMeta(input: {
  params: Record<string, unknown>;
  response: AnthropicResponseLike | null;
  requestId: string | null | undefined;
  resolvedModel: AnthropicResolvedRequestModel | undefined;
  useBetaMessages: boolean;
}): ChatProviderResponseMeta {
  const headers = input.response?.headers ?? null;
  const thinking = asRecord(input.params.thinking);
  const outputConfig = asRecord(input.params.output_config);
  const betas = Array.isArray(input.params.betas)
    ? input.params.betas.filter((b): b is string => typeof b === 'string')
    : null;
  const requestId =
    input.requestId ??
    headers?.get('request-id') ??
    headers?.get('anthropic-request-id') ??
    headers?.get('x-request-id') ??
    null;
  const effort =
    input.resolvedModel?.effort ??
    asString(outputConfig?.effort) ??
    asString(thinking?.effort) ??
    null;

  return {
    path: input.useBetaMessages ? '/v1/messages?beta=true' : '/v1/messages',
    request: {
      api_model: asString(input.params.model) ?? input.resolvedModel?.apiModel ?? null,
      requested_model: input.resolvedModel?.requestedModel ?? null,
      display_model: input.resolvedModel?.displayModel ?? null,
      max_tokens: asNumber(input.params.max_tokens),
      stream: true,
      betas,
      thinking_type: asString(thinking?.type),
      effort,
    },
    response: {
      status: input.response?.status ?? null,
      ok: input.response?.ok ?? null,
      request_id: requestId,
      retry_after: headers?.get('retry-after') ?? null,
      x_should_retry: headers?.get('x-should-retry') ?? null,
      rate_limits: collectAnthropicRateLimitHeaders(headers),
    },
  };
}

function collectAnthropicRateLimitHeaders(headers: AnthropicHeadersLike | null): Record<string, string | null> | null {
  if (!headers) return null;
  const out: Record<string, string | null> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('anthropic-ratelimit-')) {
      out[lower] = value;
    }
  });
  return Object.keys(out).length > 0 ? out : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toAnthropicMessage(m: AgentMessage): Anthropic.MessageParam | null {
  // Anthropic has only 'user' and 'assistant' roles. Tool results are sent as
  // a user message containing tool_result blocks.
  if (m.role === 'system') return null;

  if (m.role === 'tool') {
    return {
      role: 'user',
      content: m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error ?? false,
        })),
    };
  }

  if (m.role === 'user') {
    const userContent: Anthropic.ContentBlockParam[] = m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
      if (b.type === 'text') return [{ type: 'text' as const, text: b.text }];
      if (b.type === 'tool_result') {
        return [{
          type: 'tool_result' as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error ?? false,
        }];
      }
      if (b.type === 'image') {
        return [{
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: (b.mediaType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
            data: b.base64,
          },
        }];
      }
      if (b.type === 'document') {
        if (b.base64 && b.mediaType === 'application/pdf') {
          return [{
            type: 'document' as const,
            source: {
              type: 'base64' as const,
              media_type: 'application/pdf' as const,
              data: b.base64,
            },
          }];
        }
        if (b.text) {
          return [{ type: 'text' as const, text: `<document name="${b.name}" mediaType="${b.mediaType}">\n${b.text}\n</document>` }];
        }
        return [];
      }
      return [];
    });
    return { role: 'user', content: userContent };
  }

  // assistant
  const assistantContent: Anthropic.ContentBlockParam[] = m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    if (b.type === 'tool_use') {
      return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
    }
    return [];
  });
  return { role: 'assistant', content: assistantContent };
}
