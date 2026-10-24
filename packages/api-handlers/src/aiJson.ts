/**
 * Drive the project's "general AI" provider to return a single JSON
 * object. Provider selection mirrors the git AI-plan path: prefer
 * `getGeneralDefault()`, else fall through to any enabled Anthropic /
 * OpenAI / OpenRouter / Z.AI / DeepSeek provider with an api_key.
 *
 * The actual LLM call is delegated to the SAME provider engine the chat
 * uses (`createCoderProvider`), so every provider-specific routing detail
 * is inherited automatically: Z.AI's `extra.zai_mode='coding'` plan
 * endpoint, OpenRouter's base URL, vendor-specific body shaping, and
 * stream resilience. The previous hand-rolled OpenAI/Anthropic clients
 * ignored `extra.zai_mode`, so Coding-Plan users hit the pay-as-you-go
 * general endpoint and got `429 Insufficient balance`.
 *
 * Returns the raw model text (caller strips fences + parses) or a
 * `refusal` string when no provider is usable / the call fails — so
 * callers surface an actionable message instead of throwing a 500.
 */
import type { HandlerDeps } from './types.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { AgentMessage } from "@mcp/provider-sdk";

type ProviderCfg =
  | { kind?: string; api_key?: string | null; enabled?: boolean; base_url?: string | null }
  | null;

export interface AiJsonRequest {
  system: string;
  user: string;
  /**
   * Soft hint only. The streaming `ChatProvider` contract has no max-tokens
   * field, so this is no longer forwarded to the wire — kept for caller
   * source-compat. These calls are short (commit msg / pipeline / script).
   */
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

  // Resolve which provider + model to use (kept here so the "not configured"
  // refusal strings stay stable — callers match them to surface a 412).
  const def = providerStore.getGeneralDefault();
  const defCfg = (def ? providerStore.getProvider(def.providerId) : null) as ProviderCfg;
  let providerId = def?.providerId ?? '';
  let modelId = def?.modelId ?? '';
  if (!isUsable(defCfg) || !modelId) {
    const fallback = providerStore.listProviders({ enabled: true }).find((p) => isUsable(p));
    if (!fallback) {
      return { refusal: 'No usable AI provider — set an API key for Anthropic / OpenAI / Z.AI / DeepSeek in Settings → Providers.' };
    }
    providerId = fallback.id;
    modelId = providerStore.listModels(fallback.id, true)[0]?.model_id ?? '';
    if (!modelId) return { refusal: 'Fallback provider has no enabled models.' };
  }

  // Delegate to the real engine — it resolves the Z.AI coding endpoint,
  // OpenRouter base, vendor shaping, and stream resilience for us.
  try {
    const provider = await createCoderProvider(providerId, modelId);
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: req.user }] },
    ];
    let raw = '';
    for await (const d of provider.chat({
      system: req.system,
      messages,
      tools: [],
      inference: { temperature: 0 },
    })) {
      if (d.type === 'text_delta') raw += d.text;
    }
    return { raw };
  } catch (e) {
    return { refusal: `AI call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
