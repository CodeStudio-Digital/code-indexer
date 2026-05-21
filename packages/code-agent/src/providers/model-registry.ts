/**
 * Static baseline registry of known model capabilities.
 *
 * This file is the single place to add context-window sizes and tool-catalog
 * caps for new models. Values here are the fallback when the provider DB has
 * no entry (e.g. right after a fresh install, or for a model that was never
 * discovered via live refresh).
 *
 * Runtime priority (highest → lowest):
 *   1. CODER_MODEL_CAPS env var override
 *   2. provider_models DB row (populated by admin UI or live discovery)
 *   3. This registry
 *
 * To add a new model: insert a row below with its exact API model-id.
 */

export interface ModelRegistryEntry {
  maxTools: number;
  contextWindow?: number;
  /**
   * Maximum tokens the model can emit in a single response. Used to reserve
   * output headroom inside the context window when computing the compaction
   * trigger (`effective = contextWindow - reservedOutput`).
   *
   * Conservative defaults based on each provider's docs (Apr 2026). When
   * unknown, `getMaxOutputTokens` falls back to 8K.
   */
  maxOutputTokens?: number;
  note?: string;
}

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  // ── Anthropic ────────────────────────────────────────────────────────────
  'claude-opus-4-7':            { maxTools: 200, contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-opus-4-6':            { maxTools: 200, contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4-6':          { maxTools: 200, contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-haiku-4-5-20251001':  { maxTools: 120, contextWindow: 200_000, maxOutputTokens: 16_000, note: 'Haiku prefers tighter catalogs' },
  // ── OpenAI ───────────────────────────────────────────────────────────────
  'gpt-5':                      { maxTools: 128, contextWindow: 272_000, maxOutputTokens: 16_000 },
  'gpt-5.5':                    { maxTools: 128, contextWindow: 272_000, maxOutputTokens: 16_000 },
  'gpt-5-mini':                 { maxTools: 128, contextWindow: 272_000, maxOutputTokens: 16_000 },
  'gpt-4o':                     { maxTools: 128, contextWindow: 128_000, maxOutputTokens: 16_000 },
  'gpt-4o-mini':                { maxTools: 64,  contextWindow: 128_000, maxOutputTokens: 16_000, note: 'Smaller context = tighter tool catalog' },
  'gpt-4-turbo':                { maxTools: 128, contextWindow: 128_000, maxOutputTokens: 4_096 },
  'o1':                         { maxTools: 64,  contextWindow: 200_000, maxOutputTokens: 100_000 },
  'o1-mini':                    { maxTools: 64,  contextWindow: 128_000, maxOutputTokens: 65_536 },
  'o3-mini':                    { maxTools: 64,  contextWindow: 200_000, maxOutputTokens: 100_000 },
  // ── ZAI / GLM ─────────────────────────────────────────────────────────────
  // Context windows from docs.z.ai/guides/llm/* (verified Apr 2026).
  'glm-5.1':                    { maxTools: 200, contextWindow: 200_000, maxOutputTokens: 16_000 },
  'glm-4.7-flash':              { maxTools: 200, contextWindow: 128_000, maxOutputTokens: 16_000 },
  'glm-4.6':                    { maxTools: 200, contextWindow: 200_000, maxOutputTokens: 16_000 }, // FIX: doc says 200K
  'glm-4.5':                    { maxTools: 200, contextWindow: 128_000, maxOutputTokens: 16_000 },
  'glm-4.5-air':                { maxTools: 200, contextWindow: 128_000, maxOutputTokens: 16_000 },
  'glm-4.5-x':                  { maxTools: 200, contextWindow: 128_000, maxOutputTokens: 16_000 },
  'glm-4.5-airx':               { maxTools: 200, contextWindow: 128_000, maxOutputTokens: 16_000 },
  'glm-4.5-flash':              { maxTools: 200, contextWindow: 128_000, maxOutputTokens: 16_000 },
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // V4 models (April 2026): 1M context, 384K max output, native thinking mode
  // API hard limit: 128 tools max (https://api-docs.deepseek.com/api/create-chat-completion)
  'deepseek-v4-flash':          { maxTools: 128, contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  'deepseek-v4-pro':            { maxTools: 128, contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  // Deprecated aliases (routed → v4-flash/v4-pro; retire Jul 24 2026)
  'deepseek-chat':              { maxTools: 128, contextWindow: 1_000_000, maxOutputTokens: 32_000, note: 'deprecated → deepseek-v4-flash' },
  'deepseek-coder':             { maxTools: 128, contextWindow: 1_000_000, maxOutputTokens: 32_000, note: 'deprecated → deepseek-v4-flash' },
  'deepseek-reasoner':          { maxTools: 128, contextWindow: 1_000_000, maxOutputTokens: 32_000, note: 'deprecated → deepseek-v4-pro' },
  // ── Kimi Code ──────────────────────────────────────────────────────────
  'kimi-k2.6':                  { maxTools: 128, contextWindow: 262_144, maxOutputTokens: 16_000 },
  'kimi-k2.5':                  { maxTools: 128, contextWindow: 262_144, maxOutputTokens: 16_000 },
  'kimi-k2-thinking':           { maxTools: 128, contextWindow: 262_144, maxOutputTokens: 16_000, note: 'always_thinking' },
  'kimi-k2-thinking-turbo':     { maxTools: 128, contextWindow: 262_144, maxOutputTokens: 16_000, note: 'always_thinking' },
  'kimi-k2-turbo-preview':      { maxTools: 128, contextWindow: 262_144, maxOutputTokens: 16_000 },
  // ── Gemini ───────────────────────────────────────────────────────────────
  'gemini-2.5-flash':           { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-flash-preview-04-17': { maxTools: 64, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-flash-lite':      { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-pro':             { maxTools: 128, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.0-flash':           { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-2.0-flash-lite':      { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-1.5-pro':             { maxTools: 64,  contextWindow: 2_097_152, maxOutputTokens: 8_192 },
  'gemini-1.5-flash':           { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  // 3.x preview — listed in google-oauth.ts defaultModels; limits per gemini-cli tokenLimits.ts (1M default).
  'gemini-3-pro-preview':                 { maxTools: 128, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3.1-pro-preview':               { maxTools: 128, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3.1-pro-preview-customtools':   { maxTools: 128, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3-flash-preview':               { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3.1-flash-lite-preview':        { maxTools: 64,  contextWindow: 1_048_576, maxOutputTokens: 65_536 },
};
