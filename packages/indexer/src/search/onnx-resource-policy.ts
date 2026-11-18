import { availableParallelism } from 'node:os';

/** Keep native inference from creating one busy thread per logical CPU for
 * every resident model. Queries and backfill share the worker scheduler. */
export function onnxSessionOptions(cores = availableParallelism()) {
  return {
    intraOpNumThreads: Math.max(1, Math.min(2, Math.floor(cores / 2))),
    interOpNumThreads: 1,
    executionMode: 'sequential' as const,
  };
}
