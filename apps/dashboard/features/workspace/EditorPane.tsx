/**
 * Editor pane — Monaco mount + tab bar wired to the Zustand workspace
 * store. Monaco itself is lazy-loaded (Suspense fallback) so the ~5 MB
 * gzipped chunk only lands when the user actually opens a project.
 *
 * When no files are open, renders an empty state instead of mounting
 * Monaco — keeps the editor model count at zero until needed.
 */

import { Suspense, lazy } from 'react';
import { FileCode2, Loader2 } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace.js';
import { EditorTabBar } from './EditorTabBar.js';

const MonacoMount = lazy(() => import('./editor/MonacoMount.js').then((m) => ({ default: m.MonacoMount })));

export function EditorPane() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;

  return (
    <div className="h-full flex flex-col bg-background min-h-0">
      <EditorTabBar />
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {activeFile ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading editor…</span>
              </div>
            }
          >
            <MonacoMount file={activeFile} />
          </Suspense>
        ) : (
          <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2">
            <FileCode2 className="h-6 w-6 opacity-50" />
            <span>Open a file from the tree on the left.</span>
            <span className="text-[10px]">Ctrl/Cmd+S to save</span>
          </div>
        )}
      </div>
    </div>
  );
}
