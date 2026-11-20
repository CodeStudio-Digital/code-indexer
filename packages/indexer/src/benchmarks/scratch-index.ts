/**
 * Re-embed a project's corpus into a throwaway sqlite-vec store so the
 * benchmark can compare embedding models. Each model owns its own scratch DB
 * (different vector space / dimension), and the engine pairs that store with
 * the matching embedding service.
 *
 * Reuses the production candidate builder (`buildEmbeddingCandidates`) and the
 * DB+disk loader shape from `embed-retry.ts`, so the embedded text/ids are
 * byte-identical to what a real index would produce — the comparison reflects
 * production retrieval, not a benchmark-only encoding.
 *
 * The scratch build supplies an empty semantic-items ledger so every candidate
 * is emitted without mutating the live generation. Only the scratch file is
 * written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { isSemanticPath, projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { buildEmbeddingCandidates, type CandidateFile } from '@mcp/indexer/indexer/indexer/embedding-candidates.js';

export interface ScratchOpts {
  /** On-disk path for the throwaway vec0 DB. Deleted+rebuilt by the caller. */
  scratchPath: string;
  /** Cap on files embedded (ground-truth targets are always included). */
  sample?: number;
  /** Files that MUST be embedded so recall stays measurable under sampling. */
  targetFiles?: Set<string>;
  onProgress?: (p: { current: number; total: number }) => void;
}

export interface ScratchResult {
  store: VectorStore;
  embedded: number;
  tokens: number;
  files: number;
}

const WAVE_FILES = 100;
const EMBED_CHUNK = 64;

export async function buildScratchVectorStore(
  db: CodeIndexDB,
  project: { id: number; name: string; root_path: string },
  embService: EmbeddingService,
  opts: ScratchOpts,
): Promise<ScratchResult> {
  const folders = projectSemanticFolders(db.getProjectCatalogEntry(project.id));
  if (!folders.length) throw new Error('Select semantic folders before benchmarking this project');
  const namespace = codeNamespace(project.id);

  // Select files: always include ground-truth targets, then fill to `sample`.
  const all = db.listFiles(project.id).filter(file => isSemanticPath(folders, file.path));
  const targets = opts.targetFiles ?? new Set<string>();
  let selected = all;
  if (opts.sample && opts.sample < all.length) {
    const tgt = all.filter((f) => targets.has(f.path));
    const tgtIds = new Set(tgt.map((f) => f.id));
    const rest = all.filter((f) => !tgtIds.has(f.id));
    selected = [...tgt, ...rest].slice(0, Math.max(opts.sample, tgt.length));
  }

  const store = new SqliteVecVectorStore({ path: opts.scratchPath });
  let embedded = 0;
  let tokens = 0;
  let filesDone = 0;

  for (let i = 0; i < selected.length; i += WAVE_FILES) {
    const wave = selected.slice(i, i + WAVE_FILES);
    const files: CandidateFile[] = [];
    for (const dbFile of wave) {
      let content: string;
      try {
        content = readFileSync(join(project.root_path, dbFile.path), 'utf-8');
      } catch {
        filesDone++; // removed from disk — skip, same as the live retry path
        continue;
      }
      const syms = db.getSymbolsByFile(project.id, dbFile.path);
      files.push({
        path: dbFile.path,
        fileId: dbFile.id,
        language: dbFile.language,
        symbols: syms.map((s) => ({
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

    const candidates = buildEmbeddingCandidates(
      db,
      project,
      files,
      [],
      embService.fingerprint?.() ?? 'embedding:unknown',
    );
    for (let j = 0; j < candidates.length; j += EMBED_CHUNK) {
      const batch = candidates.slice(j, j + EMBED_CHUNK);
      const { vectors, tokens: t } = await embService.embed(batch.map((c) => c.text));
      tokens += t;
      const records = batch.map((c, k) => ({ id: c.id, values: vectors[k], metadata: c.metadata }));
      await store.upsert(records, namespace);
      embedded += records.length;
    }

    filesDone += files.length;
    opts.onProgress?.({ current: filesDone, total: selected.length });
  }

  return { store, embedded, tokens, files: selected.length };
}
