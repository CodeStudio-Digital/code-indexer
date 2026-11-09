import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

/** Keep native editing accelerators even when production hides the menu bar. */
export function installEditMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
}

export function installEditContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push({ role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut });
    }
    if (params.isEditable || params.selectionText) items.push({ role: 'copy', enabled: params.editFlags.canCopy });
    if (params.isEditable) items.push({ role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' }, { role: 'selectAll' });
    if (!items.length) return;
    event.preventDefault();
    Menu.buildFromTemplate(items).popup({ window: win, frame: params.frame ?? undefined });
  });
}
