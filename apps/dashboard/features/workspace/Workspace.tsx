/**
 * Workspace IDE — JetBrains-style layout.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Top bar (breadcrumb + global actions)                            │
 *   ├─┬──────────────────────────────────┬─┬───────────────────────────┤
 *   │ │  Left tool panel (optional)       │ │  Right tool panel (opt.)  │
 *   │L│                                   │R│                           │
 *   │e│  Editor                           │i│  Editor right-side wells  │
 *   │f│                                   │g│  (chat, sessions, ...)    │
 *   │t│                                   │h│                           │
 *   │ ├───────────────────────────────────┤t│                           │
 *   │R│  Bottom panel (optional: term…)   │R│                           │
 *   │a│                                   │a│                           │
 *   │i│                                   │i│                           │
 *   │l│                                   │l│                           │
 *   ├─┴───────────────────────────────────┴─┴───────────────────────────┤
 *   │  Status bar                                                       │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Activity rails (left & right) toggle tool windows in/out. Clicking the
 * active icon collapses the panel — matches JetBrains muscle memory.
 * Sizes + active selections persist to localStorage via the workspace-
 * layout Zustand store so the user's layout sticks across reloads.
 */

import { useCallback, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  Bell,
  FileCode2,
  GitBranch,
  History,
  MessageSquare,
  Search,
} from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import {
  useWorkspaceLayout,
  type LeftToolId,
  type RightToolId,
} from '../../state/workspace-layout.js';
import { WorkspaceTopBar } from './WorkspaceTopBar.js';
import { EditorPane } from './EditorPane.js';
import { BottomPanel } from './BottomPanel.js';
import { ActivityRail, type RailItem } from './jetbrains/ActivityRail.js';
import { StatusBar } from './jetbrains/StatusBar.js';
import { FileTreeWindow } from './jetbrains/tool-windows/FileTreeWindow.js';
import { SearchWindow } from './jetbrains/tool-windows/SearchWindow.js';
import { ChatWindow } from './jetbrains/tool-windows/ChatWindow.js';
import { SessionsWindow } from './jetbrains/tool-windows/SessionsWindow.js';
import { PlaceholderWindow } from './jetbrains/tool-windows/PlaceholderWindow.js';

interface WorkspaceProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  onExit: () => void;
}

const LEFT_ITEMS: RailItem<LeftToolId>[] = [
  { id: 'files', label: 'Project files', icon: FileCode2 },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'snapshots', label: 'Snapshots', icon: History },
  { id: 'git', label: 'Git', icon: GitBranch },
];

const RIGHT_ITEMS: RailItem<RightToolId>[] = [
  { id: 'chat', label: 'Agent chat', icon: MessageSquare },
  { id: 'sessions', label: 'Sessions', icon: History },
  { id: 'inbox', label: 'Inbox', icon: Bell },
];

export function Workspace({ projectId, projectName, initialSessionId, onExit }: WorkspaceProps) {
  const layout = useWorkspaceLayout();
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const [activeSessionId, setActiveSessionId] = useState<number | undefined>(initialSessionId);

  const handleOpen = useCallback(
    async (path: string) => {
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
        /* surface inline once we ship a toast system */
      }
    },
    [projectId, openFile],
  );

  return (
    <div className="flex flex-col h-[100dvh] min-h-0 w-full bg-background text-foreground">
      <WorkspaceTopBar
        projectId={projectId}
        projectName={projectName}
        bottomPanelOpen={layout.activeBottom !== null}
        onToggleBottomPanel={() => layout.toggleBottom('terminal')}
        onBackToProject={onExit}
      />
      <div className="flex flex-1 min-h-0">
        <ActivityRail
          side="left"
          items={LEFT_ITEMS}
          active={layout.activeLeft}
          onToggle={layout.toggleLeft}
        />
        <div className="flex-1 min-w-0">
          <PanelGroup direction="horizontal" autoSaveId="mcp-workspace-horizontal-v2">
            {layout.activeLeft && (
              <>
                <Panel
                  defaultSize={pctOf(layout.leftSize)}
                  minSize={12}
                  maxSize={40}
                  onResize={(size) => layout.setLeftSize(pxOf(size))}
                >
                  <LeftToolPanel
                    activeFilePath={activeFilePath}
                    onOpen={handleOpen}
                    onClose={() => layout.setActiveLeft(null)}
                    projectId={projectId}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
              </>
            )}
            <Panel minSize={30}>
              <PanelGroup direction="vertical" autoSaveId="mcp-workspace-vertical-v2">
                <Panel minSize={30}>
                  <EditorPane />
                </Panel>
                {layout.activeBottom && (
                  <>
                    <PanelResizeHandle className="h-px bg-border hover:bg-primary/40 transition-colors" />
                    <Panel
                      defaultSize={pctOf(layout.bottomSize, 'v')}
                      minSize={12}
                      maxSize={70}
                      onResize={(size) => layout.setBottomSize(pxOf(size, 'v'))}
                    >
                      <BottomPanel
                        projectId={projectId}
                        isOpen={true}
                        onToggle={() => layout.toggleBottom(layout.activeBottom!)}
                        onClose={() => layout.setActiveBottom(null)}
                      />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </Panel>
            {layout.activeRight && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
                <Panel
                  defaultSize={pctOf(layout.rightSize)}
                  minSize={16}
                  maxSize={50}
                  onResize={(size) => layout.setRightSize(pxOf(size))}
                >
                  <RightToolPanel
                    projectId={projectId}
                    projectName={projectName}
                    initialSessionId={activeSessionId}
                    onSelectSession={(id) => setActiveSessionId(id)}
                    onClose={() => layout.setActiveRight(null)}
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
        <ActivityRail
          side="right"
          items={RIGHT_ITEMS}
          active={layout.activeRight}
          onToggle={layout.toggleRight}
        />
      </div>
      <StatusBar projectId={projectId} projectName={projectName} />
    </div>
  );
}

// ─── Tool panel selectors ─────────────────────────────────────

interface LeftToolPanelProps {
  projectId: number;
  activeFilePath: string | null;
  onOpen: (path: string) => void;
  onClose: () => void;
}

function LeftToolPanel({ projectId, activeFilePath, onOpen, onClose }: LeftToolPanelProps) {
  const activeLeft = useWorkspaceLayout((s) => s.activeLeft);
  if (activeLeft === 'files') {
    return (
      <FileTreeWindow
        projectId={projectId}
        activePath={activeFilePath}
        onOpen={onOpen}
        onClose={onClose}
      />
    );
  }
  if (activeLeft === 'search') {
    return <SearchWindow projectId={projectId} onOpen={onOpen} onClose={onClose} />;
  }
  if (activeLeft === 'snapshots') {
    return (
      <PlaceholderWindow
        title="Snapshots"
        hint="Project context notes will land here. Today they live in the analytics view (top-bar shortcut)."
        onClose={onClose}
      />
    );
  }
  if (activeLeft === 'git') {
    return (
      <PlaceholderWindow
        title="Git"
        hint="Status, log, diff, and commit will land here. Use the terminal in the meantime."
        onClose={onClose}
      />
    );
  }
  return null;
}

interface RightToolPanelProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  onSelectSession: (sessionId: number) => void;
  onClose: () => void;
}

function RightToolPanel({
  projectId,
  projectName,
  initialSessionId,
  onSelectSession,
  onClose,
}: RightToolPanelProps) {
  const activeRight = useWorkspaceLayout((s) => s.activeRight);
  if (activeRight === 'chat') {
    return (
      <ChatWindow
        projectId={projectId}
        projectName={projectName}
        initialSessionId={initialSessionId}
        onClose={onClose}
      />
    );
  }
  if (activeRight === 'sessions') {
    return (
      <SessionsWindow
        projectId={projectId}
        activeSessionId={initialSessionId}
        onSelectSession={onSelectSession}
        onClose={onClose}
      />
    );
  }
  if (activeRight === 'inbox') {
    return (
      <PlaceholderWindow
        title="Inbox"
        hint="Background agent notifications + interrupt-resume prompts will surface here."
        onClose={onClose}
      />
    );
  }
  return null;
}

// ─── Size conversion helpers ──────────────────────────────────
//
// react-resizable-panels works in percent. We persist px so the user's
// stored width survives window resizes. Conversion uses the window's
// inner dimension at access time; defaults assume 1400×900.

function pctOf(px: number, axis: 'h' | 'v' = 'h'): number {
  if (typeof window === 'undefined') return axis === 'h' ? 20 : 25;
  const dim = axis === 'h' ? window.innerWidth : window.innerHeight;
  if (!dim) return axis === 'h' ? 20 : 25;
  return Math.max(8, Math.min(60, (px / dim) * 100));
}

function pxOf(pct: number, axis: 'h' | 'v' = 'h'): number {
  if (typeof window === 'undefined') return Math.round((pct / 100) * (axis === 'h' ? 1400 : 900));
  const dim = axis === 'h' ? window.innerWidth : window.innerHeight;
  return Math.round((pct / 100) * dim);
}
