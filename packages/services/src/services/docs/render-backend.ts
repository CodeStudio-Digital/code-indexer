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

export interface RenderBackend {
  readonly name: 'plain' | 'browser' | 'escalating';
  /**
   * Whether the backend is ready to serve requests. Cheap probe (synchronous-
   * resolving when possible) — caller may decide to skip the backend entirely
   * if false.
   */
  isAvailable(): Promise<boolean>;
  render(url: string, opts?: { timeoutMs?: number }): Promise<RenderResult>;
}

// ─── PlainFetchBackend ────────────────────────────────────────────────

export class PlainFetchBackend implements RenderBackend {
  readonly name = 'plain' as const;
  constructor(private fetcher: UrlFetcher) {}
  async isAvailable(): Promise<boolean> { return true; }
  async render(url: string): Promise<RenderResult> {
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

export class BrowserBackend implements RenderBackend {
  readonly name = 'browser' as const;
  constructor(private connect: BrowserConnector) {}

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

  async render(url: string, opts: { timeoutMs?: number } = {}): Promise<RenderResult> {
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

  async render(url: string, opts?: { timeoutMs?: number }): Promise<RenderResult> {
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
