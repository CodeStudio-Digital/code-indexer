import { toKimiToolParam, summarizeAssistantContentTypes, toKimiMessages } from './kimi-code-messages.js';
import type { KimiReasoningKey } from './kimi-code-messages.js';
export { toKimiToolParam, normalizeKimiToolParameters, isEffectivelyEmptyText, toKimiMessages } from './kimi-code-messages.js';
import OpenAI from 'openai';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

import { kimiDebugEnabled, logKimiFinish, logKimiRequest, logKimiToolChunk, logKimiToolFlush } from '@mcp/code-agent/providers/kimi-code-debug.js';
export type KimiCodeThinkingMode = 'auto' | 'enabled' | 'disabled';
type KimiThinkingConfig = {
  type: 'enabled' | 'disabled';
  keep?: 'all';
  effort?: 'low' | 'high' | 'max';
};

export class KimiCodeChatProvider implements ChatProvider {
  readonly inferenceOnly = true;
  readonly name = 'kimi-code';
  model: string;
  private client: OpenAI;
  private thinkingMode: KimiCodeThinkingMode;
  private reasoningKey: KimiReasoningKey = 'reasoning_content';

  constructor(opts: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    defaultHeaders?: Record<string, string>;
    thinkingMode?: KimiCodeThinkingMode;
  }) {
    this.model = opts.model ?? 'kimi-for-coding';
    this.thinkingMode = opts.thinkingMode ?? 'auto';
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? 'https://api.kimi.com/coding/v1',
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
      maxRetries: 0,
      // Use undici (native fetch) so installLlmDispatcher's bodyTimeout:0
      // applies during the reasoning phase. See native-fetch.ts.
      fetch: nativeFetch(),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const effectiveThinking = resolveEffectiveThinking(
      this.model,
      req.reasoningEffort === 'none' ? false : req.thinking,
      this.thinkingMode,
    );
    const k3Effort = normalizeKimiK3ReasoningEffort(req.reasoningEffort);
    const thinking = kimiThinkingConfig(this.model, effectiveThinking, k3Effort);
    const preservedThinkingEnabled = thinking?.type === 'enabled' && thinking.keep === 'all';
    const messages = toKimiMessages(
      req.system,
      req.messages,
      preservedThinkingEnabled,
      this.reasoningKey,
    );
    const tools = req.tools.map((tool) => toKimiToolParam(tool));

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // Current Kimi Code reserves one shared completion budget for reasoning
      // and visible content. Its official client uses max_completion_tokens so
      // reasoning cannot consume a legacy max_tokens budget before text lands.
      max_completion_tokens: resolveKimiMaxTokens(),
      ...(tools.length > 0 ? { tools } : {}),
      ...(req.sessionId != null ? { prompt_cache_key: `coder-session-${req.sessionId}` } : {}),
    };

    // K3 is calibrated for temperature=1 and must not inherit a sticky
    // user/session override. Keep this at the wire boundary so every caller
    // (individual chat, Company roles, subagents, and summaries) agrees.
    const temperature = isKimiK3Model(this.model)
      ? 1
      : shouldOmitKimiTemperature(this.model, effectiveThinking)
        ? undefined
        : req.inference?.temperature;
    if (typeof temperature === 'number') params.temperature = temperature;

    if (thinking) {
      params.thinking = thinking;
    }

    if (kimiDebugEnabled()) {
      logKimiRequest({
        model: this.model,
        messageRoles: messages.map((m) => m.role),
        messageCount: messages.length,
        toolCount: tools.length,
        hasThinking: !!params.thinking,
        promptCacheKey:
          req.sessionId != null ? `coder-session-${req.sessionId}` : undefined,
        assistantContentTypes: summarizeAssistantContentTypes(messages),
      });
    }

    const stream = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      req.signal ? { signal: req.signal } : undefined,
    );

    const toolAcc = new Map<
      number,
      { id: string; name: string; argsAcc: string; emittedStart: boolean }
    >();
    let finished = false;

    const flushToolCalls = function* (): Iterable<ChatDelta> {
      for (const acc of toolAcc.values()) {
        let input: Record<string, unknown> = {};
        let parseOk = true;
        try {
          input = acc.argsAcc ? JSON.parse(acc.argsAcc) as Record<string, unknown> : {};
        } catch {
          parseOk = false;
          input = { _raw: acc.argsAcc };
        }
        if (kimiDebugEnabled()) {
          logKimiToolFlush({
            id: acc.id,
            name: acc.name,
            argsAccLen: acc.argsAcc.length,
            parseOk,
            argsPreview: acc.argsAcc,
          });
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

      const reasoning = readKimiReasoningDelta(delta);
      if (reasoning) {
        this.reasoningKey = reasoning.key;
        if (reasoning.text.length > 0) {
          yield { type: 'thinking_delta', text: reasoning.text };
        }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          // H6 fix: skip wholly-empty tool_call deltas (no id, name, or
          // arguments). Mirrors kosong's `skip empty tool calls` at
          // `.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:479-481`.
          // Without this, the accumulator creates a ghost entry with
          // `name=""` that the runner cannot dispatch, producing a
          // tool_use_block with no matching tool → retry loop.
          if (!tc.id && !tc.function?.name && !tc.function?.arguments) continue;
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
          if (kimiDebugEnabled()) {
            logKimiToolChunk({
              idx,
              id: tc.id,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments,
              argsAccLen: acc.argsAcc.length,
              emittedStart: acc.emittedStart,
            });
          }
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
            // OpenAI-compatible: prompt_tokens already INCLUDES cached tokens.
            prompt_tokens_total: usage.prompt_tokens ?? 0,
            ...(usage.completion_tokens_details?.reasoning_tokens
              ? { thinking_tokens: usage.completion_tokens_details.reasoning_tokens }
              : {}),
          },
        };
      }

      if (!finished && choice?.finish_reason) {
        for (const d of flushToolCalls()) yield d;
        finished = true;
        if (kimiDebugEnabled()) {
          logKimiFinish({ stopReason: choice.finish_reason, finishedNormally: true });
        }
        yield { type: 'done', stop_reason: choice.finish_reason };
      }
    }

    if (!finished) {
      if (kimiDebugEnabled()) {
        logKimiFinish({ finishedNormally: false });
      }
      // Do not flush an incomplete tool call or synthesize `done` from
      // transport EOF. The runner classifies the missing native
      // finish_reason as `stream_ended_no_result`.
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
  return /thinking/i.test(model)
    || isKimiK3Model(model)
    || /^kimi-for-coding(?:-highspeed)?$/i.test(model);
}

function isKimiK3Model(model: string): boolean {
  return /^k3(?:-|$)/i.test(model);
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
  return thinking === true
    || isAlwaysThinkingModel(model)
    || /^kimi-k2\.(5|6)/i.test(model);
}

export function normalizeKimiK3ReasoningEffort(
  effort: ChatRequest['reasoningEffort'],
): 'low' | 'high' | 'max' | undefined {
  if (!effort || effort === 'none') return undefined;
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'medium' || effort === 'high') return 'high';
  return 'max';
}

function kimiThinkingConfig(
  model: string,
  thinking: boolean | undefined,
  effort?: 'low' | 'high' | 'max',
): KimiThinkingConfig | null {
  if (isAlwaysThinkingModel(model)) {
    return {
      type: 'enabled',
      keep: 'all',
      ...(isKimiK3Model(model) && effort ? { effort } : {}),
    };
  }
  if (thinking === undefined) return null;
  if (!thinking) return { type: 'disabled' };
  return { type: 'enabled', keep: 'all' };
}

function readKimiReasoningDelta(
  delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
): { key: KimiReasoningKey; text: string } | null {
  if (!delta) return null;
  const candidate = delta as unknown as Partial<Record<KimiReasoningKey, unknown>>;
  for (const key of ['reasoning_content', 'reasoning_details', 'reasoning'] as const) {
    if (typeof candidate[key] === 'string') return { key, text: candidate[key] };
  }
  return null;
}
