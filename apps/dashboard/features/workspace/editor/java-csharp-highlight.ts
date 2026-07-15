/**
 * Contextual Java/C# syntax colours used while semantic tokens are unavailable
 * or still warming. Monaco's bundled grammars intentionally classify almost
 * every symbol as `identifier`; these small prepend-only extensions preserve the
 * base grammars while distinguishing declarations, types, calls and members.
 */
import type * as MonacoNs from 'monaco-editor';
// eslint-disable-next-line import/no-unresolved
import { language as baseJava } from 'monaco-editor/esm/vs/basic-languages/java/java.js';
// eslint-disable-next-line import/no-unresolved
import { language as baseCsharp } from 'monaco-editor/esm/vs/basic-languages/csharp/csharp.js';

type Monaco = typeof MonacoNs;
type RootLanguage = MonacoNs.languages.IMonarchLanguage & {
  tokenizer: { root: MonacoNs.languages.IMonarchLanguageRule[] };
};

const JAVA_RULES: MonacoNs.languages.IMonarchLanguageRule[] = [
  [/(import)(\s+)((?:[a-zA-Z_$][\w$]*\.)*)([A-Z][a-zA-Z0-9_$]*)/, ['keyword.java', 'white', 'entity.name.namespace', 'entity.name.type']],
  [/(package|import)(\s+)([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/, ['keyword.java', 'white', 'entity.name.namespace']],
  [/(class|interface|enum|record)(\s+)([a-zA-Z_$][\w$]*)/, ['keyword.java', 'white', 'entity.name.type.class']],
  [/(extends|implements|permits|throws)(\s+)([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/, ['keyword.java', 'white', 'entity.name.type']],
  [/(new|instanceof)(\s+)([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/, ['keyword.java', 'white', 'entity.name.type']],
  [/(\.)(\s*)([a-zA-Z_$][\w$]*)(?=\s*\()/, ['delimiter.java', 'white', 'entity.name.function.member']],
  [/(\.)(\s*)([a-zA-Z_$][\w$]*)/, ['delimiter.java', 'white', 'variable.other.property']],
  [/[A-Z_$][A-Z0-9_$]*(?=\s*(?:=|;|,))/, 'variable.other.constant'],
  [/[A-Z][a-zA-Z0-9_$]*/, 'entity.name.type'],
  [/[a-zA-Z_$][\w$]*(?=\s*\()/, {
    cases: { '@keywords': 'keyword.$0', '@default': 'entity.name.function.member' },
  }],
];

const CSHARP_RULES: MonacoNs.languages.IMonarchLanguageRule[] = [
  [/(namespace|using)(\s+)([A-Z]\w*(?:\.[A-Z]\w*)*)/, ['keyword.cs', 'white', 'entity.name.namespace']],
  [/(record(?:\s+(?:class|struct))?|class|struct|interface|enum)(\s+)([a-zA-Z_]\w*)/, ['keyword.cs', 'white', 'entity.name.type.class']],
  [/(new|is|as)(\s+)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/, ['keyword.cs', 'white', 'entity.name.type']],
  [/(\[)(\s*)([A-Z][a-zA-Z0-9_]*(?:Attribute)?)/, ['delimiter.square.cs', 'white', 'entity.name.decorator']],
  [/(\.)(\s*)(@?[a-zA-Z_]\w*)(?=\s*\()/, ['delimiter.cs', 'white', 'entity.name.function.member']],
  [/(\.)(\s*)(@?[a-zA-Z_]\w*)/, ['delimiter.cs', 'white', 'variable.other.property']],
  [/[A-Z_][A-Z0-9_]*(?=\s*(?:=|;|,))/, 'variable.other.constant'],
  [/@?[a-zA-Z_]\w*(?=\s*\()/, {
    cases: { '@keywords': 'keyword.$0', '@default': 'entity.name.function.member' },
  }],
  [/[A-Z][a-zA-Z0-9_]*/, 'entity.name.type'],
];

export const JAVA_EXTRA_RULES = JAVA_RULES;
export const CSHARP_EXTRA_RULES = CSHARP_RULES;

function enrich(base: MonacoNs.languages.IMonarchLanguage, extra: MonacoNs.languages.IMonarchLanguageRule[]): MonacoNs.languages.IMonarchLanguage {
  const language = base as RootLanguage;
  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      root: [...extra, ...language.tokenizer.root],
    },
  };
}

export function enrichedJava(): MonacoNs.languages.IMonarchLanguage {
  return enrich(baseJava, JAVA_RULES);
}

export function enrichedCsharp(): MonacoNs.languages.IMonarchLanguage {
  return enrich(baseCsharp, CSHARP_RULES);
}

const installations = new WeakSet<object>();

export function enrichJavaCsharpHighlighting(monaco: Monaco): void {
  if (installations.has(monaco)) return;
  monaco.languages.registerTokensProviderFactory('java', { create: () => enrichedJava() });
  monaco.languages.registerTokensProviderFactory('csharp', { create: () => enrichedCsharp() });
  installations.add(monaco);
}
