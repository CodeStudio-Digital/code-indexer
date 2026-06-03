import { isIP } from 'node:net';
import TurndownService from 'turndown';
// @ts-expect-error — turndown-plugin-gfm ships no TS types.
import { gfm } from 'turndown-plugin-gfm';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

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

/** Block a literal IPv4 octet quad that falls in a private/loopback/special range. */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 127 || // loopback 127/8
    a === 10 || // private 10/8
    a === 0 || // "this host" 0/8 (0.0.0.0 etc.)
    (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
    (a === 192 && b === 168) || // private 192.168/16
    (a === 169 && b === 254) // link-local 169.254/16
  );
}

/**
 * SSRF defense-in-depth: should `web_fetch` REFUSE this hostname? Catches
 * private/loopback/link-local IPs (v4 + v6), IPv4-mapped IPv6, and obfuscated
 * numeric/hex IP literals (e.g. `2130706433`, `0x7f000001`) that bypass a naive
 * dotted-quad regex. This is hostname-level only — it does NOT defeat
 * DNS-rebinding (a public name resolving to a private IP); that needs
 * resolve-and-pin, which is out of scope here. Exported for unit tests.
 */
export function isBlockedFetchHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return true;
  // Strip IPv6 zone id and surrounding brackets from `[::1]` style hosts.
  host = host.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const kind = isIP(host);
  if (kind === 4) return isBlockedIpv4(host);
  if (kind === 6) {
    if (host === '::1' || host === '::') return true;
    // IPv4-mapped / -compatible (`::ffff:127.0.0.1`): check the embedded v4.
    const v4 = host.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4 && isBlockedIpv4(v4[1])) return true;
    // Unique-local fc00::/7 (fc.. / fd..) and link-local fe80::/10.
    if (/^f[cd]/.test(host)) return true;
    if (/^fe[89ab]/.test(host)) return true;
    return false;
  }

  // Not a recognized DNS name or dotted-quad: a bare integer or hex literal
  // (`2130706433`, `0x7f000001`) is an obfuscated IP — refuse it outright. Also
  // refuse dotted forms with hex/octal octets that `isIP` rejects.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(host)) return true;

  return false;
}

/**
 * HTML → markdown converter built on turndown + the GFM plugin. Covers
 * tables, nested lists, code fences, strikethrough, and HTML entities that
 * the previous regex pipeline silently mangled (MDN tables, nested docs,
 * `&#8212;` style numeric entities, etc).
 *
 * The instance is lazy + cached — turndown builds a rule table on construction
 * and we want that to happen once per process, not per fetch.
 */
let turndownInstance: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  const td = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-',
  });
  td.use(gfm);
  // Drop script/style/noscript entirely — turndown would otherwise leak their
  // text content into the output.
  td.remove(['script', 'style', 'noscript']);
  turndownInstance = td;
  return td;
}

function htmlToMarkdown(html: string): string {
  try {
    const md = getTurndown().turndown(html);
    // Collapse runs of 3+ blank lines turndown sometimes leaves behind.
    return md.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    // Malformed HTML shouldn't kill the whole fetch — strip tags and return
    // plain text as a last resort.
    return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
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
    if (isBlockedFetchHost(host)) {
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
