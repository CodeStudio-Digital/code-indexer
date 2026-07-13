/**
 * HTML → Markdown conversion with aggressive noise stripping.
 *
 * The doc indexer doesn't care about chrome — nav bars, footers, cookie
 * banners, sidebars, search boxes — only the article body. We use cheerio
 * to surgically remove those before handing the cleaned tree to Turndown.
 *
 * Heuristics for "main content":
 *   1. `<main>` element if present (semantic HTML 5)
 *   2. `<article>` element (blog-style docs)
 *   3. The largest `<div>` by text content (fallback for unstyled sites)
 */
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '.nav', '.navbar', '.navigation',
  '.sidebar', '.toc', '.table-of-contents',
  '.header', '.footer',
  '.search', '.searchbox',
  '.cookie', '.cookie-banner',
  '.advertisement', '.ad',
  '#nav', '#header', '#footer', '#sidebar', '#search',
];

const UNITY_STRIP_SELECTORS = [
  '.scrollToFeedback',
  '.suggest',
  '.switch-link',
  '.feedback',
  '.toolbar',
  '.footer-wrapper',
  '#DocsAnalyticsData',
];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  hr: '---',
  emDelimiter: '_',
  strongDelimiter: '**',
});

// Prefer fenced code blocks for `<pre><code class="language-X">…</code></pre>`.
turndown.addRule('fencedCodeWithLang', {
  filter: (node) => {
    if (node.nodeName !== 'PRE') return false;
    return (node as HTMLElement).querySelector?.('code') != null;
  },
  replacement: (_content, node) => {
    const codeEl = (node as HTMLElement).querySelector?.('code');
    const text = codeEl?.textContent ?? '';
    const langMatch = codeEl?.className?.match(/language-([\w+-]+)/);
    const lang = langMatch?.[1] ?? '';
    return `\n\n\`\`\`${lang}\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
  },
});

// Heading rule that carries a deep-link anchor as a Pandoc `{#id}` suffix:
// the real HTML `id` when the page set one (MDN, most static-site generators),
// else a GitHub-style slug of the heading text. The section chunker strips the
// `{#id}` back off (heading_path stays clean) and stores it as the chunk's
// `anchor`, so citations can point to `source_uri#anchor` — the exact section.
turndown.addRule('headingWithAnchor', {
  filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const text = content.trim().replace(/\n+/g, ' ');
    if (!text) return '';
    const level = Number(el.nodeName.charAt(1)) || 1;
    const id = (el.getAttribute?.('id') ?? '').trim() || slugify(text);
    return `\n\n${'#'.repeat(level)} ${text} {#${id}}\n\n`;
  },
});

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces → hyphens. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'section';
}

export interface ConvertedPage {
  title: string | null;
  markdown: string;
  /** Outbound same-origin links — used by the BFS crawler. */
  links: string[];
  /** Meta robots `noindex` was set on the page. */
  noindex: boolean;
  canonicalUrl: string | null;
  adapter: 'generic' | 'unity-script-reference';
}

export interface ConvertHtmlOptions {
  /** Base URL — used to resolve relative links. Required for crawl. */
  baseUrl: string;
  /** Restrict link extraction to the same origin. Default true. */
  sameOriginOnly?: boolean;
  /** Optional operator/site adapter overrides. */
  contentSelectors?: string[];
  excludeSelectors?: string[];
}

/**
 * Strip nav/footer/script/style and return:
 *   - title  (from `<title>` or first `<h1>`)
 *   - markdown body
 *   - same-origin links found in the body (for BFS expansion)
 *   - noindex flag (so the gate can drop those before the LLM)
 */
export function convertHtmlToMarkdown(html: string, opts: ConvertHtmlOptions): ConvertedPage {
  const $ = cheerio.load(html);

  const noindex = $('meta[name="robots"][content*="noindex" i]').length > 0;
  const canonicalUrl = ($('link[rel="canonical"]').first().attr('href') ?? '').trim() || null;
  const unityScriptReference = /[\\/]ScriptReference[\\/]/i.test(opts.baseUrl)
    || /\/Documentation\/ScriptReference\//i.test(canonicalUrl ?? '');

  // Title: <title> tag if non-empty, else first <h1>.
  const titleFromTag = $('title').first().text().trim();
  const titleFromH1 = $('h1').first().text().trim();
  const title = titleFromTag || titleFromH1 || null;

  // ── Step 1: collect links from the FULL document BEFORE stripping.
  //
  // Many doc sites (Unity ScriptReference, JSDoc-style API refs, etc.)
  // put the page-to-page navigation tree in a <nav>/<aside>/sidebar
  // that our STRIP_SELECTORS removes BEFORE we extract links. The seed
  // page survives, but the BFS frontier dies because the cleaned <main>
  // has no outbound links. Fix: extract every `a[href]` from the full
  // doc before stripping. The `required_path` filter the crawler
  // applies downstream keeps the frontier scoped — picking up footer
  // links to unrelated Unity products doesn't matter, they get dropped.
  const links: string[] = [];
  const sameOriginOnly = opts.sameOriginOnly !== false;
  let baseOrigin: string | null = null;
  try { baseOrigin = new URL(opts.baseUrl).origin; } catch { /* invalid base */ }

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    try {
      const resolved = new URL(href, opts.baseUrl);
      // Strip fragment — we index per-page, not per-anchor.
      resolved.hash = '';
      if (sameOriginOnly && baseOrigin && resolved.origin !== baseOrigin) return;
      links.push(resolved.toString());
    } catch { /* invalid URL */ }
  });

  // ── Step 2: strip noise for markdown generation.
  for (const sel of STRIP_SELECTORS) {
    $(sel).remove();
  }
  if (unityScriptReference) {
    for (const sel of UNITY_STRIP_SELECTORS) $(sel).remove();
  }
  for (const sel of opts.excludeSelectors ?? []) $(sel).remove();

  // Pick the main content container. Falls through to '*:first' so we
  // always have an Element-scoped Cheerio (`$.root()` is Document and
  // breaks `.find(...).each(...)` typing in cheerio v1).
  const configured = (opts.contentSelectors ?? []).find((sel) => $(sel).first().length > 0);
  const root = configured
    ? $(configured).first()
    : unityScriptReference && $('#content-wrap .content').first().length > 0
      ? $('#content-wrap .content').first()
      : $('main').first().length > 0
        ? $('main').first()
        : $('article').first().length > 0
          ? $('article').first()
          : $('[role="main"]').first().length > 0
            ? $('[role="main"]').first()
            : largestContentDiv($);

  const rootHtml = root.html() ?? '';
  const markdown = turndown.turndown(rootHtml).trim();

  return {
    title,
    markdown,
    links: dedupe(links),
    noindex,
    canonicalUrl,
    adapter: unityScriptReference ? 'unity-script-reference' : 'generic',
  };
}

function largestContentDiv($: cheerio.CheerioAPI) {
  let best = $('body').first();
  let bestScore = best.text().trim().length;
  $('body div').each((_, el) => {
    const node = $(el);
    const textLen = node.text().trim().length;
    const linkLen = node.find('a').text().trim().length;
    const score = textLen - Math.floor(linkLen * 0.7);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  });
  return best;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
