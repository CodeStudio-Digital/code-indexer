import type { ProviderDefinition } from './types.js';
import { anthropic } from './definitions/anthropic.js';
import { claudeCode } from './definitions/claude-code.js';
import { openai } from './definitions/openai.js';
import { deepseek } from './definitions/deepseek.js';
import { gemini } from './definitions/gemini.js';
import { zai } from './definitions/zai.js';
import { copilot } from './definitions/copilot.js';
import { chatgpt } from './definitions/chatgpt.js';
import { bedrock } from './definitions/bedrock.js';
import { googleOAuth } from './definitions/google-oauth.js';
import { kimiCode } from './definitions/kimi-code.js';
import { cloudflare } from './definitions/cloudflare.js';
import { moonshot } from './definitions/moonshot.js';
import { openrouter } from './definitions/openrouter.js';

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
  claudeCode,
  openai,
  deepseek,
  zai,
  gemini,
  copilot,
  chatgpt,
  bedrock,
  googleOAuth,
  kimiCode,
  cloudflare,
  moonshot,
  openrouter,
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

/**
 * List the kinds registered with a `createCoder` builder — i.e. all shapes
 * usable by the coder runner. Replaces the hardcoded SUPPORTED_CODER_PROVIDERS
 * constant from the legacy coder factory; derived dynamically so adding a
 * new coder-capable shape automatically surfaces it to the HTTP list route.
 */
export function listCoderKinds(): string[] {
  return listDefinitions().filter((d) => !!d.createCoder).map((d) => d.kind);
}

/**
 * List the kinds registered with an indexer builder (sync or async).
 */
export function listIndexerKinds(): string[] {
  return listDefinitions()
    .filter((d) => !!d.createIndexer || !!d.createIndexerAsync)
    .map((d) => d.kind);
}
