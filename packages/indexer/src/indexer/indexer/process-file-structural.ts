import { readFileSync, statSync } from 'node:fs';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ScannedFile } from '@mcp/shared/types.js';
import type { TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';

import { enrichReferencesWithLines } from './enrich-references.js';
import { hashContent, countLines } from '../content-hash.js';
import { getCachedExtraction, cacheExtraction } from '../extract-cache.js';
import { structuralPathFlags, type StructuralPathFlags } from '../mapper.js';

export interface ProcessFileStructuralResult {
  fileId: number;
  /** Tree-sitter handled the language (symbols/refs/deps are fresh). */
  supported: boolean;
  symbolCount: number;
}

/**
 * CPU/read side of the structural pipeline. Prepared values are deliberately
 * detached from SQLite so callers can run this stage in a bounded parser pool
 * and hand completed records to one writer.
 */
export interface PreparedFileStructural {
  file: Omit<ScannedFile, 'content'>;
  content: string;
  hash: string;
  sizeBytes: number;
  lineCount: number;
  mtimeMs: number | null;
  tsResult: TreeSitterResult;
  supported: boolean;
  pathFlags: StructuralPathFlags;
}

/**
 * Read + hash + tree-sitter extraction, with no SQLite mutation.
 *
 * Keeping this boundary pure with respect to the project DB is what makes a
 * clean producer/parser pool + single-writer pipeline possible.
 */
export async function prepareFileStructural(
  file: ScannedFile,
  treeSitter: { extract: (filePath: string, content: string) => Promise<TreeSitterResult> },
): Promise<PreparedFileStructural> {
  // Lazy content read, same drift handling as processFile: the file may have
  // changed between scan and process; `files.content_hash` must match what we
  // actually parsed.
  const { content: source, ...metadata } = file;
  let content = source ?? '';
  let hash = file.hash;
  let sizeBytes = file.sizeBytes;
  let lineCount = file.lineCount;
  let mtimeMs = file.mtimeMs ?? null;
  if (source === undefined && file.path) {
    content = readFileSync(file.path, 'utf-8');
    const freshHash = hashContent(content);
    if (freshHash !== hash) {
      hash = freshHash;
      sizeBytes = Buffer.byteLength(content, 'utf-8');
      lineCount = countLines(content);
      const st = statSync(file.path, { throwIfNoEntry: false });
      mtimeMs = st ? Math.trunc(st.mtimeMs) : null;
    }
  }

  // Content-keyed reuse (extract-cache): identical content already parsed —
  // by another project, another path, or this file before a branch revert —
  // skips the tree-sitter pass entirely (JetBrains shared-index short-circuit).
  let tsResult = hash ? await getCachedExtraction(hash, file.relativePath) : null;
  if (!tsResult) {
    tsResult = await treeSitter.extract(file.relativePath, content);
    if (hash) await cacheExtraction(hash, file.relativePath, tsResult);
  }
  const supported = tsResult.supported;
  const pathFlags = structuralPathFlags(file.relativePath);

  return {
    file: metadata,
    content,
    hash,
    sizeBytes,
    lineCount,
    mtimeMs,
    tsResult,
    supported,
    pathFlags,
  };
}

/**
 * SQLite side of the per-file structural pipeline.
 *
 * The transaction remains per-file as a savepoint when a caller wraps a whole
 * wave in `db.indexTransaction`: one bad file rolls back independently while
 * the outer wave still commits once.
 */
export function persistPreparedFileStructural(
  db: CodeIndexDB,
  projectId: number,
  prepared: PreparedFileStructural,
): ProcessFileStructuralResult {
  const {
    file,
    content,
    hash,
    sizeBytes,
    lineCount,
    mtimeMs,
    tsResult,
    supported,
    pathFlags,
  } = prepared;
  const symbols = supported ? tsResult.analysis.symbols ?? [] : [];

  const fileId = db.indexTransaction(projectId, () => {
    const { fileId: id } = db.upsertFileStructural(projectId, {
      path: file.relativePath,
      language: tsResult.language || 'unknown',
      size: sizeBytes,
      lineCount,
      contentHash: hash,
      mtimeMs,
      ...pathFlags,
      indexTier: file.tier,
      mapperReason: file.mapperReason,
      // Only overwrite the dependency columns when tree-sitter produced them;
      // for unsupported languages the previous structural values stay.
      ...(supported
        ? {
            dependencies: tsResult.analysis.dependencies ?? [],
            internalDeps: tsResult.analysis.internal_deps ?? [],
            externalDeps: tsResult.analysis.external_deps ?? [],
          }
        : {}),
    });

    if (supported) {
      // Empty array still upserts — an edit that removed every symbol must
      // clear the stale ones (upsertSymbols is delete+insert per file).
      db.upsertSymbols(projectId, id, file.relativePath, symbols);
      db.upsertFileDependencies(
        projectId, id, file.relativePath,
        tsResult.analysis.internal_deps ?? [],
        tsResult.analysis.external_deps ?? [],
      );
      const references = tsResult.analysis.references ?? [];
      // Replacement must also clear the previous rows when the last call or
      // import disappears. Keeping those rows makes a fresh index lie.
      db.upsertSymbolReferences(projectId, id, file.relativePath, enrichReferencesWithLines(references, content));
    }

    db.upsertFileContent(id, content, sizeBytes, projectId, hash);
    return id;
  });

  return { fileId, supported, symbolCount: symbols.length };
}

/**
 * Backwards-compatible single-file entrypoint used by narrow incremental
 * callers. Full and batched incremental passes call prepare/persist separately.
 */
export async function processFileStructural(
  db: CodeIndexDB,
  projectId: number,
  file: ScannedFile,
  treeSitter: { extract: (filePath: string, content: string) => Promise<TreeSitterResult> },
): Promise<ProcessFileStructuralResult> {
  const prepared = await prepareFileStructural(file, treeSitter);
  return persistPreparedFileStructural(db, projectId, prepared);
}
