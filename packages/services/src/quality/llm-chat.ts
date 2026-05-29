/**
 * Minimal OpenAI-compatible chat helper.
 *
 * The classifier pipeline needs to invoke an LLM for a single-shot
 * classification — system prompt + one user message → assistant text.
 * Reaching into the full `OpenAIChatProvider` would be overkill (it
 * handles streaming, tool-use, retries for a multi-turn conversation).
 *
 * This helper hits the OpenAI Chat Completions endpoint directly, which
 * works for every provider in the registry that uses OpenAI-compatible
 * REST: Cloudflare, OpenAI, OpenRouter, DeepSeek, ZAI, Moonshot, etc.
 *
 * Anthropic-native / Gemini-native shapes need their own helpers; this
 * one is named `openAiCompatibleChat` so it's obvious which dialect it
 * speaks.
 */
import type { ResolvedBinding } from '../pipelines/index.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCallResult {
  /** Raw text content of the assistant message. */
  content: string;
  /** Provider returned a non-2xx — kept here for diagnostics. */
  errorBody?: string;
  /** HTTP status when the provider returned a non-2xx. Undefined on
   *  network/abort/timeout errors (no response). Drives retry classification. */
  status?: number;
  /** Parsed `Retry-After` (ms) when the provider supplied the header. */
  retryAfterMs?: number;
  /** Usage in input/output tokens, if surfaced by the provider. */
  tokensIn?: number;
  tokensOut?: number;
  /** Wall-clock latency. */
  latencyMs: number;
}

export interface ChatCallOptions {
  /** Override the per-binding temperature. */
  temperature?: number;
  /** Override the per-binding max_tokens. */
  maxTokens?: number;
  /** Timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Optional override for the base URL. Otherwise read from binding.provider.base_url. */
  baseUrlOverride?: string;
  /** Optional fetch implementation — pass `vi.fn()` or a stub in tests. */
  fetchFn?: typeof fetch;
}

interface OpenAiChatBodyOpts {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /**
   * OpenAI-compatible JSON-mode flag. When set, the server constrains the
   * response to a valid JSON object. Supported by OpenAI, DeepSeek, Mistral,
   * Groq, Together, and a few others. ZAI / Cloudflare / Moonshot ignore it.
   * Enable per-binding via `config_json.json_mode = true`.
   */
  response_format?: { type: 'json_object' };
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const CLOUDFLARE_PATH_TEMPLATE = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1';

function resolveBaseUrl(binding: ResolvedBinding, override?: string): string {
  if (override) return override;
  const explicit = binding.provider.base_url;
  if (explicit && explicit.trim().length > 0) {
    if (explicit.includes('{account_id}')) {
      const accountId = (binding.provider.extra?.account_id ?? '') as string;
      return explicit.replace('{account_id}', accountId);
    }
    return explicit;
  }
  // Fall back to provider-kind defaults.
  switch (binding.provider.kind) {
    case 'cloudflare': {
      const accountId = ((binding.provider.extra?.account_id ?? '') as string);
      return CLOUDFLARE_PATH_TEMPLATE.replace('{account_id}', accountId);
    }
    case 'openai':   return 'https://api.openai.com/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'deepseek': return 'https://api.deepseek.com/v1';
    case 'zai':      return 'https://api.z.ai/api/coding/paas/v4';
    case 'moonshot': return 'https://api.moonshot.cn/v1';
    default:
      throw new Error(`No default base URL for provider kind '${binding.provider.kind}'`);
  }
}

/**
 * Make one OpenAI-compatible chat completion call using a `ResolvedBinding`.
 *
 * Designed to be safe to call from a pipeline scorer: never throws — on
 * any error returns `{ content: '', errorBody }` and lets the caller
 * decide whether to treat that as `verdict: 'error'`.
 */
export async function openAiCompatibleChat(
  binding: ResolvedBinding,
  messages: ChatMessage[],
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const startedAt = performance.now();
  const baseUrl = resolveBaseUrl(binding, options.baseUrlOverride);
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const cfg = binding.config as Record<string, unknown>;
  const body: OpenAiChatBodyOpts = {
    model: binding.modelId,
    messages,
    temperature: options.temperature ?? toNumber(cfg.temperature),
    max_tokens: options.maxTokens ?? toNumber(cfg.max_tokens),
  };
  // Opt-in JSON-mode (works on OpenAI / DeepSeek / Mistral / Groq / Together).
  if (cfg.json_mode === true) {
    body.response_format = { type: 'json_object' };
  }
  const timeoutMs = options.timeoutMs ?? Math.max(1000, toNumber(cfg.timeout) ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(binding.provider.api_key ? { authorization: `Bearer ${binding.provider.api_key}` } : {}),
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
    const parsed = (await res.json()) as OpenAiChatResponse;
    return {
      content: parsed.choices?.[0]?.message?.content ?? '',
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
      latencyMs,
    };
  } catch (e) {
    return { content: '', errorBody: (e as Error).message, latencyMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to ms. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
