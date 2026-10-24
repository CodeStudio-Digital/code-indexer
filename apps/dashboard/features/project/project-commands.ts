/**
 * Built-in commands for the Project view — registered on mount with
 * closures over the view's state, unregistered on cleanup. Default keys:
 * IntelliJ preset (the app default) + VS Code preset. Browser-reserved
 * combos (Ctrl+N/Ctrl+W/Ctrl+F4 alternatives) gate on isDesktop.
 */
import { registerCommandHandlers } from '../../keymap/commands.js';
import { isDesktop } from '../../keymap/dispatcher.js';
import { useSeStore } from '../search-everywhere/se-store.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { saveFile, saveAllDirty } from '../workspace/editor/save.js';
import { getActiveEditor } from '../workspace/editor/editor-models.js';

interface ProjectCommandDeps {
  projectId: number;
  toggleBottomTerminal: () => void;
  toggleProjectFiles: () => void;
  toggleChat: () => void;
}

export function registerProjectCommands(deps: ProjectCommandDeps): () => void {
  const se = () => useSeStore.getState();
  const activeFile = () => {
    const s = useWorkspaceStore.getState();
    return s.activeFilePath;
  };

  return registerCommandHandlers([
    // ─── Navigate ───────────────────────────────────────────────────
    {
      id: 'navigate.searchEverywhere',
      run: () => se().toggle('all'),
    },
    {
      id: 'navigate.file',
      run: () => se().openWith('files'),
    },
    {
      id: 'navigate.symbol',
      when: isDesktop, // Ctrl+N is unblockable in a browser tab
      run: () => se().openWith('symbols'),
    },
    {
      id: 'navigate.textSearch',
      run: () => se().openWith('text'),
    },
    {
      id: 'navigate.commands',
      run: () => se().openWith('commands'),
    },
    {
      id: 'navigate.recentFiles',
      run: () => se().openWith('files'), // empty query = recents-first
    },
    {
      id: 'navigate.fileStructure',
      run: () => se().setStructureOpen(true),
    },
    {
      id: 'navigate.line',
      run: () => {
        const editor = getActiveEditor();
        editor?.focus();
        void editor?.getAction('editor.action.gotoLine')?.run();
      },
    },
    // ─── File ───────────────────────────────────────────────────────
    {
      id: 'file.save',
      run: () => {
        const path = activeFile();
        if (path) void saveFile(deps.projectId, path);
      },
    },
    {
      id: 'file.saveAll',
      run: () => void saveAllDirty(deps.projectId),
    },
    {
      id: 'file.closeTab',
      when: isDesktop,
      run: () => {
        const path = activeFile();
        if (path) useWorkspaceStore.getState().closeFile(deps.projectId, path);
      },
    },
    // ─── View ───────────────────────────────────────────────────────
    {
      id: 'view.toggleTerminal',
      run: deps.toggleBottomTerminal,
    },
    {
      id: 'view.toggleProjectTree',
      run: deps.toggleProjectFiles,
    },
    {
      id: 'view.toggleChat',
      run: deps.toggleChat,
    },
    {
      id: 'view.keymapSettings',
      run: () => se().setKeymapOpen(true),
    },
    // Editor split — no default keys (bindable in Keymap settings); the tab-bar
    // split button + tab context menu are the primary affordances.
    {
      id: 'view.splitEditorRight',
      run: () => useWorkspaceStore.getState().splitEditor('row'),
    },
    {
      id: 'view.splitEditorDown',
      run: () => useWorkspaceStore.getState().splitEditor('column'),
    },
    {
      id: 'view.unsplitEditor',
      run: () => useWorkspaceStore.getState().unsplit(),
    },
  ]);
}
