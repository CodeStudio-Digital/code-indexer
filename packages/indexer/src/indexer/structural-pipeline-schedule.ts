const STRUCTURAL_YIELD_EVERY = 50;
const DEFAULT_WRITE_BATCH_SIZE = 50;

export interface StructuralPipelineSchedule {
  parseConcurrency: number;
  writeBatchSize: number;
  yieldEvery: number;
}

/**
 * Parsing is CPU work and may use the bounded worker pool independently of
 * SQLite placement. The single writer commits larger waves only when the
 * project owns an isolated DB; the shared central DB retains one-file commits.
 */
export function resolveStructuralPipelineSchedule(
  usesProjectDb: boolean,
  requestedConcurrency: number,
): StructuralPipelineSchedule {
  const parseConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.trunc(requestedConcurrency))
    : 1;
  const configuredBatch = Number(process.env.MCP_INDEX_WRITE_BATCH_SIZE);
  const writeBatchSize = Number.isFinite(configuredBatch) && configuredBatch > 0
    ? Math.min(200, Math.trunc(configuredBatch))
    : DEFAULT_WRITE_BATCH_SIZE;
  return usesProjectDb
    ? { parseConcurrency, writeBatchSize, yieldEvery: STRUCTURAL_YIELD_EVERY }
    : { parseConcurrency, writeBatchSize: 1, yieldEvery: 1 };
}
