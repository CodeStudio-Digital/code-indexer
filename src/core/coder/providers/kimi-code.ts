import OpenAI from 'openai';
import type { ChatProvider, ChatRequest } from './adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '../core/messages.js';
import type { JsonSchema } from '../core/tool.js';

type KimiMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type KimiCodeThinkingMode = 'auto' | 'enabled' | 'disabled';

export class KimiCodeChatProvider implements ChatProvider {
  readonly name = 'kimi-code';
  model: string;
  private client: OpenAI;
  private thinkingMode: KimiCodeThinkingMode;

  constructor(opts: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    defaultHeaders?: Record<string, string>;
    thinkingMode?: KimiCodeThinkingMode;
  }) {
    this.model = opts.model ?? 'kimi-k2.6';
    this.thinkingMode = opts.thinkingMode ?? 'auto';
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? 'https://api.kimi.com/coding/v1',
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const messages = toKimiMessages(req.system, req.messages);
    const tools = req.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: normalizeKimiToolParameters(tool.parameters),
      },
    }));

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: resolveKimiMaxTokens(),
      ...(tools.length > 0 ? { tools } : {}),
      ...(req.sessionId != null ? { prompt_cache_key: `coder-session-${req.sessionId}` } : {}),
    };

    const effectiveThinking = resolveEffectiveThinking(this.model, req.thinking, this.thinkingMode);
    const temperature = shouldOmitKimiTemperature(this.model, effectiveThinking)
      ? undefined
      : req.inference?.temperature;
    if (typeof temperature === 'number') params.temperature = temperature;

    const thinking = kimiThinkingConfig(this.model, effectiveThinking);
    if (thinking) {
      params.thinking = thinking;
    }

    const stream = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    );

    const toolAcc = new Map<
      number,
      { id: string; name: string; argsAcc: string; emittedStart: boolean }
    >();
    let finished = false;

    const flushToolCalls = function* (): Iterable<ChatDelta> {
      for (const acc of toolAcc.values()) {
        let input: Record<string, unknown> = {};
        try {
          input = acc.argsAcc ? JSON.parse(acc.argsAcc) as Record<string, unknown> : {};
        } catch {
          input = { _raw: acc.argsAcc };
        }
        yield { type: 'tool_call_end', id: acc.id, name: acc.name, input };
      }
      toolAcc.clear();
    };

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      const reasoning = (delta as { reasoning_content?: unknown } | undefined)?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { type: 'thinking_delta', text: reasoning };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let acc = toolAcc.get(idx);
          if (!acc) {
            acc = {
              id: tc.id ?? `tool_${idx}`,
              name: tc.function?.name ?? '',
              argsAcc: '',
              emittedStart: false,
            };
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

      const usage = (chunk as unknown as { usage?: KimiUsage }).usage;
      if (usage) {
        yield {
          type: 'usage',
          usage: {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            cache_read_input_tokens:
              usage.cached_tokens ??
              usage.prompt_tokens_details?.cached_tokens ??
              usage.prompt_cache_hit_tokens ??
              0,
            ...(usage.completion_tokens_details?.reasoning_tokens
              ? { thinking_tokens: usage.completion_tokens_details.reasoning_tokens }
              : {}),
          },
        };
      }

      if (choice?.finish_reason) {
        for (const d of flushToolCalls()) yield d;
        finished = true;
        yield { type: 'done', stop_reason: choice.finish_reason };
      }
    }

    if (!finished) {
      for (const d of flushToolCalls()) yield d;
      yield { type: 'done' };
    }
  }
}

interface KimiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function resolveKimiMaxTokens(): number {
  const parsed = Number(process.env.KIMI_CODE_MAX_TOKENS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32_000;
}

function isAlwaysThinkingModel(model: string): boolean {
  return /thinking/i.test(model);
}

function resolveEffectiveThinking(
  model: string,
  requestThinking: boolean | undefined,
  providerMode: KimiCodeThinkingMode,
): boolean | undefined {
  // Always-thinking model variants ignore both layers — they have no off switch.
  if (isAlwaysThinkingModel(model)) return true;
  // Per-request value wins when explicitly provided. Admin is the default,
  // not a hard cap — so a session can re-enable thinking even when the admin
  // global is `disabled`, and vice versa.
  if (requestThinking !== undefined) return requestThinking;
  if (providerMode === 'enabled') return true;
  if (providerMode === 'disabled') return false;
  return undefined;
}

export function shouldOmitKimiTemperature(model: string, thinking?: boolean): boolean {
  return thinking === true || isAlwaysThinkingModel(model) || /^kimi-k2\.(5|6)/i.test(model);
}

function kimiThinkingConfig(
  model: string,
  thinking: boolean | undefined,
): { type: 'enabled' | 'disabled' } | null {
  if (isAlwaysThinkingModel(model)) return { type: 'enabled' };
  if (thinking === undefined) return null;
  return { type: thinking ? 'enabled' : 'disabled' };
}

export function normalizeKimiToolParameters(schema: JsonSchema | unknown): Record<string, unknown> {
  const normalized = normalizeSchema(schema);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const obj = normalized as Record<string, unknown>;
    if (!obj.type) obj.type = 'object';
    return obj;
  }
  return { type: 'object', properties: {} };
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== 'object') return value;

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    out[key] = normalizeSchema(child);
  }

  if (!out.type) {
    if (out.properties && typeof out.properties === 'object') {
      out.type = 'object';
    } else if (out.items) {
      out.type = 'array';
    } else if (Array.isArray(out.enum) && out.enum.length > 0) {
      out.type = inferScalarType(out.enum[0]);
    } else if (out.const !== undefined) {
      out.type = inferScalarType(out.const);
    }
  }

  return out;
}

function inferScalarType(value: unknown): string {
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return 'string';
  }
}

export function toKimiMessages(system: string, messages: AgentMessage[]): KimiMsg[] {
  const out: KimiMsg[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'tool') {
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
      appendUserMessage(out, m.content);
      continue;
    }

    if (m.role === 'assistant') {
      appendAssistantMessage(out, m.content);
    }
  }

  if (out.length > 1 && out[1].role !== 'user') {
    out.splice(1, 0, { role: 'user', content: '[Conversation continues from summarized context.]' });
  }

  return out;
}

function appendUserMessage(out: KimiMsg[], blocks: ContentBlock[]): void {
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  const toolResults: Extract<ContentBlock, { type: 'tool_result' }>[] = [];

  for (const b of blocks) {
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
    } else if (b.type === 'tool_result') {
      toolResults.push(b);
    }
  }

  if (parts.length > 0) {
    const onlyText = parts.every((p) => p.type === 'text');
    if (onlyText) {
      out.push({
        role: 'user',
        content: parts.map((p) => (p as { text: string }).text).join('\n'),
      });
    } else {
      out.push({
        role: 'user',
        content: parts as unknown as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
      });
    }
  }

  for (const tr of toolResults) {
    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
  }
}

function appendAssistantMessage(out: KimiMsg[], blocks: ContentBlock[]): void {
  const reasoning = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.text)
    .join('');
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolUses = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );

  const msg: Record<string, unknown> = { role: 'assistant' };
  if (text || toolUses.length === 0) msg.content = text;
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolUses.length > 0) {
    msg.tool_calls = toolUses.map((tu) => ({
      id: tu.id,
      type: 'function' as const,
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      },
    }));
  }
  out.push(msg as unknown as KimiMsg);
}
