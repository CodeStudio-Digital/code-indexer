import type { CoderProviderName } from '@mcp/code-agent/providers/adapter.js';

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
 */
export function defaultModelFor(provider: CoderProviderName): string {
  switch (provider) {
    case 'anthropic':
    case 'claude-code':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-4o-mini';
    case 'zai':
      return 'glm-5.1';
    case 'deepseek':
      return 'deepseek-chat';
    case 'kimi-code':
      return 'kimi-k2.6';
    case 'gemini':
      // 2.5-flash is the current free-tier model; 2.0-flash has its free
      // quota set to 0 as of April 2026 and returns 429 immediately.
      return 'gemini-2.5-flash';
  }
}
