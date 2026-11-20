import type { DBFile, DBSymbol, HybridSearchResult } from '@mcp/shared/types.js';
import { isSemanticPath, projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import type { CodeIndexDB } from '@mcp/store/db.js';

export function codeSearchFolders(db: CodeIndexDB | undefined, projectId: number): string[] {
  const project = db?.getProjectCatalogEntry?.(projectId);
  return project ? projectSemanticFolders(project) : ['.'];
}

export function codeResultInScope(folders: readonly string[], result: Pick<HybridSearchResult, 'type' | 'data'>): boolean {
  const path = result.type === 'file' ? (result.data as DBFile).path : (result.data as DBSymbol).file_path;
  return folders.includes('.') || (!!path && isSemanticPath(folders, path));
}

/** Fit reranked candidates into their original score slots, leaving lexical
 * results outside the semantic scope eligible at their original positions. */
export function rerankWithinSlots<T>(
  candidates: readonly T[],
  orderedEligible: readonly T[],
  eligible: (candidate: T) => boolean,
  atOriginalScore: (ranked: T, original: T) => T,
): T[] {
  let index = 0;
  return candidates.map((candidate) =>
    eligible(candidate) ? atOriginalScore(orderedEligible[index++], candidate) : candidate);
}
