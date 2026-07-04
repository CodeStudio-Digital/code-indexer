/**
 * Image-generation model FAMILY detection — the single home for these
 * regexes so every discovery format tags consistently and a newly released
 * family member (gpt-image-2, the next nano banana, …) is picked up with
 * zero code changes. Discovery stamps matching rows with `mode: 'image'`;
 * nothing is ever hardcoded to a specific version.
 */

/** OpenAI-compatible ids: gpt-image-1/2/…, dall-e-2/3. */
const OPENAI_IMAGE_ID = /^(gpt-image|dall-e)/i;

/** Gemini ids: gemini-*-image[-*], imagen-*, nano-banana aliases. */
const GEMINI_IMAGE_ID = /-image(-|$)|^imagen|nano-banana/i;

export function isOpenAIImageModelId(id: string): boolean {
  return OPENAI_IMAGE_ID.test(id);
}

export function isGeminiImageModelId(id: string): boolean {
  return GEMINI_IMAGE_ID.test(id);
}

export const IMAGE_MODEL_MODE = 'image' as const;
