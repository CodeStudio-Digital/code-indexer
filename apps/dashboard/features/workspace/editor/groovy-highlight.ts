import type * as Monaco from 'monaco-editor';

const GROOVY_KEYWORDS = [
  'as', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def',
  'default', 'do', 'else', 'enum', 'extends', 'false', 'finally', 'for', 'goto',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'native', 'new',
  'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'trait', 'transient',
  'true', 'try', 'void', 'volatile', 'while',
  // Gradle's common declarative blocks/configurations deserve keyword contrast.
  'plugins', 'repositories', 'dependencies', 'buildscript', 'subprojects', 'allprojects',
  'tasks', 'sourceSets', 'implementation', 'api', 'compileOnly', 'runtimeOnly',
  'annotationProcessor', 'testImplementation', 'testCompileOnly', 'testRuntimeOnly',
  'testAnnotationProcessor',
];

const GROOVY_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.groovy',
  keywords: GROOVY_KEYWORDS,
  operators: [
    '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||',
    '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>',
    '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=', '>>>=',
    '===', '!==', '<=>', '=~', '==~', '?.', '*.', '.&', '::', '?:', '**', '**=',
  ],
  symbols: /[=><!~?:&|+\-*\/%^]+/,
  escapes: /\\(?:[btnfr"'\\]|u[0-9A-Fa-f]{4})/,
  tokenizer: {
    root: [
      [/[a-zA-Z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      { include: '@whitespace' },
      [/[{}()[\]]/, '@brackets'],
      [/[<>](?!@symbols)/, '@brackets'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/\d+\.\d+(?:[eE][+\-]?\d+)?[fFdD]?/, 'number.float'],
      [/0[xX][0-9a-fA-F_]+[gGlL]?/, 'number.hex'],
      [/\d[\d_]*[gGiIlL]?/, 'number'],
      [/[;,.]/, 'delimiter'],
      [/"""/, { token: 'string.quote', next: '@tripleDoubleString' }],
      [/'''/, { token: 'string.quote', next: '@tripleSingleString' }],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/"/, { token: 'string.quote', next: '@doubleString' }],
    ],
    whitespace: [
      [/[ \t\r\n]+/, ''],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
    doubleString: [
      [/[^\\"$]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/\$[a-zA-Z_$][\w$]*/, 'variable'],
      [/"/, 'string.quote', '@pop'],
    ],
    tripleDoubleString: [
      [/[^\\"$]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\$[a-zA-Z_$][\w$]*/, 'variable'],
      [/"""/, 'string.quote', '@pop'],
      [/"/, 'string'],
    ],
    tripleSingleString: [
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/'''/, 'string.quote', '@pop'],
      [/'/, 'string'],
    ],
  },
};

/** Monaco does not bundle Groovy; register a focused Groovy/Gradle tokenizer. */
export function registerGroovyHighlighting(monaco: typeof Monaco): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === 'groovy')) {
    monaco.languages.register({
      id: 'groovy',
      extensions: ['.groovy', '.gradle'],
      filenames: ['Jenkinsfile'],
      aliases: ['Groovy', 'groovy'],
    });
  }
  monaco.languages.setLanguageConfiguration('groovy', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider('groovy', GROOVY_LANGUAGE);
}
