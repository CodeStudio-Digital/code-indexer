import type { ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';

const SOURCE_TRUNCATION_UNITS = new Set(['chars', 'bytes', 'lines', 'rows', 'items']);

/** Bound and validate omission metadata contributed by native, MCP, or plugin tools. */
export function normalizeSourceTruncations(value: unknown): ToolSourceTruncation[] {
  if (!Array.isArray(value)) return [];
  const normalized: ToolSourceTruncation[] = [];
  for (const candidate of value.slice(0, 16)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Partial<ToolSourceTruncation>;
    const technique = typeof item.technique === 'string' ? item.technique.trim().slice(0, 80) : '';
    const inputSize = Number(item.inputSize);
    const outputSize = Number(item.outputSize);
    if (
      !technique
      || !Number.isFinite(inputSize)
      || inputSize < 0
      || !Number.isFinite(outputSize)
      || outputSize < 0
      || outputSize > inputSize
      || !SOURCE_TRUNCATION_UNITS.has(String(item.unit))
    ) continue;
    const outputId = typeof item.outputId === 'string' && /^[a-f0-9]{6,64}$/.test(item.outputId)
      ? item.outputId
      : undefined;
    normalized.push({
      technique,
      inputSize: Math.floor(inputSize),
      ...(item.inputSizeExact === false ? { inputSizeExact: false } : {}),
      outputSize: Math.floor(outputSize),
      unit: item.unit as ToolSourceTruncation['unit'],
      recoverable: item.recoverable === true,
      ...(outputId ? { outputId } : {}),
    });
  }
  return normalized;
}

const TRUNCATING_REDUCTION_STAGES = new Set([
  'source_cap',
  'semantic',
  'structured',
  'recovery_marker',
  'hard_cap',
]);

export interface StructuredToolOutputResult {
  truncated?: boolean;
  sourceTruncations?: unknown[];
  reductionReport?: { stages?: Array<{ stage?: string }> };
}

/**
 * Decide whether a tool result omitted information using trusted structure.
 * Display text is deliberately ignored: commands, pages and database cells
 * are allowed to contain strings that look exactly like truncation markers.
 */
export function hasStructuredToolTruncation(result: StructuredToolOutputResult): boolean {
  return Boolean(
    result.truncated
    || (result.sourceTruncations?.length ?? 0) > 0
    || result.reductionReport?.stages?.some((stage) => (
      typeof stage.stage === 'string' && TRUNCATING_REDUCTION_STAGES.has(stage.stage)
    )),
  );
}
