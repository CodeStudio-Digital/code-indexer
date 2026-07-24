/**
 * anthropicChat — same shape as openAiCompatibleChat but speaks the
 * Anthropic Messages API natively.
 *
 * Used when the resolved binding's provider has `kind: 'anthropic'`.
 * `pickChatFn` dispatches to this adapter.
 *
 * Important: Anthropic's API requires `max_tokens` (no default), so we
 * default to 1024 if not provided in the binding's config.
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import { type ChatCallOptions, type ChatCallResult, type ChatMessage, parseRetryAfter } from './llm-chat.js';

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_DEFAULT_VERSION = '2023-06-01';

interface AnthropicMessage { role: 'user' | 'assistant'; content: string; }
interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  temperature?: number;
  stop_sequences?: string[];
}
interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function resolveBaseUrl(binding: ResolvedBinding, override?: string): string {
  if (override) return override;
  if (binding.provider.base_url && binding.provider.base_url.trim().length > 0) {
    return binding.provider.base_url;
  }
  return ANTHROPIC_DEFAULT_BASE_URL;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Translate the generic [ChatMessage]] list into Anthropic's split shape
 * (system separate, alternating user/assistant). If multiple `system`
 * messages are present they are concatenated.
 */
function splitMessages(messages: ChatMessage[]): { system: string | undefined; conversation: AnthropicMessage[] } {
  const systems: string[] = [];
  const conversation: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
    } else {
      // Anthropic treats 'tool' / 'tool_result' shapes specially — we
      // collapse to user/assistant because these single-shot helpers do not
      // model tool calls.
      conversation.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      });
    }
  }
  return {
    system: systems.length > 0 ? systems.join('\n\n') : undefined,
    conversation,
  };
}

export async function anthropicChat(
  binding: ResolvedBinding,
  messages: ChatMessage[],
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const startedAt = performance.now();
  const baseUrl = resolveBaseUrl(binding, options.baseUrlOverride);
  const url = `${baseUrl.replace(/\/+$/, '')}/messages`;
  const cfg = binding.config as Record<string, unknown>;
  const { system, conversation } = splitMessages(messages);

  const body: AnthropicRequestBody = {
    model: binding.modelId,
    max_tokens: options.maxTokens ?? toNumber(cfg.max_tokens) ?? 1024,
    messages: conversation,
    temperature: options.temperature ?? toNumber(cfg.temperature),
  };
  if (system) body.system = system;
  // Anthropic rejects whitespace-only stop sequences — filter them out
  // (callers pass things like '\n\n' for single-line autocomplete cuts).
  const stop = (options.stop ?? []).filter((s) => s.trim().length > 0);
  if (stop.length > 0) body.stop_sequences = stop.slice(0, 4);

  const timeoutMs = options.timeoutMs ?? Math.max(1000, toNumber(cfg.timeout) ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const fetchImpl = options.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': (cfg.anthropic_version as string | undefined) ?? ANTHROPIC_DEFAULT_VERSION,
        ...(binding.provider.api_key ? { 'x-api-key': binding.provider.api_key } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - startedAt;
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      return {
        content: '',
        errorBody: errorBody.slice(0, 2000),
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        latencyMs,
      };
    }
    const parsed = (await res.json()) as AnthropicResponse;
    const content = (parsed.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    return {
      content,
      tokensIn: parsed.usage?.input_tokens,
      tokensOut: parsed.usage?.output_tokens,
      latencyMs,
    };
  } catch (e) {
    return { content: '', errorBody: (e as Error).message, latencyMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
