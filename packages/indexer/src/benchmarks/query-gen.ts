/**
 * Auto-generate a labeled eval query set from the local symbol index — the
 * tree-sitter "Symbols ready" layer that's always present ($0, on project
 * open). No manual annotation: the index itself is the ground truth.
 *
 * Two query kinds:
 *   - comment → symbol  : the symbol's leading doc/JSDoc/docstring becomes a
 *     natural-language query whose target is that symbol. These are the
 *     rerank-sensitive queries (FTS alone won't nail them).
 *   - name → symbol     : the bare symbol name, an exact-match FTS sanity check.
 *
 * Ground truth is binary: a result is relevant if it IS the symbol (by name)
 * or lives in its file. Coverage of the NL set scales with how commented the
 * codebase is.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EvalQuery } from '@mcp/indexer/benchmarks/engine.js';

export interface GenerateOpts {
  /** Hard cap on the returned set (post-shuffle). Default 200. */
  maxQueries?: number;
  /** Minimum comment length to accept as an NL query. Default 16. */
  minCommentLen?: number;
  /** Include bare symbol-name queries (FTS sanity). Default true. */
  includeNames?: boolean;
}

/** Comments that are noise, not descriptions of the symbol. */
const NOISE_COMMENT = /^(eslint|prettier|@ts-|tslint|istanbul|c8|todo\b|fixme\b|copyright|licen[cs]e|spdx)/i;
/** Symbol names too generic to be a useful exact query. */
const COMMON_NAME = new Set([
  'index', 'main', 'default', 'constructor', 'render', 'get', 'set', 'run',
  'init', 'setup', 'toString', 'valueOf', 'handler', 'callback', 'options',
  'props', 'state', 'data', 'value', 'result', 'config', 'test',
]);

/** Deterministic 32-bit FNV-1a hash — used to order queries reproducibly
 *  without Math.random (so a benchmark run is repeatable). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function generateQueriesFromIndex(
  db: CodeIndexDB,
  projectId: number,
  opts: GenerateOpts = {},
): EvalQuery[] {
  const minCommentLen = opts.minCommentLen ?? 16;
  const includeNames = opts.includeNames !== false;
  const maxQueries = opts.maxQueries ?? 200;

  const symbols = db.listAllSymbols(projectId);
  const out: EvalQuery[] = [];
  const seen = new Set<string>();

  // comment → symbol (natural-language, rerank-sensitive)
  for (const s of symbols) {
    const comment = (s.comment ?? '').replace(/\s+/g, ' ').trim();
    if (comment.length < minCommentLen || NOISE_COMMENT.test(comment) || !/[a-zA-Z]/.test(comment)) continue;
    const key = `c:${comment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: comment, relevant_symbols: [s.name], relevant_files: [s.file_path] });
  }

  // name → symbol (exact-match FTS sanity)
  if (includeNames) {
    for (const s of symbols) {
      const name = s.name;
      if (name.length < 4 || COMMON_NAME.has(name.toLowerCase())) continue;
      const key = `n:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ query: name, relevant_symbols: [name], relevant_files: [s.file_path] });
    }
  }

  // Deterministic shuffle (mixes comment + name queries) then cap.
  out.sort((a, b) => fnv1a(a.query) - fnv1a(b.query));
  return out.slice(0, maxQueries);
}
