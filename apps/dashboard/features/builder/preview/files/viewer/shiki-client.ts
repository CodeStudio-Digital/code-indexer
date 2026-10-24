import type { HighlighterGeneric, BundledLanguage, BundledTheme } from 'shiki';

/**
 * Lazy singleton Shiki highlighter. We keep one instance per page and
 * load languages/themes on demand so the initial bundle only pulls the
 * two themes below. `loadLanguage` is idempotent, so re-asking for the
 * same language is cheap.
 */

const THEMES = ['github-dark', 'github-light'] as const;

let promise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;
const loadedLangs = new Set<BundledLanguage>();

export async function getHighlighter() {
  if (!promise) {
    promise = import('shiki').then(({ createHighlighter }) => createHighlighter({
      themes: [...THEMES],
      langs: [],
    }));
  }
  return promise;
}

export async function ensureLang(lang: string): Promise<BundledLanguage | 'text'> {
  if (lang === 'text') return lang;
  const candidate = lang as BundledLanguage;
  if (loadedLangs.has(candidate)) return candidate;
  try {
    const hl = await getHighlighter();
    await hl.loadLanguage(candidate);
    loadedLangs.add(candidate);
    return candidate;
  } catch {
    // Unknown/unsupported language — fall back to plain text so we still
    // render the content instead of crashing.
    return 'text';
  }
}

export type ShikiTheme = (typeof THEMES)[number];
