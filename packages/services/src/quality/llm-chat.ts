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
  /** Time to first generated text; equals latency for non-streaming adapters. */
  ttftMs?: number;
  /** Why generation ended, including client-side stream guards. */
  finishReason?: 'provider' | 'local_stop' | 'local_max_tokens' | 'timeout' | 'aborted' | 'error';
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
  /**
   * Stop sequences (editor autocomplete: cut at fences/blank-runs). Mapped
   * per dialect: openai `stop`, anthropic `stop_sequences` (whitespace-only
   * entries filtered — the API rejects them), gemini `stopSequences`.
   * OAuth coder kinds ignore it — callers keep a client-side cut.
   */
  stop?: string[];
  /** External cancel (single-flight autocomplete) — chained into the per-call controller. */
  signal?: AbortSignal;
  /**
   * Ask the model to skip its reasoning phase (latency-critical callers:
   * editor autocomplete). Mapped per dialect — openai-compatible sends the
   * GLM-style `thinking: {type:'disabled'}`, gemini sends
   * `thinkingConfig.thinkingBudget: 0`. The CALLER gates this per
   * provider/model (OpenAI proper 400s on unknown body params).
   */
  disableThinking?: boolean;
  /**
   * Explicit reasoning-effort level (`minimal`/`low`/`medium`/`high`) for
   * providers that expose discrete effort (Codex via `reasoning.effort`).
   * Forwarded by the OAuth coder path (`coderProviderChat`) to the adapter,
   * which clamps it against the model's supported levels. The direct REST
   * path ignores it — it uses `disableThinking` for reasoning suppression.
   */
  reasoningEffort?: string;
}

interface OpenAiChatBodyOpts {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  thinking?: { type: 'disabled' };
  chat_template_kwargs?: { enable_thinking: boolean };
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

export function resolveBaseUrl(binding: ResolvedBinding, override?: string): string {
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
    case 'mistral':  return 'https://api.mistral.ai/v1';
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
  if (options.stop && options.stop.length > 0) {
    body.stop = options.stop.slice(0, 4);
  }
  if (options.disableThinking) {
    // Both dialects of the same knob — hosts ignore the one they don't
    // know (verified live): ZAI native reads `thinking`, vLLM-style hosts
    // (Cloudflare Workers AI) only honor `chat_template_kwargs`.
    body.thinking = { type: 'disabled' };
    body.chat_template_kwargs = { enable_thinking: false };
  }
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
        finishReason: 'error',
      };
    }
    const parsed = (await res.json()) as OpenAiChatResponse;
    return {
      content: parsed.choices?.[0]?.message?.content ?? '',
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
      latencyMs,
      ttftMs: latencyMs,
      finishReason: 'provider',
    };
  } catch (e) {
    const latencyMs = performance.now() - startedAt;
    const aborted = controller.signal.aborted;
    return {
      content: '', errorBody: (e as Error).message, latencyMs,
      finishReason: aborted ? (options.signal?.aborted ? 'aborted' : 'timeout') : 'error',
    };
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
