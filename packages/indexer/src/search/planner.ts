import type { SearchMode } from '@mcp/shared/types.js';

/**
 * Search planner — chooses the cheapest backend that's likely to answer
 * a given query well, instead of paying the full hybrid cost on every
 * call.
 *
 * Defaulting `HybridSearch` to `mode='hybrid'` meant a 500 ms vector
 * round-trip for queries like `parseIdParam` that FTS resolves in
 * 10 ms with higher recall. The planner fixes that by inspecting the
 * query *shape* (it does NOT call an LLM) and emitting a routing
 * decision the search layer can act on.
 *
 *   identifier-shape  → `fts`        (symbol name, function call)
 *   short code list   → `fts`        (CamelCase / snake_case / paths)
 *   concept keywords  → `hybrid`     (3+ ordinary words)
 *   natural language  → `hybrid`     (full sentence, contains stopwords)
 *   question form     → `hybrid`     (starts with how/why/what/where)
 *
 * The decision is returned alongside a short reason so diagnostics can
 * surface it in the dashboard. Future iterations can swap reasons for
 * confidence scores or A/B alternative plans.
 */

export interface RetrievalPlan {
  mode: Exclude<SearchMode, 'auto'>;
  reason: string;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const QUALIFIED_CALL_RE = /^[A-Za-z_$][\w$]*::[A-Za-z_$][\w$]*$/;
const QUESTION_RE = /\?$|^(how|why|what|where|when|which|como|por\s*que|onde|quando|qual)\b/i;

const CODE_MARKER_RE = /[_$./:\\-]|[a-z][A-Z]|(?:[A-Z][a-z0-9]+){2,}|^[A-Z][A-Z0-9_]*$/;

function isCodeShapedToken(token: string): boolean {
  return CODE_MARKER_RE.test(token);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'of', 'to', 'in', 'on',
  'for', 'with', 'and', 'or', 'que', 'de', 'da', 'do', 'um', 'uma',
  'para', 'com', 'sem',
]);

export function planQuery(rawQuery: string): RetrievalPlan {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return { mode: 'fts', reason: 'empty query' };
  }

  // Single identifier or qualified name → symbol lookup. FTS on
  // `symbols_fts` resolves these instantly with perfect recall.
  if (IDENTIFIER_RE.test(query) || QUALIFIED_CALL_RE.test(query)) {
    return { mode: 'fts', reason: 'identifier-shaped query' };
  }

  // Natural-language question → embedding-based recall pays off.
  if (QUESTION_RE.test(query)) {
    return { mode: 'hybrid', reason: 'question phrasing' };
  }

  const tokens = query.split(/\s+/).filter(Boolean);

  // Short lists dominated by actual code markers (camelCase, snake_case,
  // paths, qualified names) are code lookups. Ordinary words such as
  // "session expiration token timeout" must not match this branch.
  const codeShaped = tokens.filter(isCodeShapedToken).length;
  if (
    tokens.length > 0
    && tokens.length <= 4
    && codeShaped >= Math.ceil(tokens.length / 2)
  ) {
    return { mode: 'fts', reason: 'short code-shaped tokens' };
  }

  // Sentence-ish: contains stopwords or punctuation typical of NL. Hybrid
  // + RRF is the safe default.
  const stopwordHits = tokens.filter((t) => STOPWORDS.has(t.toLowerCase())).length;
  if (stopwordHits >= 2 || tokens.length > 6) {
    return { mode: 'hybrid', reason: 'natural-language query' };
  }

  // Three or more ordinary words are a conceptual keyword query even when a
  // model omitted sentence grammar. Hybrid protects semantic recall without
  // taxing the common one/two-identifier lookup.
  if (tokens.length >= 3) {
    return { mode: 'hybrid', reason: 'concept keyword query' };
  }

  // One or two ordinary words remain cheap lexical lookups.
  return { mode: 'fts', reason: 'short mixed query' };
}
