/**
 * binding-chat — shared "call an LLM through a ResolvedBinding" plumbing.
 *
 * Extracted from snapshot-review-pipeline so every one-shot pipeline
 * (snapshot review, task preflight, …) dispatches identically:
 *   - direct REST kinds → pickChatFn (openai-compatible / anthropic / gemini)
 *   - coder OAuth kinds → full coder provider client (token refresh etc.)
 *
 * `label` is the human-facing "pipeline/role" string used in error
 * messages; `codePrefix` namespaces the machine-readable error codes.
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import { createChatProviderAsync } from '../providers/factory.js';
import { pickChatFn } from './chat-dispatcher.js';
import type { ChatCallOptions, ChatCallResult, ChatMessage } from './llm-chat.js';

export const DIRECT_CHAT_KINDS = new Set([
  'anthropic',
  'cloudflare',
  'deepseek',
  'gemini',
  'mistral',
  'moonshot',
  'openai',
  'openrouter',
  'zai',
]);

export const CODER_CHAT_KINDS = new Set([
  'bedrock',
  'chatgpt',
  'claude-code',
  'copilot',
  'google-oauth',
  'kimi-code',
]);

export interface BindingProblem {
  code: string;
  message: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

/** Validate that a resolved binding can actually be called by a one-shot pipeline. */
export function bindingProblem(
  binding: ResolvedBinding,
  opts: { label: string; codePrefix: string },
): BindingProblem | null {
  const kind = binding.provider.kind;
  const providerName = binding.provider.name || binding.provider.id;
  if (!DIRECT_CHAT_KINDS.has(kind) && !CODER_CHAT_KINDS.has(kind)) {
    return {
      code: `${opts.codePrefix}_provider_unsupported`,
      message:
        `${opts.label} is bound to "${providerName}" (${kind}), which cannot be called by this pipeline. ` +
        'Use OpenAI, Anthropic, Gemini, OpenRouter, Cloudflare, DeepSeek, ZAI, Moonshot, ChatGPT/Codex, Claude Code, Copilot, Google OAuth, Kimi, or Bedrock.',
    };
  }
  if (DIRECT_CHAT_KINDS.has(kind) && !binding.provider.api_key) {
    return {
      code: `${opts.codePrefix}_missing_credentials`,
      message: `${opts.label} provider "${providerName}" is missing an API key.`,
    };
  }
  if (kind === 'cloudflare' && !binding.provider.extra?.account_id && !binding.provider.base_url?.includes('{account_id}')) {
    return {
      code: `${opts.codePrefix}_missing_credentials`,
      message: `${opts.label} provider "${providerName}" is missing Cloudflare account_id.`,
    };
  }
  return null;
}

/** Chat via the full coder provider client (OAuth kinds: token refresh, base-url …). */
export async function coderProviderChat(
  binding: ResolvedBinding,
  messages: ChatMessage[],
  options: ChatCallOptions,
): Promise<ChatCallResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort('aborted');
    else options.signal.addEventListener('abort', () => controller.abort('aborted'), { once: true });
  }
  try {
    const provider = await createChatProviderAsync(binding.provider.id, binding.modelId, {
      providerId: binding.provider.id,
    });
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const agentMessages = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: [{ type: 'text' as const, text: message.content }],
      }));
    let content = '';
    let ttftMs: number | undefined;
    let finishReason: ChatCallResult['finishReason'] = 'provider';
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    const stops = (options.stop ?? []).filter(Boolean);
    // OAuth adapters do not expose a per-request max-output knob consistently.
    // Guard the stream locally so a completion can stop as soon as one useful
    // line/block exists instead of buffering an agent-sized answer.
    const maxChars = Math.max(16, (options.maxTokens ?? 128) * 4);
    for await (const delta of provider.chat({
      system,
      messages: agentMessages,
      tools: [],
      thinking: false,
      // Codex/OAuth honors an explicit effort (clamped to supported levels)
      // and an AbortSignal — wire both so latency-critical one-shots (preflight)
      // can force minimal reasoning and actually cancel on timeout.
      reasoningEffort: options.reasoningEffort ?? 'minimal',
      signal: controller.signal,
      inference: { temperature: options.temperature },
    })) {
      if (delta.type === 'text_delta') {
        if (ttftMs === undefined && delta.text.length > 0) ttftMs = performance.now() - startedAt;
        content += delta.text;
        let cut = -1;
        for (const stop of stops) {
          const at = content.indexOf(stop);
          if (at >= 0 && (cut < 0 || at < cut)) cut = at;
        }
        if (cut >= 0) {
          content = content.slice(0, cut);
          finishReason = 'local_stop';
          controller.abort('local_stop');
          break;
        }
        if (content.length >= maxChars) {
          content = content.slice(0, maxChars);
          finishReason = 'local_max_tokens';
          controller.abort('local_max_tokens');
          break;
        }
      }
      if (delta.type === 'usage') {
        tokensIn = delta.usage.input_tokens;
        tokensOut = delta.usage.output_tokens;
      }
    }
    return { content, tokensIn, tokensOut, latencyMs: performance.now() - startedAt, ttftMs, finishReason };
  } catch (e) {
    const reason = controller.signal.reason;
    return {
      content: '',
      errorBody: e instanceof Error ? e.message : String(e),
      latencyMs: performance.now() - startedAt,
      finishReason: reason === 'timeout' ? 'timeout' : reason === 'aborted' ? 'aborted' : 'error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Dispatch to the coder client (OAuth kinds) or the direct REST adapters. */
export async function callConfiguredChat(
  binding: ResolvedBinding,
  messages: ChatMessage[],
  options: ChatCallOptions,
): Promise<ChatCallResult> {
  if (CODER_CHAT_KINDS.has(binding.provider.kind)) {
    return coderProviderChat(binding, messages, options);
  }
  return pickChatFn(binding)(binding, messages, options);
}

/** Human-friendly rendering of a provider errorBody (HTML pages, blobs …). */
export function friendlyProviderError(
  binding: ResolvedBinding,
  errorBody: string,
  label: string,
): string {
  const providerName = binding.provider.name || binding.provider.id;
  if (/^\s*</.test(errorBody) || /<html[\s>]/i.test(errorBody) || /<!doctype html/i.test(errorBody)) {
    return (
      `Provider "${providerName}" returned an HTML page instead of an API response. ` +
      `Check that ${label} uses an API-compatible provider and base URL.`
    );
  }
  return truncate(errorBody.replace(/\s+/g, ' ').trim(), 700);
}
