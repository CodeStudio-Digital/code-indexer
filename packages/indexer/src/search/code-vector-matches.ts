import type { DBFile, DBSymbol, HybridSearchResult, SearchType, VectorMatch } from '@mcp/shared/types.js';
import { isSemanticPath, projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import type { CodeIndexDB } from '@mcp/store/db.js';

const SYMBOL_TYPES = ['symbol', 'symbol_body', 'symbol_group'];

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

export function codeVectorFilter(type: SearchType) {
  if (type === 'symbols') return { types: SYMBOL_TYPES };
  return { filter: type === 'files' ? { type: 'file' } : {} as Record<string, string> };
}

/** KNN is ordered by score. Collapse signature, body and siblings before awarding a rank vote. */
export function distinctCodeMatches(matches: VectorMatch[], type: SearchType): VectorMatch[] {
  const best = new Map<string, VectorMatch>();
  for (const match of matches) {
    const { type: kind, ref_id } = match.metadata;
    if (!ref_id || (kind === 'file' ? type === 'symbols' : type === 'files' || !SYMBOL_TYPES.includes(kind))) continue;
    const key = (kind === 'file' ? 'f' : 's') + ref_id;
    const previous = best.get(key);
    if (!previous || previous.score < match.score) best.set(key, match);
  }
  return [...best.values()];
}
