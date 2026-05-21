/**
 * geminiChat — same shape as openAiCompatibleChat but speaks Google's
 * Gemini REST API natively.
 *
 * Used when the resolved binding's provider has `kind: 'gemini'`. URL
 * pattern:
 *   https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import type { ChatCallOptions, ChatCallResult, ChatMessage } from './llm-chat.js';

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart { text: string; }
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[]; }
interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
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
  if (temperature !== undefined || maxTokens !== undefined) {
    body.generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    };
  }

  const timeoutMs = options.timeoutMs ?? Math.max(1000, toNumber(cfg.timeout) ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - startedAt;
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      return { content: '', errorBody: errorBody.slice(0, 2000), latencyMs };
    }
    const parsed = (await res.json()) as GeminiResponse;
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
    return { content: '', errorBody: (e as Error).message, latencyMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
