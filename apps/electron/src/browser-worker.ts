import { app, BrowserWindow, session } from 'electron';

export async function runBrowserWorker(): Promise<void> {
  app.on('window-all-closed', () => {});
  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', event => event.preventDefault());

  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL('about:blank');
}
