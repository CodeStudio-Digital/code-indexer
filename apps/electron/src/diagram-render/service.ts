import { BrowserWindow, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { drawioVendorDir } from '@mcp/shared/assets/drawio-vendor.js';
import { decodeDiagramImage, type DiagramRenderer, type DiagramRenderRequest } from '@mcp/code-agent/tools/diagram/render-port.js';
import { DIAGRAM_RENDER_DOCUMENT } from './document.js';

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.json': 'application/json', '.xml': 'application/xml' };

/** A bounded, disposable, offline renderer. No preload, profile cookies,
 * project filesystem access, network or application API route is installed. */
export class DiagramRenderService implements DiagramRenderer {
  private scope?: Session;
  private readonly windows = new Set<BrowserWindow>();
  private closed = false;

  private rendererSession(): Session {
    if (this.scope) return this.scope;
    const root = drawioVendorDir();
    if (!root) throw new Error('The bundled diagram editor is unavailable');
    const scoped = session.fromPartition(`diagram-render-${randomUUID()}`, { cache: false });
    scoped.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    scoped.setPermissionCheckHandler(() => false);
    scoped.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !((url.protocol === 'mcp:' && url.hostname === 'diagram-render') || url.protocol === 'data:' || url.protocol === 'blob:') });
    });
    scoped.on('will-download', event => event.preventDefault());
    scoped.protocol.handle('mcp', async request => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.hostname !== 'diagram-render') return new Response('', { status: 403 });
      if (url.pathname === '/host') return new Response(DIAGRAM_RENDER_DOCUMENT, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (!url.pathname.startsWith('/drawio/')) return new Response('', { status: 403 });
      try {
        const abs = resolve(root, decodeURIComponent(url.pathname.slice(8))), rel = relative(root, abs);
        if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) return new Response('', { status: 403 });
        const meta = await stat(abs);
        if (!meta.isFile()) return new Response('', { status: 404 });
        return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers: { 'Content-Type': TYPES[extname(abs)] ?? 'application/octet-stream' } });
      } catch { return new Response('', { status: 404 }); }
    });
    this.scope = scoped; return scoped;
  }

  async render(request: DiagramRenderRequest, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.closed || this.windows.size >= 2) throw new Error('Diagram renderer is closed or busy');
    if (!['png', 'svg'].includes(request.format) || typeof request.xml !== 'string' || Buffer.byteLength(request.xml) > 4 * 1024 * 1024) throw new Error('Invalid diagram render input');
    const win = new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: {
      session: this.rendererSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    } });
    this.windows.add(win);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    void stopped.catch(() => undefined);
    const stop = () => { if (!win.isDestroyed()) win.destroy(); rejectStop(new Error('Diagram rendering cancelled, closed or timed out')); };
    const timer = setTimeout(stop, 30000);
    win.once('closed', stop);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      signal?.throwIfAborted();
      const render = (async () => {
        await win.loadURL('mcp://diagram-render/host');
        signal?.throwIfAborted();
        return await win.webContents.executeJavaScript(`window.__diagramRender(${JSON.stringify(request.xml)},${JSON.stringify(request.format)})`) as string;
      })();
      const result = await Promise.race([render, stopped]);
      signal?.throwIfAborted(); decodeDiagramImage(result, request.format);
      return result;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', stop); win.removeListener('closed', stop);
      if (!win.isDestroyed()) win.destroy();
      this.windows.delete(win);
    }
  }

  close(): void {
    this.closed = true;
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy();
  }
}
