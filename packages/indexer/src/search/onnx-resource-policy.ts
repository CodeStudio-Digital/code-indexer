import { availableParallelism } from 'node:os';

export type OnnxEmbeddingDevice = 'cpu' | 'dml' | 'cuda' | 'coreml';

/** Try the native accelerator supplied by Transformers.js on this platform.
 * Session creation and inference still validate the driver and model. */
export function preferredOnnxEmbeddingDevice(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): OnnxEmbeddingDevice {
  if (platform === 'win32') return 'dml';
  if (platform === 'linux' && arch === 'x64') return 'cuda';
  if (platform === 'darwin') return 'coreml';
  return 'cpu';
}

/** Keep native inference from creating one busy thread per logical CPU for
 * every resident model. Queries and backfill share the worker scheduler. */
export function onnxSessionOptions(cores = availableParallelism()) {
  return {
    intraOpNumThreads: Math.max(1, Math.min(2, Math.floor(cores / 2))),
    interOpNumThreads: 1,
    executionMode: 'sequential' as const,
  };
}
