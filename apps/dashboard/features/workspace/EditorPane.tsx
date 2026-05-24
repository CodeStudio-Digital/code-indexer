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
          <div className="h-full grid place-items-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3 px-8 py-12 max-w-sm text-center">
              <div className="h-12 w-12 rounded-lg bg-primary/10 grid place-items-center">
                <FileCode2 className="h-5 w-5 text-primary/70" />
              </div>
              <div className="space-y-1.5">
                <p className="text-[13px] font-medium text-foreground">No file selected</p>
                <p className="text-[11.5px] leading-relaxed">
                  Pick a file from the explorer on the left, or start a conversation with the agent
                  on the right to scaffold something new.
                </p>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                <kbd className="px-1.5 py-0.5 rounded border bg-card font-mono text-[10px]">Ctrl</kbd>
                <span>+</span>
                <kbd className="px-1.5 py-0.5 rounded border bg-card font-mono text-[10px]">S</kbd>
                <span>to save</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
