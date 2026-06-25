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
 * Two deviations from the live path, both deliberate:
 *   1. The live index's embedding hashes would make `buildEmbeddingCandidates`
 *      skip already-embedded items. A proxy zeroes the hash *getters* so EVERY
 *      candidate is emitted into the fresh store.
 *   2. We never call `candidate.onCommit` — that would stamp the live index's
 *      hash table as if these vectors were in the real store. Read-only w.r.t.
 *      the project index; only the scratch file is written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { safeJsonArray } from '@mcp/shared/utils/safe-json.js';
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

/** Force buildEmbeddingCandidates to emit every candidate (live hashes would
 *  otherwise skip them) without mutating the live index. */
function allCandidatesDb(db: CodeIndexDB): CodeIndexDB {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'getFileEmbeddingHashes' || prop === 'getSymbolEmbeddingHashes') {
        return () => new Map();
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as CodeIndexDB;
}

const WAVE_FILES = 100;
const EMBED_CHUNK = 64;

export async function buildScratchVectorStore(
  db: CodeIndexDB,
  project: { id: number; name: string; root_path: string },
  embService: EmbeddingService,
  opts: ScratchOpts,
): Promise<ScratchResult> {
  const store = new SqliteVecVectorStore({ path: opts.scratchPath });
  const namespace = codeNamespace(project.name);
  const proxy = allCandidatesDb(db);

  // Select files: always include ground-truth targets, then fill to `sample`.
  const all = db.listFiles(project.id);
  const targets = opts.targetFiles ?? new Set<string>();
  let selected = all;
  if (opts.sample && opts.sample < all.length) {
    const tgt = all.filter((f) => targets.has(f.path));
    const tgtIds = new Set(tgt.map((f) => f.id));
    const rest = all.filter((f) => !tgtIds.has(f.id));
    selected = [...tgt, ...rest].slice(0, Math.max(opts.sample, tgt.length));
  }

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
        summary: dbFile.summary,
        concepts: safeJsonArray<string>(dbFile.concepts),
        symbols: syms.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature, comment: s.comment, line: s.line })),
        content,
      });
    }

    const candidates = buildEmbeddingCandidates(proxy, project, files);
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
