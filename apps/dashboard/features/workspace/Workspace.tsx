/**
 * Workspace IDE — the new home for `/projects/:id/workspace`. Three
 * resizable columns (FileTreeRail | EditorPane | RightPane) plus a
 * collapsible BottomPanel running the full height of the window.
 *
 * Layout sizes persist to localStorage (see state/workspace.ts) so the
 * user's chosen widths stick across reloads.
 *
 * Day 6 wiring:
 *   - FileTreeRail clicks call apiCall('files.read', …) and push the
 *     file into the Zustand store. EditorPane (placeholder until Day 7)
 *     renders the active file's content read-only.
 *   - RightPane reuses AgentChat unchanged.
 *   - BottomPanel is a skeleton with tabs — content lands in Day 10.
 *
 * The old ProjectDetail view stays at /projects/:id; this Workspace is
 * additive while the IDE matures. Day 16+ swaps the default route.
 */

import { useCallback, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { apiCall } from '../../lib/api-client.js';
import { useWorkspaceStore, loadWorkspaceLayout, saveWorkspaceLayout } from '../../state/workspace.js';
import { WorkspaceTopBar } from './WorkspaceTopBar.js';
import { FileTreeRail } from './FileTreeRail.js';
import { EditorPane } from './EditorPane.js';
import { RightPane } from './RightPane.js';
import { BottomPanel } from './BottomPanel.js';

interface WorkspaceProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  /** Called when the user clicks the breadcrumb to leave the workspace. */
  onExit: () => void;
}

export function Workspace({ projectId, projectName, initialSessionId, onExit }: WorkspaceProps) {
  const layout = loadWorkspaceLayout();
  const [bottomPanelOpen, setBottomPanelOpen] = useState(layout.bottomPanelOpen);

  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const handleOpen = useCallback(
    async (path: string) => {
      // Best-effort: read the file and push it into the store. Errors are
      // dropped silently here — the editor pane shows "No file open" until
      // a successful read lands. We'll add an inline error indicator in
      // Day 7 when the editor is real.
      try {
        const result = await apiCall<{ content: string; encoding: 'utf8' | 'base64' }>('files.read', {
          projectId,
          path,
        });
        openFile({
          projectId,
          path,
          content: result.content,
          dirty: false,
          lastModified: null,
        });
      } catch {
        /* swallowed; surface error once EditorPane is real */
      }
    },
    [projectId, openFile],
  );

  // Persist horizontal panel sizes when the user drags a handle.
  const handleHorizontalResize = useCallback(
    (sizes: number[]) => {
      const [fileTreeSize, editorSize, rightPaneSize] = sizes;
      saveWorkspaceLayout({ fileTreeSize, editorSize, rightPaneSize });
    },
    [],
  );

  const toggleBottomPanel = useCallback(() => {
    setBottomPanelOpen((open) => {
      const next = !open;
      saveWorkspaceLayout({ bottomPanelOpen: next });
      return next;
    });
  }, []);

  // Close the panel via the X button — distinct intent from the toggle.
  const closeBottomPanel = useCallback(() => {
    setBottomPanelOpen(false);
    saveWorkspaceLayout({ bottomPanelOpen: false });
  }, []);

  // Sync the bottom panel state back if a Day-10 keyboard shortcut starts
  // touching it from outside this component.
  useEffect(() => {
    saveWorkspaceLayout({ bottomPanelOpen });
  }, [bottomPanelOpen]);

  return (
    <div className="flex flex-col h-[100dvh] min-h-0 w-full">
      <WorkspaceTopBar
        projectName={projectName}
        bottomPanelOpen={bottomPanelOpen}
        onToggleBottomPanel={toggleBottomPanel}
        onBackToProject={onExit}
      />
      <div className="flex-1 min-h-0">
        <PanelGroup direction="vertical" autoSaveId="mcp-workspace-vertical">
          <Panel defaultSize={bottomPanelOpen ? 100 - layout.bottomPanelSize : 100} minSize={40}>
            <PanelGroup
              direction="horizontal"
              autoSaveId="mcp-workspace-horizontal"
              onLayout={handleHorizontalResize}
            >
              <Panel defaultSize={layout.fileTreeSize} minSize={10} maxSize={40}>
                <FileTreeRail
                  projectId={projectId}
                  activePath={activeFilePath}
                  onOpen={handleOpen}
                />
              </Panel>
              <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
              <Panel defaultSize={layout.editorSize} minSize={30}>
                <EditorPane />
              </Panel>
              <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
              <Panel defaultSize={layout.rightPaneSize} minSize={20} maxSize={50}>
                <RightPane
                  projectId={projectId}
                  projectName={projectName}
                  initialSessionId={initialSessionId}
                />
              </Panel>
            </PanelGroup>
          </Panel>
          {bottomPanelOpen && (
            <>
              <PanelResizeHandle className="h-px bg-border hover:bg-primary/40 transition-colors" />
              <Panel
                defaultSize={layout.bottomPanelSize}
                minSize={15}
                maxSize={60}
                onResize={(size) => saveWorkspaceLayout({ bottomPanelSize: size })}
              >
                <BottomPanel
                  projectId={projectId}
                  isOpen={bottomPanelOpen}
                  onToggle={toggleBottomPanel}
                  onClose={closeBottomPanel}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
