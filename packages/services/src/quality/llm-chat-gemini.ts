/**
 * geminiChat — same shape as openAiCompatibleChat but speaks Google's
 * Gemini REST API natively.
 *
 * Used when the resolved binding's provider has `kind: 'gemini'`. URL
 * pattern:
 *   https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import { type ChatCallOptions, type ChatCallResult, type ChatMessage, parseRetryAfter } from './llm-chat.js';

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart { text: string; }
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[]; }
interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    thinkingConfig?: { thinkingBudget: number };
  };
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function resolveBaseUrl(binding: ResolvedBinding, override?: string): string {
  if (override) return override;
  if (binding.provider.base_url && binding.provider.base_url.trim().length > 0) {
    return binding.provider.base_url;
  }
  return GEMINI_DEFAULT_BASE_URL;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function splitMessages(messages: ChatMessage[]): { systemText: string | undefined; contents: GeminiContent[] } {
  const systems: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
    } else {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    systemText: systems.length > 0 ? systems.join('\n\n') : undefined,
    contents,
  };
}

export async function geminiChat(
  binding: ResolvedBinding,
  messages: ChatMessage[],
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const startedAt = performance.now();
  const baseUrl = resolveBaseUrl(binding, options.baseUrlOverride);
  const apiKey = binding.provider.api_key ?? '';
  const url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(binding.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const cfg = binding.config as Record<string, unknown>;
  const { systemText, contents } = splitMessages(messages);

  const body: GeminiRequestBody = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  const temperature = options.temperature ?? toNumber(cfg.temperature);
  const maxTokens = options.maxTokens ?? toNumber(cfg.max_tokens);
  const stop = (options.stop ?? []).slice(0, 4);
  if (temperature !== undefined || maxTokens !== undefined || stop.length > 0 || options.disableThinking) {
    body.generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      ...(stop.length > 0 ? { stopSequences: stop } : {}),
      // Gemini 2.5+ default-ON reasoning eats the whole token budget on
      // latency-critical calls; budget 0 turns it off.
      ...(options.disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    };
  }

  const timeoutMs = options.timeoutMs ?? Math.max(1000, toNumber(cfg.timeout) ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const fetchImpl = options.fetchFn ?? fetch;
  try {
    controller.signal.throwIfAborted();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - startedAt;
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      controller.signal.throwIfAborted();
      return {
        content: '',
        errorBody: errorBody.slice(0, 2000),
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        latencyMs,
      };
    }
    const parsed = (await res.json()) as GeminiResponse;
    controller.signal.throwIfAborted();
    const content = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    return {
      content,
      tokensIn: parsed.usageMetadata?.promptTokenCount,
      tokensOut: parsed.usageMetadata?.candidatesTokenCount,
      latencyMs,
    };
  } catch (e) {
    return { content: '', errorBody: e instanceof Error ? e.message : String(e), latencyMs: performance.now() - startedAt,
      finishReason: controller.signal.aborted ? options.signal?.aborted ? 'aborted' : 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
