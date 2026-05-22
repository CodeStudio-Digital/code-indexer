/**
 * Polite URL fetcher with per-host concurrency, adaptive backoff,
 * Retry-After honoring, automatic retry on 429/503, and robots.txt
 * awareness.
 *
 * The crawler reuses this for BFS frontier expansion. Invariants:
 *   1. Never hit the same host with more than `MAX_CONCURRENT_PER_HOST`
 *      requests in flight (semaphore per host).
 *   2. Honor the per-host base delay (`MIN_DELAY_MS_PER_HOST`) PLUS any
 *      penalty earned from earlier 429/503 responses. Penalty doubles
 *      with each fresh rate-limit hit (cap at `MAX_PENALTY_MS`) and
 *      decays after a streak of healthy 2xx responses.
 *   3. When a response carries `Retry-After`, block the next request on
 *      the same host for AT LEAST that duration. Beats raw exponential
 *      backoff whenever the server gives us a concrete hint.
 *   4. Retry 429/503 up to `MAX_RETRIES_PER_PAGE` times before surfacing
 *      to the caller — picks up transient bursts (CDN edge nodes, brief
 *      cold-start throttles) without losing the page.
 *   5. Respect `robots.txt` for the host (cached per-host for the
 *      duration of the fetcher instance).
 *
 * Pacing snapshot:
 *   - At base: 1 paralelo + 500 ms between requests = ~2 req/s/host.
 *   - After one 429: penalty=1s → ~1 req/s/host.
 *   - After two 429s in a row: penalty=2s → ~0.5 req/s/host.
 *   - 5 consecutive 2xx → penalty halves (back toward base).
 *   - Each pause carries ±25% jitter so concurrent runs don't fence-line.
 */

const MAX_CONCURRENT_PER_HOST = 1;
const MIN_DELAY_MS_PER_HOST = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES_PER_PAGE = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_BACKOFF_FACTOR = 2;
const MAX_PENALTY_MS = 30_000;
const PENALTY_DECAY_AFTER_SUCCESSES = 5;
const JITTER_PCT = 0.25;

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
  /** Override per-host concurrency cap. Default 1 — sequential per host. */
  maxConcurrentPerHost?: number;
  /** Override per-host minimum delay (ms) between successive requests. Default 500. */
  minDelayMsPerHost?: number;
  /** Override request timeout (ms). */
  timeoutMs?: number;
  /** Override max retries per page on 429/503. Default 3. Set 0 to disable. */
  maxRetries?: number;
  /** Inject `fetch` for tests. */
  fetchFn?: typeof fetch;
  /** Inject a deterministic sleep for tests (bypass real `setTimeout`). */
  sleepFn?: (ms: number) => Promise<void>;
}

interface HostState {
  inFlight: number;
  lastFinishedAt: number;
  queue: Array<() => void>;
  /**
   * Earliest wall-clock timestamp at which the NEXT request to this host
   * is allowed to start. Set by `Retry-After` headers and by the
   * adaptive backoff after a 429/503. 0 = no penalty active.
   */
  nextEarliestStartAt: number;
  /**
   * Current adaptive penalty in ms. Doubles on every fresh rate-limit
   * response, halves after `PENALTY_DECAY_AFTER_SUCCESSES` consecutive
   * successes. Capped at `MAX_PENALTY_MS`.
   */
  penaltyMs: number;
  /** Counter for the success-decay heuristic — bumped on each 2xx, reset on 429/503. */
  consecutiveSuccesses: number;
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
      maxRetries: opts.maxRetries ?? MAX_RETRIES_PER_PAGE,
      fetchFn: opts.fetchFn ?? fetch,
      sleepFn: opts.sleepFn ?? sleep,
    };
  }

  /**
   * Public: run `task` under the per-host throttle (concurrency cap +
   * minimum delay + active penalty). Used by sibling backends — most
   * notably `BrowserBackend` — so a `force_browser` crawl shares the
   * exact same pacing budget as the plain HTTP path. Without this the
   * browser path would dispatch unbounded `page.goto` calls and trip
   * 429s far faster than the plain fetcher.
   *
   * `host` should be the URL's `.host` (`docs.unity3d.com`), not the
   * full URL — we throttle per ORIGIN, not per path.
   */
  acquireHostSlot<T>(host: string, task: () => Promise<T>): Promise<T> {
    return this.withHostSlot(host, task);
  }

  /**
   * Inspection helper for telemetry / dashboards — current per-host
   * pacing state. Returns null when we've never touched the host.
   */
  hostPacing(host: string): { penaltyMs: number; consecutiveSuccesses: number } | null {
    const state = this.hostStates.get(host);
    if (!state) return null;
    return { penaltyMs: state.penaltyMs, consecutiveSuccesses: state.consecutiveSuccesses };
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
   * Fetch a single URL with automatic retry on 429/503. Throws if the
   * host blocks the URL via `robots.txt` or the network errors past
   * all retries. Non-rate-limit non-2xx responses (404, 500 without
   * Retry-After, etc.) are returned as-is so the caller can decide
   * whether to surface them.
   */
  async fetchPage(url: string): Promise<FetchedPage> {
    const parsed = new URL(url);
    const host = parsed.host;

    const robots = await this.loadRobots(parsed);
    if (robots && !robotsAllows(robots, parsed.pathname, this.opts.userAgent)) {
      throw new FetchBlockedError(url, 'robots');
    }

    return this.fetchWithRetry(url, host);
  }

  /**
   * Inner loop — runs the actual fetch, catches 429/503, and retries
   * up to `maxRetries` times with the slot/penalty machinery in
   * between. Each retry re-acquires the host slot, which now carries
   * the freshly-extended penalty from the previous attempt's
   * `Retry-After` (if any) or the doubled adaptive penalty.
   */
  private async fetchWithRetry(url: string, host: string): Promise<FetchedPage> {
    const maxRetries = Math.max(0, this.opts.maxRetries);
    let lastResponse: FetchedPage | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.withHostSlot(host, () => this.fetchOnce(url, host));
      lastResponse = result;
      if (!isRateLimited(result.status)) {
        // Success path — let the host state know so the penalty can decay.
        if (result.status >= 200 && result.status < 400) {
          this.recordSuccess(host);
        }
        return result;
      }
      // Rate-limited. Update host state so the NEXT slot acquisition
      // waits long enough.
      this.recordRateLimit(host, result.retryAfterMs);
      if (attempt >= maxRetries) {
        console.warn(
          `[doc-indexer] giving up on ${url} after ${attempt + 1} attempt(s): ` +
            `last status=${result.status} retry_after=${result.retryAfterMs ?? 'none'}`,
        );
        return result;
      }
      const backoff = computeRetryBackoffMs(attempt, result.retryAfterMs);
      console.warn(
        `[doc-indexer] ${result.status} on ${url} — attempt ${attempt + 1}/${maxRetries + 1}, sleeping ${backoff}ms before retry`,
      );
      await this.opts.sleepFn(backoff);
    }
    // Loop only exits via return; the !-assertion is defensive.
    return lastResponse!;
  }

  /**
   * Single fetch attempt. Does NOT retry — the retry policy lives in
   * `fetchWithRetry` above. Always returns a `FetchedPage` even on
   * non-2xx (so the retry loop can inspect status); throws only on
   * network/timeout errors after the underlying `fetch` fails.
   */
  private async fetchOnce(url: string, host: string): Promise<FetchedPage> {
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
   * Run `task` while holding a per-host slot. Implements:
   *   - Concurrency cap (semaphore) — never more than
   *     `maxConcurrentPerHost` in-flight requests against the host.
   *   - Minimum-delay pacing — at least `minDelayMsPerHost + penaltyMs`
   *     since the previous completion (penalty kicks in after 429/503).
   *   - Retry-After honoring — `nextEarliestStartAt` blocks until the
   *     server-supplied deadline passes.
   *   - Jitter — ±25% so concurrent runs (e.g. force_browser docs ingest
   *     + QA tests) don't fence-line on the same boundary.
   */
  private async withHostSlot<T>(host: string, task: () => Promise<T>): Promise<T> {
    const state = this.ensureHostState(host);

    // Wait for a concurrency slot.
    if (state.inFlight >= this.opts.maxConcurrentPerHost) {
      await new Promise<void>((resolve) => state.queue.push(resolve));
    }

    // Honor per-host pacing: max of the post-completion delay and the
    // hard "earliest start" gate set by Retry-After.
    const now = Date.now();
    const sinceFinished = now - state.lastFinishedAt;
    const baseDelay = this.opts.minDelayMsPerHost + state.penaltyMs;
    const pacingWait = sinceFinished < baseDelay ? baseDelay - sinceFinished : 0;
    const retryAfterWait = state.nextEarliestStartAt > now
      ? state.nextEarliestStartAt - now
      : 0;
    const totalWait = Math.max(pacingWait, retryAfterWait);
    if (totalWait > 0) {
      const jittered = applyJitter(totalWait);
      if (totalWait >= 1000) {
        console.log(
          `[doc-indexer] host=${host} pacing wait ${jittered}ms ` +
            `(base=${baseDelay} penalty=${state.penaltyMs} retry_after=${retryAfterWait})`,
        );
      }
      await this.opts.sleepFn(jittered);
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

  /**
   * Apply a `Retry-After` or implicit 429/503 hit to the host state.
   *   - When `retryAfterMs` is supplied, gate the next start with that
   *     concrete deadline.
   *   - Independently of the header, GROW the adaptive penalty (doubles
   *     each fresh hit) so even servers that omit the header get
   *     progressively slower traffic.
   *   - Reset the success counter so the decay path has to earn the
   *     calm-down again.
   */
  private recordRateLimit(host: string, retryAfterMs: number | undefined): void {
    const state = this.ensureHostState(host);
    if (retryAfterMs && retryAfterMs > 0) {
      const wakeAt = Date.now() + retryAfterMs;
      if (wakeAt > state.nextEarliestStartAt) state.nextEarliestStartAt = wakeAt;
    }
    // Anchor the FIRST penalty at the retry-base (1s) so it's
    // independent of `minDelayMsPerHost`. Otherwise a fetcher
    // configured with `minDelayMsPerHost: 0` (tests, "as fast as
    // possible" runs) would multiply 0 → 0 and never accumulate any
    // backoff, defeating the whole point of the penalty.
    state.penaltyMs = state.penaltyMs === 0
      ? Math.max(this.opts.minDelayMsPerHost * 2, RETRY_BASE_DELAY_MS)
      : Math.min(state.penaltyMs * 2, MAX_PENALTY_MS);
    state.consecutiveSuccesses = 0;
    console.warn(
      `[doc-indexer] host=${host} rate-limited — penalty now ${state.penaltyMs}ms ` +
        `next start in ${Math.max(0, state.nextEarliestStartAt - Date.now())}ms`,
    );
  }

  /**
   * Bookkeeping for the decay path: bump the success streak and, once
   * we've cleared the threshold, halve the penalty. Lets long healthy
   * runs return to base latency instead of staying punished forever
   * after a single 429.
   */
  private recordSuccess(host: string): void {
    const state = this.ensureHostState(host);
    if (state.penaltyMs === 0) return;
    state.consecutiveSuccesses++;
    if (state.consecutiveSuccesses >= PENALTY_DECAY_AFTER_SUCCESSES) {
      const next = Math.floor(state.penaltyMs / 2);
      // Clear the penalty once it would drop below the retry-base floor
      // (NOT the per-host pacing floor — the latter can be 0 in tests
      // and that would never let the penalty clear).
      state.penaltyMs = next < RETRY_BASE_DELAY_MS ? 0 : next;
      state.consecutiveSuccesses = 0;
      if (state.penaltyMs > 0) {
        console.log(`[doc-indexer] host=${host} penalty decayed to ${state.penaltyMs}ms`);
      } else {
        console.log(`[doc-indexer] host=${host} penalty cleared — back to base pacing`);
      }
    }
  }

  private ensureHostState(host: string): HostState {
    let state = this.hostStates.get(host);
    if (!state) {
      state = {
        inFlight: 0,
        lastFinishedAt: 0,
        queue: [],
        nextEarliestStartAt: 0,
        penaltyMs: 0,
        consecutiveSuccesses: 0,
      };
      this.hostStates.set(host, state);
    }
    return state;
  }
}

// ─── Pure helpers (exported for tests) ────────────────────────────────

/**
 * Status codes treated as "server told us to slow down". 429 is canonical;
 * 503 is the polite catch-all some CDNs (Cloudflare, Fastly) prefer for
 * burst rejection. Anything else (404, 500, …) is NOT retried — only the
 * caller knows whether a 404 should be tolerated, dropped, or escalated.
 */
export function isRateLimited(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * How long to sleep between two retry attempts of the SAME page. Uses
 * the server's `Retry-After` when present (always wins), otherwise
 * exponential backoff anchored at `RETRY_BASE_DELAY_MS`. Jitter is
 * applied so two simultaneous retries don't slam the host at the same
 * millisecond.
 */
export function computeRetryBackoffMs(
  attemptIndex: number,
  retryAfterMs: number | undefined,
): number {
  if (retryAfterMs && retryAfterMs > 0) return applyJitter(retryAfterMs);
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attemptIndex);
  return applyJitter(Math.min(exponential, MAX_PENALTY_MS));
}

function applyJitter(ms: number): number {
  if (ms <= 0) return 0;
  const delta = ms * JITTER_PCT;
  // Bias the jitter UPWARD so we never accidentally probe under the
  // server's threshold — better to wait a hair longer than to refire a
  // 429.
  return Math.round(ms + Math.random() * delta);
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
