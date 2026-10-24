import type { CandidateFile } from './embedding-candidate-types.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorItemState } from '@mcp/store/vectors.js';
export function itemsByKey(items: readonly VectorItemState[]): Map<string, VectorItemState[]> {
  const out = new Map<string, VectorItemState[]>();
  for (const item of items) {
    const rows = out.get(item.itemKey) ?? [];
    rows.push(item);
    out.set(item.itemKey, rows);
  }
  return out;
}

/** A semantic item is current only when every expected chunk is indexed under
 * the exact source hash. Failed, partial, duplicated and superseded chunks all
 * force another idempotent upsert. */
export function hasCurrentItems(
  byKey: ReadonlyMap<string, readonly VectorItemState[]>,
  key: string,
  hash: string,
  expectedChunks = 1,
  expectedVectorIds?: readonly string[],
): boolean {
  const rows = byKey.get(key) ?? [];
  if (rows.length !== expectedChunks) return false;
  const chunks = new Set<number>();
  for (const row of rows) {
    if (row.status !== 'indexed' || !row.vectorId || row.sourceHash !== hash) return false;
    if (expectedVectorIds && row.vectorId !== expectedVectorIds[row.chunkIndex]) return false;
    chunks.add(row.chunkIndex);
  }
  return chunks.size === expectedChunks
    && Array.from({ length: expectedChunks }, (_, index) => index).every((index) => chunks.has(index));
}

/** Keys needed to decide whether a wave is already current. Kept separate so
 * worker RPC reads only the relevant semantic_items rows. */
export function semanticItemKeysForCandidateFiles(
  db: CodeIndexDB,
  projectId: number,
  files: readonly CandidateFile[],
): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    keys.add(`file:${file.fileId}`);
    for (const symbol of db.getSymbolsByFile(projectId, file.path)) {
      keys.add(`symbol:${symbol.id}`);
      keys.add(`symbol_body:${symbol.id}`);
      keys.add(`symbol_group:${symbol.id}`);
    }
  }
  return [...keys];
}

/** Resolve every logical code item owned by structural file rows before those
 * rows are deleted. This replaces the legacy file_path lookup in vector_ids. */
export function semanticItemKeysForIndexedPaths(
  db: CodeIndexDB,
  projectId: number,
  paths: readonly string[],
): string[] {
  const keys = new Set<string>();
  for (const path of paths) {
    const file = db.getFile(projectId, path);
    if (!file) continue;
    keys.add(`file:${file.id}`);
    for (const symbol of db.getSymbolsByFile(projectId, path)) {
      keys.add(`symbol:${symbol.id}`);
      keys.add(`symbol_body:${symbol.id}`);
      keys.add(`symbol_group:${symbol.id}`);
    }
  }
  return [...keys];
}
