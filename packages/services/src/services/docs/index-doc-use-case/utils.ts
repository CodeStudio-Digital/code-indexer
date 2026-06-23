import { createHash } from 'node:crypto';
import type { DocCrawlConfig, DocSource } from '@mcp/store/doc-store.js';

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}

export function hashEmbeddingInput(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}

export function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

export function buildEmbeddingText(headingPath: string | null, summary: string | null, content: string): string {
  const head = headingPath ? `# ${headingPath}\n\n` : '';
  const intro = summary ? `${summary}\n\n` : '';
  return `${head}${intro}${content}`;
}

/**
 * Resolve crawl config from a persisted source row. Folder sources do not
 * have crawl semantics — returning `{}` avoids interpreting the default
 * zero/false column values as operator intent.
 */
export function defaultCrawlConfig(source: DocSource): DocCrawlConfig {
  if (source.type === 'folder') return {};
  return {
    enabled: source.crawl_enabled,
    max_pages: source.crawl_max_pages,
    max_depth: source.crawl_max_depth,
    same_origin: source.crawl_same_origin,
    include_pattern: source.crawl_include_pattern,
    exclude_pattern: source.crawl_exclude_pattern,
    required_path: source.crawl_required_path,
    llm_extract_links: source.crawl_llm_extract_links,
    force_browser: source.crawl_force_browser,
    browser_seed_only: source.crawl_browser_seed_only,
  };
}

/**
 * Auto-prepend `https://` when the user typed a bare host. Without this,
 * `new URL('docs.unity3d.com/foo')` throws → the crawler's `normalizeUrl`
 * silently drops the seed → ingestion "DONE" with 0 pages and no error.
 * Returns null when the input still isn't parseable after the prepend.
 */
export function normalizeSeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject bare paths / leading slashes — there's no host to assume.
  if (trimmed.startsWith('/')) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    // Require an actual host with a dot — rejects `https://localhost` of course,
    // but the indexer is for public docs and `localhost` is SSRF-blocked
    // elsewhere. The dot-check catches typos like `https://docs` (no TLD).
    if (!u.host.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}
