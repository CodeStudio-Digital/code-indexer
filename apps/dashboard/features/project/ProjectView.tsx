/**
 * Project view — the unified IDE-style surface at `/projects/:id`.
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  AppShell topbar (Projetos / Agentes / Admin / ...)         │   ← global nav (visible)
 *  ├─────────────────────────────────────────────────────────────┤
 *  │  ProjectTopBar — breadcrumb + project-scoped actions        │   ← slim, h-9
 *  ├─┬───────────────────────────────────────────────────────────┤
 *  │R│  PanelGroup vertical                                       │
 *  │a│  ┌─────────────────────────────────────────────────────┐  │
 *  │i│  │  Active tab content (depends on rail selection)     │  │
 *  │l│  │   - files → FileTreeRail | EditorPane (split)       │  │
 *  │ │  │   - git   → GitWindow    | EditorPane (split)       │  │
 *  │ │  │   - chat  → AgentChat                               │  │
 *  │ │  │   - search, snapshots, deps, arch, diff, costs, runs│  │
 *  │ │  └─────────────────────────────────────────────────────┘  │
 *  │ │  ─── resize handle (only when bottom panel open) ──────  │
 *  │ │  ┌─────────────────────────────────────────────────────┐  │
 *  │ │  │  BottomPanel — Terminal / Problems / Output / Search│  │
 *  │ │  └─────────────────────────────────────────────────────┘  │
 *  ├─┴───────────────────────────────────────────────────────────┤
 *  │  StatusBar — git branch · file · counts · LSP indicator     │
 *  └─────────────────────────────────────────────────────────────┘
 *
 * Replaces both the standalone JetBrains-style Workspace AND the old
 * ProjectDetail analytics tabs into a single screen. The rail is the
 * navigation primitive: each icon shows a different "tool window" in
 * the central area. The bottom panel (terminal) is independent of the
 * active rail tab — it toggles via Ctrl+J or the rail's footer icon.
 *
 * State reuse:
 *   - `useWorkspaceStore`        → open files / active file / dirty marks
 *   - `useWorkspaceLayout`       → bottom-panel toggle + size persistence
 *   - `loadPersistedTabs`        → restore tabs across reloads
 *
 * Layout assumptions:
 *   - Mounted INSIDE AppShell chrome (no h-100dvh; we get flex-1 from
 *     AppShell's `<main>`). The AppShell topbar stays visible above us.
 *   - The `useWorkspaceLayout` store's `activeBottom` is the canonical
 *     "is the terminal open?" signal — reused 1:1 from the workspace
 *     experience so the user's preference persists across project
 *     switches.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  BookOpen,
  Database,
  DollarSign,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCompare,
  History,
  Layers,
  LineChart,
  MessageSquareCode,
  Network,
  PanelBottomClose,
  PanelBottomOpen,
  Search,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiCall } from '../../lib/api-client.js';
import {
  loadPersistedTabs,
  savePersistedTabs,
  useWorkspaceStore,
} from '../../state/workspace.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { FileTreeRail } from '../workspace/FileTreeRail.js';
import { EditorPane } from '../workspace/EditorPane.js';
import { BottomPanel } from '../workspace/BottomPanel.js';
import { StatusBar } from '../workspace/jetbrains/StatusBar.js';
import { GitWindow } from '../workspace/jetbrains/tool-windows/GitWindow.js';
import AgentChat from '../chat/index.js';
import CostDashboard from '../costs/index.js';
import DiffViewer from '../diff/index.js';
import SearchPanel from '../search/index.js';
import SnapshotEditor from '../snapshots/index.js';
import { ArchitectureTab } from './tabs/ArchitectureTab.js';
import { DependenciesTab } from './tabs/DependenciesTab.js';
import { FilesTab as IndexedFilesTab } from './tabs/FilesTab.js';
import { RunsTab } from './tabs/RunsTab.js';
import { Button } from '../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';

export type ProjectTabId =
  | 'chat'
  | 'files'
  | 'indexed'
  | 'search'
  | 'git'
  | 'snapshots'
  | 'dependencies'
  | 'architecture'
  | 'diff'
  | 'costs'
  | 'runs';

interface TabDef {
  id: ProjectTabId;
  label: string;
  icon: LucideIcon;
  /** Group separates the IDE-core tools (top) from the analytics-style
   *  tools (bottom). Visually rendered as a divider in the rail. */
  group: 'core' | 'analytics';
}

const TABS: TabDef[] = [
  { id: 'chat',         label: 'Sessões',       icon: MessageSquareCode, group: 'core' },
  { id: 'files',        label: 'Files',         icon: FileCode2,         group: 'core' },
  { id: 'search',       label: 'Search',        icon: Search,            group: 'core' },
  { id: 'git',          label: 'Git',           icon: GitBranch,         group: 'core' },
  { id: 'snapshots',    label: 'Snapshots',     icon: BookOpen,          group: 'core' },
  // Indexed lives in analytics — it's the per-project file table with
  // sumarização/complexity/layer/flags, distinct from the IDE-style
  // file tree (`files`). The Search tab already exposes the vector
  // debug panel inline, so no separate "Vectors" entry needed.
  { id: 'indexed',      label: 'Indexed',       icon: Database,          group: 'analytics' },
  { id: 'dependencies', label: 'Dependencies',  icon: Network,           group: 'analytics' },
  { id: 'architecture', label: 'Architecture',  icon: Layers,            group: 'analytics' },
  { id: 'diff',         label: 'Diff',          icon: GitCompare,        group: 'analytics' },
  { id: 'costs',        label: 'Costs',         icon: DollarSign,        group: 'analytics' },
  { id: 'runs',         label: 'Runs',          icon: History,           group: 'analytics' },
];

interface ProjectViewProps {
  projectId: number;
  projectName: string;
  /** When set (via Recent Sessions click in AppShell topbar), pre-selects
   *  the chat tab + the given session inside AgentChat. */
  initialSessionId?: number;
}

export function ProjectView({ projectId, projectName, initialSessionId }: ProjectViewProps) {
  const navigate = useNavigate();
  const layout = useWorkspaceLayout();
  const openFile = useWorkspaceStore((s) => s.openFile);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const closeFile = useWorkspaceStore((s) => s.closeFile);

  // Default tab: 'chat' so existing users keep the familiar landing
  // surface. If the user opened the project specifically to look at a
  // file (Quick Open from outside, future routes), we can switch to
  // 'files' via a query string param down the road.
  const [tab, setTab] = useState<ProjectTabId>(() =>
    initialSessionId ? 'chat' : 'chat',
  );

  // Recent-session deep link forces the chat tab so the user sees the
  // session they clicked on (matches ProjectDetail's old behaviour).
  useEffect(() => {
    if (initialSessionId) setTab('chat');
  }, [initialSessionId]);

  // ─── Open file from the tree → uses the same workspace store as the
  //     legacy Workspace component so tabs persist + the editor sees
  //     them ───
  const handleOpen = useCallback(
    async (path: string) => {
      try {
        const result = await apiCall<{ content: string; encoding: 'utf8' | 'base64' }>(
          'files.read',
          { projectId, path },
        );
        openFile({
          projectId,
          path,
          content: result.content,
          dirty: false,
          lastModified: null,
        });
      } catch {
        /* silent — surface inline once we ship a toast/banner for editor errors */
      }
      // Switch to the files tab so the editor surfaces what was just opened.
      setTab('files');
    },
    [projectId, openFile],
  );

  // ─── Tab restoration across reloads (lifted verbatim from Workspace) ───
  useEffect(() => {
    const persisted = loadPersistedTabs(projectId);
    if (persisted.openFiles.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const entry of persisted.openFiles) {
        if (cancelled) return;
        try {
          const result = await apiCall<{ content: string; encoding: 'utf8' | 'base64' }>(
            'files.read',
            { projectId: entry.projectId, path: entry.path },
          );
          if (cancelled) return;
          openFile({
            projectId: entry.projectId,
            path: entry.path,
            content: result.content,
            dirty: false,
            lastModified: null,
          });
        } catch {
          /* file may have been deleted on disk — skip silently */
        }
      }
      if (cancelled) return;
      if (persisted.activeFilePath) {
        useWorkspaceStore.getState().setActive(persisted.activeFilePath);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-runs on projectId change. Re-running on `openFile` would
    // restart the restore loop because openFile mutates the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      savePersistedTabs(projectId, state.openFiles, state.activeFilePath);
    });
    return () => unsubscribe();
  }, [projectId]);

  // ─── Global keybindings ───
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

      // Ctrl+J → toggle terminal (bottom panel)
      if (key === 'j' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        layout.toggleBottom('terminal');
        return;
      }
      // Ctrl+W → close active editor tab when on the files surface
      if (key === 'w' && !e.shiftKey && !e.altKey) {
        if (inEditable(e.target)) return;
        if (tab !== 'files') return;
        e.preventDefault();
        if (activeFilePath) closeFile(activeFilePath);
        return;
      }
      // Ctrl+B → toggle file tree side via tab switch (focus convenience)
      if (key === 'b' && !e.shiftKey && !e.altKey) {
        if (inEditable(e.target)) return;
        e.preventDefault();
        setTab((cur) => (cur === 'files' ? 'chat' : 'files'));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout, tab, activeFilePath, closeFile]);

  // When the user toggles Files via the rail and there are NO files
  // open yet, surface a helpful empty state so the editor pane isn't
  // an empty void. Empty-state lives inside EditorPane so we don't
  // duplicate it here.
  void openFiles;

  return (
    // `h-full` (not `flex-1`) because the parent <main> in AppShell is
    // a plain block element — `flex-1` would no-op and the bottom of
    // the viewport would leak through as an empty background slab.
    // h-full inherits main's height (which AppShell sets via its own
    // flex-1 inside the 100dvh column).
    <div className="flex flex-col h-full min-h-0">
      <ProjectTopBar
        projectId={projectId}
        projectName={projectName}
        bottomOpen={layout.activeBottom !== null}
        onToggleBottom={() => layout.toggleBottom('terminal')}
        onOpenAnalytics={() => navigate(`/projects/${projectId}/analytics`)}
      />
      <div className="flex flex-1 min-h-0">
        <ProjectRail activeTab={tab} onSelect={setTab} layout={layout} />
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <PanelGroup direction="vertical" autoSaveId="mcp-project-vert">
            <Panel minSize={20}>
              <TabContent
                tab={tab}
                projectId={projectId}
                projectName={projectName}
                initialSessionId={initialSessionId}
                onOpenFile={handleOpen}
                activeFilePath={activeFilePath}
              />
            </Panel>
            {layout.activeBottom && (
              <>
                <PanelResizeHandle className="h-px bg-border hover:bg-primary/40 transition-colors" />
                <Panel defaultSize={25} minSize={10} maxSize={60}>
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
        </div>
      </div>
      <StatusBar projectId={projectId} projectName={projectName} />
    </div>
  );
}

// ─── Top bar ────────────────────────────────────────────────────────

interface ProjectTopBarProps {
  projectId: number;
  projectName: string;
  bottomOpen: boolean;
  onToggleBottom: () => void;
  onOpenAnalytics: () => void;
}

function ProjectTopBar({
  projectName,
  bottomOpen,
  onToggleBottom,
  onOpenAnalytics,
}: ProjectTopBarProps) {
  return (
    <header className="h-9 shrink-0 border-b bg-card/60 flex items-center px-3 gap-2 text-[12px]">
      <FolderGit2 className="h-3.5 w-3.5 text-primary shrink-0" />
      <span className="font-medium truncate max-w-[300px]" title={projectName}>
        {projectName}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onOpenAnalytics}
              aria-label="Open project analytics"
            >
              <LineChart className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Analytics view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleBottom}
              aria-label={bottomOpen ? 'Close terminal' : 'Open terminal'}
            >
              {bottomOpen ? (
                <PanelBottomClose className="h-3.5 w-3.5" />
              ) : (
                <PanelBottomOpen className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Terminal (Ctrl+J)</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

// ─── Activity rail ──────────────────────────────────────────────────

interface ProjectRailProps {
  activeTab: ProjectTabId;
  onSelect: (id: ProjectTabId) => void;
  layout: ReturnType<typeof useWorkspaceLayout>;
}

function ProjectRail({ activeTab, onSelect, layout }: ProjectRailProps) {
  const core = TABS.filter((t) => t.group === 'core');
  const analytics = TABS.filter((t) => t.group === 'analytics');
  return (
    <nav
      className="flex flex-col w-10 shrink-0 border-r bg-card/40 py-1 gap-0.5 items-center"
      aria-label="Project sections"
    >
      {core.map((tabDef) => (
        <RailButton key={tabDef.id} def={tabDef} active={activeTab === tabDef.id} onSelect={onSelect} />
      ))}
      <span className="h-px w-6 bg-border my-1.5" aria-hidden />
      {analytics.map((tabDef) => (
        <RailButton key={tabDef.id} def={tabDef} active={activeTab === tabDef.id} onSelect={onSelect} />
      ))}
      <div className="mt-auto pb-1">
        {/* Terminal toggle — sits at the bottom of the rail mirroring
            VS Code / JetBrains conventions. Active state reflects
            whether the bottom panel is currently open. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => layout.toggleBottom('terminal')}
              aria-label="Toggle terminal"
              aria-pressed={layout.activeBottom !== null}
              className={cn(
                'relative h-8 w-8 grid place-items-center rounded-md transition-colors',
                layout.activeBottom
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <TerminalSquare className="h-4 w-4" />
              {layout.activeBottom && (
                <span
                  aria-hidden
                  className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
                />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Terminal (Ctrl+J)</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

function RailButton({
  def,
  active,
  onSelect,
}: {
  def: TabDef;
  active: boolean;
  onSelect: (id: ProjectTabId) => void;
}) {
  const Icon = def.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(def.id)}
          aria-label={def.label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative h-8 w-8 grid place-items-center rounded-md transition-colors',
            active
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
          {active && (
            <span
              aria-hidden
              className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{def.label}</TooltipContent>
    </Tooltip>
  );
}

// ─── Tab content router ─────────────────────────────────────────────

interface TabContentProps {
  tab: ProjectTabId;
  projectId: number;
  projectName: string;
  initialSessionId?: number;
  onOpenFile: (path: string) => void;
  activeFilePath: string | null;
}

function TabContent({
  tab,
  projectId,
  projectName,
  initialSessionId,
  onOpenFile,
  activeFilePath,
}: TabContentProps) {
  // Files tab gets a sub-PanelGroup so the user can resize the file
  // tree independently of the editor (just like JetBrains/VS Code).
  if (tab === 'files') {
    return (
      <PanelGroup direction="horizontal" autoSaveId="mcp-project-files-horiz">
        <Panel defaultSize={20} minSize={12} maxSize={40}>
          <div className="h-full border-r overflow-hidden">
            <FileTreeRail projectId={projectId} activePath={activeFilePath} onOpen={onOpenFile} />
          </div>
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
        <Panel minSize={30}>
          <EditorPane />
        </Panel>
      </PanelGroup>
    );
  }

  // Git tab mirrors the Files split: GitWindow on the left, editor on
  // the right. Clicking a file in the Changes pane opens a diff via
  // `useWorkspaceStore.openDiff` — having EditorPane mounted alongside
  // means the diff renders inline (instead of forcing the user to flip
  // to the Files tab to see what they just opened). Default size is
  // wider than the file tree (28%) because the Changes list shows
  // path + bulk-action buttons + ahead/behind chips — needs breathing
  // room. `autoSaveId` is distinct so the persisted size doesn't
  // collide with the Files tab.
  if (tab === 'git') {
    return (
      <PanelGroup direction="horizontal" autoSaveId="mcp-project-git-horiz">
        <Panel defaultSize={28} minSize={18} maxSize={50}>
          <div className="h-full border-r overflow-hidden">
            <GitWindow projectId={projectId} />
          </div>
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
        <Panel minSize={30}>
          <EditorPane />
        </Panel>
      </PanelGroup>
    );
  }

  if (tab === 'chat') {
    return (
      <AgentChat
        projectId={projectId}
        projectName={projectName}
        initialSessionId={initialSessionId}
      />
    );
  }

  // Search, git, snapshots and the analytics-style tabs render in a
  // scrollable surface — none of them currently need a dedicated
  // sub-panel layout. Wrapped in a uniform padded container so the
  // user gets consistent breathing room across tools.
  return (
    <div className="h-full overflow-auto">
      <ToolSurface tab={tab} projectId={projectId} projectName={projectName} />
    </div>
  );
}

function ToolSurface({
  tab,
  projectId,
  projectName,
}: {
  tab: ProjectTabId;
  projectId: number;
  projectName: string;
}) {
  switch (tab) {
    case 'search':
      return (
        <div className="px-4 py-3">
          <SearchPanel projectId={projectId} projectName={projectName} />
        </div>
      );
    // 'git' is intercepted by TabContent above (split panel layout with
    // GitWindow + EditorPane); this case is unreachable but kept off the
    // switch so we don't render a duplicate GitWindow if TabContent's
    // branching is ever refactored.
    case 'snapshots':
      return (
        <div className="px-4 py-3">
          <SnapshotEditor projectId={projectId} />
        </div>
      );
    case 'indexed':
      return (
        <div className="px-4 py-3">
          <IndexedFilesTab projectId={projectId} />
        </div>
      );
    case 'dependencies':
      return (
        <div className="px-4 py-3">
          <DependenciesTab projectId={projectId} />
        </div>
      );
    case 'architecture':
      return (
        <div className="px-4 py-3">
          <ArchitectureTab projectId={projectId} />
        </div>
      );
    case 'diff':
      return (
        <div className="px-4 py-3">
          <DiffViewer projectId={projectId} />
        </div>
      );
    case 'costs':
      return (
        <div className="px-4 py-3">
          <CostDashboard projectId={projectId} />
        </div>
      );
    case 'runs':
      return (
        <div className="px-4 py-3">
          <RunsTab projectId={projectId} />
        </div>
      );
    default:
      return null;
  }
}
