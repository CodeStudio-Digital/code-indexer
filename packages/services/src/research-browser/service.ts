import { lookup } from 'node:dns/promises';
import { isPrivateHost } from '@mcp/shared/utils/ssrf.js';
import type { Browser, BrowserContext, ElementHandle, Page, Route } from 'playwright-core';
import type { IResearchBrowser, ResearchBrowserConnector, ResearchBrowserHostResolver, ResearchBrowserInvoke } from './types.js';

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
  '[role]', '[tabindex]:not([tabindex="-1"])', 'h1', 'h2', 'h3',
].join(',');
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_REFS = 120;
const MAX_TEXT_CHARS = 40_000;

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  refs: Map<string, ElementHandle<HTMLElement | SVGElement>>;
}

interface ElementSummary {
  role: string;
  name: string;
  href?: string;
  disabled?: boolean;
}

const defaultResolver: ResearchBrowserHostResolver = async (hostname) => (
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
);

function asText(value: unknown, max = 500): string {
  return String(value ?? '').trim().slice(0, max);
}

export async function requirePublicHttpsUrl(
  raw: string,
  resolveHost: ResearchBrowserHostResolver = defaultResolver,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('browser URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('browser URL must be public HTTPS without embedded credentials.');
  }
  const hostname = url.hostname.toLowerCase();
  if (isPrivateHost(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`browser blocked private or local host '${hostname}'.`);
  }
  const addresses = await resolveHost(hostname).catch(() => []);
  if (addresses.length === 0 || addresses.some(isPrivateHost)) {
    throw new Error(`browser blocked unresolved or non-public host '${hostname}'.`);
  }
  return url.toString();
}

export class ResearchBrowserService implements IResearchBrowser {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly inFlight = new Map<string, string>();

  constructor(
    private readonly connect: ResearchBrowserConnector,
    private readonly resolveHost: ResearchBrowserHostResolver = defaultResolver,
  ) {}

  async invoke(request: ResearchBrowserInvoke): Promise<unknown> {
    if (request.requestId) this.inFlight.set(request.requestId, request.key);
    try {
      return await this.dispatch(request);
    } finally {
      if (request.requestId) this.inFlight.delete(request.requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    const key = this.inFlight.get(requestId);
    if (key) await this.closeKey(key);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((key) => this.closeKey(key)));
  }

  private async dispatch({ key, method, args = {} }: ResearchBrowserInvoke): Promise<unknown> {
    if (method === 'close') return this.closeKey(key);
    if (method === 'closePrefix') return this.closePrefix(key);
    if (method === 'open') return this.open(key, asText(args.url, 8_000));

    const session = this.sessions.get(key);
    if (!session) throw new Error('No research browser is open. Call browser_open first.');
    switch (method) {
      case 'snapshot': return this.snapshot(session, Number(args.limit) || 80);
      case 'extract': return this.extract(session, Number(args.maxChars) || MAX_TEXT_CHARS);
      case 'click': return this.click(session, asText(args.ref, 40));
      case 'fill': return this.fill(session, asText(args.ref, 40), String(args.value ?? ''));
      case 'press': return this.press(session, asText(args.ref, 40), asText(args.key, 80));
      case 'screenshot': return this.screenshot(session, args.fullPage === true);
      default: throw new Error(`Unsupported research browser method: ${method}`);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const browser = await this.connect();
    if (!browser) {
      throw new Error('Research browser unavailable. Enable and start Chrome Service in Settings.');
    }
    browser.once('disconnected', () => { this.browser = null; });
    this.browser = browser;
    return browser;
  }

  private async open(key: string, rawUrl: string): Promise<unknown> {
    const url = await requirePublicHttpsUrl(rawUrl, this.resolveHost);
    const existing = this.sessions.get(key);
    if (existing) {
      this.clearRefs(existing);
      try {
        await this.navigate(existing.page, url);
        return { page: await this.pageState(existing.page), reused: true };
      } catch (error) {
        await this.closeKey(key);
        throw error;
      }
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      locale: 'en-US',
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 768 },
    });
    await context.clearPermissions();
    await context.route('**/*', (route) => this.guardRoute(route));
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', (socket) => socket.close());
    }
    const page = await context.newPage();
    const session: BrowserSession = { context, page, refs: new Map() };
    this.sessions.set(key, session);
    context.on('page', (opened) => { if (opened !== page) void opened.close().catch(() => undefined); });
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('download', (download) => void download.cancel().catch(() => undefined));
    page.on('filechooser', (chooser) => void chooser.setFiles([]).catch(() => undefined));
    try {
      await this.navigate(page, url);
      return { page: await this.pageState(page), reused: false };
    } catch (error) {
      await this.closeKey(key);
      throw error;
    }
  }

  private async guardRoute(route: Route): Promise<void> {
    const request = route.request();
    if (!READ_METHODS.has(request.method().toUpperCase())) {
      await route.abort('blockedbyclient');
      return;
    }
    try {
      await requirePublicHttpsUrl(request.url(), this.resolveHost);
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  }

  private async navigate(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }

  private async snapshot(session: BrowserSession, requestedLimit: number): Promise<unknown> {
    this.clearRefs(session);
    const handles = await session.page.locator(INTERACTIVE_SELECTOR).elementHandles() as Array<
      ElementHandle<HTMLElement | SVGElement>
    >;
    const limit = Math.max(1, Math.min(MAX_REFS, Math.floor(requestedLimit)));
    const nodes: Array<ElementSummary & { ref: string }> = [];
    for (const handle of handles.slice(0, limit)) {
      const summary = await handle.evaluate((element): ElementSummary | null => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return null;
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') || ({
          a: 'link', button: 'button', input: 'textbox', textarea: 'textbox',
          select: 'combobox', summary: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
        } as Record<string, string>)[tag] || tag;
        const html = element as HTMLElement;
        const name = element.getAttribute('aria-label') || element.getAttribute('alt')
          || element.getAttribute('placeholder') || element.getAttribute('title')
          || html.innerText || element.textContent || '';
        const href = tag === 'a' ? (element as HTMLAnchorElement).href : undefined;
        const disabled = 'disabled' in element ? Boolean((element as HTMLButtonElement).disabled) : undefined;
        return { role, name: name.trim().replace(/\s+/g, ' ').slice(0, 240), href, disabled };
      }).catch(() => null);
      if (!summary || (!summary.name && !summary.href)) continue;
      const ref = `a${nodes.length + 1}`;
      session.refs.set(ref, handle);
      nodes.push({ ref, ...summary });
    }
    return {
      page: await this.pageState(session.page),
      nodes,
      truncated: handles.length > limit,
      totalCandidates: handles.length,
    };
  }

  private async extract(session: BrowserSession, requestedMax: number): Promise<unknown> {
    const maxChars = Math.max(1_000, Math.min(MAX_TEXT_CHARS, Math.floor(requestedMax)));
    const source = await session.page.locator('body').innerText({ timeout: 10_000 });
    return {
      page: await this.pageState(session.page),
      text: source.slice(0, maxChars),
      truncated: source.length > maxChars,
      sourceChars: source.length,
    };
  }

  private ref(session: BrowserSession, rawRef: string): ElementHandle<HTMLElement | SVGElement> {
    const ref = rawRef.replace(/^ref=/, '');
    const handle = session.refs.get(ref);
    if (!handle) throw new Error(`Unknown or stale browser ref '${rawRef}'. Run browser_snapshot again.`);
    return handle;
  }

  private async click(session: BrowserSession, ref: string): Promise<unknown> {
    await this.ref(session, ref).click({ timeout: 10_000 });
    await session.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    this.clearRefs(session);
    return { page: await this.pageState(session.page) };
  }

  private async fill(session: BrowserSession, ref: string, value: string): Promise<unknown> {
    const handle = this.ref(session, ref);
    const sensitive = await handle.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) return false;
      const autocomplete = element.autocomplete.toLowerCase();
      return element.type === 'password' || element.type === 'file'
        || /password|one-time-code|^cc-/.test(autocomplete);
    });
    if (sensitive) throw new Error('Research browser refuses credential, payment, and file fields.');
    await handle.fill(value.slice(0, 4_000), { timeout: 10_000 });
    return { page: await this.pageState(session.page), valueRedacted: true };
  }

  private async press(session: BrowserSession, ref: string, key: string): Promise<unknown> {
    await this.ref(session, ref).press(key, { timeout: 10_000 });
    await session.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    this.clearRefs(session);
    return { page: await this.pageState(session.page) };
  }

  private async screenshot(session: BrowserSession, fullPage: boolean): Promise<unknown> {
    const data = await session.page.screenshot({ type: 'png', fullPage, timeout: 20_000 });
    return { base64: data.toString('base64'), page: await this.pageState(session.page) };
  }

  private async pageState(page: Page): Promise<{ url: string; title: string }> {
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  private async closeKey(key: string): Promise<{ closed: boolean }> {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (!session) return { closed: false };
    this.clearRefs(session);
    await session.context.close().catch(() => undefined);
    return { closed: true };
  }

  private clearRefs(session: BrowserSession): void {
    for (const handle of session.refs.values()) void handle.dispose().catch(() => undefined);
    session.refs.clear();
  }

  private async closePrefix(prefix: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter((key) => key === prefix || key.startsWith(`${prefix}-`));
    await Promise.allSettled(keys.map((key) => this.closeKey(key)));
  }
}
