/**
 * Editor pane — placeholder in Day 6. Day 7 swaps the body for the
 * Monaco mount + tab bar wired to the workspace store.
 *
 * Even as a placeholder this surface shows the active file's path so
 * the file-tree click→state→render loop is observable end-to-end before
 * Monaco lands.
 */

import { FileCode2 } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace.js';

export function EditorPane() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;

  return (
    <div className="h-full flex flex-col bg-background min-h-0">
      <div className="h-9 shrink-0 border-b flex items-center px-3 gap-2">
        <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground truncate">
          {activeFile ? activeFile.path : 'No file open'}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {activeFile ? (
          <pre className="text-xs p-4 font-mono whitespace-pre">{activeFile.content || '(empty)'}</pre>
        ) : (
          <div className="h-full grid place-items-center text-xs text-muted-foreground">
            Open a file from the tree on the left.
          </div>
        )}
      </div>
    </div>
  );
}
