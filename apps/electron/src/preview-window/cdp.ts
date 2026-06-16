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
/** Default preview viewport (HD). Applied as the native window CONTENT size —
 *  see PreviewWindowService — which is crash-safe (no CDP Emulation override,
 *  which destabilised Chromium on some Windows/Electron builds). Width-based
 *  responsive breakpoints work; true touch/UA device emulation is deferred. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false };

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
  /** Listeners for element selections from the injected universal inspector. */
  private selectListeners = new Set<(d: unknown) => void>();
  /** Listeners for control-bar actions (`viewport:<preset>`, `close`). */
  private controlListeners = new Set<(action: string) => void>();
  /** True once the inspector script has been registered for new documents. */
  private inspectArmed = false;
  /** Current viewport (native window content size — informational). */
  viewport: Viewport = { ...DEFAULT_VIEWPORT };

  /** Bound CDP message handler — kept so `close()` can detach it. */
  private readonly onMessage: (e: unknown, method: string, params: unknown) => void;

  constructor(public win: BrowserWindow, public url: string) {
    this.id = win.id;
    const dbg = win.webContents.debugger;
    try { dbg.attach('1.3'); } catch { /* already attached */ }
    this.onMessage = (_e, method, params) => this.onCdp(method, params as Record<string, unknown>);
    dbg.on('message', this.onMessage);
    for (const d of ['Runtime', 'Network', 'Log', 'Page', 'Performance', 'DOM', 'CSS']) {
      void dbg.sendCommand(`${d}.enable`).catch(() => undefined);
    }
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.win.webContents.debugger.sendCommand(method, params ?? {});
  }

  /** Subscribe to element selections (universal inspector → `__mcpSelect`). */
  onSelect(cb: (d: unknown) => void): () => void {
    this.selectListeners.add(cb);
    return () => this.selectListeners.delete(cb);
  }

  /** Subscribe to control-bar actions (universal toolbar → `__mcpControl`). */
  onControl(cb: (action: string) => void): () => void {
    this.controlListeners.add(cb);
    return () => this.controlListeners.delete(cb);
  }

  /**
   * Inject the framework-agnostic inspector into the page (and every future
   * document, so it survives SPA route changes / HMR reloads) and expose the
   * `__mcpSelect` binding that carries selections back via `Runtime.bindingCalled`.
   * Idempotent — the script self-guards (`__mcpInspectorInstalled`) and we only
   * register the on-new-document hook once per window.
   */
  async armInspect(source: string): Promise<void> {
    await this.send('Runtime.addBinding', { name: '__mcpSelect' }).catch(() => undefined);
    await this.send('Runtime.addBinding', { name: '__mcpRegionSelect' }).catch(() => undefined);
    await this.send('Runtime.addBinding', { name: '__mcpControl' }).catch(() => undefined);
    if (!this.inspectArmed) {
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => undefined);
      this.inspectArmed = true;
    }
    await this.send('Runtime.evaluate', { expression: source }).catch(() => undefined);
  }

  async disarmInspect(): Promise<void> {
    await this.send('Runtime.evaluate', { expression: 'window.__mcpDisarm && window.__mcpDisarm()' }).catch(() => undefined);
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
    try { this.win.webContents.debugger.removeListener('message', this.onMessage); } catch { /* gone */ }
    try { this.win.webContents.debugger.detach(); } catch { /* gone */ }
    try { this.win.close(); } catch { /* gone */ }
  }

  private push<T>(buf: T[], item: T): void {
    buf.push(item);
    if (buf.length > CAP) buf.shift();
  }
  /** Like `push`, but keeps `netById` in sync: when an entry rolls off the
   *  network ring buffer, its `netById` lookup entry is evicted too. Without
   *  this the map grows unbounded on a long-lived page making many requests. */
  private pushNet(item: NetEntry): void {
    this.network.push(item);
    if (this.network.length > CAP) {
      const removed = this.network.shift();
      if (removed) this.netById.delete(removed.requestId);
    }
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
      this.pushNet(e);
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
    } else if (method === 'Page.javascriptDialogOpening') {
      // Native alert()/confirm()/prompt()/beforeunload BLOCK the renderer (and
      // every CDP command) until answered — so an unanswered dialog froze the
      // whole agent preview. Auto-accept so flows proceed, and record it in the
      // console buffer so the agent SEES that a dialog appeared and what it said.
      const d = p as { type?: string; message?: string };
      const e: ConsoleEntry = { level: 'dialog', text: `[${d.type ?? 'dialog'}] ${d.message ?? ''}`.trim(), ts: Date.now() };
      this.push(this.console, e);
      this.fire('console', e);
      void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    } else if (method === 'Runtime.bindingCalled') {
      const payload = typeof p.payload === 'string' ? p.payload : '';
      if (p.name === '__mcpSelect' || p.name === '__mcpRegionSelect') {
        // window.__mcpSelect(json) on click; window.__mcpRegionSelect(json) on a
        // marquee drag. Both fan out to the same selection listeners — the payload
        // self-identifies via `type` ('mcp:select' | 'mcp:region-select').
        let parsed: unknown = null;
        try { parsed = JSON.parse(payload); } catch { /* malformed */ }
        if (parsed) for (const cb of Array.from(this.selectListeners)) {
          try { cb(parsed); } catch { /* listener threw — ignore */ }
        }
      } else if (p.name === '__mcpControl') {
        // The floating toolbar calls window.__mcpControl('viewport:<preset>'|'close').
        for (const cb of Array.from(this.controlListeners)) {
          try { cb(payload); } catch { /* listener threw — ignore */ }
        }
      }
    }
  }
}
