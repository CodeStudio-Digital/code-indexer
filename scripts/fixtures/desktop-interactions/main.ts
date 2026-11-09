import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installGlobalHardening, applyProductionHardening } from '../../../apps/electron/src/security-hardening.js';
import { installRendererPermissions } from '../../../apps/electron/src/renderer-permissions.js';
import { installWindowNavigation } from '../../../apps/electron/src/window-navigation.js';
import { installEditContextMenu } from '../../../apps/electron/src/edit-menu.js';

app.setPath('userData', join(__dirname, 'profile'));
Object.defineProperty(app, 'isPackaged', { value: true });
void app.whenReady().then(async () => {
  const previous = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  app.once('will-quit', () => clipboard.write(previous));
  const appUrl = pathToFileURL(join(__dirname, 'web/index.html')).href;
  const state = { external: [] as string[], documents: [] as string[], routes: [] as string[] };
  Object.assign(globalThis, { interactionSmoke: state });
  installGlobalHardening(appUrl);
  installRendererPermissions(session.defaultSession, appUrl);
  ipcMain.on('shell:openExternal', (_event, url) => state.external.push(url));
  const win = new BrowserWindow({ width: 1100, height: 840, autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  installWindowNavigation(win.webContents, { appUrl, openExternal: url => state.external.push(url),
    openDocument: url => state.documents.push(url), openAppRoute: route => state.routes.push(route) });
  installEditContextMenu(win);
  applyProductionHardening(win);
  await win.loadURL(appUrl);
  win.focus();
});
