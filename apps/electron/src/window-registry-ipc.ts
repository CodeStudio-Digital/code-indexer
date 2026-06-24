/**
 * Window → project registry for the title-bar project switcher.
 *
 * Every app window hosts exactly one project (route lives in the renderer),
 * but the main process only knows the windows, not which project each shows.
 * The renderer reports its active project via `window:setProject` (emitted on
 * project change in ProjectView); the switcher then reads the open set to
 * render its "Open Projects" section and to FOCUS an already-open window
 * instead of navigating the current one.
 *
 * Mirrors window-controls-ipc.ts: resolve the sending window via
 * `BrowserWindow.fromWebContents`, never a captured reference, so the
 * "open in new window" feature stays correct with several windows alive.
 */

import { BrowserWindow, ipcMain } from 'electron';

/** windowId → projectId for every live app window that reported one. */
const windowProjects = new Map<number, number>();
/** Windows whose `closed` cleanup is already attached (avoid double-binding). */
const tracked = new WeakSet<BrowserWindow>();

export interface OpenProjectEntry {
  windowId: number;
  projectId: number;
  focused: boolean;
}

function listOpenProjects(): OpenProjectEntry[] {
  const focusedId = BrowserWindow.getFocusedWindow()?.id;
  const out: OpenProjectEntry[] = [];
  for (const [windowId, projectId] of windowProjects) {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) {
      windowProjects.delete(windowId);
      continue;
    }
    out.push({ windowId, projectId, focused: windowId === focusedId });
  }
  return out;
}

function broadcastOpenProjects(): void {
  const payload = listOpenProjects();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('window:open-projects-changed', payload);
  }
}

export function registerWindowRegistryIpc(): void {
  ipcMain.on('window:setProject', (event, projectId: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof projectId !== 'number' || !Number.isFinite(projectId)) return;
    const winId = win.id;
    const prev = windowProjects.get(winId);
    windowProjects.set(winId, projectId);
    if (!tracked.has(win)) {
      tracked.add(win);
      // Capture the id — `win.id` may be unreadable after the window is gone.
      win.once('closed', () => {
        windowProjects.delete(winId);
        broadcastOpenProjects();
      });
    }
    // Only broadcast on a real change to avoid churn from idempotent re-reports.
    if (prev !== projectId) broadcastOpenProjects();
  });

  ipcMain.handle('window:listOpenProjects', () => listOpenProjects());

  ipcMain.handle('window:focusProject', (_event, projectId: unknown) => {
    if (typeof projectId !== 'number') return { ok: false as const };
    for (const [windowId, pid] of windowProjects) {
      if (pid !== projectId) continue;
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return { ok: true as const, windowId };
      }
    }
    return { ok: false as const };
  });
}
