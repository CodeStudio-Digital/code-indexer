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
  note?: string;
}

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  // ── Anthropic ────────────────────────────────────────────────────────────
  'claude-opus-4-7':            { maxTools: 200, contextWindow: 200_000 },
  'claude-opus-4-6':            { maxTools: 200, contextWindow: 200_000 },
  'claude-sonnet-4-6':          { maxTools: 200, contextWindow: 200_000 },
  'claude-haiku-4-5-20251001':  { maxTools: 120, contextWindow: 200_000, note: 'Haiku prefers tighter catalogs' },
  // ── OpenAI ───────────────────────────────────────────────────────────────
  'gpt-5':                      { maxTools: 128, contextWindow: 272_000 },
  'gpt-5.5':                    { maxTools: 128, contextWindow: 272_000 },
  'gpt-5-mini':                 { maxTools: 128, contextWindow: 272_000 },
  'gpt-4o':                     { maxTools: 128, contextWindow: 128_000 },
  'gpt-4o-mini':                { maxTools: 64,  contextWindow: 128_000, note: 'Smaller context = tighter tool catalog' },
  'gpt-4-turbo':                { maxTools: 128, contextWindow: 128_000 },
  'o1':                         { maxTools: 64,  contextWindow: 200_000 },
  'o1-mini':                    { maxTools: 64,  contextWindow: 128_000 },
  'o3-mini':                    { maxTools: 64,  contextWindow: 200_000 },
  // ── ZAI / GLM ─────────────────────────────────────────────────────────────
  'glm-5.1':                    { maxTools: 200, contextWindow: 200_000 },
  'glm-4.6':                    { maxTools: 200, contextWindow: 128_000 },
  'glm-4.7-flash':              { maxTools: 200, contextWindow: 128_000 },
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // V4 models (April 2026): 1M context, 384K max output, native thinking mode
  // API hard limit: 128 tools max (https://api-docs.deepseek.com/api/create-chat-completion)
  'deepseek-v4-flash':          { maxTools: 128, contextWindow: 1_000_000 },
  'deepseek-v4-pro':            { maxTools: 128, contextWindow: 1_000_000 },
  // Deprecated aliases (routed → v4-flash/v4-pro; retire Jul 24 2026)
  'deepseek-chat':              { maxTools: 128, contextWindow: 1_000_000, note: 'deprecated → deepseek-v4-flash' },
  'deepseek-coder':             { maxTools: 128, contextWindow: 1_000_000, note: 'deprecated → deepseek-v4-flash' },
  'deepseek-reasoner':          { maxTools: 128, contextWindow: 1_000_000, note: 'deprecated → deepseek-v4-pro' },
  // ── Gemini ───────────────────────────────────────────────────────────────
  'gemini-2.5-flash':           { maxTools: 64,  contextWindow: 1_048_576 },
  'gemini-2.5-flash-preview-04-17': { maxTools: 64, contextWindow: 1_048_576 },
  'gemini-2.5-pro':             { maxTools: 128, contextWindow: 1_048_576 },
  'gemini-2.0-flash':           { maxTools: 64,  contextWindow: 1_048_576 },
  'gemini-2.0-flash-lite':      { maxTools: 64,  contextWindow: 1_048_576 },
  'gemini-1.5-pro':             { maxTools: 64,  contextWindow: 2_097_152 },
  'gemini-1.5-flash':           { maxTools: 64,  contextWindow: 1_048_576 },
};
