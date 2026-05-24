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
      <div className="h-8 shrink-0 border-b flex items-center px-3 gap-2 bg-card/20">
        <FileCode2 className="h-3 w-3 text-muted-foreground/60" />
        <span className="text-[11px] text-muted-foreground">No file open</span>
      </div>
    );
  }

  return (
    <div className="h-8 shrink-0 border-b flex items-stretch bg-card/20 overflow-x-auto">
      {openFiles.map((file) => {
        const active = file.path === activeFilePath;
        const display = file.path.split('/').pop() ?? file.path;
        return (
          <div
            key={file.path}
            className={cn(
              'group relative flex items-center gap-1.5 pl-3 pr-1.5 border-r min-w-0 max-w-[200px] cursor-pointer',
              'transition-colors',
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
            onClick={() => setActive(file.path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeFile(file.path);
              }
            }}
            title={file.path}
          >
            {/* Active accent bar */}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-px bg-primary"
              />
            )}
            <FileCode2 className={cn('h-3 w-3 shrink-0', active ? 'text-primary' : 'text-muted-foreground/70')} />
            <span className="text-[11.5px] truncate font-medium">{display}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(file.path);
              }}
              className={cn(
                'shrink-0 h-4 w-4 rounded-sm grid place-items-center hover:bg-muted transition-colors',
                file.dirty ? 'text-foreground' : 'text-muted-foreground/70',
              )}
              aria-label={`Close ${display}`}
            >
              {file.dirty ? (
                <>
                  <Circle className="h-2 w-2 fill-current group-hover:hidden" />
                  <X className="h-3 w-3 hidden group-hover:block" />
                </>
              ) : (
                <X className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
