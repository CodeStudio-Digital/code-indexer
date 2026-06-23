/**
 * Drive the project's "general AI" provider to return a single JSON
 * object. Provider selection mirrors the git AI-plan path: prefer
 * `getGeneralDefault()`, else fall through to any enabled Anthropic /
 * OpenAI / OpenRouter / Z.AI / DeepSeek provider with an api_key.
 *
 * Returns the raw model text (caller strips fences + parses) or a
 * `refusal` string when no provider is usable / the call fails — so
 * callers surface an actionable message instead of throwing a 500.
 */
import type { HandlerDeps } from './types.js';

type ProviderCfg =
  | { kind?: string; api_key?: string | null; enabled?: boolean; base_url?: string | null }
  | null;

export interface AiJsonRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export type AiJsonResult = { raw: string } | { refusal: string };

function isUsable(p: ProviderCfg): boolean {
  if (!p?.enabled || !p.api_key) return false;
  const k = p.kind ?? '';
  return k === 'anthropic' || k === 'openai' || k === 'openrouter' || k === 'zai' || k === 'deepseek';
}

export function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

export async function callGeneralAiJson(
  deps: HandlerDeps,
  req: AiJsonRequest,
): Promise<AiJsonResult> {
  const { providerStore } = deps;

  const def = providerStore.getGeneralDefault();
  let cfg = (def ? providerStore.getProvider(def.providerId) : null) as ProviderCfg;
  let modelId = def?.modelId ?? '';
  if (!isUsable(cfg) || !modelId) {
    const fallback = providerStore.listProviders({ enabled: true }).find((p) => isUsable(p));
    if (!fallback) {
      return { refusal: 'No usable AI provider — set an API key for Anthropic / OpenAI / Z.AI / DeepSeek in Settings → Providers.' };
    }
    cfg = fallback;
    modelId = providerStore.listModels(fallback.id, true)[0]?.model_id ?? '';
    if (!modelId) return { refusal: 'Fallback provider has no enabled models.' };
  }
  if (!cfg) return { refusal: 'Provider config missing after selection.' };

  // Strip the ::mode suffix the dashboard appends; route Z.AI base URLs.
  let modelMode: string | undefined;
  if (modelId.includes('::')) [modelId, modelMode] = modelId.split('::', 2);
  let baseUrl: string | undefined = cfg.base_url ?? undefined;
  if (cfg.kind === 'zai') {
    if (process.env.ZAI_BASE_URL) baseUrl = process.env.ZAI_BASE_URL;
    else if (modelMode === 'coding') baseUrl = 'https://api.z.ai/api/coding/paas/v4/';
    else if (modelMode === 'general') baseUrl = 'https://api.z.ai/api/paas/v4/';
    else if (!baseUrl) baseUrl = 'https://api.z.ai/api/paas/v4/';
  } else if (cfg.kind === 'openrouter' && !baseUrl) {
    baseUrl = 'https://openrouter.ai/api/v1';
  }

  const maxTokens = req.maxTokens ?? 1500;
  try {
    if (cfg.kind === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: cfg.api_key ?? '', ...(baseUrl ? { baseURL: baseUrl } : {}) });
      const resp = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      });
      return {
        raw: resp.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join(''),
      };
    }
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: cfg.api_key ?? '', ...(baseUrl ? { baseURL: baseUrl } : {}) });
    const resp = await client.chat.completions.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    });
    return { raw: resp.choices[0]?.message?.content ?? '' };
  } catch (e) {
    return { refusal: `AI call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
