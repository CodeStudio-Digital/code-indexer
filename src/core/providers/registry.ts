import type { ProviderDefinition } from './types.js';
import { anthropic } from './definitions/anthropic.js';
import { openai } from './definitions/openai.js';
import { deepseek } from './definitions/deepseek.js';
import { gemini } from './definitions/gemini.js';
import { zai } from './definitions/zai.js';
import { copilot } from './definitions/copilot.js';
import { chatgpt } from './definitions/chatgpt.js';
import { bedrock } from './definitions/bedrock.js';
import { googleOAuth } from './definitions/google-oauth.js';

/**
 * Provider registry — single source of truth for all provider shapes.
 *
 * To add a new provider (e.g. Mistral, Groq):
 *   1. Create src/core/providers/definitions/<name>.ts that exports a
 *      defineProvider({...}) object declaring envVars, pricing,
 *      defaultModels, createIndexer?, createCoder?, etc.
 *   2. Import and add to the ALL_DEFINITIONS array below.
 *
 * That's it. The new provider automatically appears in:
 *   - CLI wizard and agent command help
 *   - Admin dashboard provider picker
 *   - ProviderStore.seedFromEnvIfEmpty (env auto-seed)
 *   - Model discovery
 *   - Cost lookup
 *   - Both factories (createIndexerProvider / createCoderProvider)
 */
const ALL_DEFINITIONS: ProviderDefinition[] = [
  anthropic,
  openai,
  deepseek,
  zai,
  gemini,
  copilot,
  chatgpt,
  bedrock,
  googleOAuth,
];

let cachedRegistry: Map<string, ProviderDefinition> | null = null;

export function getRegistry(): Map<string, ProviderDefinition> {
  if (cachedRegistry) return cachedRegistry;
  const map = new Map<string, ProviderDefinition>();
  for (const def of ALL_DEFINITIONS) {
    if (map.has(def.kind)) {
      throw new Error(`Duplicate provider kind in registry: ${def.kind}`);
    }
    map.set(def.kind, def);
  }
  cachedRegistry = map;
  return map;
}

/** All definitions as an array (for admin UI serialization). */
export function listDefinitions(): ProviderDefinition[] {
  return [...getRegistry().values()];
}

/** Shortcut: lookup a definition by kind. */
export function getDefinition(kind: string): ProviderDefinition | undefined {
  return getRegistry().get(kind);
}
