import os from 'node:os';
import { createPool, resolveWorkerSpec, type Pool } from '@mcp/indexer/workers/pool.js';
import type { DocIngestPerformanceProfile } from '@mcp/store/doc-store.js';
import type { FolderFileEntry, ReadFileResult } from '../folder-reader.js';
import type { SectionChunk } from '../section-chunker.js';
import type { DocExtractionRequest, DocExtractionResponse } from './extraction-worker-protocol.js';

export interface DocExtractionPool {
  extract(entry: FolderFileEntry, rootPath: string, sourceId: number): Promise<{
    result: ReadFileResult;
    sections: Array<{ candidateId: string; chunks: SectionChunk[] }>;
    durationMs: number;
  }>;
  size(): number;
  close(): Promise<void>;
}

export function availableDocExtractionWorkers(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(16, cores));
}

export function resolveDocWorkerCount(
  profile: DocIngestPerformanceProfile | string | null | undefined,
  requested?: number | null,
): number {
  const cores = availableDocExtractionWorkers();
  if (profile === 'custom' && Number.isFinite(requested)) {
    return Math.max(1, Math.min(16, Math.trunc(requested!)));
  }
  if (profile === 'economy') return Math.min(2, cores);
  if (profile === 'maximum') return Math.max(1, Math.min(12, cores - 1 || 1));
  return Math.max(1, Math.min(6, Math.max(2, cores - 2), cores));
}

export function createDocExtractionPool(size: number): DocExtractionPool {
  const spec = resolveWorkerSpec(import.meta.url, './extraction-worker');
  const pool: Pool<DocExtractionRequest, DocExtractionResponse> = createPool({
    workerUrl: spec.url,
    size: Math.max(1, Math.min(16, Math.trunc(size))),
    name: 'docExtraction',
    maxQueue: 64,
    idleTtlMs: 0,
    workerData: spec.bootstrapData ? { ...spec.bootstrapData } : undefined,
  });
  return {
    extract: (entry, rootPath, sourceId) => pool.dispatch({ entry, rootPath, sourceId }),
    size: () => pool.size(),
    close: () => pool.close(),
  };
}
