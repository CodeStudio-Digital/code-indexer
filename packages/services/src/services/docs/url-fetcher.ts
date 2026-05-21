/**
 * Polite URL fetcher with per-host concurrency and robots.txt awareness.
 *
 * The crawler reuses this for BFS frontier expansion. The fetcher
 * enforces two invariants the spec mandates:
 *   1. Never hit the same host with more than `MAX_CONCURRENT_PER_HOST`
 *      requests in flight.
 *   2. Respect `robots.txt` for the host (cached per-host for the duration
 *      of the fetcher instance).
 *
 * It does NOT implement any retry / backoff beyond honoring `Retry-After`
 * on 429/503 — the assumption is that doc indexing is a one-shot
 * background job, not a long-running scraper.
 */

const MAX_CONCURRENT_PER_HOST = 2;
const MIN_DELAY_MS_PER_HOST = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Mimic the User-Agent of a current desktop Chrome. Sites with bot
 * detection (Cloudflare basic, AWS WAF, generic UA filters) reject the
 * obvious "MCP-Indexer/3.x" string outright. Realistic UA + matching
 * `sec-ch-ua-*` Client Hints bypass the majority of these.
 *
 * Updated at: 2026-05-19 (Chrome 120). Stale UA strings start failing
 * after ~1 year; bump when Chrome ships a new major.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Static set of headers that any modern browser sends on a top-level
 * navigation. Spreading these into every request is what flips us from
 * "obvious bot" to "looks like a tab".
 */
function browserNavigationHeaders(uaOverride: string, sameOrigin: boolean): Record<string, string> {
  return {
    'user-agent': uaOverride,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': sameOrigin ? 'same-origin' : 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
}

export interface FetchedPage {
  url: string;
  status: number;
  finalUrl: string;
  html: string;
  contentType: string;
  bytes: number;
  headers: Headers;
  retryAfterMs?: number;
}

export interface UrlFetcherOptions {
  /** Override `User-Agent`. */
  userAgent?: string;
  /** Override per-host concurrency cap. */
  maxConcurrentPerHost?: number;
  /** Override per-host minimum delay (ms) between successive requests. */
  minDelayMsPerHost?: number;
  /** Override request timeout (ms). */
  timeoutMs?: number;
  /** Inject `fetch` for tests. */
  fetchFn?: typeof fetch;
}

interface HostState {
  inFlight: number;
  lastFinishedAt: number;
  queue: Array<() => void>;
}

/**
 * One instance per indexing run — keeps a per-host throttler, a
 * robots.txt cache, and a cookie jar. Don't share across unrelated jobs
 * (the throttler / cookie jar have no per-job scoping).
 */
export class UrlFetcher {
  private hostStates = new Map<string, HostState>();
  private robotsCache = new Map<string, RobotsRules | null>();
  /**
   * In-memory cookie jar — host → (name → value). Auth-light: stores
   * whatever the host emits in `Set-Cookie` and replays it on subsequent
   * requests to the same host. No TTL / Expires / Path parsing — the jar
   * is short-lived (one ingestion run) and the goal is just "look like a
   * browser that remembers state", not full RFC 6265 compliance.
   */
  private cookieJar = new Map<string, Map<string, string>>();
  private opts: Required<UrlFetcherOptions>;

  constructor(opts: UrlFetcherOptions = {}) {
    this.opts = {
      userAgent: opts.userAgent ?? USER_AGENT,
      maxConcurrentPerHost: opts.maxConcurrentPerHost ?? MAX_CONCURRENT_PER_HOST,
      minDelayMsPerHost: opts.minDelayMsPerHost ?? MIN_DELAY_MS_PER_HOST,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchFn: opts.fetchFn ?? fetch,
    };
  }

  /** Serialize stored cookies for `host` into a single `Cookie:` header value, or null when jar empty. */
  private cookieHeaderFor(host: string): string | null {
    const jar = this.cookieJar.get(host);
    if (!jar || jar.size === 0) return null;
    const pairs: string[] = [];
    for (const [name, value] of jar) pairs.push(`${name}=${value}`);
    return pairs.join('; ');
  }

  /** Read `Set-Cookie` from a response (Node fetch exposes it via `getSetCookie()`) and store name=value pairs. */
  private absorbCookies(host: string, headers: Headers): void {
    // `getSetCookie()` is the spec-compliant way to read multi-Set-Cookie;
    // older Node versions only expose `headers.get('set-cookie')` (single
    // string). Try the new API first, fall back to the legacy one.
    let setCookieList: string[] = [];
    const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
    if (typeof anyHeaders.getSetCookie === 'function') {
      setCookieList = anyHeaders.getSetCookie();
    } else {
      const legacy = headers.get('set-cookie');
      if (legacy) setCookieList = [legacy];
    }
    if (setCookieList.length === 0) return;
    const jar = this.cookieJar.get(host) ?? new Map<string, string>();
    for (const raw of setCookieList) {
      // First segment of a Set-Cookie value is the `name=value` pair; the
      // rest are attributes we ignore (Path/Domain/Expires/Max-Age/...).
      const head = raw.split(';', 1)[0] ?? '';
      const eq = head.indexOf('=');
      if (eq <= 0) continue;
      const name = head.slice(0, eq).trim();
      const value = head.slice(eq + 1).trim();
      if (!name) continue;
      jar.set(name, value);
    }
    this.cookieJar.set(host, jar);
  }

  /**
   * Fetch a single URL. Throws if the host blocks the URL via `robots.txt`
   * or the request errors. Non-2xx responses are returned as-is so the
   * caller can decide whether to surface them (e.g. 404 page noise that
   * should be silently dropped).
   */
  async fetchPage(url: string): Promise<FetchedPage> {
    const parsed = new URL(url);
    const host = parsed.host;

    const robots = await this.loadRobots(parsed);
    if (robots && !robotsAllows(robots, parsed.pathname, this.opts.userAgent)) {
      throw new FetchBlockedError(url, 'robots');
    }

    return this.withHostSlot(host, async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs);
      const startedAt = Date.now();
      console.log(`[doc-indexer] fetch ${url}`);
      try {
        const headers: Record<string, string> = browserNavigationHeaders(this.opts.userAgent, false);
        const cookie = this.cookieHeaderFor(host);
        if (cookie) headers.cookie = cookie;
        const res = await this.opts.fetchFn(url, {
          headers,
          signal: ctl.signal,
          redirect: 'follow',
        });
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        const body = await res.text();
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        this.absorbCookies(host, res.headers);
        console.log(
          `[doc-indexer] fetched ${res.status} ${url} (${body.length}B in ${Date.now() - startedAt}ms)`,
        );
        return {
          url,
          status: res.status,
          finalUrl: res.url || url,
          html: body,
          contentType,
          bytes: body.length,
          headers: res.headers,
          retryAfterMs: retryAfter ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[doc-indexer] fetch FAILED ${url} (${Date.now() - startedAt}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Load + cache robots.txt for the host. Null cache value = no robots file
   * (or fetch failed for any reason). Capped at 10s so a slow/missing host
   * never blocks the rest of the crawl.
   */
  private async loadRobots(seed: URL): Promise<RobotsRules | null> {
    const host = seed.host;
    const cached = this.robotsCache.get(host);
    if (cached !== undefined) return cached;
    const url = `${seed.protocol}//${host}/robots.txt`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await this.opts.fetchFn(url, {
        headers: browserNavigationHeaders(this.opts.userAgent, false),
        signal: ctl.signal,
      });
      if (res.status >= 400) {
        this.robotsCache.set(host, null);
        return null;
      }
      const txt = await res.text();
      const parsed = parseRobots(txt);
      this.robotsCache.set(host, parsed);
      return parsed;
    } catch (err) {
      // Timeout / network error / abort — assume no robots and move on.
      console.warn(
        `[doc-indexer] robots.txt fetch failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.robotsCache.set(host, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run `task` while holding a per-host slot. Implements both concurrency
   * cap (semaphore) and minimum delay between successive starts on the
   * same host.
   */
  private async withHostSlot<T>(host: string, task: () => Promise<T>): Promise<T> {
    const state = this.hostStates.get(host) ?? { inFlight: 0, lastFinishedAt: 0, queue: [] };
    this.hostStates.set(host, state);

    // Wait for a slot if we're at the concurrency cap.
    if (state.inFlight >= this.opts.maxConcurrentPerHost) {
      await new Promise<void>((resolve) => state.queue.push(resolve));
    }

    // Honor the per-host delay since the last completion.
    const now = Date.now();
    const since = now - state.lastFinishedAt;
    if (since < this.opts.minDelayMsPerHost) {
      await sleep(this.opts.minDelayMsPerHost - since);
    }

    state.inFlight++;
    try {
      return await task();
    } finally {
      state.inFlight--;
      state.lastFinishedAt = Date.now();
      const next = state.queue.shift();
      if (next) next();
    }
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export class FetchBlockedError extends Error {
  constructor(public readonly url: string, public readonly reason: 'robots' | 'origin') {
    super(`Fetch blocked (${reason}): ${url}`);
    this.name = 'FetchBlockedError';
  }
}

// ─── robots.txt ─────────────────────────────────────────────────────

interface RobotsRules {
  /** Map of user-agent token → disallowed path prefixes. `*` is the wildcard. */
  groups: Map<string, string[]>;
}

function parseRobots(text: string): RobotsRules {
  const groups = new Map<string, string[]>();
  let currentAgents: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      currentAgents = [value.toLowerCase()];
    } else if (key === 'disallow') {
      for (const agent of currentAgents) {
        const list = groups.get(agent) ?? [];
        if (value) list.push(value);
        groups.set(agent, list);
      }
    }
  }
  return { groups };
}

function robotsAllows(rules: RobotsRules, pathname: string, userAgent: string): boolean {
  const uaLower = userAgent.toLowerCase();
  // Try most-specific (exact UA token), then wildcard.
  for (const [ua, disallows] of rules.groups) {
    if (uaLower.includes(ua) && ua !== '*') {
      return !disallows.some((d) => pathname.startsWith(d));
    }
  }
  const wildcard = rules.groups.get('*');
  if (wildcard) return !wildcard.some((d) => pathname.startsWith(d));
  return true;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const num = Number(header);
  if (Number.isFinite(num) && num >= 0) return num * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
