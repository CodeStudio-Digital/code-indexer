import { createHighlighter, type HighlighterGeneric, type BundledLanguage, type BundledTheme } from 'shiki';

/**
 * Lazy singleton Shiki highlighter. We keep one instance per page and
 * load languages/themes on demand so the initial bundle only pulls the
 * two themes below. `loadLanguage` is idempotent, so re-asking for the
 * same language is cheap.
 */

const THEMES = ['github-dark', 'github-light'] as const;

let promise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;
const loadedLangs = new Set<string>();

export async function getHighlighter() {
  if (!promise) {
    promise = createHighlighter({
      themes: [...THEMES],
      langs: [],
    });
  }
  return promise;
}

export async function ensureLang(lang: string): Promise<string> {
  if (lang === 'text' || loadedLangs.has(lang)) return lang;
  try {
    const hl = await getHighlighter();
    await hl.loadLanguage(lang as BundledLanguage);
    loadedLangs.add(lang);
    return lang;
  } catch {
    // Unknown/unsupported language — fall back to plain text so we still
    // render the content instead of crashing.
    return 'text';
  }
}

export type ShikiTheme = (typeof THEMES)[number];
