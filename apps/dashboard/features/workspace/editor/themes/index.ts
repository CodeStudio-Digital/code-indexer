/**
 * Editor theme registry. `defineEditorThemes` registers every custom theme with
 * Monaco (called once from `setupMonaco`, before the first editor mounts, so the
 * themes exist for every Monaco instance — editor, API client, diff views).
 * `THEME_OPTIONS` is the flat list the settings UI renders.
 */
import type * as MonacoNs from 'monaco-editor';
import { EDITOR_THEMES } from './catalog.js';
import type { ThemeAppearance } from './types.js';




/** Register the custom themes (built-in vs/vs-dark are skipped — already known). */
export function defineEditorThemes(monaco: typeof MonacoNs): void {
  for (const theme of EDITOR_THEMES) {
    if (!theme.data) continue;
    try {
      monaco.editor.defineTheme(theme.id, theme.data);
    } catch {
      /* a malformed theme must never break editor setup — skip it */
    }
  }
}

interface ThemeOption {
  id: string;
  label: string;
  appearance: ThemeAppearance;
}

export const THEME_OPTIONS: ThemeOption[] = EDITOR_THEMES.map(({ id, label, appearance }) => ({
  id, label, appearance,
}));

/** Whether `id` is a known theme (used to ignore stale localStorage values). */
export function isKnownThemeId(id: string): boolean {
  return EDITOR_THEMES.some((t) => t.id === id);
}
