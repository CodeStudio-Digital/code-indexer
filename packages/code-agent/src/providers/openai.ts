import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { getMaxOutputTokens } from '@mcp/code-agent/providers/capabilities.js';
import {
  renderTextDocument,
  safeDocumentFilename,
  unsupportedBinaryDocumentText,
} from './document-utils.js';

/**
 * OpenAI-compatible chat adapter (works with OpenAI, OpenRouter, ZAI/GLM, DeepSeek and any
 * provider that implements the OpenAI chat completions schema with function
 * calling and streaming).
 */
export type OpenAICompatVendor = 'openai' | 'openrouter' | 'zai' | 'deepseek' | 'copilot' | 'fugu';

export class OpenAIChatProvider implements ChatProvider {
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

    // Z.AI / GLM extensions. These fields are not in the OpenAI SDK type but
    // the wire protocol is OpenAI-compatible; cast at the call site. Gated on
    // vendor+model family so DeepSeek/Copilot/OpenAI don't receive unknown params.
    const zaiExtras: Record<string, unknown> = {};
    if (this.vendor === 'zai') {
      zaiExtras.tool_stream = true;
      // `thinking` is accepted by GLM-4.5+ and the entire GLM-5 family
      // (docs.z.ai/guides/capabilities/thinking). Earlier GLM-4.x
      // variants (4-air, 4-flash, 4.3, 4.4, …) reject it with HTTP 400
      // "unknown field", so we keep the regex narrow:
      //   - `glm-5`, `glm-5.1`, `glm-5-turbo`     (5 anything)
      //   - `glm-4.5`, `glm-4.6`, `glm-4.7`        and `.x-air`/`.x-flash` variants
      // We always set it explicitly (enabled OR disabled) instead of
      // omitting on `false`. Z.AI's server default for these models is
      // "model decides" — omitting would let it think even when the
      // user didn't toggle the composer flag, mismatching the UI.
      if (/^glm-(?:5(?:[.\-]|$)|4\.[567])/.test(this.model)) {
        zaiExtras.thinking = { type: req.thinking ? 'enabled' : 'disabled' };
      }
      // Keep the wire payload aligned with the model capability used for
      // context reservation. A provider-instance DB override wins; otherwise
      // use the DB/registry/fallback resolution chain.
      zaiExtras.max_tokens =
        this.modelMaxOutputTokens?.[this.model] ?? getMaxOutputTokens(this.model);
    }

    // DeepSeek-V4: only explicitly enable thinking when the runner requests it.
    // Thinking is ON by default for V4 models — we never disable it via param
    // because: (a) the default is fine, (b) disabling would suppress reasoning_content
    // which we now pass back in multi-turn contexts (see toOpenAIMessages).
    const deepseekExtras: Record<string, unknown> = {};
    if (this.vendor === 'deepseek' && req.thinking === true) {
      deepseekExtras.thinking = { type: 'enabled' };
    }

    // OpenRouter normalizes reasoning controls across providers via the
    // `reasoning` parameter. An explicit effort override (composer/role) wins:
    // OpenRouter accepts `reasoning.effort` (low/medium/high) and maps it per
    // upstream model. Otherwise fall back to budget (when supplied) or the
    // model's default reasoning mode when `thinking` is on.
    const openrouterExtras: Record<string, unknown> = {};
    if (this.vendor === 'openrouter') {
      if (req.reasoningEffort) {
        openrouterExtras.reasoning = { effort: req.reasoningEffort };
      } else if (req.thinking === true) {
        openrouterExtras.reasoning =
          typeof req.thinkingBudgetTokens === 'number' && req.thinkingBudgetTokens > 0
            ? { max_tokens: req.thinkingBudgetTokens }
            : { enabled: true };
      }
    }

    // Sakana Fugu reasons by default; its OpenAI-compatible Chat Completions takes
    // the discrete effort as the STRING field `reasoning_effort` (high/xhigh/max,
    // where xhigh==max). Forward the user-selected level when present; omitting it
    // lets Fugu apply its server-side default (xhigh). Gated on vendor so other
    // OpenAI-compatible vendors never receive the field.
    const fuguExtras: Record<string, unknown> = {};
    if (this.vendor === 'fugu' && req.reasoningEffort) {
      fuguExtras.reasoning_effort = req.reasoningEffort;
    }

    // Stable cache/routing hint per session. OpenRouter Chat Completions uses
    // `session_id` as its documented sticky-routing key; OpenAI uses
    // `prompt_cache_key`. Do not rely on OpenRouter silently accepting the
    // OpenAI-only field: without session_id a cold first request does not pin
    // the follow-up to the endpoint that owns the newly-written cache.
    const stableSessionId =
      req.sessionId != null ? `coder-session-${req.sessionId}` : null;
    const cacheKeyExtras: Record<string, unknown> =
      stableSessionId == null
        ? {}
        : this.vendor === 'openrouter'
          ? { session_id: stableSessionId }
          : { prompt_cache_key: stableSessionId };

    // OpenAI o-series and gpt-5 reasoning variants reject `temperature !== 1`.
    // The runner's resolver already filters these models, but guard here too
    // since this adapter is shared across vendors. Copilot has been observed
    // to reject `top_p` paired with `temperature` — we only send temperature
    // in this MVP, so that conflict can't occur.
    const isReasoningModel = /^(o[134]([\-.].*)?$|gpt-5.*reason)/i.test(this.model);
    // Legacy Kimi Code rows can still resolve through the generic OpenAI wire
    // (`provider_configs.id='kimi-code', kind='openai'`). K3 rejects every
    // temperature except 1, so enforce the invariant here as well as in the
    // dedicated Kimi adapter. This is deliberately keyed to the exact model id.
    const isKimiK3 = /^k3$/i.test(this.model);
    const temperature = isKimiK3
      ? 1
      : isReasoningModel ? undefined : req.inference?.temperature;

    const kimiK3Extras: Record<string, unknown> = {};
    if (isKimiK3 && req.reasoningEffort) {
      kimiK3Extras.reasoning_effort = req.reasoningEffort;
    }

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
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...zaiExtras,
        ...deepseekExtras,
        ...openrouterExtras,
        ...fuguExtras,
        ...kimiK3Extras,
        ...cacheKeyExtras,
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
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
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
        if (delta?.content) {
          yield { type: 'text_delta', text: delta.content };
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

type OAIMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAIMessages(system: string, messages: AgentMessage[], vendor?: OpenAICompatVendor): OAIMsg[] {
  const out: OAIMsg[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'tool') {
      // Each tool_result becomes a separate `role: 'tool'` message
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.content,
        });
      }
      continue;
    }

    if (m.role === 'user') {
      // Build a multimodal content array (text + image_url) when applicable.
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'file'; file: { filename: string; file_data: string } }
      > = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
          });
        } else if (
          b.type === 'document'
          && b.base64
          && (vendor === 'openai' || vendor === 'openrouter')
        ) {
          parts.push({
            type: 'file',
            file: {
              filename: safeDocumentFilename(b),
              file_data: `data:${b.mediaType};base64,${b.base64}`,
            },
          });
        } else if (b.type === 'document' && (b.text || b.path)) {
          parts.push({
            type: 'text',
            text: renderTextDocument(b),
          });
        } else if (b.type === 'document' && b.base64) {
          parts.push({ type: 'text', text: unsupportedBinaryDocumentText(b) });
        }
      }
      const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      if (parts.length > 0) {
        const onlyText = parts.every((p) => p.type === 'text');
        if (onlyText) {
          out.push({ role: 'user', content: parts.map((p) => (p as { text: string }).text).join('\n') });
        } else {
          out.push({ role: 'user', content: parts as unknown as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] });
        }
      }
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const reasoning = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
        .map((b) => b.text)
        .join('');
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      // DeepSeek V4 requires reasoning_content to be passed back in multi-turn
      // conversations that include tool calls — without it the API rejects the
      // request. Other vendors ignore unknown fields, so it's safe to include
      // for deepseek only to avoid polluting other providers' payloads.
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: text || "",
        ...(vendor === 'deepseek' ? { reasoning_content: reasoning } : {}),
      };
      if (toolUses.length > 0) {
        msg['tool_calls'] = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }));
      }
      out.push(msg as unknown as OAIMsg);
    }
  }

  // Guard: strict OpenAI-compatible providers (GLM/ZAI) may reject messages
  // that don't start with a user turn after the system message. This can
  // happen when the summarizer replaces the opening user message with a
  // synthetic assistant summary.
  if (out.length > 1 && out[1].role !== 'user') {
    out.splice(1, 0, { role: 'user', content: '[Conversation continues from summarized context.]' });
  }

  return out;
}
