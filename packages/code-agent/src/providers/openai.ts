import { buildOpenAIRequestExtras } from './openai-request.js';
import { toOpenAIMessages } from './openai-messages.js';
import type { OpenAICompatVendor } from './openai-messages.js';
export type { OpenAICompatVendor } from './openai-messages.js';
export { toOpenAIMessages } from './openai-messages.js';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

export class OpenAIChatProvider implements ChatProvider {
  readonly toolLimits: ChatProvider['toolLimits'];
  readonly name: string;
  model: string;
  private client: OpenAI;
  private vendor: OpenAICompatVendor;
  // Declarative request shaping (set only when a provider's `request` descriptor
  // is present; undefined for every built-in → native behavior unchanged).
  private bodyInject?: Record<string, unknown>;
  private bodyRemove?: string[];
  private reasoningDeltaKey?: string;
  /** Provider-instance overrides keyed by bare model id. */
  private modelMaxOutputTokens?: Readonly<Record<string, number>>;

  constructor(opts: {
    name?: string;
    apiKey?: string;
    baseURL?: string;
    model: string;
    defaultHeaders?: Record<string, string>;
    vendor?: OpenAICompatVendor;
    /** Custom auth header (from `request.auth`). Replaces the SDK's Authorization. */
    authHeader?: { name: string; value: string };
    /** Query params appended to every request (from `request.query`). */
    defaultQuery?: Record<string, string>;
    /** Static body fields merged in (from `request.body.inject`). */
    bodyInject?: Record<string, unknown>;
    /** Top-level body keys removed before send (from `request.body.remove`). */
    bodyRemove?: string[];
    /** Non-standard reasoning delta key (from `request.response.reasoningDeltaKey`). */
    reasoningDeltaKey?: string;
    /** Persisted provider_models.default_max_tokens values for this instance. */
    modelMaxOutputTokens?: Readonly<Record<string, number>>;
  }) {
    this.name = opts.name ?? 'openai';
    this.model = opts.model;
    this.vendor = opts.vendor ?? 'openai';
    this.toolLimits = this.vendor === 'openai' && (!opts.baseURL || new URL(opts.baseURL).hostname === 'api.openai.com')
      ? { maxNameChars: 64, source: 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create' }
      : undefined;
    this.bodyInject = opts.bodyInject;
    this.bodyRemove = opts.bodyRemove;
    this.reasoningDeltaKey = opts.reasoningDeltaKey;
    this.modelMaxOutputTokens = opts.modelMaxOutputTokens;

    // Merge a custom auth header in, suppressing the SDK's native Authorization
    // when a differently-named header carries the credential (null omits it).
    const headers: Record<string, string | null> = { ...(opts.defaultHeaders ?? {}) };
    if (opts.authHeader) {
      headers[opts.authHeader.name] = opts.authHeader.value;
      if (opts.authHeader.name.toLowerCase() !== 'authorization') headers['Authorization'] = null;
    }

    this.client = new OpenAI({
      // Credentials come only from the resolved provider config — never the
      // environment. Empty string blocks the SDK's OPENAI_API_KEY auto-read;
      // an unconfigured provider then fails with a clean 401.
      apiKey: opts.apiKey ?? '',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
      ...(opts.defaultQuery ? { defaultQuery: opts.defaultQuery } : {}),
      // The behavior-tree runner owns retries/backoff/circuit breaking for
      // every OpenAI-compatible vendor. One adapter call maps to one physical
      // request so attempt telemetry remains truthful.
      maxRetries: 0,
      // Route through undici (native fetch) instead of the SDK's bundled
      // node-fetch@2 so installLlmDispatcher's bodyTimeout:0 applies to the
      // reasoning phase. See native-fetch.ts.
      fetch: nativeFetch(),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const messages = toOpenAIMessages(req.system, req.messages, this.vendor);
    const tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    const attemptStartedAt = Date.now();
    let attemptReported = false;
    let generationId: string | null = null;
    let upstreamProvider: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cachedTokens: number | null = null;
    let costUsd: number | null = null;
    let providerTerminalSeen = false;

    const reportAttempt = async (
      attempt: Omit<import('@mcp/provider-sdk').ProviderAttemptTelemetry, 'durationMs'>,
    ): Promise<void> => {
      if (attemptReported || !req.onAttempt) return;
      attemptReported = true;
      try {
        await req.onAttempt({
          ...attempt,
          durationMs: Math.max(0, Date.now() - attemptStartedAt),
        });
      } catch {
        // Telemetry must never break the provider stream.
      }
    };

    const reportFailure = async (raw: unknown): Promise<void> => {
      const error = raw as {
        status?: unknown;
        code?: unknown;
        request_id?: unknown;
        headers?: unknown;
        message?: unknown;
      };
      const status = typeof error.status === 'number' ? error.status : null;
      const requestId = typeof error.request_id === 'string' ? error.request_id : null;
      const headerGenerationId = readHeader(error.headers, 'x-generation-id');
      await reportAttempt({
        status,
        ok: false,
        generationId: headerGenerationId ?? generationId,
        requestId: requestId ?? readHeader(error.headers, 'x-request-id'),
        upstreamProvider:
          readHeader(error.headers, 'x-openrouter-provider') ?? upstreamProvider,
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd,
        retryAfter: readHeader(error.headers, 'retry-after'),
        errorCode: safeProviderErrorCode(error.code),
        // Provider messages can echo prompt fragments, URLs or credentials.
        // Persist only an error class plus a correlation hash.
        errorMessage: opaqueProviderErrorMessage(raw),
      });
    };

    let stream;
    try {
      // Pass stream:true as a typed literal so the overload resolves to the
      // streaming return type; spread vendor extras via an untyped cast since
      // the SDK types don't know about GLM-specific fields.
      const params = {
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true as const,
        stream_options: { include_usage: true },
        ...buildOpenAIRequestExtras(req, this.vendor, this.model, this.modelMaxOutputTokens),
      };
      // Declarative body shaping (custom providers only). Re-assert the
      // streaming invariants afterward so a descriptor can't break the stream.
      if (this.bodyRemove || this.bodyInject) {
        const p = params as Record<string, unknown>;
        if (this.bodyRemove) for (const k of this.bodyRemove) delete p[k];
        if (this.bodyInject) Object.assign(p, this.bodyInject);
        p.model = this.model;
        p.messages = messages;
        p.stream = true;
        p.stream_options = { include_usage: true };
      }
      stream = await this.client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (apiErr: any) {
      await reportFailure(apiErr);
      throw apiErr;
    }

    // Tool calls arrive in deltas indexed by `tool_calls[i].index`.
    const toolAcc = new Map<number, { id: string; name: string; argsAcc: string; emittedStart: boolean }>();

    try {
      for await (const chunk of stream) {
        const rawChunk = chunk as unknown as {
          id?: unknown;
          provider?: unknown;
          usage?: unknown;
        };
        if (generationId == null && typeof rawChunk.id === 'string') {
          generationId = rawChunk.id;
        }
        if (upstreamProvider == null && typeof rawChunk.provider === 'string') {
          upstreamProvider = rawChunk.provider;
        }
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        const content = (delta as { content?: unknown } | undefined)?.content;
        if (typeof content === 'string' && content.length > 0) {
          yield { type: 'text_delta', text: content };
        } else if (Array.isArray(content)) {
          // Mistral streams reasoning as a list of ThinkChunk/TextChunk values,
          // then switches back to a plain string for the final answer.
          for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            const record = part as Record<string, unknown>;
            if (record.type === 'thinking') {
              for (const text of readMistralThinkingTexts(record.thinking)) {
                yield { type: 'thinking_delta', text };
              }
            } else if (record.type === 'text' && typeof record.text === 'string' && record.text) {
              yield { type: 'text_delta', text: record.text };
            }
          }
        }
      // GLM / DeepSeek-R1 expose chain-of-thought via reasoning_content on the
      // delta. Field is absent on vanilla OpenAI responses.
      const reasoning = (delta as { reasoning_content?: unknown })?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { type: 'thinking_delta', text: reasoning };
      }
      const openrouterReasoning = (delta as { reasoning?: unknown })?.reasoning;
      if (typeof openrouterReasoning === 'string' && openrouterReasoning.length > 0) {
        yield { type: 'thinking_delta', text: openrouterReasoning };
      } else {
        // Some OpenRouter upstreams expose only the structured reasoning_details
        // stream. Surface text details without duplicating the normalized
        // `delta.reasoning` value when both are present.
        const details = (delta as { reasoning_details?: unknown })?.reasoning_details;
        if (Array.isArray(details)) {
          for (const detail of details) {
            if (!detail || typeof detail !== 'object') continue;
            const text = (detail as { text?: unknown }).text;
            if (typeof text === 'string' && text.length > 0) {
              yield { type: 'thinking_delta', text };
            }
          }
        }
      }
      // Declarative response mapping: a vendor exposing chain-of-thought under a
      // non-standard delta key (custom providers only).
      if (this.reasoningDeltaKey) {
        const custom = (delta as Record<string, unknown>)?.[this.reasoningDeltaKey];
        if (typeof custom === 'string' && custom.length > 0) {
          yield { type: 'thinking_delta', text: custom };
        }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let acc = toolAcc.get(idx);
          if (!acc) {
            acc = { id: tc.id ?? `tool_${idx}`, name: tc.function?.name ?? '', argsAcc: '', emittedStart: false };
            toolAcc.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.argsAcc += tc.function.arguments;
          if (!acc.emittedStart && acc.name) {
            acc.emittedStart = true;
            yield { type: 'tool_call_start', id: acc.id, name: acc.name };
          }
          if (tc.function?.arguments) {
            yield { type: 'tool_call_args', id: acc.id, partial_json: tc.function.arguments };
          }
        }
      }
        if (chunk.usage) {
        // OpenAI / ZAI / GLM return cached prompt tokens in prompt_tokens_details.
        // DeepSeek uses a different shape (prompt_cache_hit_tokens) — read both.
          const u = chunk.usage as unknown as {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
            reasoning_tokens?: number;
            cost?: number;
          };
          const cachedRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
          const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens;
          inputTokens = u.prompt_tokens ?? 0;
          outputTokens = u.completion_tokens ?? 0;
          cachedTokens = cachedRead;
          costUsd = typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null;
          yield {
            type: 'usage',
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_input_tokens: cachedRead,
              // OpenAI-style: prompt_tokens already INCLUDES cached tokens.
              prompt_tokens_total: inputTokens,
              ...(reasoningTokens ? { thinking_tokens: reasoningTokens } : {}),
            },
          };
        }
        if (choice?.finish_reason) {
        providerTerminalSeen = true;
        // Flush all tool calls now that the message is complete
        for (const acc of toolAcc.values()) {
          let input: Record<string, unknown> = {};
          try {
            input = acc.argsAcc ? JSON.parse(acc.argsAcc) : {};
          } catch {
            input = { _raw: acc.argsAcc };
          }
          yield { type: 'tool_call_end', id: acc.id, name: acc.name, input };
        }
        toolAcc.clear();
          yield { type: 'done', stop_reason: choice.finish_reason };
        }
      }
      if (providerTerminalSeen) {
        yield {
          type: 'response_meta',
          meta: {
            path: '/chat/completions',
            response: {
              status: 200,
              ok: true,
              // Chat-completion `id` is a generation id, not proof of an
              // upstream request id. Keep the identities distinct.
              request_id: null,
            },
          },
        };
      }
    } catch (streamErr) {
      await reportFailure(streamErr);
      throw streamErr;
    } finally {
      if (!attemptReported) {
        if (providerTerminalSeen) {
          await reportAttempt({
            status: 200,
            ok: true,
            generationId,
            requestId: null,
            upstreamProvider,
            inputTokens,
            outputTokens,
            cachedTokens,
            costUsd,
            retryAfter: null,
            errorCode: null,
            errorMessage: null,
          });
        } else {
          await reportAttempt({
            status: req.signal?.aborted ? 499 : null,
            ok: false,
            generationId,
            requestId: null,
            upstreamProvider,
            inputTokens,
            outputTokens,
            cachedTokens,
            costUsd,
            retryAfter: null,
            errorCode: req.signal?.aborted ? 'ABORTED' : 'STREAM_ENDED_NO_TERMINAL',
            errorMessage: req.signal?.aborted
              ? 'AbortError:provider-attempt-aborted'
              : 'ProviderStreamProtocolError:stream-ended-no-terminal',
          });
        }
      }
    }
  }
}

function safeProviderErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const safe = value.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
  return safe || null;
}

function opaqueProviderErrorMessage(raw: unknown): string {
  const name = raw instanceof Error && raw.name
    ? raw.name.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64)
    : 'ProviderError';
  const message = raw && typeof raw === 'object'
    && typeof (raw as { message?: unknown }).message === 'string'
    ? (raw as { message: string }).message
    : typeof raw === 'string'
      ? raw
      : Object.prototype.toString.call(raw);
  const hash = createHash('sha256').update(message).digest('hex');
  return `${name || 'ProviderError'}:sha256:${hash}`;
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readMistralThinkingTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => (
    part
    && typeof part === 'object'
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text]
      : []
  ));
}
