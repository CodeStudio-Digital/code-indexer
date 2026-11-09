import type { ShikiTheme } from '../../builder/preview/files/viewer/shiki-client.js';

// Tokenization and the resulting span tree run on the renderer thread. Large
// expanded fences keep their full readable/copyable text without that cost.
export const MAX_HIGHLIGHT_CHARS = 50_000;

/** Lazy grammar initialization may outlive several streaming renders. Check
 * cancellation before tokenization, not just before publishing its result. */
export async function highlightMarkdownCode(code: string, lang: string, theme: ShikiTheme, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted || code.length > MAX_HIGHLIGHT_CHARS || lang === 'text') return null;
  const { ensureLang, getHighlighter } = await import('../../builder/preview/files/viewer/shiki-client.js');
  if (signal.aborted) return null;
  const resolvedLang = await ensureLang(lang);
  if (signal.aborted || resolvedLang === 'text') return null;
  const highlighter = await getHighlighter();
  if (signal.aborted) return null;
  return highlighter.codeToHtml(code, { lang: resolvedLang, theme });
}
