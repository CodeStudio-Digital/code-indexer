/**
 * Main-process implementation of the agent preview/devtools backend. Opens a
 * dedicated, SANDBOXED BrowserWindow per agent key (no preload → the dev page
 * never gets `electronAPI`), attaches CDP, and dispatches the `preview_*`
 * tool calls. Registered via `setGlobalPreviewDevtools` in main.ts.
 */
import { BrowserWindow, screen } from 'electron';
import type { IPreviewDevtools, PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { PreviewWindow, DEFAULT_VIEWPORT, type Viewport } from './cdp.js';
import { dispatchInteraction } from './interact.js';
import { resolveViewport } from './viewport.js';

export class PreviewWindowService implements IPreviewDevtools {
  private byKey = new Map<string, PreviewWindow>();

  async invoke(req: PreviewInvoke): Promise<unknown> {
    const { key, method } = req;
    const args = req.args ?? {};
    if (method === 'open') return this.open(key, String(args.url ?? ''), args);

    if (method === 'close') {
      this.closeKey(key);
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
        const v = await pw.setViewport(resolveViewport(args, pw.viewport));
        this.fitWindow(pw, v);
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
        const r = (await pw.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: !!args.fullPage,
        })) as { data?: string };
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
    url: string,
    args: Record<string, unknown> = {},
  ): Promise<{ windowId: number; url: string; viewport: Viewport }> {
    const initial = resolveViewport(args, DEFAULT_VIEWPORT);
    const existing = this.byKey.get(key);
    if (existing && !existing.win.isDestroyed()) {
      existing.clearBuffers();
      await existing.win.loadURL(url);
      existing.url = url;
      const v = await existing.setViewport(initial);
      this.fitWindow(existing, v);
      return { windowId: existing.id, url, viewport: v };
    }
    const { width, height } = this.clampToScreen(initial.width, initial.height);
    const win = new BrowserWindow({
      width,
      height,
      title: `Preview · ${key}`,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.on('closed', () => {
      if (this.byKey.get(key)?.id === win.id) this.byKey.delete(key);
    });
    const pw = new PreviewWindow(win, url);
    this.byKey.set(key, pw);
    await win.loadURL(url);
    const v = await pw.setViewport(initial);
    return { windowId: pw.id, url, viewport: v };
  }

  /** Clamp a desired content size to the primary display work area. */
  private clampToScreen(w: number, h: number): { width: number; height: number } {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    return { width: Math.min(Math.max(320, w), wa.width), height: Math.min(Math.max(320, h), wa.height) };
  }

  /** Resize the OS window content to match the viewport when it fits the
   *  screen; larger viewports stay clamped (device-metrics keeps them exact). */
  private fitWindow(pw: PreviewWindow, v: Viewport): void {
    if (pw.win.isDestroyed()) return;
    const { width, height } = this.clampToScreen(v.width, v.height);
    try { pw.win.setContentSize(width, height); } catch { /* best-effort */ }
  }

  closeKey(key: string): void {
    this.byKey.get(key)?.close();
    this.byKey.delete(key);
  }
  closeAll(): void {
    for (const pw of this.byKey.values()) pw.close();
    this.byKey.clear();
  }
}
