/**
 * Render backends — fetch a URL and return parsed HTML.
 *
 * The doc indexer always goes through this abstraction so we can swap
 * the underlying transport (plain fetch vs. headless browser) without
 * the crawler needing to know which path produced the bytes.
 *
 * Three concrete implementations:
 *   - `PlainFetchBackend`   — wraps the existing `UrlFetcher` (fast,
 *                              same network behavior as before).
 *   - `BrowserBackend`      — connects to `ChromeService`'s Playwright
 *                              WebSocket endpoint and lets Chromium load
 *                              the page (slow, handles SPAs/Cloudflare).
 *   - `EscalatingFetcher`   — composite. Always tries plain first; falls
 *                              back to browser only when `detectBlocked`
 *                              flags the result.
 *
 * `BrowserBackend` degrades gracefully when ChromeService is disabled —
 * `isAvailable()` returns false and the escalating wrapper keeps the
 * original plain result (annotated with `blockedSignals` for visibility).
 *
 * The composite is what gets wired in `apps/http-api/server/deps.ts` and
 * handed to `IndexDocumentationUseCase`. Tests inject any of the three.
 */
import type { FetchedPage, UrlFetcher } from './url-fetcher.js';

/**
 * Normalized fetch result. Mirrors `FetchedPage` plus a `via` discriminant
 * so downstream code (telemetry, UI badges) can attribute pages to the
 * backend that produced them, and an optional `blockedSignals` field that
 * surfaces detector output when escalation was attempted but degraded.
 */
export interface RenderResult {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  contentType: string;
  bytes: number;
  via: 'plain' | 'browser';
  blockedSignals?: string[];
}

export interface RenderOpts {
  /** Per-call timeout, forwarded to the underlying transport. */
  timeoutMs?: number;
  /**
   * Force the browser backend for THIS call regardless of the
   * `EscalatingFetcher`'s heuristic. Honored by `EscalatingFetcher` —
   * the leaf backends ignore it (a `PlainFetchBackend` can't grow a
   * Chromium and a `BrowserBackend` is already browser). When set,
   * `EscalatingFetcher`:
   *   - skips `plain.render` + `detectBlocked()` entirely
   *   - calls `browser.render(url)` directly
   *   - falls back to plain (with `force_browser_unavailable` signal)
   *     when no browser is wired OR `isAvailable()` is false
   *   - falls back to plain (with `force_browser_failed` signal) when
   *     the browser call throws
   */
  forceBrowser?: boolean;
}

export interface RenderBackend {
  readonly name: 'plain' | 'browser' | 'escalating';
  /**
   * Whether the backend is ready to serve requests. Cheap probe (synchronous-
   * resolving when possible) — caller may decide to skip the backend entirely
   * if false.
   */
  isAvailable(): Promise<boolean>;
  render(url: string, opts?: RenderOpts): Promise<RenderResult>;
}

// ─── PlainFetchBackend ────────────────────────────────────────────────

export class PlainFetchBackend implements RenderBackend {
  readonly name = 'plain' as const;
  constructor(private fetcher: UrlFetcher) {}
  async isAvailable(): Promise<boolean> { return true; }
  async render(url: string, _opts?: RenderOpts): Promise<RenderResult> {
    // `_opts` accepted for interface compatibility; plain has no notion of
    // timeout or forceBrowser. `forceBrowser` only matters at the
    // EscalatingFetcher layer.
    const page = await this.fetcher.fetchPage(url);
    return fetchedToResult(page, 'plain');
  }
}

function fetchedToResult(page: FetchedPage, via: 'plain' | 'browser'): RenderResult {
  return {
    url: page.url,
    finalUrl: page.finalUrl,
    status: page.status,
    html: page.html,
    contentType: page.contentType,
    bytes: page.bytes,
    via,
  };
}

// ─── BrowserBackend ───────────────────────────────────────────────────

/**
 * Connection provider for the browser backend. Returns a usable Playwright
 * `Browser` instance OR null when the underlying ChromeService is disabled
 * / unhealthy. Kept as an injected function so the backend stays decoupled
 * from `ChromeService` and is trivially testable with a fake browser.
 */
export type BrowserConnector = () => Promise<BrowserHandle | null>;

/**
 * Minimal Playwright surface area we need. Avoids depending on
 * `playwright-core` types at compile time in this file — the real
 * `ChromeService.connectBrowser` returns a real `playwright.Browser`
 * which structurally satisfies this shape.
 */
export interface BrowserHandle {
  newContext(opts: {
    userAgent?: string;
    locale?: string;
    viewport?: { width: number; height: number } | null;
    extraHTTPHeaders?: Record<string, string>;
  }): Promise<BrowserContextHandle>;
  /** Optional — used by callers that own the browser lifecycle. */
  close?(): Promise<void>;
}

export interface BrowserContextHandle {
  newPage(): Promise<BrowserPageHandle>;
  close(): Promise<void>;
}

export interface BrowserPageHandle {
  goto(url: string, opts?: {
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    timeout?: number;
  }): Promise<BrowserResponseHandle | null>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

export interface BrowserResponseHandle {
  status(): number;
  headers(): Record<string, string>;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Optional cross-backend host throttle. When provided, `BrowserBackend`
 * acquires a slot through this before opening a context — so a
 * `force_browser=true` crawl shares the EXACT same per-host pacing
 * budget as the plain HTTP path. Without it, the browser backend would
 * fire `page.goto` concurrently and trip 429s far faster than the
 * polite plain fetcher.
 *
 * Implemented today by `UrlFetcher.acquireHostSlot`; kept as an
 * interface so the backend stays decoupled (the e2b runner, a future
 * benchmark harness, or a unit test can pass a fake throttle).
 */
export interface HostThrottle {
  acquireHostSlot<T>(host: string, task: () => Promise<T>): Promise<T>;
}

export class BrowserBackend implements RenderBackend {
  readonly name = 'browser' as const;
  constructor(
    private connect: BrowserConnector,
    private hostThrottle: HostThrottle | null = null,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const browser = await this.connect();
      if (!browser) return false;
      // Don't `browser.close()` — connector owns lifecycle (likely a long-
      // lived ChromeService instance). Just confirming we could connect.
      return true;
    } catch {
      return false;
    }
  }

  async render(url: string, opts: RenderOpts = {}): Promise<RenderResult> {
    // Share the per-host pacing with the plain backend when wired. Per
    // ORIGIN, not per path — same host throttle bucket as the
    // UrlFetcher uses.
    if (this.hostThrottle) {
      const host = tryParseHost(url);
      if (host) {
        return this.hostThrottle.acquireHostSlot(host, () => this.doRender(url, opts));
      }
    }
    return this.doRender(url, opts);
  }

  private async doRender(url: string, opts: RenderOpts = {}): Promise<RenderResult> {
    // `opts.forceBrowser` ignored here — we're already the browser path.
    const browser = await this.connect();
    if (!browser) {
      throw new Error('browser backend unavailable: ChromeService not connected');
    }
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let context: BrowserContextHandle | null = null;
    let page: BrowserPageHandle | null = null;
    const startedAt = Date.now();
    console.log(`[doc-indexer] browser render ${url}`);
    try {
      context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
        locale: 'en-US',
        viewport: { width: 1280, height: 720 },
        // Match the headers the plain backend sends so server-side
        // fingerprint checks agree across the two paths.
        extraHTTPHeaders: {
          'accept-language': 'en-US,en;q=0.9',
          'upgrade-insecure-requests': '1',
        },
      });
      page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
      const html = await page.content();
      const finalUrl = page.url();
      const status = response?.status() ?? 200;
      const contentType = (response?.headers()['content-type'] ?? 'text/html').toLowerCase();
      console.log(
        `[doc-indexer] browser fetched ${status} ${url} (${html.length}B in ${Date.now() - startedAt}ms)`,
      );
      return {
        url,
        finalUrl,
        status,
        html,
        contentType,
        bytes: html.length,
        via: 'browser',
      };
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  }
}

/** Defensive URL parse — returns null on malformed input so the throttle bypass never crashes a render. */
function tryParseHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ─── EscalatingFetcher ────────────────────────────────────────────────

/**
 * Tries `plain` first. If the result triggers any detection signal AND a
 * browser backend is available, re-fetches via browser and returns that
 * result. Otherwise returns the plain result, optionally annotated with
 * the signals that fired (so the caller / UI can show "tried but couldn't
 * escalate").
 */
export class EscalatingFetcher implements RenderBackend {
  readonly name = 'escalating' as const;
  constructor(
    private plain: RenderBackend,
    private browser: RenderBackend | null,
    private isBlocked: (r: RenderResult) => string[],
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.plain.isAvailable();
  }

  async render(url: string, opts?: RenderOpts): Promise<RenderResult> {
    // ─── Force-browser branch (per-source opt-in, migration 099) ──
    // The operator explicitly opted in via the AddSourceDialog. Skip
    // plain + detectBlocked entirely and try the browser straight. If
    // the browser is unwired or unhealthy, fall back to plain (with a
    // distinguishing signal so the UI/log makes it obvious that the
    // intent was honored even when the realisation degraded).
    if (opts?.forceBrowser) {
      if (!this.browser) {
        console.warn(`[doc-indexer] force_browser=1 but no browser backend wired — falling back to plain for ${url}`);
        const plain = await this.plain.render(url, opts);
        return { ...plain, blockedSignals: ['force_browser_unavailable'] };
      }
      const available = await this.browser.isAvailable();
      if (!available) {
        console.warn(`[doc-indexer] force_browser=1 but browser unavailable — falling back to plain for ${url}`);
        const plain = await this.plain.render(url, opts);
        return { ...plain, blockedSignals: ['force_browser_unavailable'] };
      }
      console.log(`[doc-indexer] force_browser=1 — bypassing plain on ${url}`);
      try {
        const result = await this.browser.render(url, opts);
        return { ...result, blockedSignals: ['force_browser'] };
      } catch (err) {
        console.warn(
          `[doc-indexer] force_browser=1 render failed: ${err instanceof Error ? err.message : String(err)} — falling back to plain`,
        );
        const plain = await this.plain.render(url, opts);
        return { ...plain, blockedSignals: ['force_browser', 'force_browser_failed'] };
      }
    }

    // ─── Default heuristic branch (status / cf / spa_shell / …) ──
    const first = await this.plain.render(url, opts);
    const signals = this.isBlocked(first);
    if (signals.length === 0) return first;
    if (!this.browser) {
      console.warn(`[doc-indexer] block signals=${signals.join(',')} but no browser backend — returning plain`);
      return { ...first, blockedSignals: signals };
    }
    const available = await this.browser.isAvailable();
    if (!available) {
      console.warn(`[doc-indexer] block signals=${signals.join(',')} but browser unavailable — returning plain`);
      return { ...first, blockedSignals: signals };
    }
    console.log(`[doc-indexer] block signals=${signals.join(',')} → escalating to browser`);
    try {
      const second = await this.browser.render(url, opts);
      return { ...second, blockedSignals: signals };
    } catch (err) {
      console.warn(`[doc-indexer] browser escalation failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ...first, blockedSignals: [...signals, 'browser_failed'] };
    }
  }
}
