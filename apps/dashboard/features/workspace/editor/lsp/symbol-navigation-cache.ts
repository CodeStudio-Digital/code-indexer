import type { DocumentSymbolDTO } from '@mcp/api-bus';
/**
 * IntelliJ-style symbol navigation UI on top of the existing LSP providers:
 * Code Vision links above declarations plus a clickable glyph-margin marker.
 * The links/glyphs are cheap — references and implementations are requested
 * only after the user clicks and a standalone-safe peek popup owns the results.
 */
import type * as MonacoNs from 'monaco-editor';
import { modelBelongsToProject, relPath } from './dto.js';
import { ensureDocumentSynced } from '../documentSync.js';
import { apiCall } from '../../../../lib/api-client.js';

type CacheEntry = {
  versionId: number;
  result: Promise<DocumentSymbolDTO[]>;
  /** Empty/cold results are retried; populated results live for the model version. */
  expiresAt: number | null;
};

const symbolCache = new Map<string, CacheEntry>();

const EMPTY_SYMBOL_TTL_MS = 750;

function cacheKey(projectId: number, model: MonacoNs.editor.ITextModel): string {
  return `${projectId}:${model.uri.toString()}`;
}

/** Shared by outline, Code Vision and gutter so one model version costs one RPC. */
export function documentSymbolsForModel(
  model: MonacoNs.editor.ITextModel,
  projectId: number,
): Promise<DocumentSymbolDTO[]> {
  if (!modelBelongsToProject(model, projectId)) return Promise.resolve([]);
  const key = cacheKey(projectId, model);
  const versionId = model.getVersionId();
  const cached = symbolCache.get(key);
  if (cached?.versionId === versionId && (cached.expiresAt === null || Date.now() < cached.expiresAt)) {
    return cached.result;
  }

  const entry: CacheEntry = {
    versionId,
    result: Promise.resolve([]),
    expiresAt: null,
  };
  entry.result = ensureDocumentSynced(projectId, model)
    .then(() => apiCall<DocumentSymbolDTO[]>('lsp.documentSymbols', {
      projectId,
      file: relPath(model),
    }))
    .then((symbols) => symbols ?? [])
    .catch(() => [])
    .then((symbols) => {
      entry.expiresAt = symbols.length > 0 ? null : Date.now() + EMPTY_SYMBOL_TTL_MS;
      return symbols;
    });
  symbolCache.set(key, entry);
  if (symbolCache.size > 80) symbolCache.delete(symbolCache.keys().next().value as string);
  return entry.result;
}

export function invalidateProjectSymbolCache(projectId: number): void {
  const prefix = `${projectId}:`;
  for (const key of symbolCache.keys()) {
    if (key.startsWith(prefix)) symbolCache.delete(key);
  }
}

/** Test-only: model/version cache must not leak between isolated test cases. */
export function __resetSymbolNavigationCacheForTests(): void {
  symbolCache.clear();
}
