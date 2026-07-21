import type { BrowserWindow, Input } from 'electron';

export const TASK_MANAGER_ROUTE = '/admin?section=perf';

/** Chrome-compatible, app-scoped shortcut for the process metrics panel. */
export function isTaskManagerShortcut(input: Pick<
  Input,
  'type' | 'key' | 'code' | 'shift' | 'control' | 'meta' | 'alt'
>): boolean {
  if (input.type !== 'keyDown') return false;
  const key = (input.key || input.code || '').toLowerCase();
  return (key === 'escape' || key === 'esc')
    && input.shift
    && !input.control
    && !input.meta
    && !input.alt;
}

/**
 * Registers Shift+Esc on one application window. Using `before-input-event`
 * keeps the shortcut scoped to CodeStudio instead of reserving it globally in
 * the operating system. The listener is released with the window's
 * WebContents, so no global unregister step is needed during shutdown.
 */
export function registerTaskManagerShortcut(
  win: BrowserWindow,
  openTaskManager: () => void | Promise<void>,
): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (!isTaskManagerShortcut(input)) return;
    event.preventDefault();
    void Promise.resolve(openTaskManager()).catch((error) => {
      console.error('[electron] failed to open task manager:', error);
    });
  });
}
