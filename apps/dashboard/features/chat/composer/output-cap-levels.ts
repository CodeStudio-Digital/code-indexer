/**
 * Tool-output cap LEVELS — frontend metadata for the Composer cap selector.
 *
 * Mirrors the backend `ToolOutputCapLevel` union (packages/code-agent
 * `core/runner/output-caps.ts`). Kept as a LOCAL copy on purpose so the
 * renderer bundle doesn't pull in backend runner code. The `hint` is anchored
 * on the MAIN runner cap (base 24 KB → ceiling 1 MB; ultra = 4× ceiling); the
 * MCP / code_exec / read_file caps scale proportionally from their own bases.
 */
export type OutputCapLevel = 'economic' | 'medium' | 'high' | 'extra' | 'max' | 'ultra';

const DEFAULT_OUTPUT_CAP_LEVEL: OutputCapLevel = 'economic';

interface OutputCapLevelMeta {
  key: OutputCapLevel;
  /** i18n key in the `chat` namespace. */
  labelKey: string;
  /** PT-BR fallback used as the i18n defaultValue. */
  defaultLabel: string;
  /** Headline cap (main runner) shown next to the label. */
  hint: string;
}

export const OUTPUT_CAP_LEVELS: readonly OutputCapLevelMeta[] = [
  { key: 'economic', labelKey: 'toolbar.outputCap.economic', defaultLabel: 'Econômico', hint: '24 KB' },
  { key: 'medium', labelKey: 'toolbar.outputCap.medium', defaultLabel: 'Médio', hint: '48 KB' },
  { key: 'high', labelKey: 'toolbar.outputCap.high', defaultLabel: 'Alto', hint: '96 KB' },
  { key: 'extra', labelKey: 'toolbar.outputCap.extra', defaultLabel: 'Extra', hint: '144 KB' },
  // Label renamed 'Ultra' → 'XL' (P2 do plano ultra-agent): "Ultra" agora é a
  // identidade do MODO de execução; este seletor só controla bytes de saída.
  // O valor persistido `ultra` (migration 153) permanece intocado.
  { key: 'max', labelKey: 'toolbar.outputCap.max', defaultLabel: 'Máximo', hint: '1 MB' },
  { key: 'ultra', labelKey: 'toolbar.outputCap.ultra', defaultLabel: 'XL', hint: '4 MB' },
];

/** Any level above the production default. Drives the amber "active" styling. */
export function isElevatedCapLevel(level: OutputCapLevel): boolean {
  return level !== 'economic';
}

/**
 * Hydrate the selector's initial level from a session row. Prefers the new
 * `tool_output_cap_level` column; when absent, derives from the legacy
 * `unrestricted_tool_output` boolean (true → 'max'), mirroring the backend
 * `levelFromLegacyBoolean`.
 */
export function levelFromSession(
  session?: { tool_output_cap_level?: string | null; unrestricted_tool_output?: boolean | null } | null,
): OutputCapLevel {
  const lv = session?.tool_output_cap_level;
  if (lv && OUTPUT_CAP_LEVELS.some((o) => o.key === lv)) return lv as OutputCapLevel;
  return session?.unrestricted_tool_output ? 'max' : DEFAULT_OUTPUT_CAP_LEVEL;
}
