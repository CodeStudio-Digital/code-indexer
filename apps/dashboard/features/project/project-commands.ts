/**
 * Built-in commands for the Project view — registered on mount with
 * closures over the view's state, unregistered on cleanup. Default keys:
 * IntelliJ preset (the app default) + VS Code preset. Browser-reserved
 * combos (Ctrl+N/Ctrl+W/Ctrl+F4 alternatives) gate on isDesktop.
 */
import { registerCommands } from '../../keymap/commands.js';
import { isDesktop } from '../../keymap/dispatcher.js';
import { useSeStore } from '../search-everywhere/se-store.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { saveFile, saveAllDirty } from '../workspace/editor/save.js';
import { getActiveEditor } from '../workspace/editor/editor-models.js';

export interface ProjectCommandDeps {
  projectId: number;
  setTab: (tab: string) => void;
  toggleBottomTerminal: () => void;
  toggleChat: () => void;
}

export function registerProjectCommands(deps: ProjectCommandDeps): () => void {
  const se = () => useSeStore.getState();
  const activeFile = () => {
    const s = useWorkspaceStore.getState();
    return s.activeFilePath;
  };

  return registerCommands([
    // ─── Navigate ───────────────────────────────────────────────────
    {
      id: 'navigate.searchEverywhere',
      title: 'Search Everywhere',
      category: 'Navigate',
      defaultKeys: { intellij: 'Shift Shift', vscode: 'Ctrl+T' },
      run: () => se().toggle('all'),
    },
    {
      id: 'navigate.file',
      title: 'Go to File',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+Shift+N', vscode: 'Ctrl+P' },
      run: () => se().openWith('files'),
    },
    {
      id: 'navigate.symbol',
      title: 'Go to Symbol',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+N', vscode: 'Ctrl+Shift+O' },
      when: isDesktop, // Ctrl+N is unblockable in a browser tab
      run: () => se().openWith('symbols'),
    },
    {
      id: 'navigate.textSearch',
      title: 'Find in Files',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+Shift+F', vscode: 'Ctrl+Shift+F' },
      run: () => se().openWith('text'),
    },
    {
      id: 'navigate.commands',
      title: 'Find Action (Commands)',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+Shift+A', vscode: 'Ctrl+Shift+P' },
      run: () => se().openWith('commands'),
    },
    {
      id: 'navigate.recentFiles',
      title: 'Recent Files',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+E', vscode: 'Ctrl+E' },
      run: () => se().openWith('files'), // empty query = recents-first
    },
    {
      id: 'navigate.fileStructure',
      title: 'File Structure',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+F12', vscode: 'Ctrl+Shift+O' },
      run: () => se().setStructureOpen(true),
    },
    {
      id: 'navigate.line',
      title: 'Go to Line',
      category: 'Navigate',
      defaultKeys: { intellij: 'Ctrl+G', vscode: 'Ctrl+G' },
      allowInInputs: true, // editor focus is the common case
      run: () => {
        const editor = getActiveEditor();
        editor?.focus();
        void editor?.getAction('editor.action.gotoLine')?.run();
      },
    },
    // ─── File ───────────────────────────────────────────────────────
    {
      id: 'file.save',
      title: 'Save File',
      category: 'File',
      defaultKeys: { intellij: 'Ctrl+S', vscode: 'Ctrl+S' },
      allowInInputs: true,
      run: () => {
        const path = activeFile();
        if (path) void saveFile(deps.projectId, path);
      },
    },
    {
      id: 'file.saveAll',
      title: 'Save All',
      category: 'File',
      defaultKeys: { intellij: 'Ctrl+Shift+S', vscode: 'Ctrl+Shift+S' },
      allowInInputs: true,
      run: () => void saveAllDirty(deps.projectId),
    },
    {
      id: 'file.closeTab',
      title: 'Close Tab',
      category: 'File',
      defaultKeys: { intellij: 'Ctrl+F4', vscode: 'Ctrl+W' },
      when: isDesktop,
      run: () => {
        const path = activeFile();
        if (path) useWorkspaceStore.getState().closeFile(deps.projectId, path);
      },
    },
    // ─── View ───────────────────────────────────────────────────────
    {
      id: 'view.toggleTerminal',
      title: 'Toggle Terminal',
      category: 'View',
      defaultKeys: { intellij: 'Alt+F12', vscode: 'Ctrl+J' },
      run: deps.toggleBottomTerminal,
    },
    {
      id: 'view.toggleProjectTree',
      title: 'Toggle Project Files',
      category: 'View',
      defaultKeys: { intellij: 'Alt+1', vscode: 'Ctrl+B' },
      run: () => deps.setTab('files'),
    },
    {
      id: 'view.toggleChat',
      title: 'Toggle Agent Chat',
      category: 'View',
      defaultKeys: { intellij: 'Alt+2', vscode: 'Ctrl+Alt+B' },
      run: deps.toggleChat,
    },
    {
      id: 'view.keymapSettings',
      title: 'Keymap Settings',
      category: 'View',
      defaultKeys: { intellij: 'Ctrl+Alt+S', vscode: 'Ctrl+K Ctrl+S' },
      run: () => se().setKeymapOpen(true),
    },
    // Editor split — no default keys (bindable in Keymap settings); the tab-bar
    // split button + tab context menu are the primary affordances.
    {
      id: 'view.splitEditorRight',
      title: 'Split Editor Right',
      category: 'View',
      run: () => useWorkspaceStore.getState().splitEditor('row'),
    },
    {
      id: 'view.splitEditorDown',
      title: 'Split Editor Down',
      category: 'View',
      run: () => useWorkspaceStore.getState().splitEditor('column'),
    },
    {
      id: 'view.unsplitEditor',
      title: 'Unsplit Editor',
      category: 'View',
      run: () => useWorkspaceStore.getState().unsplit(),
    },
  ]);
}
