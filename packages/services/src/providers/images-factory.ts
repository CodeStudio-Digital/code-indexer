import type { ImageGenClient } from '@mcp/provider-sdk';
import { lookupProvider } from './factory.js';
import { resolveCreds } from './shared/resolver.js';

/**
 * Build an image-generation client for a provider instance — the third
 * factory next to createCoderProvider, sharing the
 * exact same 3-branch lookup + credential resolution. The bound `model`
 * normally comes from a `sprite-studio/image_gen` pipeline binding (rows
 * with provider_models.mode='image'); callers may override per request.
 */
export async function createImagesProvider(
  name?: string,
  model?: string,
): Promise<ImageGenClient> {
  const { def, cfg } = await lookupProvider(name);
  if (!def.createImages) {
    throw new Error(
      `Shape '${def.kind}' does not support image generation. ` +
        `Bind an image-capable provider (openai gpt-image-*, gemini *-image).`,
    );
  }
  const creds = await resolveCreds(def, cfg);
  return def.createImages(creds, model);
}
