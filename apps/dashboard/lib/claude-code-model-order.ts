export const CLAUDE_CODE_MODEL_IDS = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet-4-6',
] as const;

const CLAUDE_CODE_MODEL_ORDER = new Map<string, number>(
  CLAUDE_CODE_MODEL_IDS.map((modelId, index) => [modelId, index]),
);

/** Keep Claude Code's primary and legacy models in the same order as its UI. */
export function sortClaudeCodeModels<T>(
  models: readonly T[],
  getModelId: (model: T) => string,
  getModelName: (model: T) => string,
): T[] {
  return [...models].sort((a, b) => {
    const rankA = CLAUDE_CODE_MODEL_ORDER.get(getModelId(a)) ?? Number.MAX_SAFE_INTEGER;
    const rankB = CLAUDE_CODE_MODEL_ORDER.get(getModelId(b)) ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB || getModelName(a).localeCompare(getModelName(b));
  });
}
