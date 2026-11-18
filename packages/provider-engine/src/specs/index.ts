import type { ProviderSpec } from '@mcp/provider-sdk';
import { openaiSpec } from './openai-compat.js';
import { anthropicSpec } from './anthropic.js';
import { bedrockSpec } from './bedrock.js';
import { copilotSpec } from './copilot.js';

/** Provider formats available in CodeStudio Local. */
export const BUILTIN_SPECS: ProviderSpec[] = [
  anthropicSpec,
  openaiSpec,
  copilotSpec,
  bedrockSpec,
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
