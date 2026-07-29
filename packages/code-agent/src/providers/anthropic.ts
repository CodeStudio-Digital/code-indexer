import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type {
  AgentMessage,
  ChatDelta,
  ChatProviderResponseMeta,
  ContentBlock,
} from '@mcp/code-agent/core/messages.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@mcp/code-agent/core/system-prompt.js';
import { renderTextDocument } from './document-utils.js';

export const ANTHROPIC_EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';

export type AnthropicResolvedRequestModel = {
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

export interface AnthropicRuntimeModelMetadata {
  supported_reasoning_levels?: readonly string[] | null;
}

const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function anthropicModelFamily(model: string): string {
  return model.replace(/\[(1|2)m\]$/i, '').toLowerCase();
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const family = anthropicModelFamily(model);
  return (
    family.includes('claude-fable-5') ||
    family.includes('claude-mythos-5') ||
    family.includes('claude-opus-5') ||
    family.includes('claude-opus-4-8') ||
    family.includes('claude-opus-4-7') ||
    family.includes('claude-opus-4-6') ||
    family.includes('claude-sonnet-5') ||
    family.includes('claude-sonnet-4-6')
  );
}

function anthropicDefaultMaxTokens(model: string): number {
  const family = anthropicModelFamily(model);
  if (
    family.includes('claude-fable-5') ||
    family.includes('claude-mythos-5') ||
    family.includes('claude-opus-5') ||
    family.includes('claude-opus-4-8') ||
    family.includes('claude-opus-4-7') ||
    family.includes('claude-opus-4-6') ||
    family.includes('claude-sonnet-5')
  ) {
    return 64_000;
  }
  if (
    family.includes('claude-sonnet-4-6') ||
    family.includes('claude-haiku-4-5')
  ) {
    return 32_000;
  }
  return 8_192;
}

/**
 * Resolve current first-party Anthropic model controls without leaking the
 * legacy `{type:"enabled", budget_tokens}` shape into adaptive-only models.
 * Fable 5 rejects disabled thinking, so it always receives adaptive thinking.
 */
export function resolveAnthropicRequestModel(
  model: string,
  req: Pick<ChatRequest, 'thinking' | 'reasoningEffort'>,
  metadata?: AnthropicRuntimeModelMetadata,
): AnthropicResolvedRequestModel {
  const adaptive = supportsAnthropicAdaptiveThinking(model);
  const family = anthropicModelFamily(model);
  const alwaysAdaptive =
    family.includes('claude-fable-5') || family.includes('claude-mythos-5');
  const requestedEffort = req.reasoningEffort?.trim().toLowerCase();
  const advertisedLevels = metadata?.supported_reasoning_levels?.map((level) =>
    level.toLowerCase(),
  );
  const effort =
    adaptive &&
    requestedEffort &&
    ANTHROPIC_EFFORT_LEVELS.includes(
      requestedEffort as (typeof ANTHROPIC_EFFORT_LEVELS)[number],
    ) &&
    (advertisedLevels == null || advertisedLevels.includes(requestedEffort))
      ? requestedEffort
      : null;
  const thinking =
    adaptive && (alwaysAdaptive || req.thinking === true || effort !== null)
      ? { type: 'adaptive' as const }
      : undefined;

  return {
    apiModel: model.replace(/\[(1|2)m\]$/i, ''),
    requestedModel: model,
    displayModel: model,
    maxTokens: anthropicDefaultMaxTokens(model),
    thinking,
    outputConfig: adaptive && effort ? { effort } : undefined,
    effort,
  };
}

export type AnthropicPromptCacheTtl = '5m' | '1h';

type AnthropicExtendedCacheControl = Anthropic.CacheControlEphemeral & {
  ttl?: AnthropicPromptCacheTtl;
};

function anthropicCacheControl(ttl?: AnthropicPromptCacheTtl): AnthropicExtendedCacheControl {
  return {
    type: 'ephemeral',
    ...(ttl ? { ttl } : {}),
  };
}

function isTransientConversationContextBlock(block: Anthropic.ContentBlockParam): boolean {
  if (block.type !== 'text') return false;
  const text = block.text.trimStart();
  return text.startsWith('<active_skills>')
    || text.startsWith('<active-context>')
    || text.startsWith('<system-reminder>');
}

/**
 * Pin a moving cache breakpoint to the newest cacheable conversation message.
 *
 * Anthropic caches the request prefix through the marked content block. Moving
 * this marker forward each turn lets the next request reuse the full prior
 * conversation instead of caching only the system prompt and tool schema.
 */
export function applyAnthropicMessageCacheBreakpoint(
  messages: readonly Anthropic.MessageParam[],
  ttl?: AnthropicPromptCacheTtl,
): Anthropic.MessageParam[] {
  let cacheMessageIndex = -1;
  let cacheBlockIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (typeof message.content === 'string') {
      if (
        message.role === 'user'
        && isTransientConversationContextBlock({ type: 'text', text: message.content })
      ) {
        continue;
      }
      cacheMessageIndex = index;
      break;
    }
    const lastBlock = message.content.at(-1);
    if (!lastBlock) continue;
    if (
      message.role === 'assistant'
      && (lastBlock.type === 'thinking' || lastBlock.type === 'redacted_thinking')
    ) {
      continue;
    }
    if (message.role === 'user') {
      let stableBlockIndex = -1;
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = message.content[blockIndex];
        if (block && !isTransientConversationContextBlock(block)) {
          stableBlockIndex = blockIndex;
          break;
        }
      }
      if (stableBlockIndex < 0) continue;
      cacheBlockIndex = stableBlockIndex;
    } else {
      cacheBlockIndex = message.content.length - 1;
    }
    cacheMessageIndex = index;
    break;
  }

  if (cacheMessageIndex < 0) return [...messages];

  return messages.map((message, index) => {
    if (index !== cacheMessageIndex) return message;
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: [{
          type: 'text' as const,
          text: message.content,
          cache_control: anthropicCacheControl(ttl),
        }],
      };
    }
    return {
      ...message,
      content: message.content.map((block, blockIndex) => blockIndex === cacheBlockIndex
        ? { ...block, cache_control: anthropicCacheControl(ttl) }
        : block),
    } as Anthropic.MessageParam;
  });
}

/** Build the provider system array while honoring the composer's cache split. */
export function buildAnthropicSystemBlocks(
  defaultPrefix: readonly Anthropic.TextBlockParam[] | undefined,
  system: string | undefined,
  ttl?: AnthropicPromptCacheTtl,
): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = defaultPrefix ? [...defaultPrefix] : [];
  let boundaryFound = false;
  let stableBoundaryIndex = -1;
  if (system) {
    const boundaryAt = system.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    if (boundaryAt >= 0) {
      boundaryFound = true;
      const stable = system.slice(0, boundaryAt).trimEnd();
      const dynamic = system.slice(boundaryAt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart();
      if (stable) {
        blocks.push({ type: 'text', text: stable });
        stableBoundaryIndex = blocks.length - 1;
      } else if (blocks.length > 0) {
        stableBoundaryIndex = blocks.length - 1;
      }
      if (dynamic) blocks.push({ type: 'text', text: dynamic });
    } else {
      blocks.push({ type: 'text', text: system });
    }
  }
  if (blocks.length > 0) {
    const cacheIdx = boundaryFound ? stableBoundaryIndex : blocks.length - 1;
    if (cacheIdx >= 0) {
      blocks[cacheIdx] = {
        ...blocks[cacheIdx],
        cache_control: anthropicCacheControl(ttl),
      };
    }
  }
  return blocks;
}

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
  private cacheMessages: boolean;
  private promptCacheTtl?: AnthropicPromptCacheTtl;

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
    cacheMessages?: boolean;
    promptCacheTtl?: AnthropicPromptCacheTtl;
    name?: string;
  }) {
    this.name = opts.name ?? 'anthropic';
    this.model = opts.model ?? 'claude-sonnet-5';
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
    this.cacheMessages = opts.cacheMessages ?? false;
    this.promptCacheTtl = opts.promptCacheTtl;
    this.client = new Anthropic({
      apiKey: opts.authToken ? null : (opts.apiKey ?? ''),
      // Runner recovery owns retries. Explicit override remains available to
      // non-runner hosts; the coder default is one physical attempt.
      maxRetries: opts.maxRetries ?? 0,
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
      ...(opts.dangerouslyAllowBrowser !== undefined
        ? { dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser }
        : {}),
      // Default to undici (native fetch) so installLlmDispatcher's bodyTimeout:0
      // applies during the reasoning phase and the SDK avoids bundled
      // node-fetch@2. An explicit opts.fetch (proxy/OAuth) still wins.
      fetch: (opts.fetch ?? nativeFetch()) as unknown as ClientOptions['fetch'],
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const rawMessages = req.messages
      .map(toAnthropicMessage)
      .filter((m): m is Anthropic.MessageParam => m !== null);
    const messages = this.cacheMessages
      ? applyAnthropicMessageCacheBreakpoint(rawMessages, this.promptCacheTtl)
      : rawMessages;
    const tools: Anthropic.Tool[] = req.tools.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
      // Cache breakpoint on the LAST tool covers the entire tools[] array.
      ...(i === arr.length - 1
        ? { cache_control: anthropicCacheControl(this.promptCacheTtl) }
        : {}),
    }));

    // Claude Code OAuth requires the canonical billing+identity prefix at the
    // start of the system array (mirrors Og8/Mg8 in the upstream bundle).
    // When the composer provides a cache boundary, cache only the stable prefix
    // and keep repo-map/tool-cap/skill variability in an uncached tail block.
    const systemBlocks = buildAnthropicSystemBlocks(
      this.defaultSystemPrefixBlocks,
      req.system,
      this.promptCacheTtl,
    );

    const resolvedModel = this.resolveModel?.(this.model, req);
    let thinking = resolvedModel?.thinking ?? (req.thinking ? this.defaultThinking : undefined);
    // Explicit budgets belong only to legacy `{ type: 'enabled' }` thinking.
    // Current Claude Code models use `{ type: 'adaptive' }`, where sending a
    // `budget_tokens` sibling is rejected by Anthropic's request schema.
    if (
      thinking &&
      (thinking as { type?: string }).type === 'enabled' &&
      typeof req.thinkingBudgetTokens === 'number' &&
      req.thinkingBudgetTokens > 0
    ) {
      thinking = { ...(thinking as Record<string, unknown>), budget_tokens: req.thinkingBudgetTokens };
    }
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
      // Prevent the SDK's "unhandled rejection on stream error" behaviour
      // (see @anthropic-ai/sdk MessageStream.ts:382-394 — when neither
      // `.done()` nor `.finalMessage()` was awaited AND no 'error'
      // listener is registered, the SDK synthesises `Promise.reject(error)`
      // on the next tick). Real errors still propagate through the
      // `for await (const event of stream)` consumer below — the listener
      // exists ONLY to flip the helper's internal `#catchingPromiseCreated`
      // flag so we don't pollute the log with `UnhandledPromiseRejection`
      // when the consumer breaks out of iteration on `this.aborted` and
      // `finalMessage()` never runs.
      helper.on('error', () => {
        /* swallowed — iterator path owns the real error handling */
      });
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
      // Same rationale as the beta branch above — see MessageStream.ts
      // :382-394 in the SDK for why this listener is required.
      helper.on('error', () => {
        /* swallowed — iterator path owns the real error handling */
      });
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
        const inputT = final.usage.input_tokens ?? 0;
        const cacheW = final.usage.cache_creation_input_tokens ?? 0;
        const cacheR = final.usage.cache_read_input_tokens ?? 0;
        yield {
          type: 'usage',
          usage: {
            input_tokens: inputT,
            output_tokens: final.usage.output_tokens ?? 0,
            cache_creation_input_tokens: cacheW,
            cache_read_input_tokens: cacheR,
            // Anthropic splits the prompt: input_tokens EXCLUDES cached slices.
            prompt_tokens_total: inputT + cacheW + cacheR,
          },
        };
      }
      return;
    }

    if (sawUsage) {
      yield {
        type: 'usage',
        usage: {
          ...usage,
          prompt_tokens_total:
            usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
        },
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
        if (b.text || b.path) {
          return [{ type: 'text' as const, text: renderTextDocument(b) }];
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
