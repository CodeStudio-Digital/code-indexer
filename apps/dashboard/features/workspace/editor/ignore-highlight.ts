import type * as MonacoNs from 'monaco-editor';

type Monaco = typeof MonacoNs;

/** Gitignore-style patterns used by Git and by most `.*ignore` tools. */
export const IGNORE_LANGUAGE: MonacoNs.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.ignore',
  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      [/^\s*!/, 'keyword'],
      [/\\./, 'string.escape'],
      [/\*\*/, 'keyword'],
      [/[?*]/, 'operator'],
      [/\[(?:!|\^)?(?:\\.|[^\]\\])+\]/, 'regexp'],
      [/\//, 'delimiter'],
    ],
  },
};

export function registerIgnoreHighlighting(monaco: Monaco): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === 'ignore')) {
    monaco.languages.register({
      id: 'ignore',
      extensions: ['.ignore'],
      filenames: [
        '.gitignore', '.dockerignore', '.npmignore', '.eslintignore',
        '.prettierignore', '.stylelintignore', '.helmignore', '.vercelignore',
        '.mcpindexignore', '.ignore', '.gitattributes',
      ],
      aliases: ['Ignore patterns', 'ignore'],
    });
  }
  monaco.languages.setLanguageConfiguration('ignore', {
    comments: { lineComment: '#' },
    brackets: [['[', ']']],
    autoClosingPairs: [{ open: '[', close: ']' }],
    surroundingPairs: [{ open: '[', close: ']' }],
  });
  monaco.languages.setMonarchTokensProvider('ignore', IGNORE_LANGUAGE);
}
