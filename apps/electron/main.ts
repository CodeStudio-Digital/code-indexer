/**
 * Electron main process. Owns the backend (imported in-process — no
 * child_process, no HTTP loopback) and the BrowserWindow that hosts
 * the React dashboard.
 *
 * Flow on startup:
 *   1. `createApp()` instantiates the full deps graph (SQLite, providers,
 *      stores). Same `createDeps` the Hono server uses — we just skip
 *      `serve()`. The Hono `app` is unused unless MCP_DEV_HTTP=1 (debug).
 *   2. `mountIpcHandlers()` wires every handler in @mcp/api-handlers to
 *      `ipcMain.handle('api:<namespace>:<method>', …)`. Streaming methods
 *      register on a separate channel that returns a MessagePort.
 *   3. The window loads either the Vite dev URL (npm run electron:dev)
 *      or the built dashboard files (production via electron-builder).
 *
 * The renderer reaches the backend via `window.electronAPI.api.*`
 * (defined in preload.ts via contextBridge). There is no port open on
 * loopback — every call is in-process IPC.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '@apps/http-api/server.js';
import { mountIpcHandlers } from './src/handlers-mount.js';
import { startOptionalDevHttp } from './src/dev-http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_URL = process.env.MCP_ELECTRON_DEV_URL;
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

async function bootstrap() {
  // Boot the backend in-process. The Hono app is built but not served
  // unless MCP_DEV_HTTP=1 — that flag exists so an operator can curl
  // the same backend from outside the Electron window for debugging.
  const { app: honoApp, deps } = createApp();
  await startOptionalDevHttp(honoApp);

  await app.whenReady();

  mountIpcHandlers(deps);
  registerNativeIpc();

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'MCP IDE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (DEV_URL) {
    await window.loadURL(DEV_URL);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Production: dashboard build is bundled into the asar at dist/dashboard.
    await window.loadFile(path.join(__dirname, '../../dashboard/index.html'));
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * IPC handlers backed by Electron's native APIs (dialog, shell,
 * Notification). Counterparts to api-handlers but for things that only
 * make sense inside the desktop shell.
 */
function registerNativeIpc() {
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.on('shell:openExternal', (_event, url: string) => {
    // Safety: only http/https. The api-bus billing flow only ever passes
    // Stripe URLs but the renderer is the source of strings here — guard
    // against `javascript:` / `file:` payloads regardless of intent.
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.on('app:notify', (_event, opts: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      new Notification({ title: opts.title, body: opts.body }).show();
    }
  });
}

void bootstrap().catch((err) => {
  console.error('[electron] bootstrap failed:', err);
  process.exitCode = 1;
});
