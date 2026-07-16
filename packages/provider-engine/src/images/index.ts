import type { ProviderDefinition, ProviderSpec, ResolvedCreds } from '@mcp/provider-sdk';
import { OpenAIImagesClient } from './openai-images.js';
import { GeminiImagesClient } from './gemini-images.js';
import { ChatGPTImagesClient } from './chatgpt-images.js';

/**
 * Derive `createImages` for an engine-built provider, mirroring how the wire
 * builders derive createCoder. Only shapes that opt in via
 * `capabilities.supportsImageGen` get a factory; everything else stays
 * undefined so the services factory can reject with a clear message.
 *
 * Dispatch is by wire, with `kind`-specific carve-outs first: cloudflare rides
 * the openai-compat wire for chat but its image models use the Workers AI
 * `/ai/run/{model}` endpoint (phase 2 — no factory yet, so the flag stays off
 * on its spec until that client lands).
 */
export function buildImagesFactory(
  spec: ProviderSpec,
): ProviderDefinition['createImages'] | undefined {
  if (!spec.capabilities?.supportsImageGen) return undefined;
  switch (spec.wire) {
    case 'openai-compat':
      return (creds: ResolvedCreds, model?: string) => new OpenAIImagesClient(creds, model);
    case 'gemini':
      return (creds: ResolvedCreds, model?: string) => new GeminiImagesClient(creds, model);
    case 'codex':
      // ChatGPT-subscription images (Codex backend standalone endpoints).
      return (creds: ResolvedCreds, model?: string) => new ChatGPTImagesClient(creds, model);
    default:
      return undefined;
  }
}
