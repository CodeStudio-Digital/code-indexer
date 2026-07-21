/**
 * TextMate scope → Monaco token category. Our themes (Monarch heritage) color
 * a small vocabulary of token names ('keyword', 'string', 'type', …), so each
 * TM token's scope list collapses to the closest category. Scanning goes from
 * the MOST specific scope (last) outward — the innermost scope wins, matching
 * how TM themes resolve. Pure string work; unit-tested.
 */

/** Ordered prefix table — first hit wins within one scope string. */
const SCOPE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['comment', 'comment'],
  ['punctuation.definition.comment', 'comment'],
  ['string.regexp', 'regexp'],
  ['string', 'string'],
  ['constant.numeric', 'number'],
  ['constant.character.escape', 'string.escape'],
  ['constant.language', 'keyword'],
  ['constant', 'constant'],
  ['keyword.operator', 'operator'],
  ['keyword', 'keyword'],
  ['storage.type', 'keyword'],
  ['storage.modifier', 'keyword'],
  ['storage', 'keyword'],
  ['support.type', 'type'],
  ['support.class', 'type'],
  ['support.function', 'function'],
  ['support.constant', 'constant'],
  ['support.variable', 'variable'],
  ['entity.name.type', 'type'],
  ['entity.name.class', 'type'],
  ['entity.name.namespace', 'namespace'],
  ['entity.name.function', 'function'],
  ['entity.name.tag', 'tag'],
  ['entity.name.section', 'type'],
  ['entity.other.attribute-name', 'attribute.name'],
  ['entity.other.inherited-class', 'type'],
  ['variable.parameter', 'variable'],
  ['variable.language', 'keyword'],
  ['variable.function', 'function'],
  ['variable', 'variable'],
  ['meta.diff.range', 'metatag'],
  ['markup.inserted', 'string'],
  ['markup.deleted', 'invalid'],
  ['markup.changed', 'attribute.value'],
  ['markup.heading', 'keyword'],
  ['markup.bold', 'strong'],
  ['markup.italic', 'emphasis'],
  ['invalid', 'invalid'],
  ['punctuation', 'delimiter'],
];

/**
 * Collapse a TM scope list to one Monaco token category ('' = unstyled).
 * `scopes[0]` is the grammar root — skipped; it matches everything.
 */
export function mapScopesToToken(scopes: readonly string[]): string {
  for (let i = scopes.length - 1; i >= 1; i--) {
    const scope = scopes[i]!;
    for (const [prefix, token] of SCOPE_PREFIXES) {
      if (scope.startsWith(prefix)) return token;
    }
  }
  return '';
}
