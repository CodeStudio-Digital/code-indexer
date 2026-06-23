/**
 * Minimal sitemap.xml parser. We don't pull a full XML parser dep just for
 * this; sitemaps are extremely uniform and a regex catches >99% of well-
 * formed entries. Bad input → empty list (caller falls back to BFS crawl).
 */
import type { UrlFetcher } from './url-fetcher.js';

const URL_RE = /<loc>\s*([^<]+?)\s*<\/loc>/g;
const SITEMAP_INDEX_RE = /<sitemap>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>/g;

export interface SitemapDiscoverOptions {
  /** Recurse into sitemap-index entries this many times (default 1). */
  maxIndexDepth?: number;
  /** Cap the returned URL count. Default 5000. */
  maxUrls?: number;
}

/**
 * Try `/sitemap.xml` at the seed origin and return the list of URLs
 * declared inside. Sitemap-index responses are recursed (max depth
 * configurable). Returns an empty array on any failure — the caller
 * should fall back to a BFS crawl from the seed.
 */
export async function discoverFromSitemap(
  seed: string,
  fetcher: UrlFetcher,
  opts: SitemapDiscoverOptions = {},
): Promise<string[]> {
  const maxIndexDepth = opts.maxIndexDepth ?? 1;
  const maxUrls = opts.maxUrls ?? 5000;
  const seedUrl = new URL(seed);
  const sitemapUrl = `${seedUrl.protocol}//${seedUrl.host}/sitemap.xml`;
  return parseSitemapTree(sitemapUrl, fetcher, maxIndexDepth, maxUrls);
}

async function parseSitemapTree(
  sitemapUrl: string,
  fetcher: UrlFetcher,
  remainingDepth: number,
  maxUrls: number,
  visited: Set<string> = new Set(),
): Promise<string[]> {
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  let body: string;
  try {
    const page = await fetcher.fetchPage(sitemapUrl);
    if (page.status >= 400 || !page.contentType.includes('xml')) return [];
    body = page.html;
  } catch {
    return [];
  }

  // Sitemap-index?  <sitemap><loc>...</loc></sitemap>
  const isIndex = body.includes('<sitemapindex');
  const urls: string[] = [];
  if (isIndex && remainingDepth > 0) {
    const indexes = matchAll(body, SITEMAP_INDEX_RE);
    for (const child of indexes) {
      if (urls.length >= maxUrls) break;
      const inner = await parseSitemapTree(child, fetcher, remainingDepth - 1, maxUrls - urls.length, visited);
      urls.push(...inner);
    }
    return urls.slice(0, maxUrls);
  }

  // Regular urlset.
  const found = matchAll(body, URL_RE);
  for (const url of found) {
    if (urls.length >= maxUrls) break;
    urls.push(url);
  }
  return urls;
}

function matchAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const v = decodeXmlEntities(match[1] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
