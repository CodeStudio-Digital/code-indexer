import OpenAI from 'openai';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';

/**
 * OpenAI-compatible chat adapter (works with OpenAI, ZAI/GLM, DeepSeek and any
 * provider that implements the OpenAI chat completions schema with function
 * calling and streaming).
 */
export type OpenAICompatVendor = 'openai' | 'zai' | 'deepseek' | 'copilot';

export class OpenAIChatProvider implements ChatProvider {
  readonly name: string;
  model: string;
  private client: OpenAI;
  private vendor: OpenAICompatVendor;

  constructor(opts: {
    name?: string;
    apiKey?: string;
    baseURL?: string;
    model: string;
    defaultHeaders?: Record<string, string>;
    vendor?: OpenAICompatVendor;
  }) {
    this.name = opts.name ?? 'openai';
    this.model = opts.model;
    this.vendor = opts.vendor ?? 'openai';
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
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
      // Only glm-5.x accepts the `thinking` parameter; glm-4.* rejects it with 400.
      // Match `glm-5` (bare), `glm-5.1`, `glm-5-turbo` — the trailing
      // anchor (?:[.\-]|$) is critical: without it, plain `glm-5` falls
      // through and the server uses its OWN default (thinking on for
      // glm-5), so the chat shows "Pensando…" even when the user never
      // toggled `think+` in the composer.
      if (/^glm-5(?:[.\-]|$)/.test(this.model)) {
        zaiExtras.thinking = { type: req.thinking ? 'enabled' : 'disabled' };
      }
      const maxTokensEnv = process.env.ZAI_MAX_TOKENS;
      const parsed = maxTokensEnv ? Number(maxTokensEnv) : NaN;
      zaiExtras.max_tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 32_000;
    }

    // DeepSeek-V4: only explicitly enable thinking when the runner requests it.
    // Thinking is ON by default for V4 models — we never disable it via param
    // because: (a) the default is fine, (b) disabling would suppress reasoning_content
    // which we now pass back in multi-turn contexts (see toOpenAIMessages).
    const deepseekExtras: Record<string, unknown> = {};
    if (this.vendor === 'deepseek' && req.thinking === true) {
      deepseekExtras.thinking = { type: 'enabled' };
    }

    // Stable cache hint per session. OpenAI accepts `prompt_cache_key`
    // (https://platform.openai.com/docs/guides/prompt-caching#prompt-cache-key)
    // and routes the request to a server that has the prefix cached. DeepSeek
    // and other OpenAI-compatible vendors silently ignore unknown params, so
    // there's no harm sending it everywhere — when the vendor honors it we
    // get the cache hit, when it doesn't, no behavior change. Mirrors the
    // wiring already in kimi-code.ts for GLM-Code.
    const cacheKeyExtras: Record<string, unknown> =
      req.sessionId != null ? { prompt_cache_key: `coder-session-${req.sessionId}` } : {};

    // OpenAI o-series and gpt-5 reasoning variants reject `temperature !== 1`.
    // The runner's resolver already filters these models, but guard here too
    // since this adapter is shared across vendors. Copilot has been observed
    // to reject `top_p` paired with `temperature` — we only send temperature
    // in this MVP, so that conflict can't occur.
    const isReasoningModel = /^(o[134]([\-.].*)?$|gpt-5.*reason)/i.test(this.model);
    const temperature = isReasoningModel ? undefined : req.inference?.temperature;

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
        ...cacheKeyExtras,
      };
      stream = await this.client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
      );
    } catch (apiErr: any) {
      throw apiErr;
    }

    // Tool calls arrive in deltas indexed by `tool_calls[i].index`.
    const toolAcc = new Map<number, { id: string; name: string; argsAcc: string; emittedStart: boolean }>();

    for await (const chunk of stream) {
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
        };
        const cachedRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        const reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
        yield {
          type: 'usage',
          usage: {
            input_tokens: u.prompt_tokens ?? 0,
            output_tokens: u.completion_tokens ?? 0,
            cache_read_input_tokens: cachedRead,
            ...(reasoningTokens ? { thinking_tokens: reasoningTokens } : {}),
          },
        };
      }
      if (choice?.finish_reason) {
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
  }
}

type OAIMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAIMessages(system: string, messages: AgentMessage[], vendor?: OpenAICompatVendor): OAIMsg[] {
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
      > = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
          });
        } else if (b.type === 'document' && b.text) {
          parts.push({
            type: 'text',
            text: `<document name="${b.name}" mediaType="${b.mediaType}">\n${b.text}\n</document>`,
          });
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
