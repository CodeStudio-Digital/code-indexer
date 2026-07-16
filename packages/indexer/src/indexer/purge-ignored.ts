import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { buildScannerIgnore } from './scanner-ignore.js';
import { isHardExcluded } from './mapper.js';
import type { LshIndexingSink } from './lsh-indexing-sink.js';
import { semanticItemKeysForIndexedPaths } from './indexer/embedding-candidates.js';

export interface PurgeIgnoredIndexedFilesResult {
  ok: true;
  matched_files: number;
  local_deleted: number;
  vectors_known: number;
  vectors_deleted: number;
  vector_error: string | null;
  file_count: number;
  symbol_count: number;
}

export async function purgeIgnoredIndexedFiles(
  db: CodeIndexDB,
  vectorStore: VectorStore | null,
  lshSink: LshIndexingSink | null,
  projectId: number,
): Promise<PurgeIgnoredIndexedFilesResult> {
  const project = db.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  const ig = buildScannerIgnore(project.root_path, projectIndexIgnorePatterns(project), isHardExcluded);
  const matched = db.listFiles(projectId).filter((file) => ig.ignores(file.path));
  const itemKeys = semanticItemKeysForIndexedPaths(db, projectId, matched.map((file) => file.path));
  const itemRows = vectorStore
    ? await vectorStore.listItems?.(codeNamespace(project.id), itemKeys) ?? []
    : [];
  const vectorIds = itemRows.flatMap((item) => item.vectorId ? [item.vectorId] : []);
  let localDeleted = 0;

  for (const file of matched) {
    db.deleteFile(projectId, file.path);
    localDeleted++;
  }

  let vectorsDeleted = 0;
  let vectorError: string | null = null;
  if (itemKeys.length > 0) {
    if (vectorStore?.deleteByItemKeys) {
      try {
        vectorsDeleted = await vectorStore.deleteByItemKeys(itemKeys, codeNamespace(project.id));
      } catch (err) {
        vectorError = err instanceof Error ? err.message : String(err);
      }
    } else {
      vectorError = 'vector store unavailable';
    }
    try { await lshSink?.afterDelete?.(projectId, vectorIds); }
    catch { /* LSH is best-effort; stale buckets only cost recall. */ }
  }

  const stats = db.getStats(projectId, { fresh: true });
  db.updateProject(projectId, {
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
  });

  return {
    ok: true,
    matched_files: matched.length,
    local_deleted: localDeleted,
    vectors_known: itemRows.length,
    vectors_deleted: vectorsDeleted,
    vector_error: vectorError,
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
  };
}
