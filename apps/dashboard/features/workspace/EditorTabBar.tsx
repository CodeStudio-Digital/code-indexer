/**
 * Tab bar above the Monaco editor — one chip per open file, with a
 * dirty indicator and a close button. Behavior mirrors VS Code's
 * defaults closely (click activates, middle-click closes, dirty files
 * use a dot instead of the X until you hover).
 *
 * Kept as a separate file because the tab list is the heaviest piece
 * of editor-adjacent UI in terms of variants (active/dirty/hovered/
 * unsaved-on-close-confirm) and likely to grow.
 */

import { X, Circle, FileCode2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useWorkspaceStore } from '../../state/workspace.js';

export function EditorTabBar() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const closeFile = useWorkspaceStore((s) => s.closeFile);

  if (openFiles.length === 0) {
    return (
      <div className="h-9 shrink-0 border-b flex items-center px-3 gap-2 bg-card/40">
        <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">No file open</span>
      </div>
    );
  }

  return (
    <div className="h-9 shrink-0 border-b flex items-stretch bg-card/40 overflow-x-auto">
      {openFiles.map((file) => {
        const active = file.path === activeFilePath;
        const display = file.path.split('/').pop() ?? file.path;
        return (
          <div
            key={file.path}
            className={cn(
              'group flex items-center gap-2 px-3 border-r min-w-0 max-w-[200px] cursor-pointer',
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
            onClick={() => setActive(file.path)}
            // Middle-click closes — common editor affordance.
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeFile(file.path);
              }
            }}
            title={file.path}
          >
            <FileCode2 className="h-3 w-3 shrink-0" />
            <span className="text-xs truncate">{display}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(file.path);
              }}
              className={cn(
                'shrink-0 h-4 w-4 rounded grid place-items-center hover:bg-muted',
                // Dirty files: show a filled circle, swap to X on hover so
                // the close action is still discoverable without losing the
                // unsaved hint at a glance.
                file.dirty ? 'text-foreground' : 'text-muted-foreground',
              )}
              aria-label={`Close ${display}`}
            >
              {file.dirty ? (
                <>
                  <Circle className="h-2 w-2 fill-current group-hover:hidden" />
                  <X className="h-3 w-3 hidden group-hover:block" />
                </>
              ) : (
                <X className="h-3 w-3" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
