/**
 * Content-keyed extraction cache — the local slice of JetBrains' "shared
 * indexes" short-circuit: before parsing a file, ask whether this exact
 * (content_hash, ext, EXTRACTOR_VERSION) was already extracted — by any
 * project, or by this one before a branch revert — and reuse the analysis.
 *
 * Correctness notes:
 *  - The analysis is content+extension-deterministic EXCEPT `symbol.namespace`
 *    for the path-derived languages (Python/Rust) — re-stamped on every hit
 *    via `pathDerivedNamespace` (no AST needed).
 *  - Only `supported` results are cached; the version gate strands rows on an
 *    EXTRACTOR_VERSION bump (pruned at open, never migrated).
 *
 * Resilience: the SQLite store loads lazily (dynamic import) and any open or
 * I/O failure disables the cache for the process — indexing NEVER breaks on a
 * cache problem. Kill-switch: MCP_EXTRACT_CACHE=0.
 */
import { join } from 'node:path';
import type { StructuralFileAnalysis } from '@mcp/shared/types.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { EXTRACTOR_VERSION } from '@mcp/indexer/indexer/tree-sitter/extractor.js';
import { pathDerivedNamespace } from '@mcp/indexer/indexer/tree-sitter/namespace-extractor.js';

/** Minimal store seam (production: @mcp/store ExtractCacheStore; tests: Map fake). */
export interface ExtractCacheStoreLike {
  get(contentHash: string, ext: string, version: number): { language: string; analysis_json: string; touched_at: number } | null;
  put(contentHash: string, ext: string, version: number, language: string, analysisJson: string, touchedAt: number): void;
  touch(contentHash: string, ext: string, version: number, touchedAt: number): void;
  prune(cutoffMs: number): number;
}

const PRUNE_AGE_MS = 30 * 24 * 3600 * 1000;
/** touched_at refresh throttle — a hit younger than this skips the UPDATE. */
const TOUCH_THROTTLE_MS = 24 * 3600 * 1000;

/** undefined = not opened yet; null = disabled (kill-switch or open failure). */
let store: ExtractCacheStoreLike | null | undefined;
let opening: Promise<ExtractCacheStoreLike | null> | null = null;
const stats = { hits: 0, misses: 0 };

async function openStore(): Promise<ExtractCacheStoreLike | null> {
  if (store !== undefined) return store;
  if (process.env.MCP_EXTRACT_CACHE === '0') {
    store = null;
    return store;
  }
  // Single-flight: concurrent first calls share one open attempt.
  opening ??= (async () => {
    try {
      // Dynamic so environments that never index (or whose better-sqlite3
      // ABI can't dlopen, e.g. bare vitest) don't pay/fail the native load.
      const { ExtractCacheStore } = await import('@mcp/store/extract-cache-store.js');
      const s = new ExtractCacheStore(join(mcpDataDir(), 'extract-cache.db'));
      s.prune(Date.now() - PRUNE_AGE_MS);
      return s;
    } catch (err) {
      console.warn(`[extract-cache] disabled for this process: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  })();
  store = await opening;
  opening = null;
  return store;
}

function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Look up a prior extraction for this exact content. On hit, re-stamps the
 * path-derived namespace (Python/Rust) for the CURRENT path and returns a
 * fresh, caller-owned TreeSitterResult. Null on miss/disabled.
 */
export async function getCachedExtraction(contentHash: string, relPath: string): Promise<TreeSitterResult | null> {
  const s = await openStore();
  if (!s) return null;
  const ext = extOf(relPath);
  if (!ext) return null;
  try {
    const row = s.get(contentHash, ext, EXTRACTOR_VERSION);
    if (!row) {
      stats.misses++;
      return null;
    }
    const analysis = JSON.parse(row.analysis_json) as Partial<StructuralFileAnalysis>;
    const ns = pathDerivedNamespace(row.language, relPath);
    if (ns !== undefined) {
      for (const sym of analysis.symbols ?? []) {
        if (ns) sym.namespace = ns;
        else delete sym.namespace;
      }
    }
    const now = Date.now();
    if (now - row.touched_at > TOUCH_THROTTLE_MS) s.touch(contentHash, ext, EXTRACTOR_VERSION, now);
    stats.hits++;
    return { supported: true, language: row.language, analysis };
  } catch (err) {
    // Corrupt row / storage hiccup — treat as miss; the re-parse overwrites.
    console.warn(`[extract-cache] read failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    stats.misses++;
    return null;
  }
}

/** Persist a fresh extraction (supported languages only — unsupported is a cheap no-parse). */
export async function cacheExtraction(contentHash: string, relPath: string, result: TreeSitterResult): Promise<void> {
  if (!result.supported) return;
  const s = await openStore();
  if (!s) return;
  const ext = extOf(relPath);
  if (!ext) return;
  try {
    s.put(contentHash, ext, EXTRACTOR_VERSION, result.language, JSON.stringify(result.analysis), Date.now());
  } catch (err) {
    console.warn(`[extract-cache] write failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Hit/miss counters for this process (verification + perf telemetry). */
export function extractCacheStats(): { hits: number; misses: number } {
  return { ...stats };
}

/** Test hooks: inject a fake store / reset module state. */
export function __setExtractCacheStoreForTests(fake: ExtractCacheStoreLike | null | undefined): void {
  store = fake;
  opening = null;
  stats.hits = 0;
  stats.misses = 0;
}
