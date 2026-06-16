/**
 * Main-process implementation of the agent preview/devtools backend. Opens a
 * dedicated, SANDBOXED BrowserWindow per agent key (no preload → the dev page
 * never gets `electronAPI`), attaches CDP, and dispatches the `preview_*`
 * tool calls. Registered via `setGlobalPreviewDevtools` in main.ts.
 */
import { BrowserWindow } from 'electron';
import type { IPreviewDevtools, PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { UNIVERSAL_INSPECTOR_SOURCE } from '@mcp/services/sandbox/builder/inspector/universal-inspector-source.js';
import { UNIVERSAL_TOOLBAR_SOURCE } from '@mcp/services/sandbox/builder/inspector/universal-toolbar-source.js';
import { REGION_HELPERS_SOURCE } from '@mcp/services/sandbox/builder/inspector/region-runtime.js';
import { PreviewWindow, DEFAULT_VIEWPORT, type Viewport } from './cdp.js';
import { dispatchInteraction } from './interact.js';
import { resolveViewport, applyViewport, clampToScreen, VIEWPORT_PRESETS } from './viewport.js';
import { resolveAppIconPath } from '../app-icon.js';
import { resolveDevUrl, type RunnerBridge } from './dev-server-resolver.js';

export class PreviewWindowService implements IPreviewDevtools {
  private byKey = new Map<string, PreviewWindow>();
  /** Per-key selection subscribers (dashboard "Inspect"). Decoupled from the
   *  window lifecycle so a stream can subscribe before the window opens. */
  private inspectListeners = new Map<string, Set<(d: unknown) => void>>();
  /** Windows whose CDP selection events are already forwarded to the map. */
  private inspectForwarded = new WeakSet<PreviewWindow>();
  /** Dev servers THIS service started for a preview (key → runner taskId).
   *  Kept SEPARATE from byKey so closing the window (turn end) doesn't drop
   *  ownership — the owned server is stopped only on closeSession (evict). */
  private ownedTaskByKey = new Map<string, string>();

  /** Injected in main.ts (null in tests / non-runner contexts). Enables
   *  url-less preview_open: reuse the project's running runner or start one. */
  constructor(private runnerBridge: RunnerBridge | null = null) {}

  setRunnerBridge(bridge: RunnerBridge | null): void {
    this.runnerBridge = bridge;
  }

  async invoke(req: PreviewInvoke): Promise<unknown> {
    const { key, method } = req;
    const args = req.args ?? {};
    if (method === 'open') return this.open(key, args);
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

    if (method === 'close') {
      this.closeKey(key);
      return { ok: true };
    }
    // Backend lifecycle (not agent-facing): closeWindow frees the window but
    // keeps the owned dev server for reuse; closeSession also stops it.
    if (method === 'closeWindow') {
      this.closeKey(key);
      return { ok: true };
    }
    if (method === 'closeSession') {
      await this.closeSession(key);
      return { ok: true };
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
      return dispatchInteraction(pw, method, args);
    }

    switch (method) {
      case 'viewport': {
        const v = applyViewport(pw, resolveViewport(args, pw.viewport));
        return { ok: true, viewport: v };
      }
      case 'navigate':
        pw.clearBuffers();
        await pw.win.loadURL(String(args.url ?? ''));
        pw.url = String(args.url ?? '');
        return { ok: true, url: pw.url };
      case 'console':
        if (args.waitMs) await pw.waitFor('console', () => true, Number(args.waitMs));
        return { logs: pw.getConsole(args.level as string | undefined).slice(-50) };
      case 'network': {
        if (args.waitForMs) {
          await pw.waitFor('network', (e) => {
            const n = e as { url: string; status?: number; failed?: boolean };
            return (!args.urlFilter || n.url.includes(String(args.urlFilter))) && (n.status != null || !!n.failed);
          }, Number(args.waitForMs));
        }
        const requests = pw.getNetwork({ urlFilter: args.urlFilter as string, status: args.status as number }).slice(-60);
        if (args.includeBody) {
          // Best-effort: response bodies are only retained by CDP for a window
          // and only for finished responses — try each, attach truncated body.
          await Promise.all(
            requests.map(async (r) => {
              try {
                const b = (await pw.send('Network.getResponseBody', { requestId: r.requestId })) as { body?: string; base64Encoded?: boolean };
                if (b?.body) r.body = b.base64Encoded ? '[binary body omitted]' : b.body.slice(0, 2000);
              } catch { /* body unavailable (failed/evicted/no-content) */ }
            }),
          );
        }
        return { requests };
      }
      case 'eval': {
        const r = (await pw.send('Runtime.evaluate', {
          expression: String(args.js ?? ''),
          returnByValue: true,
          awaitPromise: true,
          replMode: true,
        })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
        if (r.exceptionDetails) return { error: JSON.stringify(r.exceptionDetails).slice(0, 600) };
        return { value: r.result?.value ?? r.result?.description ?? null };
      }
      case 'screenshot': {
        // Optional `clip` ({x,y,width,height}) crops to a region — used by the
        // dashboard's region-select to capture exactly the drawn box.
        const clip = (args.clip as { x: number; y: number; width: number; height: number } | undefined) ?? null;
        const params: Record<string, unknown> = {
          format: 'png',
          captureBeyondViewport: !!args.fullPage,
        };
        if (clip && clip.width > 0 && clip.height > 0) {
          params.clip = {
            x: Math.round(clip.x),
            y: Math.round(clip.y),
            width: Math.round(clip.width),
            height: Math.round(clip.height),
            scale: 1,
          };
        }
        const r = (await pw.send('Page.captureScreenshot', params)) as { data?: string };
        return { base64: r.data };
      }
      case 'inspect_css': {
        const doc = (await pw.send('DOM.getDocument', {})) as { root?: { nodeId?: number } };
        const q = (await pw.send('DOM.querySelector', { nodeId: doc.root?.nodeId, selector: String(args.selector ?? '') })) as { nodeId?: number };
        if (!q.nodeId) return { error: 'no element matched the selector' };
        const computed = await pw.send('CSS.getComputedStyleForNode', { nodeId: q.nodeId }).catch(() => null);
        const matched = await pw.send('CSS.getMatchedStylesForNode', { nodeId: q.nodeId }).catch(() => null);
        return { computed, matched };
      }
      case 'performance':
        return pw.send('Performance.getMetrics', {});
      case 'memory': {
        const r = (await pw.send('Runtime.evaluate', {
          expression: 'JSON.stringify((performance).memory||{})',
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        return { memory: r.result?.value };
      }
      case 'storage': {
        const kind = String(args.kind ?? 'local');
        if (kind === 'cookies') {
          // Network.getCookies includes httpOnly cookies that document.cookie
          // can't see; fall back to document.cookie if the domain has none.
          try {
            const c = (await pw.send('Network.getCookies', {})) as { cookies?: unknown[] };
            return { kind, data: c.cookies ?? [] };
          } catch { /* fall through to document.cookie */ }
        }
        const expr =
          kind === 'cookies' ? 'document.cookie'
          : kind === 'session' ? 'JSON.stringify(Object.assign({},sessionStorage))'
          : kind === 'indexeddb' ? '(async()=>((indexedDB.databases?await indexedDB.databases():[]).map(d=>d.name)))()'
          : 'JSON.stringify(Object.assign({},localStorage))';
        const r = (await pw.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown } };
        return { kind, data: r.result?.value };
      }
      default:
        throw new Error(`unknown preview method: ${method}`);
    }
  }

  private async open(
    key: string,
    args: Record<string, unknown> = {},
  ): Promise<{ windowId: number; url: string; viewport: Viewport; reused: boolean }> {
    const initial = resolveViewport(args, DEFAULT_VIEWPORT);
    // Resolve the URL: explicit `url` wins; otherwise reuse/start the
    // project's dev server via the runner (and remember ownership so we
    // can stop exactly what we started, never the user's runner).
    let url = String(args.url ?? '').trim();
    let reused = true;
    if (!url) {
      const projectId = typeof args.projectId === 'number' ? args.projectId : null;
      if (projectId == null || !this.runnerBridge) {
        throw new Error(
          'preview_open needs a `url` (no project dev-server resolver available here). ' +
            'Pass url=http://localhost:PORT.',
        );
      }
      const resolved = await resolveDevUrl(this.runnerBridge, projectId);
      url = resolved.url;
      reused = !resolved.ownedTaskId;
      if (resolved.ownedTaskId) this.ownedTaskByKey.set(key, resolved.ownedTaskId);
    }
    const existing = this.byKey.get(key);
    if (existing && !existing.win.isDestroyed()) {
      existing.clearBuffers();
      await existing.win.loadURL(url);
      existing.url = url;
      const v = applyViewport(existing, initial);
      return { windowId: existing.id, url, viewport: v, reused };
    }
    const { width, height } = clampToScreen(initial.width, initial.height);
    const appIconPath = resolveAppIconPath();
    const win = new BrowserWindow({
      width,
      height,
      title: `Preview · ${key}`,
      ...(appIconPath ? { icon: appIconPath } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.on('closed', () => {
      if (this.byKey.get(key)?.id === win.id) {
        // Tell the dashboard the window is gone (native X or toolbar close) so
        // it can un-pause the inline iframe. Harmless for agent keys (no listeners).
        this.fanoutSelect(key, { type: 'mcp:closed' });
        this.byKey.delete(key);
        this.inspectListeners.delete(key);
      }
    });
    const pw = new PreviewWindow(win, url);
    this.byKey.set(key, pw);
    await win.loadURL(url);
    pw.viewport = initial;
    return { windowId: pw.id, url, viewport: initial, reused };
  }

  // ── Dashboard-driven "Inspect" (universal element selection) ──────────
  // Reuses the agent CDP window machinery: open the app, inject the
  // framework-agnostic inspector, and stream selections back to the dashboard.

  /** Subscribe to selections for a key. Safe to call before `openInspect`. */
  onInspectSelect(key: string, cb: (d: unknown) => void): () => void {
    let set = this.inspectListeners.get(key);
    if (!set) this.inspectListeners.set(key, (set = new Set()));
    set.add(cb);
    return () => { this.inspectListeners.get(key)?.delete(cb); };
  }

  private fanoutSelect(key: string, d: unknown): void {
    const set = this.inspectListeners.get(key);
    if (set) for (const cb of Array.from(set)) { try { cb(d); } catch { /* listener threw */ } }
  }

  /**
   * Open (or reuse) the window at `url` and inject the inspector + control bar.
   * `arm` starts in selection mode; otherwise it opens in navigate mode (the
   * bar's Inspect toggle / dashboard can arm later). Used by both the dashboard
   * "Inspect" (arm) and "Open in new window" (navigate) entry points.
   */
  async openInspect(key: string, url: string, opts: { arm?: boolean } = {}): Promise<{ windowId: number; url: string }> {
    const res = await this.open(key, { url });
    const pw = this.byKey.get(key);
    if (pw) {
      if (!this.inspectForwarded.has(pw)) {
        pw.onSelect((d) => this.fanoutSelect(key, d));
        pw.onControl((action) => this.handleControl(key, action));
        this.inspectForwarded.add(pw);
      }
      // region helpers FIRST (the inspector's marquee handlers call them), then
      // the inspector, then the floating control bar.
      await pw.armInspect(`${REGION_HELPERS_SOURCE}\n${UNIVERSAL_INSPECTOR_SOURCE}\n${UNIVERSAL_TOOLBAR_SOURCE}`);
      await pw.send('Runtime.evaluate', {
        expression: opts.arm ? 'window.__mcpArm && window.__mcpArm()' : 'window.__mcpDisarm && window.__mcpDisarm()',
      }).catch(() => undefined);
    }
    return { windowId: res.windowId, url: res.url };
  }

  async disarmInspect(key: string): Promise<void> {
    const pw = this.byKey.get(key);
    if (pw && !pw.win.isDestroyed()) await pw.disarmInspect();
  }

  /** Bring the inspect window to the front (dashboard "Focus"). */
  focusInspect(key: string): void {
    const pw = this.byKey.get(key);
    if (pw && !pw.win.isDestroyed()) { try { pw.win.focus(); } catch { /* gone */ } }
  }

  /** Control-bar actions from the injected toolbar (`viewport:<preset>`, `close`). */
  private handleControl(key: string, action: string): void {
    if (action === 'close') { this.closeKey(key); return; }
    if (action.startsWith('viewport:')) {
      const vp = VIEWPORT_PRESETS[action.slice('viewport:'.length)];
      const pw = this.byKey.get(key);
      if (pw && vp) applyViewport(pw, vp);
    }
  }

  closeKey(key: string): void {
    // Notify the dashboard BEFORE teardown; delete synchronously so a quick
    // re-open never reuses a closing window. The window 'closed' handler then
    // no-ops (byKey already cleared), so the sentinel fires exactly once.
    // NOTE: leaves ownedTaskByKey intact — the owned dev server survives a
    // window close (turn end) for reuse; only closeSession stops it.
    this.fanoutSelect(key, { type: 'mcp:closed' });
    this.byKey.get(key)?.close();
    this.byKey.delete(key);
    this.inspectListeners.delete(key);
  }

  /** Session evict: close the window AND stop the dev server we started for
   *  it (if any). The user's own runner is never owned, so it stays up. */
  async closeSession(key: string): Promise<void> {
    this.closeKey(key);
    const taskId = this.ownedTaskByKey.get(key);
    if (taskId && this.runnerBridge) {
      this.ownedTaskByKey.delete(key);
      try {
        await this.runnerBridge.stop(taskId);
      } catch {
        /* runner already gone — best-effort */
      }
    }
  }

  closeAll(): void {
    for (const pw of this.byKey.values()) pw.close();
    this.byKey.clear();
    this.inspectListeners.clear();
    // Stop every preview-owned dev server (app quit). Fire-and-forget.
    if (this.runnerBridge) {
      for (const taskId of this.ownedTaskByKey.values()) {
        void this.runnerBridge.stop(taskId).catch(() => undefined);
      }
    }
    this.ownedTaskByKey.clear();
  }
}
