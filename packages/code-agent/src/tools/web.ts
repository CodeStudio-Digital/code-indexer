import { isPrivateHost } from '@mcp/shared/utils/ssrf.js';
import { decodeCompleteUtf8Prefix } from '@mcp/shared/utils/http-engine.js';
import TurndownService from 'turndown';
// @ts-expect-error — turndown-plugin-gfm ships no TS types.
import { gfm } from 'turndown-plugin-gfm';
import type {
  CoderTool,
  ToolContext,
  ToolResult,
  ToolSourceTruncation,
} from '@mcp/code-agent/core/tool.js';
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
 * - Runner-owned output shaping, so oversized pages are spilled before they
 *   are reduced and remain recoverable through get_tool_output.
 * - Short TTL in-memory cache keyed by (url, search-query) so the agent can
 *   re-check the same page within a session without paying twice.
 */

const FETCH_TIMEOUT_MS = Number(process.env.CODER_WEB_TIMEOUT_MS ?? 20_000);
const CACHE_TTL_MS = Number(process.env.CODER_WEB_CACHE_TTL_MS ?? 15 * 60 * 1000);
const MAX_CACHE_ENTRY_CHARS = Number(process.env.CODER_WEB_CACHE_ENTRY_MAX ?? 1_000_000);
const DEFAULT_WEB_READ_BYTES = 2 * 1024 * 1024;
const MAX_WEB_READ_BYTES = 10 * 1024 * 1024;

// In-memory cache. Keyed by a string prefix + the raw key (URL or query).
interface CacheEntry {
  at: number;
  text: string;
  sourceTruncations?: ToolSourceTruncation[];
}
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cachePut(key: string, text: string, sourceTruncations?: ToolSourceTruncation[]): void {
  // Do not retain pathological pages in the process-wide cache. This limits
  // memory without changing the tool result that flows to the runner/spill.
  if (text.length > MAX_CACHE_ENTRY_CHARS) return;
  cache.set(key, {
    at: Date.now(),
    text,
    ...(sourceTruncations?.length ? { sourceTruncations } : {}),
  });
  if (cache.size > 50) {
    // Evict oldest.
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

/**
 * SSRF defense-in-depth for `web_fetch`: refuse private/loopback/link-local
 * hosts. The classifier is consolidated in `@mcp/shared/utils/ssrf` so the
 * API-client send proxy shares the EXACT same guard; re-exported under the
 * original name for callers and the existing unit tests.
 */
export const isBlockedFetchHost = isPrivateHost;

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

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; finish: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'mcp-code-indexer/3.11 (+https://github.com/CodeStudio/MCP-CodeBase)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(init?.headers ?? {}),
      },
    });
    // Keep the timer and signal alive until the caller finishes consuming the
    // body. fetch() resolves at headers; clearing here left a slow/stalled body
    // unbounded forever.
    return { response, finish: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; inputBytes: number; inputSizeExact: boolean }> {
  const rawContentLength = response.headers.get('content-length');
  const contentEncoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  // Undici/fetch exposes a decoded body but commonly preserves the wire-level
  // Content-Length. Those dimensions are incomparable for gzip/br/deflate, so
  // only an identity response can turn the header into an exact source size.
  const contentLengthMatchesBody = !contentEncoding || contentEncoding === 'identity';
  const parsedContentLength = rawContentLength && /^\d+$/.test(rawContentLength.trim())
    ? Number(rawContentLength)
    : Number.NaN;
  const declaredLength = contentLengthMatchesBody
    && Number.isSafeInteger(parsedContentLength)
    && parsedContentLength >= 0
    ? parsedContentLength
    : undefined;
  if (!response.body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    return {
      text: decodeCompleteUtf8Prefix(bytes, maxBytes),
      truncated: bytes.length > maxBytes,
      inputBytes: bytes.length,
      inputSizeExact: true,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let observedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      observedBytes += value.byteLength;
      const remaining = Math.max(0, maxBytes - keptBytes);
      if (remaining > 0) {
        const kept = value.subarray(0, remaining);
        chunks.push(kept);
        keptBytes += kept.byteLength;
      }
      if (observedBytes > maxBytes) {
        truncated = true;
        await reader.cancel('web_fetch acquisition ceiling reached');
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: decodeCompleteUtf8Prefix(bytes, maxBytes),
    truncated,
    inputBytes: truncated && declaredLength != null && declaredLength >= observedBytes
      ? declaredLength
      : observedBytes,
    inputSizeExact: !truncated || (declaredLength != null && declaredLength >= observedBytes),
  };
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
    'REFUSES localhost/127.0.0.1 and private/loopback hosts (SSRF defense) — to test a LOCAL backend, use http_request instead.\n' +
    `Oversized results are stored by the runner and can be paged with get_tool_output. Results up to ${MAX_CACHE_ENTRY_CHARS} chars are cached in-memory for ${Math.round(CACHE_TTL_MS / 60_000)} minutes.`,
  source: 'native',
  outputPolicy: { mode: 'structured', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to fetch. Must start with http:// or https://.',
      },
      max_bytes: {
        type: 'number',
        description: `Network acquisition ceiling (default ${DEFAULT_WEB_READ_BYTES}, max ${MAX_WEB_READ_BYTES}). Reaching it stops the transfer and marks the source as truncated.`,
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

    const requestedMaxBytes = Number(args.max_bytes ?? DEFAULT_WEB_READ_BYTES);
    const maxBytes = Number.isFinite(requestedMaxBytes)
      ? Math.min(MAX_WEB_READ_BYTES, Math.max(1024, Math.floor(requestedMaxBytes)))
      : DEFAULT_WEB_READ_BYTES;
    const cacheKey = `fetch:${parsed.toString()}|max=${maxBytes}`;
    const hit = cacheGet(cacheKey);
    if (hit) {
      return {
        content: hit.text + '\n\n[cached]',
        sourceTruncations: hit.sourceTruncations,
      };
    }

    try {
      const timed = await fetchWithTimeout(parsed.toString());
      try {
        const res = timed.response;
        if (!res.ok) {
          return err(`web_fetch: HTTP ${res.status} ${res.statusText} for ${parsed.toString()}`);
        }
        const contentType = res.headers.get('content-type') ?? '';
        const acquired = await readResponseTextBounded(res, maxBytes);
        const raw = acquired.text;
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
        const sourceMarker = acquired.truncated
          ? `\n\n[source truncated: web transfer stopped at max_bytes=${maxBytes}; source size ${acquired.inputSizeExact ? `was ${acquired.inputBytes}` : `is at least ${acquired.inputBytes}`} bytes. Retry a narrower resource or raise max_bytes.]`
          : '';
        const out = header + body + sourceMarker;
        const sourceTruncations: ToolSourceTruncation[] | undefined = acquired.truncated
          ? [{
              technique: 'network-acquisition-cap',
              inputSize: acquired.inputBytes,
              ...(acquired.inputSizeExact ? {} : { inputSizeExact: false }),
              outputSize: new TextEncoder().encode(raw).byteLength,
              unit: 'bytes',
              recoverable: false,
            }]
          : undefined;
        cachePut(cacheKey, out, sourceTruncations);
        return { content: out, sourceTruncations };
      } finally {
        timed.finish();
      }
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
  const timed = await fetchWithTimeout(url, {
    headers: {
      'X-Subscription-Token': key,
      Accept: 'application/json',
    },
  });
  try {
    const res = timed.response;
    if (!res.ok) throw new Error(`Brave ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = data.web?.results ?? [];
    return results.slice(0, 10).map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: htmlToMarkdown(String(r.description ?? '')),
    }));
  } finally {
    timed.finish();
  }
}

/**
 * DuckDuckGo HTML scraping fallback. No API key needed. Slightly fragile
 * (format can change) but good enough when Brave isn't configured.
 */
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const timed = await fetchWithTimeout(url);
  try {
    const res = timed.response;
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
      const snippet = htmlToMarkdown(match[3]).trim();
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
  } finally {
    timed.finish();
  }
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
  outputPolicy: { mode: 'search', reducer: 'smart', recovery: 'rerun' },
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
    if (hit) return ok(hit.text + '\n\n[cached]');

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
    cachePut(cacheKey, body);
    return ok(body);
  },
};

export const webTools: CoderTool[] = [webFetch, webSearch];
