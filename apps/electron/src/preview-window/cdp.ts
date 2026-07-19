/**
 * A single agent-owned preview window + its CDP (Chrome DevTools Protocol)
 * session. The window loads a loopback dev-server URL as a TOP-LEVEL page
 * (no iframe → no OOPIF) so `webContents.debugger` attaches trivially. We
 * buffer console/exception/network events into capped ring buffers and
 * support an "active wait" (resolve on the next matching event) so the agent
 * can block until the console/network responds (Unity-style).
 */
import type { BrowserWindow } from 'electron';

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  requestedWidth?: number;
  requestedHeight?: number;
  emulated?: boolean;
}
/** Default preview viewport (HD). Applied as the native window CONTENT size —
 *  see PreviewWindowService — which is crash-safe (no CDP Emulation override,
 *  which destabilised Chromium on some Windows/Electron builds). Width-based
 *  responsive breakpoints work; true touch/UA device emulation is deferred. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false };

export interface ConsoleEntry { seq: number; level: string; text: string; ts: number; url?: string; line?: number }
export interface NetEntry {
  seq: number;
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  type?: string;
  mimeType?: string;
  completed?: boolean;
  failed?: boolean;
  errorText?: string;
  fromCache?: boolean;
  encodedDataLength?: number;
  durationMs?: number;
  body?: string;
  ts: number;
  startedMonotonic?: number;
}

const CAP = 250;
const MAX_CONSOLE_ENTRY_CHARS = 20_000;
const MAX_URL_CHARS = 8_000;
const CDP_INITIALIZE_TIMEOUT_MS = 30_000;
const CDP_DOMAINS = ['Runtime', 'Network', 'Log', 'Page', 'Performance', 'DOM', 'CSS', 'Accessibility'] as const;

function capText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[entry capped at ${max} chars]` : value;
}

interface Waiter {
  kind: 'console' | 'network';
  match: (e: unknown) => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface PreviewCursor { consoleSeq: number; networkSeq: number }

export class PreviewWindow {
  readonly id: number;
  private console: ConsoleEntry[] = [];
  private network: NetEntry[] = [];
  private netById = new Map<string, NetEntry>();
  private waiters: Waiter[] = [];
  private consoleSeq = 0;
  private networkSeq = 0;
  private navigationId = 0;
  private nextRef = 0;
  private refToBackendNode = new Map<string, number>();
  /** Listeners for element selections from the injected universal inspector. */
  private selectListeners = new Set<(d: unknown) => void>();
  /** Listeners for control-bar actions (`viewport:<preset>`, `close`). */
  private controlListeners = new Set<(action: string) => void>();
  /** True once the inspector script has been registered for new documents. */
  private inspectArmed = false;
  /** Identifier of the on-new-document script that sets `window.__mcpSelectorMode`.
   *  Kept SEPARATE from the static inspector source (registered once) so a live
   *  mode toggle can replace it — and so the mode survives in-window navigation. */
  private modeScriptId: string | null = null;
  /** Current viewport (native window content size — informational). */
  viewport: Viewport = { ...DEFAULT_VIEWPORT };

  /** Bound CDP message handler — kept so `close()` can detach it. */
  private readonly onMessage: (e: unknown, method: string, params: unknown) => void;
  private readonly onDetach: (_e: unknown, reason: string) => void;

  private constructor(public win: BrowserWindow, public url: string) {
    this.id = win.id;
    const dbg = win.webContents.debugger;
    this.onMessage = (_e, method, params) => this.onCdp(method, params as Record<string, unknown>);
    this.onDetach = (_e, reason) => {
      const entry: ConsoleEntry = {
        seq: ++this.consoleSeq,
        level: 'error',
        text: `Preview DevTools detached: ${reason}`,
        ts: Date.now(),
      };
      this.push(this.console, entry);
      this.fire('console', entry);
    };
    dbg.on('message', this.onMessage);
    dbg.on('detach', this.onDetach);
  }

  static async create(
    win: BrowserWindow,
    url: string,
    navigate?: () => Promise<void>,
  ): Promise<PreviewWindow> {
    const preview = new PreviewWindow(win, url);
    const dbg = win.webContents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (!dbg.isAttached()) throw new Error('debugger did not attach');
      // Start CDP capture before navigation so the initial console/network
      // activity is retained. DOM/CSS/Accessibility can remain pending while
      // the target is about:blank, however, so navigation must run in parallel
      // with domain initialization instead of waiting behind it.
      const pending = new Set<string>(CDP_DOMAINS);
      const initialize = Promise.all(
        CDP_DOMAINS.map((domain) =>
          dbg.sendCommand(`${domain}.enable`).finally(() => pending.delete(domain)),
        ),
      );
      const boundedInitialize = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `CDP initialization timed out after ${CDP_INITIALIZE_TIMEOUT_MS}ms` +
              (pending.size ? ` (pending: ${[...pending].join(', ')})` : ''),
          ));
        }, CDP_INITIALIZE_TIMEOUT_MS);
        initialize.then(
          () => { clearTimeout(timer); resolve(); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
      if (navigate) await Promise.all([boundedInitialize, navigate()]);
      else await boundedInitialize;
      await dbg.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true });
      return preview;
    } catch (error) {
      preview.close();
      throw new Error(`Failed to initialize Preview DevTools: ${error instanceof Error ? error.message : String(error)}`);
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

  /**
   * Set the element-selector mode ('react' | 'universal' | 'auto'). Applied to
   * the CURRENT document immediately AND (re)registered as its own on-new-document
   * script so it survives SPA navigation / reload / HMR — replacing the previous
   * one so a live toggle takes effect on every future document too. The inspector
   * reads `window.__mcpSelectorMode` lazily at click time, so this can run before
   * or after the inspector source without ordering concerns.
   */
  async setSelectorMode(mode: string): Promise<void> {
    const expr = `window.__mcpSelectorMode=${JSON.stringify(mode)}`;
    await this.send('Runtime.evaluate', { expression: expr }).catch(() => undefined);
    if (this.modeScriptId) {
      await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.modeScriptId }).catch(() => undefined);
      this.modeScriptId = null;
    }
    const res = (await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `${expr};` }).catch(() => null)) as
      | { identifier?: string }
      | null;
    this.modeScriptId = res?.identifier ?? null;
  }

  /** Reset console/network ring buffers — called on navigate / window reuse so
   *  the agent never reads stale events from the previous page. */
  clearBuffers(): void {
    this.console = [];
    this.network = [];
    this.netById.clear();
    this.resetRefs();
  }

  getConsole(level?: string): ConsoleEntry[] {
    const normalized = level === 'warning' ? 'warn' : level;
    return normalized && normalized !== 'all' ? this.console.filter((c) => c.level === normalized) : this.console.slice();
  }

  getCursor(): PreviewCursor {
    return { consoleSeq: this.consoleSeq, networkSeq: this.networkSeq };
  }

  getDiagnosticsSince(cursor: PreviewCursor): { consoleErrors: ConsoleEntry[]; failedRequests: NetEntry[] } {
    return {
      consoleErrors: this.console.filter((entry) => entry.seq > cursor.consoleSeq && entry.level === 'error'),
      failedRequests: this.network.filter((entry) => entry.seq > cursor.networkSeq && entry.failed),
    };
  }

  async getPageState(): Promise<{ url: string; title: string; navigationId: number }> {
    const url = this.win.webContents.getURL() || this.url;
    const response = (await this.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    }).catch(() => null)) as { result?: { value?: unknown } } | null;
    return { url, title: typeof response?.result?.value === 'string' ? response.result.value : '', navigationId: this.navigationId };
  }

  resetRefs(): void {
    this.nextRef = 0;
    this.refToBackendNode.clear();
  }

  bindRef(backendNodeId: number): string {
    const ref = `a${++this.nextRef}`;
    this.refToBackendNode.set(ref, backendNodeId);
    return ref;
  }

  resolveRef(ref: string): number | undefined {
    return this.refToBackendNode.get(ref.replace(/^ref=/, ''));
  }
  getNetwork(opts: { urlFilter?: string; status?: number } = {}): NetEntry[] {
    return this.network.filter((n) => {
      if (opts.urlFilter && !n.url.includes(opts.urlFilter)) return false;
      if (opts.status === 0) return (n.status ?? 0) >= 400 || !!n.failed;
      if (typeof opts.status === 'number' && n.status !== opts.status) return false;
      return true;
    }).map((entry) => {
      // Monotonic CDP timestamps are an internal duration-calculation detail;
      // exposing them makes the model-facing payload noisy and misleading.
      const { startedMonotonic: _startedMonotonic, ...publicEntry } = entry;
      return publicEntry;
    });
  }

  /** Block until the next matching event of `kind`, or `timeoutMs`. */
  waitFor(kind: 'console' | 'network', match: (e: unknown) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Preview wait aborted.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.waiters.find((w) => w.timer === timer);
        if (waiter) this.removeWaiter(waiter);
        resolve();
      }, Math.min(Math.max(timeoutMs, 500), 30_000));
      const waiter: Waiter = { kind, match, resolve, reject, timer, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          reject(new Error('Preview wait aborted.'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  close(): void {
    for (const waiter of this.waiters.slice()) {
      this.removeWaiter(waiter);
      waiter.reject(new Error('Preview window closed.'));
    }
    try { this.win.webContents.debugger.removeListener('message', this.onMessage); } catch { /* gone */ }
    try { this.win.webContents.debugger.removeListener('detach', this.onDetach); } catch { /* gone */ }
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
      if (removed && this.netById.get(removed.requestId) === removed) this.netById.delete(removed.requestId);
    }
  }
  private fire(kind: 'console' | 'network', e: unknown): void {
    for (const w of this.waiters.slice()) {
      if (w.kind === kind && w.match(e)) {
        this.removeWaiter(w);
        w.resolve();
      }
    }
  }

  private removeWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    this.waiters = this.waiters.filter((entry) => entry !== waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  private onCdp(method: string, p: Record<string, unknown>): void {
    if (method === 'Runtime.consoleAPICalled') {
      const args = (p.args as Array<{ value?: unknown; unserializableValue?: string; description?: string; preview?: { description?: string } }> | undefined) ?? [];
      const text = args.map((a) => {
        if (a.value !== undefined) {
          if (typeof a.value === 'string') return a.value;
          try { return JSON.stringify(a.value); } catch { return String(a.value); }
        }
        return a.unserializableValue ?? a.preview?.description ?? a.description ?? '';
      }).join(' ');
      const stack = p.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined;
      const frame = stack?.callFrames?.[0];
      const rawLevel = String(p.type ?? 'log');
      const e: ConsoleEntry = {
        seq: ++this.consoleSeq,
        level: rawLevel === 'warning' ? 'warn' : rawLevel,
        text: capText(text, MAX_CONSOLE_ENTRY_CHARS),
        ts: Date.now(),
        ...(frame?.url ? { url: frame.url } : {}),
        ...(typeof frame?.lineNumber === 'number' ? { line: frame.lineNumber + 1 } : {}),
      };
      this.push(this.console, e);
      this.fire('console', e);
    } else if (method === 'Runtime.exceptionThrown') {
      const det = p.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } } | undefined;
      const e: ConsoleEntry = {
        seq: ++this.consoleSeq,
        level: 'error',
        text: capText(det?.exception?.description ?? det?.text ?? 'exception', MAX_CONSOLE_ENTRY_CHARS),
        ts: Date.now(),
        ...(det?.url ? { url: det.url } : {}),
        ...(typeof det?.lineNumber === 'number' ? { line: det.lineNumber + 1 } : {}),
      };
      this.push(this.console, e);
      this.fire('console', e);
    } else if (method === 'Log.entryAdded') {
      const entry = p.entry as { level?: string; text?: string; timestamp?: number; url?: string; lineNumber?: number } | undefined;
      const rawLevel = String(entry?.level ?? 'log');
      const e: ConsoleEntry = {
        seq: ++this.consoleSeq,
        level: rawLevel === 'warning' ? 'warn' : rawLevel,
        text: capText(entry?.text ?? '', MAX_CONSOLE_ENTRY_CHARS),
        ts: typeof entry?.timestamp === 'number' ? entry.timestamp : Date.now(),
        ...(entry?.url ? { url: entry.url } : {}),
        ...(typeof entry?.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
      };
      this.push(this.console, e);
      this.fire('console', e);
    } else if (method === 'Network.requestWillBeSent') {
      const req = p.request as { url?: string; method?: string } | undefined;
      const requestId = String(p.requestId);
      const redirect = p.redirectResponse as { status?: number; statusText?: string } | undefined;
      const previous = this.netById.get(requestId);
      if (redirect && previous) {
        previous.seq = ++this.networkSeq;
        previous.status = redirect.status;
        previous.statusText = redirect.statusText;
        previous.completed = true;
        previous.durationMs = Math.max(0, (Number(p.timestamp) - (previous.startedMonotonic ?? Number(p.timestamp))) * 1000);
        this.fire('network', previous);
      }
      const e: NetEntry = {
        seq: ++this.networkSeq,
        requestId,
        url: capText(req?.url ?? '', MAX_URL_CHARS),
        method: req?.method ?? 'GET',
        type: typeof p.type === 'string' ? p.type : undefined,
        ts: typeof p.wallTime === 'number' ? Number(p.wallTime) * 1000 : Date.now(),
        startedMonotonic: Number(p.timestamp),
      };
      this.netById.set(e.requestId, e);
      this.pushNet(e);
    } else if (method === 'Network.responseReceived') {
      const res = p.response as { status?: number; statusText?: string; mimeType?: string; fromDiskCache?: boolean; fromPrefetchCache?: boolean } | undefined;
      const e = this.netById.get(String(p.requestId));
      if (e) {
        e.status = res?.status;
        e.statusText = res?.statusText;
        e.type = typeof p.type === 'string' ? p.type : e.type;
        e.mimeType = res?.mimeType;
        e.fromCache = !!res?.fromDiskCache || !!res?.fromPrefetchCache;
      }
    } else if (method === 'Network.loadingFinished') {
      const e = this.netById.get(String(p.requestId));
      if (e) {
        // Completion gets its own sequence so a request started before an
        // interaction but failed/finished after it is still diagnosed.
        e.seq = ++this.networkSeq;
        e.completed = true;
        e.encodedDataLength = Number(p.encodedDataLength) || 0;
        e.durationMs = Math.max(0, (Number(p.timestamp) - (e.startedMonotonic ?? Number(p.timestamp))) * 1000);
        this.fire('network', e);
      }
    } else if (method === 'Network.loadingFailed') {
      // CORS blocks, net::ERR_*, aborted/blocked requests — no response is ever
      // received, so without this they'd be invisible to preview_network.
      const e = this.netById.get(String(p.requestId));
      if (e) {
        e.seq = ++this.networkSeq;
        e.completed = true;
        e.failed = true;
        e.errorText = String(p.errorText ?? (p.blockedReason ? `blocked: ${p.blockedReason}` : 'request failed'));
        e.durationMs = Math.max(0, (Number(p.timestamp) - (e.startedMonotonic ?? Number(p.timestamp))) * 1000);
        this.fire('network', e);
      }
    } else if (method === 'Network.requestServedFromCache') {
      const e = this.netById.get(String(p.requestId));
      if (e) e.fromCache = true;
    } else if (method === 'Page.javascriptDialogOpening') {
      // Native alert()/confirm()/prompt()/beforeunload BLOCK the renderer (and
      // every CDP command) until answered — so an unanswered dialog froze the
      // whole agent preview. Resolve it immediately and record the safe choice.
      const d = p as { type?: string; message?: string };
      const accept = d.type === 'alert';
      const e: ConsoleEntry = {
        seq: ++this.consoleSeq,
        level: 'dialog',
        text: `[${d.type ?? 'dialog'} ${accept ? 'accepted' : 'dismissed'}] ${d.message ?? ''}`.trim(),
        ts: Date.now(),
      };
      this.push(this.console, e);
      this.fire('console', e);
      // Alerts are acknowledgement-only. Confirmation/prompt/beforeunload are
      // dismissed by default so preview automation never silently authorizes
      // a destructive operation.
      void this.send('Page.handleJavaScriptDialog', { accept }).catch(() => undefined);
    } else if (method === 'Page.frameNavigated') {
      const frame = p.frame as { parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId) {
        this.navigationId += 1;
        this.url = frame.url || this.win.webContents.getURL() || this.url;
        this.resetRefs();
      }
    } else if (method === 'Runtime.executionContextsCleared') {
      this.resetRefs();
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
