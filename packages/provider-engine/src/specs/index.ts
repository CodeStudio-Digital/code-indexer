import type { ProviderSpec } from '@mcp/provider-sdk';
import { openaiSpec, deepseekSpec, zaiSpec, cloudflareSpec, openrouterSpec, fuguSpec } from './openai-compat.js';
import { anthropicSpec } from './anthropic.js';
import { bedrockSpec } from './bedrock.js';
import { chatgptSpec } from './chatgpt.js';
import { claudeCodeSpec } from './claude-code.js';
import { copilotSpec } from './copilot.js';
import { geminiSpec } from './gemini.js';
import { googleOAuthSpec } from './google-oauth.js';
import { kimiCodeSpec } from './kimi.js';
import { moonshotSpec } from './moonshot.js';

/**
 * All 15 built-in provider specs, in the EXACT order of registry.ts's former
 * BUILTIN_DEFINITIONS. The order is load-bearing: pricing.ts first-match
 * resolution of duplicate model ids (gpt-4o across openai/copilot/chatgpt;
 * kimi-k2-*-turbo across kimi-code/moonshot) and factory env-var fallback both
 * iterate the registry in insertion order. Built from single-spec imports (NOT
 * the per-file *_SPECS arrays) so the interleaving is exact. `fuguSpec` is
 * appended last — its model ids collide with no other provider, so position is
 * irrelevant for pricing resolution.
 */
export const BUILTIN_SPECS: ProviderSpec[] = [
  anthropicSpec,
  claudeCodeSpec,
  openaiSpec,
  deepseekSpec,
  zaiSpec,
  geminiSpec,
  copilotSpec,
  chatgptSpec,
  bedrockSpec,
  googleOAuthSpec,
  kimiCodeSpec,
  cloudflareSpec,
  moonshotSpec,
  openrouterSpec,
  fuguSpec,
];

const BY_KIND = new Map<string, ProviderSpec>();
for (const s of BUILTIN_SPECS) {
  if (BY_KIND.has(s.kind)) throw new Error(`Duplicate spec kind: ${s.kind}`);
  BY_KIND.set(s.kind, s);
}

/** Look up a built-in spec by provider kind. Plugin specs are not included. */
export function getSpecByKind(kind: string): ProviderSpec | undefined {
  return BY_KIND.get(kind);
}
