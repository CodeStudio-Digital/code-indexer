/**
 * Editor color-scheme preference (global, like state/ui-density.ts).
 *
 * Holds the default dark and light themes plus optional per-language overrides
 * (e.g. PHP → IntelliJ Darcula). The active editor resolves its theme from the
 * focused file's language via `resolveThemeId`, then `monaco.editor.setTheme`.
 * Persisted to localStorage; the catalog of available themes lives in
 * features/workspace/editor/themes.
 *
 * NOTE: a per-language override is a single themeId applied regardless of the
 * app's light/dark mode — it's an explicit "this language always looks like X"
 * choice. Only the default (no override) follows the dark/light toggle.
 */
import { create } from 'zustand';
import { isKnownThemeId } from '../features/workspace/editor/themes/index.js';
import type { ThemeAppearance } from '../features/workspace/editor/themes/types.js';

export interface EditorThemeState {
  /** Theme used in dark mode when no per-language override applies. */
  darkTheme: string;
  /** Theme used in light mode when no per-language override applies. */
  lightTheme: string;
  /** languageId → themeId. A present entry wins over the dark/light default. */
  perLanguage: Record<string, string>;
}

const STORAGE_KEY = 'mcp-ide:editor-theme';
const DEFAULT: EditorThemeState = { darkTheme: 'codestudio-dark', lightTheme: 'codestudio-light', perLanguage: {} };

/**
 * Pure theme resolution — exported and unit-tested. Per-language override (if
 * the id is still known) beats the appearance default.
 */
export function resolveThemeId(args: {
  appearance: ThemeAppearance;
  languageId: string | null | undefined;
  state: EditorThemeState;
}): string {
  const { appearance, languageId, state } = args;
  if (languageId) {
    const override = state.perLanguage[languageId];
    if (override && isKnownThemeId(override)) return override;
  }
  const fallback = appearance === 'dark' ? state.darkTheme : state.lightTheme;
  return isKnownThemeId(fallback) ? fallback : DEFAULT[appearance === 'dark' ? 'darkTheme' : 'lightTheme'];
}

function loadPersisted(): EditorThemeState {
  if (typeof window === 'undefined') return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<EditorThemeState>;
    const perLanguage: Record<string, string> = {};
    if (parsed.perLanguage && typeof parsed.perLanguage === 'object') {
      for (const [lang, id] of Object.entries(parsed.perLanguage)) {
        if (typeof id === 'string' && isKnownThemeId(id)) perLanguage[lang] = id;
      }
    }
    return {
      darkTheme: typeof parsed.darkTheme === 'string' && isKnownThemeId(parsed.darkTheme)
        ? parsed.darkTheme : DEFAULT.darkTheme,
      lightTheme: typeof parsed.lightTheme === 'string' && isKnownThemeId(parsed.lightTheme)
        ? parsed.lightTheme : DEFAULT.lightTheme,
      perLanguage,
    };
  } catch {
    return DEFAULT;
  }
}

function persist(state: EditorThemeState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota/disabled — non-fatal */
  }
}

interface EditorThemeStore extends EditorThemeState {
  setDarkTheme: (id: string) => void;
  setLightTheme: (id: string) => void;
  /** Set (id) or clear (null) the override for a language. */
  setLanguageOverride: (languageId: string, id: string | null) => void;
}

const initial = loadPersisted();

export const useEditorTheme = create<EditorThemeStore>((set, get) => ({
  ...initial,
  setDarkTheme: (id) =>
    set(() => {
      const next = { ...stateOf(get()), darkTheme: id };
      persist(next);
      return next;
    }),
  setLightTheme: (id) =>
    set(() => {
      const next = { ...stateOf(get()), lightTheme: id };
      persist(next);
      return next;
    }),
  setLanguageOverride: (languageId, id) =>
    set(() => {
      const perLanguage = { ...get().perLanguage };
      if (id) perLanguage[languageId] = id;
      else delete perLanguage[languageId];
      const next = { ...stateOf(get()), perLanguage };
      persist(next);
      return next;
    }),
}));

/** Strip the actions off the store to get the plain persisted slice. */
function stateOf(s: EditorThemeStore | EditorThemeState): EditorThemeState {
  return { darkTheme: s.darkTheme, lightTheme: s.lightTheme, perLanguage: s.perLanguage };
}

/** Plain snapshot for non-React callers (e.g. the editor mount resolver). */
export function editorThemeSnapshot(): EditorThemeState {
  return stateOf(useEditorTheme.getState());
}
