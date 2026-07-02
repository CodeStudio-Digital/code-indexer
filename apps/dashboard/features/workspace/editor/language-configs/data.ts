/**
 * Language-configuration OVERLAYS — only properties the bundled
 * basic-languages confs are MISSING (per-property resolution in Monaco's
 * LanguageConfigurationRegistry makes partial overlays safe: a property we
 * don't define keeps the base conf's value regardless of load order).
 *
 * Verified against monaco-editor's basic-languages: onEnterRules exist only
 * in ts/js/python/html/xml/yaml/handlebars/razor/mdx/liquid/freemarker2 —
 * every C-family language below lacks docblock continuation.
 */
import type * as MonacoNs from 'monaco-editor';

// IndentAction literals — Monaco const enums may not exist as runtime
// objects in the bundle (lesson from CompletionItemInsertTextRules).
const INDENT_NONE = 0 as MonacoNs.languages.IndentAction;
const INDENT_OUTDENT = 2 as MonacoNs.languages.IndentAction;

/** `/** … *​/` continuation — the exact rule set of the ts/js base conf. */
export const DOCBLOCK_ON_ENTER: MonacoNs.languages.OnEnterRule[] = [
  {
    // e.g. /** | */
    beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
    afterText: /^\s*\*\/$/,
    action: { indentAction: INDENT_OUTDENT, appendText: ' * ' },
  },
  {
    // e.g. /** ...|
    beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
    action: { indentAction: INDENT_NONE, appendText: ' * ' },
  },
  {
    // e.g.  * ...|
    beforeText: /^(\t|(\ \ ))*\ \*(\ ([^*]|\*(?!\/))*)?$/,
    action: { indentAction: INDENT_NONE, appendText: '* ' },
  },
  {
    // e.g.  */|
    beforeText: /^(\t|(\ \ ))*\ \*\/\s*$/,
    action: { indentAction: INDENT_NONE, removeText: 1 },
  },
];

const BRACKET_QUOTE_SURROUND: MonacoNs.languages.IAutoClosingPair[] = [
  { open: '{', close: '}' },
  { open: '[', close: ']' },
  { open: '(', close: ')' },
  { open: "'", close: "'" },
  { open: '"', close: '"' },
];

const DOCBLOCK_ONLY: MonacoNs.languages.LanguageConfiguration = {
  onEnterRules: DOCBLOCK_ON_ENTER,
};

export const LANGUAGE_CONFIG_OVERLAYS: Record<string, MonacoNs.languages.LanguageConfiguration> = {
  // php base conf also lacks surroundingPairs — without it, selecting text
  // and typing a quote REPLACES the selection instead of wrapping it.
  php: { onEnterRules: DOCBLOCK_ON_ENTER, surroundingPairs: BRACKET_QUOTE_SURROUND },
  go: DOCBLOCK_ONLY,
  rust: DOCBLOCK_ONLY,
  java: DOCBLOCK_ONLY,
  c: DOCBLOCK_ONLY,
  cpp: DOCBLOCK_ONLY,
  csharp: DOCBLOCK_ONLY,
  kotlin: DOCBLOCK_ONLY,
  swift: DOCBLOCK_ONLY,
  dart: DOCBLOCK_ONLY,
};
