/**
 * Canonical FTS5 query construction from free-typed user text.
 *
 * The query is tokenized on whitespace and each token is wrapped in double
 * quotes (an FTS5 *phrase literal*). Inside a quoted phrase FTS5 only tokenizes
 * the contents, so operator-significant characters — `.`, `-`, `:`, `*`,
 * parens, etc. — are neutralized instead of being parsed as syntax. This is why
 * a query like `auth.api.client` no longer raises `fts5: syntax error near "."`.
 *
 * Bare boolean operators are dropped so user prose can't accidentally form an
 * FTS boolean expression.
 */

/** Tokenize free text into the terms used for an FTS5 MATCH (no quoting). */
export function ftsTokens(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '')) // strip embedded quotes
    .filter((t) => t && !/^(AND|OR|NOT|NEAR)$/i.test(t));
}

/**
 * Build an FTS5 MATCH expression. Defaults to AND (every term must appear) for
 * precision; callers fall back to OR when AND returns nothing so recall is
 * preserved. Returns '' when there is nothing to match (caller should skip).
 */
export function buildFtsMatch(query: string, connector: 'AND' | 'OR' = 'AND'): string {
  const tokens = ftsTokens(query);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(` ${connector} `);
}

const MAX_MEMORY_QUERY_CHARS = 4096;
const MAX_MEMORY_FTS_TERMS = 24;

/** A continuation can reuse an entire spec as its memory search query.
 * Keep its opening and closing context before embedding or tokenizing it. */
export function boundAgentMemoryQuery(text: string): string {
  const query = text.trim();
  if (query.length <= MAX_MEMORY_QUERY_CHARS) return query;
  const tailSize = MAX_MEMORY_QUERY_CHARS / 4;
  const head = query.slice(0, MAX_MEMORY_QUERY_CHARS - tailSize - 1).replace(/\S+$/u, '').trimEnd();
  const tail = query.slice(-tailSize).replace(/^\S+/u, '').trimStart();
  return [head, tail].filter(Boolean).join('\n') || query.slice(0, MAX_MEMORY_QUERY_CHARS);
}

/** Bound the number of posting lists an OR query ranks. Keep both ends of a
 * long request and stop repeated prose from inflating its BM25 expression. */
export function buildAgentMemoryFtsMatch(query: string): string {
  const distinct = new Map<string, string>();
  for (const term of ftsTokens(boundAgentMemoryQuery(query))) {
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    const key = term.toLowerCase();
    if (!distinct.has(key)) distinct.set(key, term);
  }
  const terms = [...distinct.values()];
  if (terms.length <= MAX_MEMORY_FTS_TERMS) return buildFtsMatch(terms.join(' '), 'OR');
  const descriptive = terms.filter(term => /[\p{L}\p{N}]{3}/u.test(term));
  const candidates = descriptive.length >= MAX_MEMORY_FTS_TERMS ? descriptive : terms;
  const tail = MAX_MEMORY_FTS_TERMS / 4;
  return buildFtsMatch([...candidates.slice(0, MAX_MEMORY_FTS_TERMS - tail), ...candidates.slice(-tail)].join(' '), 'OR');
}

/**
 * The compact content index stores columns, not token positions. FTS5 rejects
 * multi-token phrases against that index (including quoted identifiers such as
 * `auth.api_client`). Expand phrase literals into word intersections while
 * preserving the surrounding boolean expression. These are candidates only;
 * callers needing exact punctuation or adjacency must verify the source text.
 */
export function columnFtsMatch(match: string): string {
  return match.replace(/"((?:""|[^"])*)"/g, (_phrase, value: string) => {
    // unicode61's default token categories are letters, numbers and private-use
    // characters. Keep combining marks attached to their base character.
    const words = value.normalize('NFC').match(/[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu) ?? [];
    if (words.length < 2) return `"${words[0] ?? ''}"`;
    return `(${words.map(word => `"${word}"`).join(' AND ')})`;
  });
}
