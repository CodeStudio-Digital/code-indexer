import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { buildScannerIgnore } from './scanner-ignore.js';
import { isHardExcluded } from './mapper.js';
import type { LshIndexingSink } from './lsh-indexing-sink.js';

export interface PurgeIgnoredIndexedFilesResult {
  ok: true;
  matched_files: number;
  local_deleted: number;
  vectors_known: number;
  vectors_deleted_remote: number;
  tombstoned: number;
  remote_error: string | null;
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
  const vectorIds: string[] = [];
  let localDeleted = 0;

  for (const file of matched) {
    vectorIds.push(...db.deleteVectorIdsByFile(projectId, file.path));
    db.deleteFile(projectId, file.path);
    localDeleted++;
  }

  let vectorsDeletedRemote = 0;
  let tombstoned = 0;
  let remoteError: string | null = null;
  if (vectorIds.length > 0) {
    if (vectorStore) {
      try {
        vectorsDeletedRemote = await vectorStore.deleteByIds(vectorIds, codeNamespace(project.name));
      } catch (err) {
        remoteError = err instanceof Error ? err.message : String(err);
        tombstoned = db.enqueuePendingVectorDeletes(vectorIds.map((vector_id) => ({
          vector_id,
          project_name: project.name,
          error: remoteError,
        })));
      }
    } else {
      remoteError = 'vector store unavailable';
      tombstoned = db.enqueuePendingVectorDeletes(vectorIds.map((vector_id) => ({
        vector_id,
        project_name: project.name,
        error: remoteError,
      })));
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
    vectors_known: vectorIds.length,
    vectors_deleted_remote: vectorsDeletedRemote,
    tombstoned,
    remote_error: remoteError,
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
  };
}
