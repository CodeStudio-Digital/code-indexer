import { defineProvider } from '../types.js';
import { ZAIProvider } from '@mcp/indexer/indexer/providers/zai.js';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';
import { parseModelWithMode } from '../shared/model-mode.js';

/**
 * Z.AI / Zhipu GLM. Uses OpenAI-compat wire protocol for both indexer
 * and coder. Per https://docs.z.ai/api-reference/llm/chat-completion,
 * the same model id can hit either the general PaaS endpoint or the
 * dedicated "GLM Coding Plan" endpoint — only the latter is gated by a
 * separate paid plan.
 *
 * Per-request mode (model-picker `::coding` / `::general` suffix) wins
 * over the persisted admin setting, so users can flip per-message
 * without reconfiguring. With no suffix we honour `cfg.base_url` from
 * the admin (so Coding-Plan users set it once and forget it), then
 * fall back to the general URL.
 *
 * The previous heuristic auto-routed glm-5.1 / glm-5-turbo / glm-4-plus
 * / codegeex-4* through the coding URL based on model name. That broke
 * for non-Coding-Plan users (401/403 on every request) — we now leave
 * the choice to admin config + `::mode` suffix instead.
 */
const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

/**
 * Resolve the coder baseURL.
 *   1. `process.env.ZAI_BASE_URL` always wins (test/dev override).
 *   2. Explicit `::coding` / `::general` suffix from the model picker
 *      overrides admin config for that one request.
 *   3. `adminBaseURL` (from `cfg.base_url`) — operator preference, set
 *      once in the admin. Coding-Plan users put the coding URL here.
 *   4. General URL — safe default for fresh installs.
 */
function resolveZaiCoderBaseURL(
  _model: string | undefined,
  mode: string | undefined,
  adminBaseURL: string | undefined,
): string {
  if (process.env.ZAI_BASE_URL) return process.env.ZAI_BASE_URL;
  if (mode === 'coding') return ZAI_CODING_URL;
  if (mode === 'general') return ZAI_GENERAL_URL;
  if (adminBaseURL && adminBaseURL.trim()) return adminBaseURL;
  return ZAI_GENERAL_URL;
}

export const zai = defineProvider({
  kind: 'zai',
  displayName: 'Z.AI / GLM',
  visual: { icon: 'Sparkles', fg: 'text-violet-500', bg: 'bg-violet-500/15' },
  credKind: 'api-key',
  envVars: ['ZAI_API_KEY'],
  defaultBaseURL: 'https://api.z.ai/api/paas/v4',
  // Catalog sourced from
  // https://docs.z.ai/api-reference/llm/chat-completion (Supported Models).
  // Kept narrow to flagship + flash tiers — the full list (incl. vision
  // and 128k variants) is still reachable via the `models` API; this
  // seed just keeps the picker tidy. Order: newest first, then by tier.
  defaultModels: [
    'glm-5.1',
    'glm-5-turbo',
    'glm-5',
    'glm-4.7',
    'glm-4.7-flash',
    'glm-4.6',
    'glm-4.5',
    'glm-4.5-air',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
  ],
  pricing: {
    'glm-5.1':              { inputPer1M: 0.60, outputPer1M: 2.20 },
    'glm-5-turbo':          { inputPer1M: 1.20, outputPer1M: 4.00 },
    'glm-5':                { inputPer1M: 0.60, outputPer1M: 2.20 },
    'glm-4.7':              { inputPer1M: 0.60, outputPer1M: 2.20 },
    'glm-4.7-flash':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4.6':              { inputPer1M: 0.60, outputPer1M: 2.20 },
    'glm-4.5':              { inputPer1M: 0.60, outputPer1M: 2.20 },
    'glm-4.5-air':          { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4.5-flash':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-32b-0414-128k':  { inputPer1M: 0.10, outputPer1M: 0.10 },
    'glm-4-flash':          { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-flash-250414':   { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-air':            { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4-airx':           { inputPer1M: 1.40, outputPer1M: 1.40 },
    'glm-4':                { inputPer1M: 1.40, outputPer1M: 1.40 },
  },
  // `supportsThinking` lets the UI surface the think toggle for this
  // provider; the model-aware narrowing in
  // `apps/dashboard/.../provider-caps.ts` then filters it down to the
  // GLM-4.5+ / GLM-5 families that actually accept the `thinking`
  // parameter on the wire (older glm-4.* 400 with "unknown field").
  // `zaiCodingMode` keeps the existing model-picker `::coding` toggle.
  capabilities: { zaiCodingMode: true, supportsThinking: true },
  createIndexer: (creds, model) => {
    // Indexer path matches legacy exactly: strip any "::mode" suffix, respect
    // cfg.base_url if present (seed default is the general URL, which is
    // always correct for single-shot analysis).
    const parsed = parseModelWithMode(model);
    return new ZAIProvider(creds.apiKey, parsed.model, creds.baseURL);
  },
  createCoder: (creds, model) => {
    const parsed = parseModelWithMode(model);
    const effectiveModel = parsed.model ?? 'glm-5.1';
    const baseURL = resolveZaiCoderBaseURL(effectiveModel, parsed.mode, creds.baseURL);
    return new OpenAIChatProvider({
      name: 'zai',
      apiKey: creds.apiKey,
      baseURL,
      model: effectiveModel,
      vendor: 'zai',
    });
  },
});
