/**
 * Curated editor themes converted to Monaco's format. Palettes are derived from
 * the well-known VS Code / editor themes of the same name; we map each palette
 * onto a single set of token rules (rulesFromPalette) so every theme reliably
 * differentiates functions, methods, properties, parameters, classes, etc. —
 * for BOTH the Monarch tokenizer and LSP semantic tokens.
 *
 * Why the scopes below work for semantic tokens: Monaco maps each semantic
 * token type to a default TextMate scope (function→entity.name.function,
 * method→entity.name.function.member, property→variable.other.property,
 * parameter→variable.parameter, class→entity.name.type.class, …) and resolves
 * the colour from these rules by longest-prefix match. So a method rule
 * (entity.name.function.member) wins over the function rule for methods, while
 * short scopes (keyword, string, comment) also catch the Monarch output.
 */
import type * as MonacoNs from 'monaco-editor';
import type { EditorThemeDef, Palette } from './types.js';

type Rule = MonacoNs.editor.ITokenThemeRule;

const rule = (token: string, foreground: string, fontStyle?: string): Rule =>
  fontStyle ? { token, foreground, fontStyle } : { token, foreground };

function rulesFromPalette(p: Palette): Rule[] {
  return [
    // ── Monarch + generic ───────────────────────────────────────────
    rule('comment', p.comment, 'italic'),
    rule('keyword', p.keyword),
    rule('storage', p.keyword),
    rule('storage.type', p.keyword),
    rule('keyword.operator', p.operator),
    rule('operator', p.operator),
    rule('delimiter', p.punctuation),
    rule('punctuation', p.punctuation),
    rule('string', p.string),
    rule('string.escape', p.regexp),
    rule('constant.numeric', p.number),
    rule('number', p.number),
    rule('constant.language', p.constant),
    rule('constant.character', p.constant),
    rule('constant', p.constant),
    rule('regexp', p.regexp),
    rule('constant.regexp', p.regexp),
    // ── functions / methods ─────────────────────────────────────────
    rule('entity.name.function', p.function),
    rule('support.function', p.function),
    rule('meta.function-call', p.function),
    rule('entity.name.function.member', p.method), // semantic: method
    // ── types / classes / namespaces ────────────────────────────────
    rule('entity.name.type', p.type),
    rule('entity.name.type.class', p.klass),
    rule('entity.name.class', p.klass),
    rule('support.class', p.klass),
    rule('support.type', p.type),
    rule('entity.name.namespace', p.namespace),
    rule('entity.name.type.namespace', p.namespace),
    // ── properties / fields ─────────────────────────────────────────
    rule('variable.other.property', p.property),
    rule('variable.other.object.property', p.property),
    rule('variable.other.member', p.property),
    rule('meta.property-name', p.property),
    rule('support.variable.property', p.property),
    // ── parameters / variables ──────────────────────────────────────
    rule('variable.parameter', p.parameter),
    rule('variable', p.variable),
    rule('variable.other', p.variable),
    rule('variable.other.readwrite', p.variable),
    rule('variable.other.constant', p.constant),
    // ── decorators / annotations ────────────────────────────────────
    rule('entity.name.decorator', p.decorator),
    rule('meta.decorator', p.decorator),
    rule('storage.type.annotation', p.decorator),
    // ── markup (html/xml/jsx) ───────────────────────────────────────
    rule('entity.name.tag', p.tag),
    rule('entity.other.attribute-name', p.attribute),
  ];
}

const hash = (c?: string): string | undefined => (c ? `#${c}` : undefined);

function colorsFromPalette(p: Palette): MonacoNs.editor.IColors {
  const colors: MonacoNs.editor.IColors = {
    'editor.background': `#${p.background}`,
    'editor.foreground': `#${p.foreground}`,
  };
  const set = (k: string, v?: string): void => { if (v) colors[k] = v; };
  set('editorCursor.foreground', hash(p.cursor ?? p.foreground));
  set('editor.lineHighlightBackground', hash(p.lineHighlight));
  set('editor.selectionBackground', hash(p.selection));
  set('editorLineNumber.foreground', hash(p.lineNumber ?? p.comment));
  set('editorLineNumber.activeForeground', hash(p.lineNumberActive ?? p.foreground));
  return colors;
}

function darkTheme(id: string, label: string, p: Palette): EditorThemeDef {
  return {
    id, label, appearance: 'dark',
    data: { base: 'vs-dark', inherit: true, rules: rulesFromPalette(p), colors: colorsFromPalette(p) },
  };
}

function lightTheme(id: string, label: string, p: Palette): EditorThemeDef {
  return {
    id, label, appearance: 'light',
    data: { base: 'vs', inherit: true, rules: rulesFromPalette(p), colors: colorsFromPalette(p) },
  };
}

// ─── Palettes ──────────────────────────────────────────────────────

const oneDarkPro: Palette = {
  background: '282c34', foreground: 'abb2bf', comment: '5c6370', keyword: 'c678dd',
  string: '98c379', number: 'd19a66', operator: '56b6c2', function: '61afef',
  method: '61afef', property: 'e06c75', variable: 'e06c75', parameter: 'abb2bf',
  type: 'e5c07b', klass: 'e5c07b', namespace: 'e5c07b', constant: 'd19a66',
  decorator: '61afef', regexp: '98c379', tag: 'e06c75', attribute: 'd19a66',
  punctuation: 'abb2bf', lineHighlight: '2c313c', selection: '3e4451', lineNumber: '4b5263',
};

const dracula: Palette = {
  background: '282a36', foreground: 'f8f8f2', comment: '6272a4', keyword: 'ff79c6',
  string: 'f1fa8c', number: 'bd93f9', operator: 'ff79c6', function: '50fa7b',
  method: '50fa7b', property: 'f8f8f2', variable: 'ffb86c', parameter: 'ffb86c',
  type: '8be9fd', klass: '8be9fd', namespace: 'f8f8f2', constant: 'bd93f9',
  decorator: '50fa7b', regexp: 'f1fa8c', tag: 'ff79c6', attribute: '50fa7b',
  punctuation: 'f8f8f2', lineHighlight: '44475a', selection: '44475a', lineNumber: '6272a4',
};

const monokai: Palette = {
  background: '272822', foreground: 'f8f8f2', comment: '75715e', keyword: 'f92672',
  string: 'e6db74', number: 'ae81ff', operator: 'f92672', function: 'a6e22e',
  method: 'a6e22e', property: 'f8f8f2', variable: 'fd971f', parameter: 'fd971f',
  type: '66d9ef', klass: 'a6e22e', namespace: 'f8f8f2', constant: 'ae81ff',
  decorator: 'a6e22e', regexp: 'e6db74', tag: 'f92672', attribute: 'a6e22e',
  punctuation: 'f8f8f2', lineHighlight: '3e3d32', selection: '49483e', lineNumber: '90908a',
};

const nord: Palette = {
  background: '2e3440', foreground: 'd8dee9', comment: '616e88', keyword: '81a1c1',
  string: 'a3be8c', number: 'b48ead', operator: '81a1c1', function: '88c0d0',
  method: '88c0d0', property: 'd8dee9', variable: '8fbcbb', parameter: '8fbcbb',
  type: '8fbcbb', klass: '8fbcbb', namespace: '8fbcbb', constant: 'b48ead',
  decorator: 'd08770', regexp: 'ebcb8b', tag: '81a1c1', attribute: '8fbcbb',
  punctuation: 'eceff4', lineHighlight: '3b4252', selection: '434c5e', lineNumber: '4c566a',
};

const githubDark: Palette = {
  background: '0d1117', foreground: 'c9d1d9', comment: '8b949e', keyword: 'ff7b72',
  string: 'a5d6ff', number: '79c0ff', operator: 'ff7b72', function: 'd2a8ff',
  method: 'd2a8ff', property: '79c0ff', variable: 'e3b341', parameter: 'e3b341',
  type: 'ffa657', klass: 'ffa657', namespace: 'ffa657', constant: '79c0ff',
  decorator: 'd2a8ff', regexp: 'a5d6ff', tag: '7ee787', attribute: '79c0ff',
  punctuation: 'c9d1d9', lineHighlight: '161b22', selection: '264f78', lineNumber: '484f58',
};

const githubLight: Palette = {
  background: 'ffffff', foreground: '24292f', comment: '6e7781', keyword: 'cf222e',
  string: '0a3069', number: '0550ae', operator: 'cf222e', function: '8250df',
  method: '8250df', property: '0550ae', variable: '953800', parameter: '953800',
  type: '953800', klass: '953800', namespace: '953800', constant: '0550ae',
  decorator: '8250df', regexp: '0a3069', tag: '116329', attribute: '0550ae',
  punctuation: '24292f', lineHighlight: 'f6f8fa', selection: 'add6ff', lineNumber: '8c959f',
};

const solarizedDark: Palette = {
  background: '002b36', foreground: '839496', comment: '586e75', keyword: '859900',
  string: '2aa198', number: 'd33682', operator: '859900', function: '268bd2',
  method: '268bd2', property: '839496', variable: '6c71c4', parameter: '6c71c4',
  type: 'b58900', klass: 'b58900', namespace: 'b58900', constant: 'd33682',
  decorator: '268bd2', regexp: '2aa198', tag: '268bd2', attribute: '93a1a1',
  punctuation: '839496', lineHighlight: '073642', selection: '073642', lineNumber: '586e75',
};

const intellijDarcula: Palette = {
  background: '2b2b2b', foreground: 'a9b7c6', comment: '808080', keyword: 'cc7832',
  string: '6a8759', number: '6897bb', operator: 'a9b7c6', function: 'ffc66d',
  method: 'ffc66d', property: '9876aa', variable: '9876aa', parameter: '9876aa',
  type: 'a9b7c6', klass: 'a9b7c6', namespace: 'a9b7c6', constant: '9876aa',
  decorator: 'bbb529', regexp: '6a8759', tag: 'e8bf6a', attribute: 'a9b7c6',
  punctuation: 'a9b7c6', lineHighlight: '323232', selection: '214283', lineNumber: '606366',
};

/**
 * The full picker catalog. The two built-ins (vs-dark/vs) carry no `data` —
 * Monaco already defines them — and stay first so they read as the "defaults".
 */
export const EDITOR_THEMES: EditorThemeDef[] = [
  { id: 'vs-dark', label: 'Default Dark', appearance: 'dark' },
  { id: 'vs', label: 'Default Light', appearance: 'light' },
  darkTheme('one-dark-pro', 'One Dark Pro', oneDarkPro),
  darkTheme('dracula', 'Dracula', dracula),
  darkTheme('monokai', 'Monokai', monokai),
  darkTheme('nord', 'Nord', nord),
  darkTheme('github-dark', 'GitHub Dark', githubDark),
  darkTheme('solarized-dark', 'Solarized Dark', solarizedDark),
  darkTheme('intellij-darcula', 'IntelliJ Darcula', intellijDarcula),
  lightTheme('github-light', 'GitHub Light', githubLight),
];
