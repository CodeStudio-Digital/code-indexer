/**
 * Editor color-scheme catalog types.
 *
 * An `EditorThemeDef` is a Monaco theme the user can pick (globally or per
 * language) in the project settings. The built-in `vs`/`vs-dark` are included
 * as options with no `data` (Monaco already knows them); everything else ships
 * its own `IStandaloneThemeData` (see catalog.ts) and is registered via
 * `defineEditorThemes` at Monaco setup.
 */
import type * as MonacoNs from 'monaco-editor';

export type ThemeAppearance = 'dark' | 'light';

export interface EditorThemeDef {
  /** Monaco theme id passed to `monaco.editor.setTheme`. */
  id: string;
  /** Human label for the picker (proper noun — not translated). */
  label: string;
  appearance: ThemeAppearance;
  /** Absent for the built-in `vs`/`vs-dark` (Monaco defines them already). */
  data?: MonacoNs.editor.IStandaloneThemeData;
}

/**
 * Per-theme colour set. The catalog turns this into Monaco token rules that
 * cover BOTH the Monarch tokenizer output (keyword/string/number/comment/…)
 * AND the LSP semantic tokens (function/method/property/parameter/class/…),
 * so "function ≠ method ≠ property" holds in every theme. Hex strings are
 * 6-digit WITHOUT a leading '#'.
 */
export interface Palette {
  background: string;
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  operator: string;
  function: string;
  method: string;
  property: string;
  variable: string;
  parameter: string;
  type: string;
  klass: string;
  namespace: string;
  constant: string;
  decorator: string;
  regexp: string;
  tag: string;
  attribute: string;
  punctuation: string;
  /** Optional editor-chrome accents (fall back to sensible derivations). */
  cursor?: string;
  selection?: string;
  lineHighlight?: string;
  lineNumber?: string;
  lineNumberActive?: string;
  /**
   * Optional widget-chrome overrides (suggest popup / hover / signature help).
   * When absent they derive from background↔foreground (see widget-colors.ts),
   * so a theme only sets these when the derived value isn't ideal.
   */
  widgetBackground?: string;
  widgetBorder?: string;
  suggestSelectedBackground?: string;
  /** Matched-characters color in the suggest popup (defaults to `function`). */
  matchHighlight?: string;
}
