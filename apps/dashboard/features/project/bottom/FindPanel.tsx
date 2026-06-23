/**
 * Find/Replace in Files — IntelliJ-style, surfaced in the bottom panel. The
 * toolbar (search + replace + matcher toggles + file mask) sits on top; the
 * body is a resizable 2-pane split with results on the LEFT and a live file
 * preview on the RIGHT (the wide-screen layout the user asked for). Backed by
 * the `search.grep` / `search.replace` API (literal/regex over indexed files).
 */
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useFindReplace } from './useFindReplace.js';
import { FindToolbar } from './FindToolbar.js';
import { FindResults } from './FindResults.js';
import { FindPreview } from './FindPreview.js';

interface FindPanelProps {
  projectId: number;
  onOpenFile?: (path: string) => void;
}

export function FindPanel({ projectId, onOpenFile }: FindPanelProps) {
  const c = useFindReplace(projectId);

  return (
    <div className="flex flex-col h-full min-h-0">
      <FindToolbar c={c} />
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId="mcp-find-in-files">
          <Panel defaultSize={45} minSize={25}>
            <FindResults c={c} onOpenFile={onOpenFile} />
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel defaultSize={55} minSize={25}>
            <div className="h-full border-l">
              <FindPreview projectId={projectId} c={c} />
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
