/**
 * Incremental in-session re-indexing.
 *
 * Runs the tree-sitter symbol extractor against a single file's current
 * contents and upserts the result into the symbol DB. Used by the coder
 * runner to keep `mcp__find_references`, `mcp__grep_code`, `mcp__get_symbol_body`
 * and friends fresh after the agent edits a file — without paying the cost
 * of the full LLM-driven indexer pipeline.
 *
 * Scope:
 *  - Only refreshes symbols for files that already have a row in `files`.
 *    New files (never indexed) are skipped — full indexing is the right path
 *    there because metadata fields (summary, concepts, layer, …) require the
 *    LLM and don't have sane tree-sitter defaults.
 *  - Languages without a tree-sitter grammar return false (no-op).
 *  - Errors are swallowed and logged. This is a best-effort cache refresh,
 *    never a correctness gate.
 */
import { extname } from 'node:path';
import type { CodeIndexDB } from '../../store/db.js';
import { TreeSitterExtractor } from './tree-sitter/extractor.js';
import { getGrammarForExtension, initTreeSitter } from './tree-sitter/languages.js';

const sharedExtractor = new TreeSitterExtractor();
let initialized = false;

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await initTreeSitter();
    initialized = true;
  }
}

/**
 * Re-extract symbols for one file and upsert them. Returns true when the
 * symbol table was updated, false otherwise (unsupported language, unknown
 * file, extraction error). Never throws.
 */
export async function indexFileNow(
  db: CodeIndexDB,
  projectId: number,
  relPath: string,
  content: string,
): Promise<boolean> {
  try {
    const ext = extname(relPath).replace(/^\./, '').toLowerCase();
    if (!getGrammarForExtension(ext)) return false;

    const fileRow = db.getFile(projectId, relPath);
    if (!fileRow) return false;

    await ensureInit();
    const result = await sharedExtractor.extract(relPath, content);
    if (!result.supported || !result.analysis.symbols) return false;

    db.upsertSymbols(projectId, fileRow.id, relPath, result.analysis.symbols);
    return true;
  } catch (e) {
    console.warn(`[incremental-index] ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
