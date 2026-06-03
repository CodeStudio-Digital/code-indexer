/**
 * A single agent-owned preview window + its CDP (Chrome DevTools Protocol)
 * session. The window loads a loopback dev-server URL as a TOP-LEVEL page
 * (no iframe → no OOPIF) so `webContents.debugger` attaches trivially. We
 * buffer console/exception/network events into capped ring buffers and
 * support an "active wait" (resolve on the next matching event) so the agent
 * can block until the console/network responds (Unity-style).
 */
import type { BrowserWindow } from 'electron';

export interface Viewport { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
/** Default emulated viewport (HD) — deterministic so debug/screenshots are
 *  representative instead of whatever the OS window happens to be. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false };
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export interface ConsoleEntry { level: string; text: string; ts: number }
export interface NetEntry { requestId: string; url: string; method: string; status?: number; statusText?: string; failed?: boolean; errorText?: string; body?: string; ts: number }

const CAP = 250;

interface Waiter { kind: 'console' | 'network'; match: (e: unknown) => boolean; resolve: () => void; timer: NodeJS.Timeout }

export class PreviewWindow {
  readonly id: number;
  private console: ConsoleEntry[] = [];
  private network: NetEntry[] = [];
  private netById = new Map<string, NetEntry>();
  private waiters: Waiter[] = [];
  /** Current emulated viewport (DevTools device-metrics override). */
  viewport: Viewport = { ...DEFAULT_VIEWPORT };

  constructor(public win: BrowserWindow, public url: string) {
    this.id = win.id;
    const dbg = win.webContents.debugger;
    try { dbg.attach('1.3'); } catch { /* already attached */ }
    dbg.on('message', (_e, method, params) => this.onCdp(method, params as Record<string, unknown>));
    for (const d of ['Runtime', 'Network', 'Log', 'Page', 'Performance', 'DOM', 'CSS']) {
      void dbg.sendCommand(`${d}.enable`).catch(() => undefined);
    }
    void this.setViewport(DEFAULT_VIEWPORT);
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.win.webContents.debugger.sendCommand(method, params ?? {});
  }

  /**
   * Set the emulated viewport via CDP device-metrics override — the page
   * renders at EXACTLY this size regardless of the OS window, so layout
   * inspection and screenshots are deterministic. `mobile` also enables touch
   * + a mobile UA so responsive/UA-sniffing sites switch to their mobile view.
   */
  async setViewport(v: Partial<Viewport>): Promise<Viewport> {
    const next: Viewport = {
      width: Math.max(200, Math.round(v.width ?? this.viewport.width)),
      height: Math.max(200, Math.round(v.height ?? this.viewport.height)),
      deviceScaleFactor: v.deviceScaleFactor ?? this.viewport.deviceScaleFactor ?? 1,
      mobile: v.mobile ?? this.viewport.mobile ?? false,
    };
    try {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: next.width,
        height: next.height,
        deviceScaleFactor: next.deviceScaleFactor || 1,
        mobile: next.mobile,
        screenWidth: next.width,
        screenHeight: next.height,
      });
      await this.send('Emulation.setTouchEmulationEnabled', {
        enabled: next.mobile,
        maxTouchPoints: next.mobile ? 5 : 0,
      }).catch(() => undefined);
      await this.send('Emulation.setUserAgentOverride', {
        userAgent: next.mobile ? MOBILE_UA : this.win.webContents.getUserAgent(),
      }).catch(() => undefined);
    } catch {
      /* degrade — emulation unsupported */
    }
    this.viewport = next;
    return next;
  }

  /** Reset console/network ring buffers — called on navigate / window reuse so
   *  the agent never reads stale events from the previous page. */
  clearBuffers(): void {
    this.console = [];
    this.network = [];
    this.netById.clear();
  }

  getConsole(level?: string): ConsoleEntry[] {
    return level && level !== 'all' ? this.console.filter((c) => c.level === level) : this.console.slice();
  }
  getNetwork(opts: { urlFilter?: string; status?: number } = {}): NetEntry[] {
    return this.network.filter((n) => {
      if (opts.urlFilter && !n.url.includes(opts.urlFilter)) return false;
      if (opts.status === 0) return (n.status ?? 0) >= 400 || !!n.failed;
      if (typeof opts.status === 'number' && n.status !== opts.status) return false;
      return true;
    });
  }

  /** Block until the next matching event of `kind`, or `timeoutMs`. */
  waitFor(kind: 'console' | 'network', match: (e: unknown) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        resolve();
      }, Math.min(Math.max(timeoutMs, 500), 30_000));
      this.waiters.push({ kind, match, resolve, timer });
    });
  }

  close(): void {
    try { this.win.webContents.debugger.detach(); } catch { /* gone */ }
    try { this.win.close(); } catch { /* gone */ }
  }

  private push<T>(buf: T[], item: T): void {
    buf.push(item);
    if (buf.length > CAP) buf.shift();
  }
  private fire(kind: 'console' | 'network', e: unknown): void {
    for (const w of this.waiters.slice()) {
      if (w.kind === kind && w.match(e)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve();
      }
    }
  }

  private onCdp(method: string, p: Record<string, unknown>): void {
    if (method === 'Runtime.consoleAPICalled') {
      const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' ');
      const e: ConsoleEntry = { level: String(p.type ?? 'log'), text, ts: Date.now() };
      this.push(this.console, e);
      this.fire('console', e);
    } else if (method === 'Runtime.exceptionThrown') {
      const det = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      const e: ConsoleEntry = { level: 'error', text: det?.exception?.description ?? det?.text ?? 'exception', ts: Date.now() };
      this.push(this.console, e);
      this.fire('console', e);
    } else if (method === 'Network.requestWillBeSent') {
      const req = p.request as { url?: string; method?: string } | undefined;
      const e: NetEntry = { requestId: String(p.requestId), url: req?.url ?? '', method: req?.method ?? 'GET', ts: Date.now() };
      this.netById.set(e.requestId, e);
      this.push(this.network, e);
    } else if (method === 'Network.responseReceived') {
      const res = p.response as { status?: number; statusText?: string } | undefined;
      const e = this.netById.get(String(p.requestId));
      if (e) {
        e.status = res?.status;
        e.statusText = res?.statusText;
        this.fire('network', e);
      }
    } else if (method === 'Network.loadingFailed') {
      // CORS blocks, net::ERR_*, aborted/blocked requests — no response is ever
      // received, so without this they'd be invisible to preview_network.
      const e = this.netById.get(String(p.requestId));
      if (e) {
        e.failed = true;
        e.errorText = String(p.errorText ?? (p.blockedReason ? `blocked: ${p.blockedReason}` : 'request failed'));
        this.fire('network', e);
      }
    }
  }
}
