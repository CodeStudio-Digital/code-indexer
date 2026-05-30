/**
 * Core internationalization for the IDE. A tiny, dependency-light i18n layer:
 *  - a Zustand store holding the active locale (persisted in localStorage),
 *  - `translate()` — a pure lookup with `{var}` interpolation and `en` fallback,
 *  - `useT()` — a hook returning a `t(key, vars?)` bound to the live locale.
 *
 * Plugins get the active locale through the webview bridge (window.mcp.i18n);
 * they ship their OWN catalogs (the host can't know a plugin's strings).
 */
import { create } from 'zustand';
import { MESSAGES, type Locale, type Messages } from './i18n-messages.js';

const STORAGE_KEY = 'mcp.locale';
const SUPPORTED: Locale[] = ['en', 'pt-BR'];

/** localStorage override → system language (pt* → pt-BR) → English. */
export function detectLocale(): Locale {
  if (typeof window !== 'undefined') {
    const saved = window.localStorage?.getItem(STORAGE_KEY);
    if (saved && (SUPPORTED as string[]).includes(saved)) return saved as Locale;
    const sys = (navigator?.language ?? '').toLowerCase();
    if (sys.startsWith('pt')) return 'pt-BR';
  }
  return 'en';
}

/** Substitute `{name}` placeholders from `vars`. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Pure translation: locale catalog → English fallback → the key itself. */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const fromLocale: Messages = MESSAGES[locale] ?? {};
  const msg = fromLocale[key] ?? MESSAGES.en[key] ?? key;
  return interpolate(msg, vars);
}

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    try {
      window.localStorage?.setItem(STORAGE_KEY, locale);
    } catch {
      /* private mode / no storage — keep in-memory only */
    }
    set({ locale });
  },
}));

/** Hook: returns a `t(key, vars?)` bound to the current locale (re-renders on change). */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const locale = useLocaleStore((s) => s.locale);
  return (key, vars) => translate(locale, key, vars);
}
