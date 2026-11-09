/**
 * Main-process implementation of the agent preview/devtools backend. Opens a
 * dedicated, SANDBOXED BrowserWindow per agent key (no preload → the dev page
 * never gets `electronAPI`), attaches CDP, and dispatches the `preview_*`
 * tool calls. Registered via `setGlobalPreviewDevtools` in main.ts.
 */
import { BrowserWindow, session, type Session } from 'electron';
import type { IPreviewDevtools, PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { PreviewInspector } from './inspector.js';
import { dispatchPreviewQuery } from './queries.js';
import { PreviewWindow, DEFAULT_VIEWPORT, type Viewport } from './cdp.js';
import { dispatchInteraction } from './interact.js';
import { resolveViewport, applyViewport, clampToScreen } from './viewport.js';
import { resolveAppIconPath } from '../app-icon.js';
import { resolveDevUrl, type RunnerBridge } from './dev-server-resolver.js';
import type { PreviewDispatchScope } from '@mcp/services/preview/contracts.js';
import { assertPreviewDispatch, previewDispatchRunner, runPreviewDispatch } from './dispatch-scope.js';

function abortError(): Error {
  const error = new Error('Preview operation aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAllowedPreviewUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function requireAllowedPreviewUrl(raw: string): string {
  const url = raw.trim();
  if (!isAllowedPreviewUrl(url)) {
    throw new Error('Preview URL must be an http(s) loopback URL (localhost, 127.0.0.1, or [::1]).');
  }
  return url;
}

function partitionForKey(key: string): string {
  return `mcp-preview-${key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 120)}`;
}

export class PreviewWindowService extends PreviewInspector implements IPreviewDevtools {
  readonly authorityAttested = true as const;
  private byKey = new Map<string, PreviewWindow>();
  private inFlight = new Map<string, { key: string; controller: AbortController; done: Promise<unknown> }>();
  private pending = new Set<{ key: string; controller: AbortController; done: Promise<unknown> }>();
  private operationTail = new Map<string, Promise<unknown>>();
  private closingKeys = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;
  private configuredSessions = new WeakSet<Session>();
  /** Dev servers THIS service started for a preview (key → runner taskId).
   *  Kept SEPARATE from byKey so closing the window (turn end) doesn't drop
   *  ownership — the owned server is stopped only on closeSession (evict). */
  private ownedTaskByKey = new Map<string, string>();
  private ownedRunnerByKey = new Map<string, RunnerBridge>();
  private scopeOwners = new Map<string, object>();

  /** Injected in main.ts (null in tests / non-runner contexts). Enables
   *  url-less preview_open: reuse the project's running runner or start one. */
  constructor(private runnerBridge: RunnerBridge | null = null, private readonly options: { show?: boolean } = {}) { super(); }

  protected getPreview(key: string) { return this.byKey.get(key); }

  setRunnerBridge(bridge: RunnerBridge | null): void {
    this.runnerBridge = bridge;
  }

  existingRunners() {
    const bridge = this.runnerBridge;
    return bridge && { list: () => bridge.list(), readBuffer: (id: string) => bridge.readBuffer(id), pinnedPort: (id: number) => bridge.pinnedPort(id) };
  }

  async invoke(req: PreviewInvoke, scope?: PreviewDispatchScope): Promise<unknown> {
    const owner = this.scopeOwners.get(req.key);
    if ((owner && owner !== scope?.owner) || (req.key.includes('-attempt-') && !scope?.owner)) {
      throw new Error('Preview scope belongs to a different host owner');
    }
    scope?.signal.throwIfAborted();
    scope?.assertDispatch();
    if (scope?.owner) this.scopeOwners.set(req.key, scope.owner);
    if (this.closing) throw new Error('Preview service is closing.');
    // Lifecycle closes cancel and drain their key outside the operation being
    // cancelled. Including a close in its own drain would deadlock shutdown.
    if (req.method === 'closeSession') return this.closeSession(req.key);
    if (req.method === 'closeSessionPrefix') return this.closeSessionPrefix(req.key);
    if (req.method === 'close' || req.method === 'closeWindow') {
      await this.closeOwnedKey(req.key, false);
      return { ok: true };
    }
    if (req.method === 'closeWindowPrefix') {
      const keys = this.matchingKeys(req.key);
      if (keys.some(key => this.scopeOwners.has(key))) throw new Error('Cannot close an owned preview through a legacy prefix');
      await Promise.all(keys.map(key => this.closeOwnedKey(key, false)));
      return { ok: true };
    }
    const requestId = req.requestId;
    if (this.closingKeys.has(req.key)) throw new Error('Preview session is closing.');
    if (requestId && this.inFlight.has(requestId)) throw new Error('Duplicate preview request ID.');
    if (this.pending.size >= 256 || [...this.pending].filter(item => item.key === req.key).length >= 32) {
      throw new Error('Preview request queue is full.');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(scope?.signal.reason);
    scope?.signal.addEventListener('abort', cancel, { once: true });
    if (scope?.signal.aborted) cancel();
    const previous = this.operationTail.get(req.key) ?? Promise.resolve();
    const done = previous.catch(() => undefined).then(() => runPreviewDispatch({
      signal: controller.signal, assertDispatch: () => scope?.assertDispatch(), runner: scope?.runner,
    }, () => this.invokeInternal(req, controller.signal)));
    this.operationTail.set(req.key, done);
    const operation = { key: req.key, controller, done };
    this.pending.add(operation);
    if (requestId) this.inFlight.set(requestId, operation);
    try {
      return await done;
    } finally {
      scope?.signal.removeEventListener('abort', cancel);
      this.pending.delete(operation);
      if (this.operationTail.get(req.key) === done) this.operationTail.delete(req.key);
      if (requestId && this.inFlight.get(requestId) === operation) this.inFlight.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    this.inFlight.get(requestId)?.controller.abort();
  }

  async closeOwnedScope(key: string, owner: object): Promise<void> {
    const current = this.scopeOwners.get(key);
    if (current && current !== owner) throw new Error('Preview cleanup belongs to a different host owner');
    await this.closeSession(key);
    this.scopeOwners.delete(key);
  }

  private async invokeInternal(req: PreviewInvoke, signal: AbortSignal): Promise<unknown> {
    assertPreviewDispatch();
    throwIfAborted(signal);
    const { key, method } = req;
    const args = req.args ?? {};
    if (method === 'open') return this.open(key, args, signal);
    // Standalone offscreen capture — no per-key window involved.
    if (method === 'thumbnail') {
      const { captureThumbnail } = await import('./thumbnail.js');
      return captureThumbnail({
        url: String(args.url ?? ''),
        outPath: String(args.outPath ?? ''),
        width: typeof args.width === 'number' ? args.width : undefined,
        thumbWidth: typeof args.thumbWidth === 'number' ? args.thumbWidth : undefined,
      });
    }

    const pw = this.byKey.get(key);
    if (!pw || pw.win.isDestroyed()) {
      throw new Error('No preview window open for this agent. Call preview_open first.');
    }

    if (
      method === 'click' || method === 'type' || method === 'fill' || method === 'wait_for' ||
      method === 'press' || method === 'scroll' || method === 'hover' ||
      method === 'double_click' || method === 'right_click'
    ) {
      const cursor = pw.getCursor();
      const result = await dispatchInteraction(pw, method, args, signal);
      throwIfAborted(signal);
      const page = await pw.getPageState();
      const diagnostics = pw.getDiagnosticsSince(cursor);
      return { ...(result as object), page, diagnostics };
    }

    switch (method) {
      case 'viewport': {
        const v = applyViewport(pw, resolveViewport(args, pw.viewport));
        return { ok: true, viewport: v };
      }
      case 'navigate':
        pw.clearBuffers();
        await this.loadUrl(pw.win, requireAllowedPreviewUrl(String(args.url ?? '')), signal);
        pw.url = pw.win.webContents.getURL();
        return { ok: true, url: pw.url };
      default: return dispatchPreviewQuery(pw, method, args, signal);
    }
  }

  private async open(
    key: string,
    args: Record<string, unknown> = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ windowId: number; url: string; viewport: Viewport; reused: boolean; source: 'explicit' | 'reused' | 'started' }> {
    throwIfAborted(signal);
    const initial = resolveViewport(args, DEFAULT_VIEWPORT);
    // Resolve the URL: explicit `url` wins; otherwise reuse/start the
    // project's dev server via the runner (and remember ownership so we
    // can stop exactly what we started, never the user's runner).
    let url = String(args.url ?? '').trim();
    let reused = true;
    let startedTaskId: string | undefined;
    let source: 'explicit' | 'reused' | 'started' = url ? 'explicit' : 'reused';
    const runner = previewDispatchRunner() ?? this.runnerBridge;
    if (!url) {
      const projectId = typeof args.projectId === 'number' ? args.projectId : null;
      if (projectId == null || !runner) {
        throw new Error(
          'preview_open needs a `url` (no project dev-server resolver available here). ' +
            'Pass url=http://localhost:PORT.',
        );
      }
      const resolved = await resolveDevUrl(runner, projectId, { signal,
        onOwnedTask: taskId => { this.ownedTaskByKey.set(key, taskId); this.ownedRunnerByKey.set(key, runner); },
        onOwnedTaskStopped: taskId => {
          if (this.ownedTaskByKey.get(key) === taskId) this.ownedTaskByKey.delete(key);
        },
      });
      url = resolved.url;
      reused = !resolved.ownedTaskId;
      source = resolved.ownedTaskId ? 'started' : 'reused';
      if (resolved.ownedTaskId) {
        startedTaskId = resolved.ownedTaskId;
        this.ownedTaskByKey.set(key, resolved.ownedTaskId);
      }
    }
    const stopServerStartedByThisOpen = async (): Promise<void> => {
      if (!startedTaskId || this.ownedTaskByKey.get(key) !== startedTaskId) return;
      if (runner) {
        await runner.stop(startedTaskId);
        if (this.ownedTaskByKey.get(key) === startedTaskId) this.ownedTaskByKey.delete(key);
      }
    };
    try {
      url = requireAllowedPreviewUrl(url);
    } catch (error) {
      await stopServerStartedByThisOpen();
      throw error;
    }
    if (signal.aborted) {
      await stopServerStartedByThisOpen();
      throw abortError();
    }
    const existing = this.byKey.get(key);
    if (existing && !existing.win.isDestroyed()) {
      try {
        existing.clearBuffers();
        await this.loadUrl(existing.win, url, signal);
        existing.url = existing.win.webContents.getURL();
        const v = applyViewport(existing, initial);
        return { windowId: existing.id, url: existing.url, viewport: v, reused, source };
      } catch (error) {
        await stopServerStartedByThisOpen();
        throw error;
      }
    }
    const { width, height } = clampToScreen(initial.width, initial.height);
    const appIconPath = resolveAppIconPath();
    assertPreviewDispatch();
    const win = new BrowserWindow({
      show: this.options.show ?? true,
      width,
      height,
      title: `Preview · ${key}`,
      ...(appIconPath ? { icon: appIconPath } : {}),
      webPreferences: {
        offscreen: this.options.show === false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: partitionForKey(key),
        backgroundThrottling: false,
      },
    });
    this.configureSession(win.webContents.session);
    win.webContents.setWindowOpenHandler(({ url: requestedUrl }) => {
      if (isAllowedPreviewUrl(requestedUrl)) {
        void this.loadUrl(win, requestedUrl, new AbortController().signal).catch(() => undefined);
      }
      return { action: 'deny' };
    });
    const guardNavigation = (event: { preventDefault(): void }, requestedUrl: string): void => {
      if (!isAllowedPreviewUrl(requestedUrl)) event.preventDefault();
    };
    win.webContents.on('will-navigate', guardNavigation);
    win.webContents.on('will-redirect', guardNavigation);
    win.on('closed', () => {
      if (this.byKey.get(key)?.id === win.id) {
        // Tell the dashboard the window is gone (native X or toolbar close) so
        // it can un-pause the inline iframe. Harmless for agent keys (no listeners).
        this.fanoutSelect(key, { type: 'mcp:closed' });
        this.byKey.delete(key);
        this.inspectListeners.delete(key);
      }
    });
    let pw: PreviewWindow | null = null;
    try {
      pw = await PreviewWindow.create(win, url, () => this.loadUrl(win, url, signal));
      throwIfAborted(signal);
      assertPreviewDispatch();
      this.byKey.set(key, pw);
      pw.url = win.webContents.getURL();
      const viewport = applyViewport(pw, initial);
      return { windowId: pw.id, url: pw.url, viewport, reused, source };
    } catch (error) {
      if (this.byKey.get(key)?.id === win.id) this.byKey.delete(key);
      if (pw) pw.close();
      else if (!win.isDestroyed()) win.destroy();
      await stopServerStartedByThisOpen();
      throw error;
    }
  }

  private configureSession(ses: Session): void {
    if (this.configuredSessions.has(ses)) return;
    this.configuredSessions.add(ses);
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.on('will-download', (event) => event.preventDefault());
  }

  private loadUrl(win: BrowserWindow, url: string, signal: AbortSignal): Promise<void> {
    assertPreviewDispatch();
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => {
        try { win.webContents.stop(); } catch { /* gone */ }
        finish(abortError());
      };
      const timer = setTimeout(() => {
        try { win.webContents.stop(); } catch { /* gone */ }
        finish(new Error(`Preview navigation timed out after 30s: ${url}`));
      }, 30_000);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      win.loadURL(url).then(
        () => finish(),
        (error) => finish(error),
      );
    });
  }

  closeKey(key: string): void {
    for (const operation of this.pending) if (operation.key === key) operation.controller.abort();
    // Notify the dashboard BEFORE teardown; delete synchronously so a quick
    // re-open never reuses a closing window. The window 'closed' handler then
    // no-ops (byKey already cleared), so the sentinel fires exactly once.
    // NOTE: leaves ownedTaskByKey intact — the owned dev server survives a
    // window close (turn end) for reuse; only closeSession stops it.
    const preview = this.byKey.get(key);
    preview?.close();
    if (this.byKey.get(key) === preview) this.fanoutSelect(key, { type: 'mcp:closed' });
    this.byKey.delete(key);
    this.inspectListeners.delete(key);
  }

  private matchingKeys(prefix: string): string[] {
    const all = new Set([...this.byKey.keys(), ...this.ownedTaskByKey.keys(), ...[...this.pending].map(item => item.key)]);
    return Array.from(all).filter((key) => key === prefix || key.startsWith(`${prefix}-`));
  }

  private async closeSessionPrefix(prefix: string): Promise<void> {
    if (this.matchingKeys(prefix).some(key => this.scopeOwners.has(key))) throw new Error('Cannot close an owned preview through a legacy prefix');
    await Promise.all(this.matchingKeys(prefix).map((key) => this.closeSession(key)));
  }

  /** Session evict: close the window AND stop the dev server we started for
   *  it (if any). The user's own runner is never owned, so it stays up. */
  async closeSession(key: string): Promise<void> {
    await this.closeOwnedKey(key, true);
  }

  private closeOwnedKey(key: string, stopServer: boolean): Promise<void> {
    const previous = this.closingKeys.get(key);
    // A session close arriving after a window close must still stop its server.
    if (previous) return previous.then(() => stopServer ? this.closeOwnedKey(key, true) : undefined);
    const closed = this.finishCloseKey(key, stopServer).finally(() => {
      if (this.closingKeys.get(key) === closed) this.closingKeys.delete(key);
    });
    this.closingKeys.set(key, closed);
    return closed;
  }

  private async finishCloseKey(key: string, stopServer: boolean): Promise<void> {
    this.closeKey(key);
    await this.drainKey(key);
    if (!stopServer) return;
    const taskId = this.ownedTaskByKey.get(key);
    const runner = this.ownedRunnerByKey.get(key) ?? this.runnerBridge;
    if (taskId && runner) {
      await runner.stop(taskId);
      if (this.ownedTaskByKey.get(key) === taskId) this.ownedTaskByKey.delete(key);
    }
    this.ownedRunnerByKey.delete(key);
    try {
      await session.fromPartition(partitionForKey(key)).clearStorageData();
    } catch {
      /* in-memory preview partition already gone */
    }
  }

  async closeAll(): Promise<void> {
    if (this.closing) return this.closing;
    const operations = [...this.pending];
    for (const operation of operations) operation.controller.abort();
    const closing = this.finishCloseAll([...operations.map(item => item.done), ...this.closingKeys.values()]);
    this.closing = closing;
    try { await closing; }
    finally { if (this.closing === closing) this.closing = null; }
  }

  private async drainKey(key: string): Promise<void> {
    await Promise.allSettled([...this.pending].filter(item => item.key === key).map(item => item.done));
  }

  private async finishCloseAll(operations: Promise<unknown>[]): Promise<void> {
    await Promise.allSettled(operations);
    const failures: unknown[] = [];
    for (const [key, pw] of [...this.byKey]) {
      try { pw.close(); this.byKey.delete(key); this.inspectListeners.delete(key); }
      catch (cause) { failures.push(cause); }
    }
    // Stop every preview-owned dev server before the runner worker pool goes
    // away. Awaiting this prevents a late stop request from racing app exit.
    const ownedTasks = [...this.ownedTaskByKey.entries()];
    {
      const results = await Promise.allSettled(ownedTasks.map(async ([key, taskId]) => {
        const runner = this.ownedRunnerByKey.get(key) ?? this.runnerBridge;
        if (!runner) throw new Error('Preview server has no cleanup owner');
        await runner.stop(taskId);
        if (this.ownedTaskByKey.get(key) === taskId) this.ownedTaskByKey.delete(key);
        this.ownedRunnerByKey.delete(key);
      }));
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, 'Preview cleanup is unconfirmed');
    this.scopeOwners.clear();
  }
}
