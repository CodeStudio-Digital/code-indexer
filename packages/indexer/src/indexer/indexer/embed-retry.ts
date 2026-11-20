/**
 * Retry embedding for all files in a project that have missing or outdated
 * embedding hashes — reads metadata from DB and content from disk, no LLM.
 *
 * Wave-based: the old version read the ENTIRE project's content into one
 * array before building candidates (the whole codebase in RAM during a
 * model-change sweep). Now files are processed in waves of `WAVE_FILES`:
 * read → candidates → embed → release, so peak memory is one wave.
 *
 * Progress semantics: counted in FILES processed (monotonic), not embedding
 * candidates — the candidate total isn't known without reading everything,
 * which is exactly what waves avoid. Consumers only render
 * current/total/percent, which keep their meaning.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';

import {
  buildEmbeddingCandidates,
  semanticItemKeysForCandidateFiles,
  type CandidateFile,
} from './embedding-candidates.js';
import { executeEmbedding, type EmbedExecutorDeps } from './embed-executor.js';
import { EMBED_CHUNK_SIZE, resolveEmbedConcurrency, runEmbedChunks } from './embed-parallel.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { isSemanticPath, projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';

export interface EmbeddingProgress { current: number; total: number; percent: number }

export interface EmbeddingRetryResult {
  embedded: number;
  skipped: number;
  tokens: number;
  /** Batches that failed (their candidates' hashes never committed — a re-run picks them up). */
  failedBatches: number;
}

export class EmbeddingPauseRequestedError extends Error {
  constructor() {
    super('semantic backfill paused because the project is no longer active');
    this.name = 'EmbeddingPauseRequestedError';
  }
}

const FALLBACK_WAVE_FILES = 25;
const MIN_WAVE_FILES = 1;
const MAX_WAVE_FILES = 100;

function clampWaveFiles(value: number, fallback = FALLBACK_WAVE_FILES): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_WAVE_FILES, Math.max(MIN_WAVE_FILES, Math.trunc(value)));
}

function configuredWaveFiles(): number {
  return clampWaveFiles(Number(process.env.MCP_EMBED_WAVE_FILES));
}

export async function retryEmbeddings(
  deps: EmbedExecutorDeps,
  projectNameOrPath: string,
  options?: {
    onProgress?: (p: EmbeddingProgress) => void;
    /** Attribute embedding cost to an index run (model-change sweep). Default: untracked. */
    runId?: number | null;
    /** Files per wave — test hook; default in code. */
    waveFiles?: number;
    /** Project-relative paths for a watcher/editor delta. Omitted means the
     * explicit full-generation sweep. */
    paths?: readonly string[];
    embeddingFingerprint?: string;
    /** Cooperative lifecycle fence checked only between bounded file waves.
     * The currently-running native ONNX batch always finishes cleanly. */
    shouldPause?: () => boolean;
  },
): Promise<EmbeddingRetryResult> {
  const vectorsAvailable = deps.vectorStore && !(deps.embeddingService instanceof NullEmbeddingService)
    ? await deps.vectorStore.isAvailable()
    : false;
  if (!vectorsAvailable || !deps.vectorStore) {
    throw new Error('Embedding service or vector store not available');
  }

  const project = deps.db.resolveProject(undefined, projectNameOrPath) ?? deps.db.resolveProject(projectNameOrPath);
  const folders = projectSemanticFolders(project);
  const requestedPaths = options?.paths
    ? [...new Set(options.paths.map((path) => path.replace(/\\/g, '/')))]
    : null;
  const dbFiles = requestedPaths
    ? requestedPaths.filter((path) => isSemanticPath(folders, path)).flatMap((path) => {
        const file = deps.db.getFile(project.id, path);
        return file ? [file] : [];
      })
    : folders.includes('.') ? deps.db.listFiles(project.id) : deps.db.listFilesInFolders(project.id, folders);
  const requestedWaveFiles = options?.waveFiles ?? configuredWaveFiles();
  const waveFiles = clampWaveFiles(requestedWaveFiles);
  const concurrency = resolveEmbedConcurrency(deps.embeddingService);

  let filesDone = 0;
  let filesMissing = 0;
  let embedded = 0;
  let tokens = 0;
  let lshFailed = 0;
  let failedBatches = 0;
  const total = dbFiles.length;

  const reportProgress = (): void => {
    options?.onProgress?.({
      current: filesDone,
      total,
      percent: total === 0 ? 100 : Math.round((filesDone / total) * 100),
    });
  };

  console.error(`[indexer] Retry embedding: ${total} file(s) in waves of ${waveFiles}`);

  for (let start = 0; start < dbFiles.length; start += waveFiles) {
    if (options?.shouldPause?.()) throw new EmbeddingPauseRequestedError();
    const waveRows = dbFiles.slice(start, start + waveFiles);
    const files: CandidateFile[] = [];
    for (const dbFile of waveRows) {
      let content: string;
      try { content = readFileSync(join(project.root_path, dbFile.path), 'utf-8'); }
      catch { filesMissing++; filesDone++; continue; }  // removed from disk — skip

      const dbSymbols = deps.db.getSymbolsByFile(project.id, dbFile.path);
      files.push({
        path: dbFile.path,
        fileId: dbFile.id,
        language: dbFile.language,
        symbols: dbSymbols.map((s) => ({
          id: s.id,
          stable_id: s.stable_id,
          name: s.name,
          kind: s.kind,
          signature: s.signature,
          comment: s.comment,
          line: s.line,
          end_line: s.end_line,
          parent: s.parent,
        })),
        content,
      });
    }

    const keys = semanticItemKeysForCandidateFiles(deps.db, project.id, files);
    const currentItems = await deps.vectorStore.listItems?.(codeNamespace(project.id), keys) ?? [];
    if (options?.shouldPause?.()) throw new EmbeddingPauseRequestedError();
    const candidates = buildEmbeddingCandidates(
      deps.db,
      project,
      files,
      currentItems,
      options?.embeddingFingerprint ?? deps.embeddingService.fingerprint?.() ?? 'embedding:unknown',
    );
    if (candidates.length > 0) {
      const res = await runEmbedChunks(candidates, {
        chunkSize: EMBED_CHUNK_SIZE,
        concurrency,
        execute: (chunk) => executeEmbedding(deps, project, options?.runId ?? null, chunk),
      });
      embedded += res.embedded;
      tokens += res.tokens;
      lshFailed += res.lshFailed;
      failedBatches += res.failures.length;
      if (res.failures.length > 0) {
        console.warn(
          `[indexer] ${res.failures.length} embedding batch(es) failed in this wave — re-run picks them up (first error: ${res.failures[0].error})`,
        );
      }
    }

    filesDone += files.length;
    reportProgress();
    if (options?.shouldPause?.()) throw new EmbeddingPauseRequestedError();
    // `files`/`candidates` go out of scope here — the wave's content is GC-able.
  }

  if (lshFailed > 0) {
    console.warn(`[indexer] LSH sink failed for ${lshFailed} record(s) during retry`);
  }
  reportProgress();

  return { embedded, skipped: filesMissing, tokens, failedBatches };
}
