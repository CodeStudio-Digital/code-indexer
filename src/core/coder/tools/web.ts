import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';

/**
 * Web tools — web_fetch and web_search.
 *
 * Fill a gaping hole in the previous catalog: without these the agent has
 * no way to answer "what's the latest version of X?", "what did the
 * maintainers change in Y's 4.0?", "are there known CVEs in Z?". It had
 * to guess (hallucinate) or ask the user.
 *
 * Design goals:
 * - Zero new runtime dependencies (uses native fetch, a small HTML→markdown
 *   converter inline, and falls back to scraping when no API key is set).
 * - Deterministic output shape so prompt cache stays stable across retries.
 * - Hard output caps to prevent a single page from flooding the history.
 * - Short TTL in-memory cache keyed by (url, search-query) so the agent can
 *   re-check the same page within a session without paying twice.
 */

const OUTPUT_CAP = Number(process.env.CODER_WEB_OUTPUT_CAP ?? 15_000);
const FETCH_TIMEOUT_MS = Number(process.env.CODER_WEB_TIMEOUT_MS ?? 20_000);
const CACHE_TTL_MS = Number(process.env.CODER_WEB_CACHE_TTL_MS ?? 15 * 60 * 1000);

// In-memory cache. Keyed by a string prefix + the raw key (URL or query).
interface CacheEntry {
  at: number;
  text: string;
}
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.text;
}

function cachePut(key: string, text: string): void {
  cache.set(key, { at: Date.now(), text });
  if (cache.size > 50) {
    // Evict oldest.
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

/**
 * Minimal HTML → plaintext/markdown converter. Intentionally not pulling
 * turndown as a dep — most of what the agent needs from a page is readable
 * text + link targets, and a focused regex pipeline does that in ~50 lines
 * without adding 200KB to the install.
 */
function htmlToMarkdown(html: string): string {
  // Strip <script> and <style> blocks entirely.
  let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  // Drop HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Headings → markdown.
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  s = s.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
  // Code blocks.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '\n\n```\n$1\n```\n\n');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Links: keep both text and href.
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Lists.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  // Line breaks and paragraphs.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<p\b[^>]*>/gi, '');
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, '');
  // Decode the common HTML entities.
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Collapse excessive whitespace.
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

function applyCap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return (
    text.slice(0, OUTPUT_CAP) +
    `\n\n[truncated: ${text.length - OUTPUT_CAP} chars elided — the page was too long for inline capture]`
  );
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'mcp-code-indexer/3.11 (+https://github.com/CodeStudio/MCP-CodeBase)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── web_fetch ─────────────────────────────────────────────────────

export const webFetch: CoderTool = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its content converted to plain text / markdown.\n' +
    "USE: read documentation for an external library (react.dev, docs.python.org, MDN), a specific GitHub README/issue/PR page, a changelog, a Stack Overflow answer, or any public web page the user cited.\n" +
    "USE: follow a redirect the user pasted to see where it ends up.\n" +
    "DON'T: use on local files (use read_file or mcp__read_file instead).\n" +
    "DON'T: use for code search across the project (use mcp__search or mcp__grep_code).\n" +
    "DON'T: scrape paginated result pages one-by-one — use web_search for that.\n" +
    `Output is capped at ~${OUTPUT_CAP} chars. Results are cached in-memory for ${Math.round(CACHE_TTL_MS / 60_000)} minutes.`,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to fetch. Must start with http:// or https://.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  handler: async (args, _ctx: ToolContext): Promise<ToolResult> => {
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) return err('url cannot be empty');
    if (!/^https?:\/\//i.test(rawUrl)) {
      return err(`url must start with http:// or https:// — got '${rawUrl}'`);
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return err(`invalid url: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Guard against obvious internal/private endpoints to avoid SSRF mischief
    // when the agent is persuaded to fetch an attacker-controlled target.
    const host = parsed.hostname;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|localhost$|::1$)/i.test(host)) {
      return err(
        `refusing to fetch private/loopback host '${host}'. If you need local content, use read_file or run_command.`,
      );
    }

    const cacheKey = `fetch:${parsed.toString()}`;
    const hit = cacheGet(cacheKey);
    if (hit) return ok(hit + '\n\n[cached]');

    try {
      const res = await fetchWithTimeout(parsed.toString());
      if (!res.ok) {
        return err(`web_fetch: HTTP ${res.status} ${res.statusText} for ${parsed.toString()}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      let body: string;
      if (contentType.includes('application/json')) {
        try {
          body = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          body = raw;
        }
      } else if (contentType.includes('text/html') || /<html[\s>]/i.test(raw)) {
        body = htmlToMarkdown(raw);
      } else {
        body = raw;
      }
      const header = `# ${parsed.toString()}\n\nContent-Type: ${contentType || '(unknown)'}\n\n---\n\n`;
      const out = applyCap(header + body);
      cachePut(cacheKey, out);
      return ok(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`web_fetch failed: ${msg}`);
    }
  },
};

// ── web_search ────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Brave Search backend. Uses the free-tier REST API when `BRAVE_API_KEY`
 * is set. Returns up to 10 results.
 */
async function searchBrave(query: string, key: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'X-Subscription-Token': key,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const results = data.web?.results ?? [];
  return results.slice(0, 10).map((r) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    snippet: htmlToMarkdown(String(r.description ?? '')).slice(0, 300),
  }));
}

/**
 * DuckDuckGo HTML scraping fallback. No API key needed. Slightly fragile
 * (format can change) but good enough when Brave isn't configured.
 */
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`DDG ${res.status}: ${res.statusText}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  // Parse result blocks: each link has class "result__a" with href, followed
  // by a snippet with class "result__snippet". Intentionally forgiving regex.
  const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && results.length < 10) {
    const href = match[1];
    const title = htmlToMarkdown(match[2]).trim();
    const snippet = htmlToMarkdown(match[3]).trim().slice(0, 300);
    // DDG wraps URLs in a /l/?uddg=<encoded> redirect — unwrap.
    let finalUrl = href;
    try {
      const parsed = new URL(href, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) finalUrl = decodeURIComponent(uddg);
    } catch {
      /* keep raw */
    }
    results.push({ title, url: finalUrl, snippet });
  }
  return results;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');
}

function domainFilter(
  results: SearchResult[],
  allow?: string[],
  block?: string[],
): SearchResult[] {
  let out = results;
  if (allow && allow.length > 0) {
    out = out.filter((r) => allow.some((d) => r.url.includes(d)));
  }
  if (block && block.length > 0) {
    out = out.filter((r) => !block.some((d) => r.url.includes(d)));
  }
  return out;
}

export const webSearch: CoderTool = {
  name: 'web_search',
  description:
    'Search the web and return a ranked list of URLs + snippets.\n' +
    "USE: discover the canonical docs URL for a library, find recent changelog entries, locate Stack Overflow threads about an error message, check whether a package has been deprecated.\n" +
    "USE: follow up with web_fetch on the best result(s) when you need the full content.\n" +
    "DON'T: use for project questions — use mcp__search or mcp__grep_code.\n" +
    "DON'T: use as a substitute for web_fetch when you already know the URL.\n" +
    "Backend: Brave Search when BRAVE_API_KEY is set (free tier 2000/mo), DuckDuckGo HTML scraping fallback otherwise. Output is cached for 15min.",
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Keep it short and keyword-dense (3-8 words usually works best).',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Only return results whose URL contains one of these substrings (e.g. ["docs.python.org"]).',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Drop results whose URL contains one of these substrings (e.g. ["w3schools.com"]).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, _ctx: ToolContext): Promise<ToolResult> => {
    const query = String(args.query ?? '').trim();
    if (!query) return err('query cannot be empty');
    const allow = Array.isArray(args.allowed_domains)
      ? args.allowed_domains.map(String)
      : undefined;
    const block = Array.isArray(args.blocked_domains)
      ? args.blocked_domains.map(String)
      : undefined;

    const cacheKey = `search:${query}|${(allow ?? []).join(',')}|${(block ?? []).join(',')}`;
    const hit = cacheGet(cacheKey);
    if (hit) return ok(hit + '\n\n[cached]');

    const braveKey = process.env.BRAVE_API_KEY;
    let results: SearchResult[] = [];
    let backend = 'none';
    try {
      if (braveKey) {
        backend = 'brave';
        results = await searchBrave(query, braveKey);
      } else {
        backend = 'duckduckgo';
        results = await searchDuckDuckGo(query);
      }
    } catch (e) {
      // Brave failed → try DDG fallback. DDG failed → bubble up.
      if (backend === 'brave') {
        try {
          results = await searchDuckDuckGo(query);
          backend = 'duckduckgo (brave failed)';
        } catch (e2) {
          return err(
            `web_search failed (brave + ddg): ${e instanceof Error ? e.message : String(e)} / ${e2 instanceof Error ? e2.message : String(e2)}`,
          );
        }
      } else {
        return err(`web_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const filtered = domainFilter(results, allow, block);
    const body = `[backend: ${backend}]\nquery: ${query}\n\n${formatResults(filtered)}`;
    const capped = applyCap(body);
    cachePut(cacheKey, capped);
    return ok(capped);
  },
};

export const webTools: CoderTool[] = [webFetch, webSearch];
