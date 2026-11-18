import { lookup } from 'node:dns/promises';
import { isPrivateHost } from '@mcp/shared/utils/ssrf.js';
import type { ElementHandle, Page, Route } from 'playwright-core';
import type { IResearchBrowser, ResearchBrowserConnector, ResearchBrowserContext, ResearchBrowserHostResolver, ResearchBrowserInvoke } from './types.js';
import { ResearchBrowserOperations } from './operations.js';
import type { HostUiDispatchScope } from '@mcp/shared/host-ui-dispatch.js';
import { assertBrowserDispatch, browserLifetimeGuard, runBrowserDispatch } from './dispatch-scope.js';

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
  '[role]', '[tabindex]:not([tabindex="-1"])', 'h1', 'h2', 'h3',
].join(',');
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_REFS = 120;
const MAX_TEXT_CHARS = 40_000;

interface BrowserSession {
  context: ResearchBrowserContext;
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
  readonly authorityAttested = true as const;
  private readonly scopeOwners = new Map<string, object>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly ownedContexts = new Map<string, Set<ResearchBrowserContext>>();
  private readonly operations = new ResearchBrowserOperations();
  private connecting: ReturnType<ResearchBrowserConnector> | undefined;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly connect: ResearchBrowserConnector,
    private readonly resolveHost: ResearchBrowserHostResolver = defaultResolver,
  ) {}

  async invoke(request: ResearchBrowserInvoke, scope?: HostUiDispatchScope): Promise<unknown> {
    const owner = this.scopeOwners.get(request.key);
    if ((owner && owner !== scope?.owner) || (request.key.includes('-attempt-') && !scope?.owner)) {
      throw new Error('Research browser belongs to a different host owner');
    }
    scope?.signal.throwIfAborted(); scope?.assertDispatch();
    if (scope?.owner) this.scopeOwners.set(request.key, scope.owner);
    if (this.closing) throw new Error('Research browser is closing.');
    if (request.method === 'close') return this.closeOwnedKey(request.key);
    if (request.method === 'closePrefix') return this.closePrefix(request.key);
    const cancel = () => {
      if (request.requestId) void this.cancel(request.requestId).catch(() => undefined);
    };
    const pending = this.operations.run(request.key, request.requestId, signal => {
      const combined = scope ? AbortSignal.any([signal, scope.signal]) : signal;
      return runBrowserDispatch({ ...scope, signal: combined, assertDispatch: () => scope?.assertDispatch() },
        () => this.dispatch(request, combined));
    });
    scope?.signal.addEventListener('abort', cancel, { once: true });
    if (scope?.signal.aborted) cancel();
    try { return await pending; }
    finally { scope?.signal.removeEventListener('abort', cancel); }
  }

  async closeOwnedScope(key: string, owner: object): Promise<void> {
    const current = this.scopeOwners.get(key);
    if (current && current !== owner) throw new Error('Research browser cleanup belongs to another host owner');
    await this.closeOwnedKey(key);
    this.scopeOwners.delete(key);
  }

  async cancel(requestId: string): Promise<void> {
    const operation = this.operations.cancel(requestId);
    if (!operation) return;
    // Cancelling a queued snapshot must not close the currently active open.
    if (operation.started) await this.closeOwnedKey(operation.key);
    await operation.done.catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    if (this.closing) return this.closing;
    const keys = new Set([...this.ownedContexts.keys(), ...this.operations.keys(), ...this.scopeOwners.keys()]);
    const closing = Promise.allSettled([...keys].map(async key => {
      await this.closeOwnedKey(key);
      this.scopeOwners.delete(key);
    })).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Research browser cleanup is unconfirmed');
    });
    this.closing = closing;
    try { await closing; }
    finally { if (this.closing === closing) this.closing = null; }
  }

  private async getHost() {
    const pending = this.connecting ??= this.connect();
    try { return await pending; }
    finally { if (this.connecting === pending) this.connecting = undefined; }
  }

  private async dispatch({ key, method, args = {} }: ResearchBrowserInvoke, signal: AbortSignal): Promise<unknown> {
    assertBrowserDispatch();
    signal.throwIfAborted();
    if (method === 'open') return this.open(key, asText(args.url, 8_000), signal);

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

  private async open(key: string, rawUrl: string, signal: AbortSignal): Promise<unknown> {
    const url = await requirePublicHttpsUrl(rawUrl, this.resolveHost);
    signal.throwIfAborted();
    const existing = this.sessions.get(key);
    if (!existing && this.ownedContexts.get(key)?.size) throw new Error('Research browser cleanup is unconfirmed. Close the session before reopening.');
    if (existing) {
      this.clearRefs(existing);
      try {
        await this.navigate(existing.page, url);
        signal.throwIfAborted();
        return { page: await this.pageState(existing.page), reused: true };
      } catch (error) {
        await this.closeKey(key);
        throw error;
      }
    }

    const browser = await this.getHost();
    if (!browser) throw new Error('Research browser is available in the Electron desktop app.');
    signal.throwIfAborted();
    assertBrowserDispatch();
    const context = await browser.newContext({
      acceptDownloads: false,
      locale: 'en-US',
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 768 },
    });
    const owned = this.ownedContexts.get(key) ?? new Set<ResearchBrowserContext>();
    owned.add(context);
    this.ownedContexts.set(key, owned);
    // From this point the context is owned even before newPage completes.
    // Every failure/cancel path must close it; closeKey cannot see it yet.
    try {
      signal.throwIfAborted();
      const assertLifetime = browserLifetimeGuard();
      await context.route('**/*', (route) => this.guardRoute(route, assertLifetime));
      if (typeof context.routeWebSocket === 'function') {
        await context.routeWebSocket('**/*', (socket) => socket.close());
      }
      signal.throwIfAborted();
      assertBrowserDispatch();
      const page = await context.newPage();
      signal.throwIfAborted();
      const session: BrowserSession = { context, page, refs: new Map() };
      this.sessions.set(key, session);
      context.on('page', (opened) => { if (opened !== page) void opened.close().catch(() => undefined); });
      page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
      page.on('download', (download) => void download.cancel().catch(() => undefined));
      page.on('filechooser', (chooser) => void chooser.setFiles([]).catch(() => undefined));
      await this.navigate(page, url);
      signal.throwIfAborted();
      return { page: await this.pageState(page), reused: false };
    } catch (error) {
      const published = this.sessions.get(key);
      if (published?.context === context) {
        this.sessions.delete(key);
        this.clearRefs(published);
      }
      await this.releaseContext(key, context);
      throw error;
    }
  }

  private async guardRoute(route: Route, assertLifetime: () => void): Promise<void> {
    const request = route.request();
    if (!READ_METHODS.has(request.method().toUpperCase())) {
      await route.abort('blockedbyclient');
      return;
    }
    try {
      await requirePublicHttpsUrl(request.url(), this.resolveHost);
      assertLifetime();
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  }

  private async navigate(page: Page, url: string): Promise<void> {
    assertBrowserDispatch();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }

  private async snapshot(session: BrowserSession, requestedLimit: number): Promise<unknown> {
    this.clearRefs(session);
    const candidates = session.page.locator(INTERACTIVE_SELECTOR);
    // Do not materialize one remote ElementHandle per node on a large page.
    // Only the bounded snapshot window can retain handles in this process.
    const totalCandidates = await candidates.count();
    const limit = Math.max(1, Math.min(MAX_REFS, Math.floor(requestedLimit)));
    const nodes: Array<ElementSummary & { ref: string }> = [];
    for (let index = 0; index < Math.min(totalCandidates, limit); index++) {
      assertBrowserDispatch();
      const handle = await candidates.nth(index).elementHandle({ timeout: 1_000 });
      if (!handle) continue;
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
      if (!summary || (!summary.name && !summary.href)) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      const ref = `a${nodes.length + 1}`;
      session.refs.set(ref, handle);
      nodes.push({ ref, ...summary });
    }
    return {
      page: await this.pageState(session.page),
      nodes,
      truncated: totalCandidates > limit,
      totalCandidates,
    };
  }

  private async extract(session: BrowserSession, requestedMax: number): Promise<unknown> {
    const maxChars = Math.max(1_000, Math.min(MAX_TEXT_CHARS, Math.floor(requestedMax)));
    // Slice in the page so a multi-megabyte body never crosses CDP only to be
    // discarded in the host immediately afterwards.
    const source = await session.page.locator('body').evaluate((body, maximum) => {
      const text = (body as HTMLElement).innerText;
      return { text: text.slice(0, maximum), sourceChars: text.length, truncated: text.length > maximum };
    }, maxChars, { timeout: 10_000 });
    return {
      page: await this.pageState(session.page),
      ...source,
    };
  }

  private ref(session: BrowserSession, rawRef: string): ElementHandle<HTMLElement | SVGElement> {
    const ref = rawRef.replace(/^ref=/, '');
    const handle = session.refs.get(ref);
    if (!handle) throw new Error(`Unknown or stale browser ref '${rawRef}'. Run browser_snapshot again.`);
    return handle;
  }

  private async click(session: BrowserSession, ref: string): Promise<unknown> {
    assertBrowserDispatch();
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
    assertBrowserDispatch();
    await handle.fill(value.slice(0, 4_000), { timeout: 10_000 });
    return { page: await this.pageState(session.page), valueRedacted: true };
  }

  private async press(session: BrowserSession, ref: string, key: string): Promise<unknown> {
    assertBrowserDispatch();
    await this.ref(session, ref).press(key, { timeout: 10_000 });
    await session.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    this.clearRefs(session);
    return { page: await this.pageState(session.page) };
  }

  private async screenshot(session: BrowserSession, fullPage: boolean): Promise<unknown> {
    assertBrowserDispatch();
    const data = await session.page.screenshot({ type: 'png', fullPage, timeout: 20_000 });
    return { base64: data.toString('base64'), page: await this.pageState(session.page) };
  }

  private async pageState(page: Page): Promise<{ url: string; title: string }> {
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  private async closeKey(key: string): Promise<{ closed: boolean }> {
    const session = this.sessions.get(key);
    if (session) this.clearRefs(session);
    const contexts = [...(this.ownedContexts.get(key) ?? [])];
    const outcomes = await Promise.allSettled(contexts.map(context => this.releaseContext(key, context)));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    return { closed: contexts.length > 0 };
  }

  private async releaseContext(key: string, context: ResearchBrowserContext): Promise<void> {
    await context.close();
    const owned = this.ownedContexts.get(key);
    owned?.delete(context);
    if (!owned?.size) this.ownedContexts.delete(key);
  }

  private async closeOwnedKey(key: string): Promise<{ closed: boolean }> {
    return this.operations.close(key, () => this.closeKey(key));
  }

  private clearRefs(session: BrowserSession): void {
    for (const handle of session.refs.values()) void handle.dispose().catch(() => undefined);
    session.refs.clear();
  }

  private async closePrefix(prefix: string): Promise<void> {
    const keys = new Set([...this.ownedContexts.keys(), ...this.operations.keys()]
      .filter(key => key === prefix || key.startsWith(`${prefix}-`)));
    if ([...keys].some(key => this.scopeOwners.has(key))) throw new Error('Cannot close an owned browser through a legacy prefix');
    await Promise.all([...keys].map(key => this.closeOwnedKey(key)));
  }
}
