import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { LLMFileAnalysis } from '@mcp/shared/types.js';

import {
  buildEmbeddingCandidates,
  type CandidateFile,
  type EmbeddingCandidate,
} from './embedding-candidates.js';

export interface EmbedExecutorDeps {
  db: CodeIndexDB;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore | null;
  costTracker: CostTracker;
  lshSink: LshIndexingSink;
  indexProfile?: 'aggressive' | 'balanced' | 'conservative';
}

/**
 * Embed candidates and upsert to vector store. Shared by `processEmbeddings`
 * (after LLM analysis) and `retryEmbeddings` (DB+disk path). Returns the
 * embedding tokens consumed for cost accounting.
 */
export async function executeEmbedding(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number | null,
  candidates: EmbeddingCandidate[],
): Promise<number> {
  if (!deps.vectorStore) throw new Error('vectorStore is required for executeEmbedding');
  const { vectors, tokens } = await deps.embeddingService.embed(candidates.map((c) => c.text));

  if (runId !== null) {
    deps.costTracker.record({
      projectId: project.id,
      runId,
      provider: 'cloudflare',
      model: '@cf/baai/bge-m3',
      operation: 'embedding',
      inputTokens: tokens,
      outputTokens: 0,
    });
  }

  const vectorRecords: VectorRecord[] = candidates.map((c, i) => ({
    id: c.id,
    values: vectors[i],
    metadata: c.metadata,
  }));

  // Isolate by project namespace so another project's code never pollutes
  // this project's search top-K (and a project delete can drop it wholesale).
  await deps.vectorStore.upsert(vectorRecords, codeNamespace(project.name));

  deps.db.saveVectorIds(
    project.id,
    candidates.map((c) => ({
      vectorId: c.id,
      filePath: c.filePath,
      type: c.metadata.type as 'file' | 'symbol' | 'symbol_body',
    })),
  );

  // LSH bucket sink. Optional — default is no-op. When `RealLshIndexingSink`
  // is wired this populates `embedding_simhash_signatures` + `_lsh_buckets`
  // alongside the vector store so the hybrid search can narrow candidates
  // via integer bucket lookup before doing full-precision cosine.
  try {
    await deps.lshSink.afterUpsert(project.id, vectorRecords);
  } catch {
    // LSH is best-effort; never fail indexing because of it.
  }

  for (const c of candidates) c.onCommit();
  return tokens;
}

export interface IndexedFileEntry {
  path: string;
  fileId: number;
  analysis: LLMFileAnalysis;
  content: string;
  tier?: 'core' | 'support' | 'on_demand';
}

const EMBED_CHUNK_SIZE = 50;

/**
 * Process embeddings for files that were just LLM-analyzed in this run.
 *
 * The "aggressive" index profile skips embeddings for `on_demand` files
 * (tests, docs, migrations, fixtures). They stay searchable via FTS but no
 * longer consume embedding tokens. Files without a tier (legacy pre-071) are
 * treated as `support` and embedded.
 */
export async function processEmbeddings(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number,
  indexedFiles: IndexedFileEntry[],
): Promise<void> {
  const profile = deps.indexProfile ?? 'balanced';
  const skipped: string[] = [];
  const eligible = indexedFiles.filter((f) => {
    if (profile === 'aggressive' && f.tier === 'on_demand') {
      skipped.push(f.path);
      return false;
    }
    return true;
  });

  if (skipped.length > 0) {
    console.error(`[indexer] Skipping ${skipped.length} on_demand embedding(s) (aggressive profile)`);
  }

  const files: CandidateFile[] = eligible.map((f) => ({
    path: f.path,
    fileId: f.fileId,
    language: f.analysis.language,
    summary: f.analysis.summary,
    concepts: f.analysis.concepts,
    symbols: f.analysis.symbols,
    content: f.content,
  }));

  const candidates = buildEmbeddingCandidates(deps.db, project, files);

  if (candidates.length === 0) {
    console.error('[indexer] All embeddings up to date — skipping embed pipeline');
    return;
  }

  console.error(`[indexer] Embedding ${candidates.length} new/changed records`);
  for (let i = 0; i < candidates.length; i += EMBED_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + EMBED_CHUNK_SIZE);
    await executeEmbedding(deps, project, runId, chunk);
  }
}

export interface EmbeddingProgress { current: number; total: number; percent: number }
export interface EmbeddingRetryResult { embedded: number; skipped: number; tokens: number }

/**
 * Retry embedding for all files in a project that have missing or outdated
 * embedding hashes. Reads file metadata from DB and content from disk — no
 * LLM analysis needed.
 */
export async function retryEmbeddings(
  deps: EmbedExecutorDeps,
  projectNameOrPath: string,
  options?: { onProgress?: (p: EmbeddingProgress) => void },
): Promise<EmbeddingRetryResult> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const vectorsAvailable = deps.vectorStore && !(deps.embeddingService instanceof NullEmbeddingService)
    ? await deps.vectorStore.isAvailable()
    : false;
  if (!vectorsAvailable || !deps.vectorStore) {
    throw new Error('Embedding service or vector store not available');
  }

  const project = deps.db.resolveProject(undefined, projectNameOrPath) ?? deps.db.resolveProject(projectNameOrPath);
  const dbFiles = deps.db.listFiles(project.id);

  const files: CandidateFile[] = [];
  for (const dbFile of dbFiles) {
    let content: string;
    try { content = readFileSync(join(project.root_path, dbFile.path), 'utf-8'); }
    catch { continue; }  // file removed from disk — skip

    const dbSymbols = deps.db.getSymbolsByFile(project.id, dbFile.path);
    files.push({
      path: dbFile.path,
      fileId: dbFile.id,
      language: dbFile.language,
      summary: dbFile.summary,
      concepts: JSON.parse(dbFile.concepts || '[]') as string[],
      symbols: dbSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature, comment: s.comment, line: s.line })),
      content,
    });
  }

  const candidates = buildEmbeddingCandidates(deps.db, project, files);
  const total = candidates.length;

  if (total === 0) {
    options?.onProgress?.({ current: 0, total: 0, percent: 100 });
    return { embedded: 0, skipped: dbFiles.length, tokens: 0 };
  }

  console.error(`[indexer] Retry embedding: ${total} candidates from ${files.length} files`);

  let embedded = 0;
  let totalTokens = 0;
  for (let i = 0; i < candidates.length; i += EMBED_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + EMBED_CHUNK_SIZE);
    const tokens = await executeEmbedding(deps, project, null, chunk);
    embedded += chunk.length;
    totalTokens += tokens;
    options?.onProgress?.({ current: embedded, total, percent: Math.round((embedded / total) * 100) });
  }

  return { embedded, skipped: dbFiles.length - files.length, tokens: totalTokens };
}
