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
