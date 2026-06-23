import { getDefinition } from '@mcp/services/providers/registry.js';

/**
 * Best-effort file-path extraction from the user's prompt text. Used by the
 * skill matcher to seed `pathGlobs` for path-aware skill triggers. Returns
 * up to 20 unique candidates.
 *
 * Pure heuristic; misses are fine — when the matcher returns empty, we
 * degrade to the lazy section instead of dumping every skill.
 */
export function extractFilePathsFromText(text: string): string[] {
  if (!text) return [];
  const paths = new Set<string>();
  // Tokens that look like a file path (with at least one slash or a dotted
  // extension) — non-greedy to avoid swallowing surrounding prose.
  const re = /(?:[a-zA-Z0-9_\-./@]+\/)?[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,8}\b/g;
  for (const m of text.matchAll(re)) {
    paths.add(m[0]);
    if (paths.size >= 20) break;
  }
  return [...paths];
}

/**
 * Default model id for a provider when the caller didn't specify one. Used
 * by `runCoder` when creating a fresh session via the `{ create: { ... } }`
 * shape and the operator passed only a provider.
 *
 * Registry-driven (replaces a hardcoded, defaultless `switch` that returned
 * `undefined` for the 6 kinds it omitted): the provider definition declares
 * its preferred `defaultModel`, falling back to the head of `defaultModels`,
 * and finally to a safe Sonnet default for an unknown/plugin kind.
 */
export function defaultModelFor(provider: string): string {
  const def = getDefinition(provider);
  return def?.defaultModel ?? def?.defaultModels?.[0] ?? 'claude-sonnet-4-6';
}
