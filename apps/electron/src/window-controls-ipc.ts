/**
 * Window-control IPC for the custom (frameless) title bar.
 *
 * The main window runs with `titleBarStyle: 'hidden'` (see `createAppWindow`
 * in main.ts), so the dashboard renders its own minimize/maximize/close
 * buttons in the top `<header>`. Those buttons call the channels registered
 * here via `window.electronAPI.windowControls.*` (see preload.ts).
 *
 * Every handler resolves the *sending* window with
 * `BrowserWindow.fromWebContents(event.sender)` rather than a captured
 * reference — the "open in new window" feature (window:open) means there can
 * be several windows alive, and each must control only itself.
 */

import { app, BrowserWindow, ipcMain } from 'electron';

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function registerWindowControlsIpc(): void {
  ipcMain.on('window:minimize', (event) => {
    senderWindow(event)?.minimize();
  });

  ipcMain.on('window:toggleMaximize', (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window:close', (event) => {
    senderWindow(event)?.close();
  });

  // Quit the whole app (logo menu → "Sair"), distinct from closing one window.
  ipcMain.on('app:quit', () => {
    app.quit();
  });

  ipcMain.handle('window:isMaximized', (event) => {
    return senderWindow(event)?.isMaximized() ?? false;
  });
}
