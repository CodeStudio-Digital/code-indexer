export type EditorWordWrap = 'off' | 'on' | 'wordWrapColumn' | 'bounded';
export type EditorWhitespace = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';

/** Versioned editor preferences shared by dashboard, API and persistence. */
export interface EditorSettings {
  version: 1;
  fontFamily: string;
  /** null follows the current UI density. */
  fontSize: number | null;
  fontLigatures: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  wordWrap: EditorWordWrap;
  wordWrapColumn: number;
  renderWhitespace: EditorWhitespace;
  rulers: number[];
  detectIndentation: boolean;
  tabSize: number;
  insertSpaces: boolean;
  endOfLine: 'auto' | 'lf' | 'crlf';
  formatOnPaste: boolean;
  formatOnSave: boolean;
  formatOnType: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  quickSuggestions: boolean;
  suggestOnTriggerCharacters: boolean;
  acceptSuggestionOnEnter: 'on' | 'off' | 'smart';
  tabCompletion: 'on' | 'off' | 'onlySnippets';
  wordBasedSuggestions: 'off' | 'currentDocument' | 'matchingDocuments' | 'allDocuments';
  snippetSuggestions: 'top' | 'bottom' | 'inline' | 'none';
  aiCompletionEnabled: boolean;
  aiCompletionMode: 'automatic' | 'manual';
  includeRelatedCode: boolean;
  respectEditorConfig: boolean;
}

export type EditorSettingsOverride = Partial<Omit<EditorSettings, 'version'>> & { version?: 1 };

export const DEFAULT_EDITOR_SETTINGS: Readonly<EditorSettings> = Object.freeze({
  version: 1,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  fontSize: null,
  fontLigatures: true,
  minimap: true,
  stickyScroll: true,
  wordWrap: 'off',
  wordWrapColumn: 120,
  renderWhitespace: 'selection',
  rulers: [],
  detectIndentation: true,
  tabSize: 2,
  insertSpaces: true,
  endOfLine: 'auto',
  formatOnPaste: true,
  formatOnSave: false,
  formatOnType: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  quickSuggestions: true,
  suggestOnTriggerCharacters: true,
  acceptSuggestionOnEnter: 'on',
  tabCompletion: 'on',
  wordBasedSuggestions: 'off',
  snippetSuggestions: 'inline',
  aiCompletionEnabled: true,
  aiCompletionMode: 'automatic',
  includeRelatedCode: false,
  respectEditorConfig: true,
});

export function mergeEditorSettings(...layers: Array<EditorSettingsOverride | null | undefined>): EditorSettings {
  const merged: EditorSettings = Object.assign({}, DEFAULT_EDITOR_SETTINGS, ...layers, { version: 1 as const });
  merged.rulers = Array.isArray(merged.rulers)
    ? [...new Set(merged.rulers.filter((value) => Number.isInteger(value) && value > 0 && value <= 500))]
    : [];
  merged.tabSize = Math.min(16, Math.max(1, Number(merged.tabSize) || 2));
  merged.wordWrapColumn = Math.min(500, Math.max(40, Number(merged.wordWrapColumn) || 120));
  merged.fontSize = merged.fontSize === null ? null : Math.min(40, Math.max(8, Number(merged.fontSize) || 13));
  return merged;
}
