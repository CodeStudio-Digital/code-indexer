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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  Bell,
  FileCode2,
  GitBranch,
  History,
  MessageSquare,
  PanelBottomOpen,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import {
  useWorkspaceStore,
  loadPersistedTabs,
  savePersistedTabs,
} from '../../state/workspace.js';
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
import { CommandPalette, type Command } from './jetbrains/CommandPalette.js';
import { useContributions, hydrateContributions } from '../../state/contribution-registry.js';
import { buildThemeCommands } from './registries/commands.js';
import { contributedRailItems } from './registries/rail-items.js';
import { installWebviewBridge } from './webview-bridge.js';
import { QuickOpen } from './jetbrains/QuickOpen.js';
import { FileTreeWindow } from './jetbrains/tool-windows/FileTreeWindow.js';
import { SnapshotsWindow } from './jetbrains/tool-windows/SnapshotsWindow.js';
import { GitWindow } from './jetbrains/tool-windows/GitWindow.js';
import { SearchWindow } from './jetbrains/tool-windows/SearchWindow.js';
import { SpecsWindow } from './jetbrains/tool-windows/SpecsWindow.js';
import { ChatWindow } from './jetbrains/tool-windows/ChatWindow.js';
import { PlaceholderWindow } from './jetbrains/tool-windows/PlaceholderWindow.js';
import { WebviewWindow } from './jetbrains/tool-windows/WebviewWindow.js';

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
  { id: 'specs', label: 'Specs (SDD)', icon: ScrollText },
  { id: 'git', label: 'Git', icon: GitBranch },
];

// ChatWindow now hosts the sessions list internally (no more duplicate
// sidebar inside a narrow rail), so the standalone Sessions icon would
// just open the same surface twice.
const RIGHT_ITEMS: RailItem<RightToolId>[] = [
  { id: 'chat', label: 'Agent chat', icon: MessageSquare },
  { id: 'inbox', label: 'Inbox', icon: Bell },
];

export function Workspace({ projectId, projectName, initialSessionId, onExit }: WorkspaceProps) {
  const layout = useWorkspaceLayout();
  const contribThemes = useContributions((s) => s.themes);
  const contribWindows = useContributions((s) => s.toolWindows);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const [activeSessionId, setActiveSessionId] = useState<number | undefined>(initialSessionId);
  const [quickOpen, setQuickOpen] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const openFiles = useWorkspaceStore((s) => s.openFiles);

  const handleOpen = useCallback(
    (path: string) => {
      // Instant open — content: null; the editor fetches on activation.
      openFile({ projectId, path, content: null, dirty: false, lastModified: null });
    },
    [projectId, openFile],
  );

  // Restore the user's previous tab set on first mount — instant (no
  // serial fetch loop); each tab loads on first activation.
  useEffect(() => {
    const persisted = loadPersistedTabs(projectId);
    if (persisted.openFiles.length === 0) return;
    for (const entry of persisted.openFiles) {
      openFile({
        projectId: entry.projectId,
        path: entry.path,
        content: null,
        dirty: false,
        lastModified: null,
      });
    }
    if (persisted.activeFilePath) {
      useWorkspaceStore.getState().setActive(persisted.activeFilePath);
    }
    // Only re-runs on projectId change. Re-running on `openFile` would
    // restart the restore loop because openFile mutates the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Persist tab state on every change so a reload picks up the same set.
  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      savePersistedTabs(projectId, state.openFiles, state.activeFilePath);
    });
    return () => unsubscribe();
  }, [projectId]);

  // Build the command list once per layout-state change. Each command
  // captures the live setter, so toggling a tool window via the palette
  // produces the same state delta as clicking the rail icon.
  // Hydrate plugin UI contributions (themes, commands, tool windows) once.
  useEffect(() => {
    void hydrateContributions();
  }, []);

  // Host side of the plugin webview bridge (whitelisted read-only calls).
  useEffect(() => installWebviewBridge(), []);

  const commands = useMemo<Command[]>(() => {
    const toggleLeft = (id: LeftToolId, label: string): Command => ({
      id: `view.toggle-left-${id}`,
      category: 'View',
      label: `Toggle ${label}`,
      run: () => layout.toggleLeft(id),
    });
    const toggleRight = (id: RightToolId, label: string): Command => ({
      id: `view.toggle-right-${id}`,
      category: 'View',
      label: `Toggle ${label}`,
      run: () => layout.toggleRight(id),
    });
    return [
      // ── File ──────────────────────
      {
        id: 'file.quick-open',
        category: 'File',
        label: 'Go to file…',
        shortcut: 'Ctrl+P',
        icon: FileCode2,
        run: () => setQuickOpen(true),
      },
      {
        id: 'file.save-all',
        category: 'File',
        label: 'Save all',
        shortcut: 'Ctrl+Shift+S',
        icon: Save,
        run: async () => {
          // Reads live Monaco models (store can lag a keystroke) and skips
          // never-loaded tabs (content null) — see editor/save.ts.
          const { saveAllDirty } = await import('./editor/save.js');
          await saveAllDirty(projectId);
        },
      },
      {
        id: 'file.close-active',
        category: 'File',
        label: 'Close active tab',
        shortcut: 'Ctrl+W',
        icon: X,
        run: () => {
          if (activeFilePath) closeFile(activeFilePath);
        },
      },
      // ── View ──────────────────────
      toggleLeft('files', 'project files'),
      toggleLeft('search', 'search'),
      toggleLeft('snapshots', 'snapshots'),
      toggleLeft('git', 'git'),
      toggleRight('chat', 'agent chat'),
      toggleRight('inbox', 'inbox'),
      {
        id: 'view.toggle-left-rail',
        category: 'View',
        label: 'Toggle left tool panel',
        shortcut: 'Ctrl+B',
        icon: PanelLeft,
        run: () => layout.setActiveLeft(layout.activeLeft ? null : 'files'),
      },
      {
        id: 'view.toggle-right-rail',
        category: 'View',
        label: 'Toggle right tool panel',
        shortcut: 'Ctrl+Alt+B',
        icon: PanelRight,
        run: () => layout.setActiveRight(layout.activeRight ? null : 'chat'),
      },
      {
        id: 'view.toggle-terminal',
        category: 'View',
        label: 'Toggle terminal',
        shortcut: 'Ctrl+J',
        icon: TerminalSquare,
        run: () => layout.toggleBottom('terminal'),
      },
      {
        id: 'view.toggle-bottom-panel',
        category: 'View',
        label: 'Toggle bottom panel',
        shortcut: 'Ctrl+`',
        icon: PanelBottomOpen,
        run: () =>
          layout.activeBottom ? layout.setActiveBottom(null) : layout.setActiveBottom('terminal'),
      },
      // ── Workspace ─────────────────
      {
        id: 'workspace.reload',
        category: 'Workspace',
        label: 'Reload window',
        shortcut: 'Ctrl+R',
        icon: RefreshCw,
        run: () => window.location.reload(),
      },
      // ── Plugin contributions ──────
      ...buildThemeCommands(contribThemes),
    ];
  }, [layout, activeFilePath, closeFile, openFiles, contribThemes]);

  // Global keyboard shortcuts. Each binding is gated on the focus
  // not being inside another input (Monaco already swallows the
  // bindings it cares about, so this listener doesn't reach it).
  useEffect(() => {
    const inEditable = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      // Quick Open
      if (key === 'p' && !e.shiftKey && !e.altKey) {
        if (inEditable(e.target)) return;
        e.preventDefault();
        setQuickOpen(true);
        return;
      }
      // Command Palette
      if (key === 'p' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCommandPalette(true);
        return;
      }
      // Save all
      if (key === 's' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        const saveAll = commands.find((c) => c.id === 'file.save-all');
        if (saveAll) void saveAll.run();
        return;
      }
      // Close tab
      if (key === 'w' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (activeFilePath) closeFile(activeFilePath);
        return;
      }
      // Toggle left rail
      if (key === 'b' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        layout.setActiveLeft(layout.activeLeft ? null : 'files');
        return;
      }
      // Toggle right rail
      if (key === 'b' && e.altKey && !e.shiftKey) {
        e.preventDefault();
        layout.setActiveRight(layout.activeRight ? null : 'chat');
        return;
      }
      // Toggle terminal
      if (key === 'j' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        layout.toggleBottom('terminal');
        return;
      }
      // Toggle bottom panel (` key)
      if (e.key === '`' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (layout.activeBottom) layout.setActiveBottom(null);
        else layout.setActiveBottom('terminal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout, activeFilePath, closeFile, commands]);

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
          items={[...LEFT_ITEMS, ...contributedRailItems(contribWindows, 'left')]}
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
                    onClose={() => layout.setActiveRight(null)}
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
        <ActivityRail
          side="right"
          items={[...RIGHT_ITEMS, ...contributedRailItems(contribWindows, 'right')]}
          active={layout.activeRight}
          onToggle={layout.toggleRight}
        />
      </div>
      <StatusBar projectId={projectId} projectName={projectName} />
      <QuickOpen
        projectId={projectId}
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onPick={(path) => void handleOpen(path)}
      />
      <CommandPalette
        open={commandPalette}
        commands={commands}
        onClose={() => setCommandPalette(false)}
      />
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
  const contribWindows = useContributions((s) => s.toolWindows);
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
    return <SnapshotsWindow projectId={projectId} onClose={onClose} />;
  }
  if (activeLeft === 'specs') {
    return <SpecsWindow projectId={projectId} onOpen={onOpen} onClose={onClose} />;
  }
  if (activeLeft === 'git') {
    return <GitWindow projectId={projectId} onClose={onClose} />;
  }
  const win = contribWindows.find((w) => w.side === 'left' && w.id === activeLeft);
  if (win) {
    return (
      <WebviewWindow namespace={win.pluginNs} title={win.title} entry={win.entry} onClose={onClose} />
    );
  }
  return null;
}

interface RightToolPanelProps {
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  onClose: () => void;
}

function RightToolPanel({
  projectId,
  projectName,
  initialSessionId,
  onClose,
}: RightToolPanelProps) {
  const activeRight = useWorkspaceLayout((s) => s.activeRight);
  const contribWindows = useContributions((s) => s.toolWindows);
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
  if (activeRight === 'inbox') {
    return (
      <PlaceholderWindow
        title="Inbox"
        hint="Background agent notifications + interrupt-resume prompts will surface here."
        onClose={onClose}
      />
    );
  }
  const win = contribWindows.find((w) => w.side === 'right' && w.id === activeRight);
  if (win) {
    return (
      <WebviewWindow namespace={win.pluginNs} title={win.title} entry={win.entry} onClose={onClose} />
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
